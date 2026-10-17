import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, parse } from '@zlens/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMessage, AgentProvider } from '../providers/types.js';
import type { LocalContextPack } from '../metadata/catalog.js';
import { buildFromPrompt, type BuildBlockResult, type BuildCellResult } from './build-from-prompt.js';
import { renderProposedDraft } from './write-draft.js';

describe('canonical semantic proposal DQL (CONTRACT-002 / UI-016)', () => {
  it('renders metric arrays through the shared semantic writer without embedded SQL', () => {
    const source = renderProposedDraft({
      slug: 'customer_unit_economics',
      domain: 'finance',
      owner: '',
      description: 'Revenue, refunds, and margin by customer.',
      sql: 'SELECT legacy_sql_should_not_be_source_of_truth',
      blockType: 'semantic',
      metrics: ['revenue', 'refunds', 'gross_margin'],
      metricRef: 'revenue',
      dimensions: ['customer_name'],
      pattern: 'metric_wrapper',
      entities: [],
      declaredOutputs: ['customer_name', 'revenue', 'refunds', 'gross_margin'],
      invariants: [],
      examples: [],
      tags: ['ai-generated', 'review-required'],
      sourceModel: 'semantic-layer',
      sourceSystems: ['dbt'],
      certification: { certified: false, errors: [], warnings: [] },
    }, 'blocks/_drafts/customer_unit_economics.dql');

    expect(source).toContain('type = "semantic"');
    expect(source).toContain('metrics = ["revenue", "refunds", "gross_margin"]');
    expect(source).toContain('dimensions = ["customer_name"]');
    expect(source).not.toContain('metric = ');
    expect(source).not.toContain('query =');
    expect(source).not.toContain('owner =');
    expect(() => parse(source)).not.toThrow();
  });
});

/** A scripted provider that returns each queued response in order. */
function scriptedProvider(responses: string[]): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  let index = 0;
  return {
    name: 'openai',
    calls,
    available: async () => true,
    generate: async (messages: AgentMessage[]) => {
      calls.push(messages);
      const response = responses[Math.min(index, responses.length - 1)] ?? '{}';
      index += 1;
      return response;
    },
  };
}

/** A two-model manifest where order_items lives at dev.order_items. */
function writeBugManifest(targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  const manifest = {
    metadata: { project_name: 'jaffle_shop' },
    nodes: {
      'model.jaffle_shop.order_items': {
        resource_type: 'model',
        name: 'order_items',
        schema: 'dev',
        original_file_path: 'models/marts/order_items.sql',
        config: { materialized: 'table' },
        tags: [],
        depends_on: { nodes: ['model.jaffle_shop.stg_orders'] },
        columns: { order_id: { name: 'order_id' }, amount: { name: 'amount' } },
        meta: {},
      },
      'model.jaffle_shop.stg_orders': {
        resource_type: 'model',
        name: 'stg_orders',
        schema: 'dev',
        original_file_path: 'models/staging/stg_orders.sql',
        config: { materialized: 'view' },
        tags: [],
        depends_on: { nodes: [] },
        columns: { order_id: { name: 'order_id' }, customer_id: { name: 'customer_id' } },
        meta: {},
      },
    },
    sources: {},
    exposures: {},
  };
  const path = join(targetDir, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
  return path;
}

/** Minimal dbt manifest so the engine has schema to ground offline fallbacks on. */
function writeDbtManifest(targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  const manifest = {
    metadata: { project_name: 'jaffle_shop' },
    nodes: {
      'model.jaffle_shop.fct_orders': {
        resource_type: 'model',
        name: 'fct_orders',
        schema: 'marts',
        database: 'analytics',
        description: 'Order-grain fact.',
        original_file_path: 'models/marts/fct_orders.sql',
        config: { materialized: 'table' },
        tags: [],
        depends_on: { nodes: [] },
        columns: { order_id: { name: 'order_id' }, amount: { name: 'amount' } },
        meta: {},
      },
    },
    sources: {},
    exposures: {},
  };
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  return join(targetDir, 'manifest.json');
}

describe('buildFromPrompt (spec 14, part B) — offline / deterministic', () => {
  let projectRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-build-prompt-'));
    writeFileSync(
      join(projectRoot, 'dql.config.json'),
      JSON.stringify({ project: 'p', identity: { owner: 'owner@example.com' } }),
      'utf-8',
    );
    manifestPath = writeDbtManifest(join(projectRoot, 'target'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("target:'cell' returns SQL and writes nothing", async () => {
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'show me total orders',
      target: 'cell',
      offline: true,
      dbtManifestPath: manifestPath,
    })) as BuildCellResult;

    expect(result.target).toBe('cell');
    expect(result.sql.trim().length).toBeGreaterThan(0);
    // Offline path grounds the starter query on the available schema.
    expect(result.sql).toContain('fct_orders');
    // Nothing written: no drafts directory created.
    expect(readdirSync(projectRoot)).not.toContain('blocks');
  });

  it("target:'cell' echoes the current cell SQL when provided (refine, not rewrite)", async () => {
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'add a filter',
      target: 'cell',
      offline: true,
      context: { cellSql: 'SELECT order_id FROM fct_orders' },
      dbtManifestPath: manifestPath,
    })) as BuildCellResult;
    expect(result.sql).toContain('SELECT order_id FROM fct_orders');
  });

  it("target:'block' writes a complete, parseable DRAFT with owner + semantic name", async () => {
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'Can you build the total orders by geography at the daily level?',
      target: 'block',
      offline: true,
      dbtManifestPath: manifestPath,
    })) as BuildBlockResult;

    expect(result.target).toBe('block');

    // Semantic name — NOT the raw prompt tokenized.
    expect(result.name).toBe('orders_by_geography_daily');
    expect(result.name).not.toContain('can_you_build');
    expect(result.name).toMatch(/^[a-z][a-z0-9_]*$/);

    // The draft file exists, parses, and is born status="draft" with an owner.
    const source = readFileSync(join(projectRoot, result.path), 'utf-8');
    expect(result.path).toContain('_drafts/');
    expect(source).toContain('status = "draft"');
    expect(source).not.toContain('status = "certified"');
    expect(source).toContain('owner = "owner@example.com"');
    expect(() => parse(source)).not.toThrow();

    // The whole project still parses with no parse diagnostics.
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics?.filter((d) => d.kind === 'parse')).toEqual([]);

    // Certifier verdict shape is returned, and "Missing owner" is NOT blocking.
    expect(result.certifierVerdict).toMatchObject({
      blocking: expect.any(Array),
      warnings: expect.any(Array),
      ready: expect.any(Boolean),
    });
    expect(result.certifierVerdict.blocking).not.toContain('Missing owner');

    // Preview fields are present for the frontend.
    expect(result.sqlPreview.trim().length).toBeGreaterThan(0);
    expect(typeof result.description).toBe('string');
    expect(Array.isArray(result.outputs)).toBe(true);
    expect(Array.isArray(result.examples)).toBe(true);
  });

  it("target:'block' resolves owner from explicit body.owner when given", async () => {
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'build revenue by month',
      target: 'block',
      offline: true,
      owner: 'override@example.com',
      dbtManifestPath: manifestPath,
    })) as BuildBlockResult;
    const source = readFileSync(join(projectRoot, result.path), 'utf-8');
    expect(source).toContain('owner = "override@example.com"');
  });

  it('rejects an empty prompt', async () => {
    await expect(
      buildFromPrompt({ projectRoot, prompt: '   ', target: 'cell', offline: true }),
    ).rejects.toThrow(/non-empty prompt/);
  });
});

describe('buildFromPrompt (spec 15) — grounded SQL accuracy', () => {
  let projectRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-build-grounding-'));
    writeFileSync(
      join(projectRoot, 'dql.config.json'),
      JSON.stringify({ project: 'p', identity: { owner: 'owner@example.com' } }),
      'utf-8',
    );
    manifestPath = writeBugManifest(join(projectRoot, 'target'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("cell: rewrites bare names to qualified relations (the FROM order_items bug)", async () => {
    // The model emits the reported bad SQL with BARE names.
    const provider = scriptedProvider([
      JSON.stringify({ sql: 'SELECT oi.amount FROM order_items oi JOIN stg_orders o ON oi.order_id = o.order_id' }),
    ]);
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'total amount per order joining order_items and stg_orders',
      target: 'cell',
      provider,
      dbtManifestPath: manifestPath,
    })) as BuildCellResult;

    // The resolver qualified both bare relations; validation passed in one shot.
    expect(result.sql).toContain('FROM dev.order_items');
    expect(result.sql).toContain('JOIN dev.stg_orders');
    expect(result.sql).not.toMatch(/FROM order_items\b/);
    // Only the initial generation call — no repair needed.
    expect(provider.calls.length).toBe(1);
  });

  it('cell: repairs a deliberate bare-name/unknown-column miss with a re-prompt', async () => {
    // First response references a column that does not exist; second fixes it.
    const provider = scriptedProvider([
      JSON.stringify({ sql: 'SELECT made_up_column FROM order_items' }),
      JSON.stringify({ sql: 'SELECT amount FROM order_items' }),
    ]);
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'show order amounts',
      target: 'cell',
      provider,
      dbtManifestPath: manifestPath,
    })) as BuildCellResult;

    // The repair re-prompt ran, and the corrected SQL is grounded + qualified.
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.sql).toContain('FROM dev.order_items');
    expect(result.sql).toContain('amount');
    expect(result.sql).not.toContain('made_up_column');
  });

  it('block: grounds SQL on {{ ref() }} form and passes validation', async () => {
    const provider = scriptedProvider([
      JSON.stringify({
        name: 'order_amounts',
        sql: 'SELECT order_id, amount FROM order_items',
        description: 'Amounts per order.',
        outputs: ['order_id', 'amount'],
        examples: ['What is the amount per order?'],
        entities: ['order'],
        invariants: [],
      }),
    ]);
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'amount per order',
      target: 'block',
      provider,
      dbtManifestPath: manifestPath,
    })) as BuildBlockResult;

    // Block SQL references the relation via the {{ ref() }} form.
    expect(result.sqlPreview).toContain("{{ ref('order_items') }}");
    expect(result.sqlPreview).not.toMatch(/FROM order_items\b/);
    expect(result.target).toBe('block');
  });

  it('uses a supplied context pack as the hard model and skill boundary', async () => {
    const provider = scriptedProvider([
      JSON.stringify({ sql: 'SELECT amount FROM stg_orders' }),
      JSON.stringify({ sql: 'SELECT amount FROM order_items' }),
    ]);
    const contextPack = {
      id: 'ctx_build_snapshot',
      mode: 'build',
      objects: [],
      skills: [{
        objectKey: 'sales::skill::margin-policy',
        id: 'margin-policy',
        qualifiedId: 'sales::skill::margin-policy',
        domain: 'sales',
        domains: ['sales'],
        modelAreaRefs: [],
        description: 'Use net amount for margin analysis.',
        triggers: ['margin'],
        exclusions: [],
        preferredMetrics: [],
        preferredBlocks: [],
        preferredDimensions: [],
        requiredFilters: [],
        clarifyWhen: [],
        vocabulary: {},
        guidance: 'Use net amount, not gross amount.',
        guidanceTruncated: false,
        sourceRefs: [],
        provenance: 'skills/sales/margin-policy.skill.md',
      }],
      allowedSqlContext: {
        relations: [{
          relation: 'dev.order_items',
          name: 'order_items',
          source: 'context snapshot',
          columns: [{ name: 'order_id' }, { name: 'amount' }],
        }],
        sourceBlockSql: [],
      },
      routeDecision: { route: 'generated_sql', intent: 'ad_hoc_ranking' },
      evidenceRoles: [{
        objectKey: 'dbt:model.order_items',
        objectType: 'dbt_model',
        name: 'order_items',
        role: 'dbt_model',
        reason: 'selected for this request',
      }],
      freshness: { catalogPath: 'metadata.sqlite', builtAt: null, fingerprint: 'snapshot_123' },
    } as unknown as LocalContextPack;

    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'show order amounts',
      target: 'cell',
      provider,
      dbtManifestPath: manifestPath,
      contextPack,
    })) as BuildCellResult;

    expect(provider.calls[0]?.[1]?.content).toContain('margin-policy');
    expect(provider.calls[0]?.[1]?.content).toContain('dev.order_items');
    expect(provider.calls[0]?.[1]?.content).not.toContain('dev.stg_orders');
    expect(provider.calls[0]?.[0]?.content).toContain('NOT governed relationship proof');
    expect(result.sql).toContain('FROM dev.order_items');
    expect(result.sql).not.toContain('stg_orders');
    expect(result.appliedSkills).toEqual([expect.objectContaining({
      id: 'margin-policy',
      provenance: 'skills/sales/margin-policy.skill.md',
    })]);
    expect(result.diagnostics).toMatchObject({
      sourceTrust: 'exploratory_dbt_grounded',
      reviewRequired: true,
      contextPackId: 'ctx_build_snapshot',
      snapshotId: 'snapshot_123',
      allowedRelations: ['dev.order_items'],
      joinPolicy: 'dbt_hints_are_not_governed_proof',
    });
  });

  it('rejects caller domain inputs that conflict with the server-resolved scope', async () => {
    await expect(buildFromPrompt({
      projectRoot,
      prompt: 'show order amounts',
      target: 'cell',
      offline: true,
      dbtManifestPath: manifestPath,
      domain: 'sales',
      domainContext: {
        activeDomain: 'finance',
        ancestors: [], descendants: [],
        allowedImports: [],
        source: 'explicit_api',
        confidence: 'high',
        snapshotId: 'snapshot_123',
      },
    })).rejects.toThrow(/does not match the server-resolved domain/i);
  });
});

describe('buildFromPrompt (spec 17, part A) — edit an existing block', () => {
  let projectRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-edit-block-'));
    writeFileSync(
      join(projectRoot, 'dql.config.json'),
      JSON.stringify({ project: 'p', identity: { owner: 'owner@example.com' } }),
      'utf-8',
    );
    manifestPath = writeDbtManifest(join(projectRoot, 'target'));
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeDraftBlock(relPath: string): string {
    const file = join(projectRoot, relPath);
    mkdirSync(join(projectRoot, relPath, '..'), { recursive: true });
    writeFileSync(
      file,
      `// dql-format: 1
block "orders_summary" {
  type = "custom"
  domain = "sales"
  status = "draft"
  description = "Order counts."
  owner = "owner@example.com"
  grain = "one row per day"
  outputs = ["order_count"]

  query = """
    SELECT COUNT(*) AS order_count FROM {{ ref('fct_orders') }}
  """
}
`,
      'utf-8',
    );
    return file;
  }

  it('edits in place: writes back to the SAME path, returns previousSql, no new draft', async () => {
    const relPath = 'blocks/orders_summary.dql';
    writeDraftBlock(relPath);
    const before = readdirSync(join(projectRoot, 'blocks'));

    const provider = scriptedProvider([
      JSON.stringify({
        sql: "SELECT COUNT(*) AS order_count, SUM(amount) AS revenue FROM {{ ref('fct_orders') }}",
        description: 'Order counts and revenue.',
        grain: 'one row per day',
        outputs: ['order_count', 'revenue'],
      }),
    ]);

    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'also include total revenue',
      target: 'block',
      mode: 'edit',
      blockPath: relPath,
      provider,
      dbtManifestPath: manifestPath,
    })) as BuildBlockResult;

    // Same path, marked edited, previousSql for the diff.
    expect(result.path).toBe(relPath);
    expect(result.edited).toBe(true);
    expect(result.previousSql).toMatch(/COUNT\(\*\) AS order_count/);
    expect(result.previousSql).not.toMatch(/revenue/i);

    // The change was applied + grounded to {{ ref() }}.
    const source = readFileSync(join(projectRoot, relPath), 'utf-8');
    expect(source).toMatch(/revenue/i);
    expect(source).toContain("{{ ref('fct_orders') }}");
    expect(() => parse(source)).not.toThrow();

    // Status preserved as draft; never certified by edit.
    expect(source).toContain('status = "draft"');
    expect(source).not.toContain('status = "certified"');

    // No NEW file forked — the blocks dir has exactly the same entries.
    expect(readdirSync(join(projectRoot, 'blocks'))).toEqual(before);
    expect(readdirSync(join(projectRoot, 'blocks'))).not.toContain('_drafts');
  });

  it('preserves a certified block as certified (requires re-cert, never auto-downgrades)', async () => {
    const relPath = 'blocks/certified_block.dql';
    const file = join(projectRoot, relPath);
    writeFileSync(
      file,
      `// dql-format: 1
block "certified_block" {
  type = "custom"
  domain = "sales"
  status = "certified"
  description = "Certified orders."
  owner = "owner@example.com"

  query = """
    SELECT COUNT(*) AS order_count FROM {{ ref('fct_orders') }}
  """
}
`,
      'utf-8',
    );

    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'add revenue',
      target: 'block',
      mode: 'edit',
      blockPath: relPath,
      offline: true,
      dbtManifestPath: manifestPath,
    })) as BuildBlockResult;

    expect(result.path).toBe(relPath);
    const source = readFileSync(file, 'utf-8');
    // Certified stays certified — the human must re-certify after the edit.
    expect(source).toContain('status = "certified"');
  });

  it('throws when the block to edit does not exist', async () => {
    await expect(
      buildFromPrompt({
        projectRoot,
        prompt: 'edit it',
        target: 'block',
        mode: 'edit',
        blockPath: 'blocks/missing.dql',
        offline: true,
        dbtManifestPath: manifestPath,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('buildFromPrompt in a database-only project (warehouse catalog, no dbt)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dql-build-warehouse-'));
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'w', manifestVersion: 3, modeling: { mode: 'warehouse-first' } }));
    mkdirSync(join(root, '.dql'), { recursive: true });
    writeFileSync(join(root, '.dql', 'warehouse-catalog.json'), JSON.stringify({
      version: 1, driver: 'duckdb', connectionId: 'default', scopes: [], capturedAt: '2026-10-01T00:00:00.000Z', fingerprint: 'x',
      relations: [{ id: 'warehouse.jaffle_shop.dev.order_items', database: 'jaffle_shop', schema: 'dev', name: 'order_items', relation: 'dev.order_items', kind: 'table', columns: [{ name: 'product_id', type: 'VARCHAR' }, { name: 'product_price', type: 'DECIMAL' }] }],
    }));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('grounds on the warehouse catalog (the model used to see no tables) and says when the SQL is only the starter template', async () => {
    const seen: string[] = [];
    const provider: AgentProvider = {
      name: 'claude',
      available: async () => true,
      generate: async (messages: AgentMessage[]) => {
        seen.push(messages.map((message) => message.content).join('\n'));
        return '{}';
      },
    } as unknown as AgentProvider;
    const result = await buildFromPrompt({ projectRoot: root, prompt: 'total revenue by product', target: 'block', provider }) as BuildBlockResult;
    expect(seen.join('\n')).toContain('dev.order_items');
    // The model answered with no SQL, so the draft is the template, and the result says so.
    expect(result.generation).toBe('offline_template');
    expect(result.sqlPreview).toContain('dev.order_items');
    expect(result.sqlPreview).not.toContain('placeholder');
  });
});
