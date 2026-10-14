import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, parse } from '@zlens/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProposePreview, propose, proposePlan } from './propose.js';

/**
 * Small synthetic dbt project: a staging model, a customer dimension, an orders
 * fact (with measures + time), and a daily-revenue aggregate referenced by an
 * exposure. catalog.json adds warehouse types; run_results.json adds run counts.
 */
function writeDbtArtifacts(targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });

  const manifest = {
    metadata: { project_name: 'jaffle_shop' },
    nodes: {
      'model.jaffle_shop.stg_orders': {
        resource_type: 'model',
        name: 'stg_orders',
        schema: 'staging',
        database: 'analytics',
        description: '',
        original_file_path: 'models/staging/stg_orders.sql',
        config: { materialized: 'view' },
        tags: [],
        depends_on: { nodes: ['source.jaffle_shop.raw.orders'] },
        columns: { order_id: { name: 'order_id' } },
        meta: {},
      },
      'model.jaffle_shop.dim_customers': {
        resource_type: 'model',
        name: 'dim_customers',
        schema: 'marts',
        database: 'analytics',
        description: 'One row per customer with lifetime attributes.',
        original_file_path: 'models/marts/dim_customers.sql',
        config: { materialized: 'table' },
        tags: ['core'],
        depends_on: { nodes: ['model.jaffle_shop.stg_orders'] },
        columns: {
          customer_id: { name: 'customer_id', description: 'Customer surrogate key.' },
          customer_name: { name: 'customer_name' },
        },
        meta: {},
      },
      'model.jaffle_shop.fct_orders': {
        resource_type: 'model',
        name: 'fct_orders',
        schema: 'marts',
        database: 'analytics',
        description: 'Order-grain fact with amounts.',
        original_file_path: 'models/marts/fct_orders.sql',
        config: { materialized: 'table' },
        tags: ['core'],
        depends_on: {
          nodes: ['model.jaffle_shop.stg_orders', 'model.jaffle_shop.dim_customers'],
        },
        columns: {
          order_id: { name: 'order_id' },
          order_date: { name: 'order_date' },
          amount: { name: 'amount' },
        },
        meta: {},
      },
      'model.jaffle_shop.agg_daily_revenue': {
        resource_type: 'model',
        name: 'agg_daily_revenue',
        schema: 'marts',
        database: 'analytics',
        description: 'Daily revenue rollup.',
        original_file_path: 'models/marts/agg_daily_revenue.sql',
        config: { materialized: 'table' },
        tags: [],
        depends_on: { nodes: ['model.jaffle_shop.fct_orders'] },
        columns: {
          revenue_date: { name: 'revenue_date' },
          total_revenue: { name: 'total_revenue' },
        },
        meta: {},
      },
    },
    sources: {
      'source.jaffle_shop.raw.orders': {
        name: 'orders',
        identifier: 'orders',
        schema: 'raw',
        database: 'analytics',
        tags: [],
      },
    },
    exposures: {
      'exposure.jaffle_shop.exec_dashboard': {
        name: 'exec_dashboard',
        depends_on: { nodes: ['model.jaffle_shop.agg_daily_revenue'] },
      },
    },
  };
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');

  const catalog = {
    nodes: {
      'model.jaffle_shop.dim_customers': {
        columns: {
          customer_id: { name: 'customer_id', type: 'INTEGER' },
          customer_name: { name: 'customer_name', type: 'VARCHAR' },
        },
      },
      'model.jaffle_shop.fct_orders': {
        columns: {
          order_id: { name: 'order_id', type: 'INTEGER' },
          order_date: { name: 'order_date', type: 'DATE' },
          amount: { name: 'amount', type: 'DECIMAL' },
        },
      },
    },
  };
  writeFileSync(join(targetDir, 'catalog.json'), JSON.stringify(catalog), 'utf-8');

  const runResults = {
    results: [
      { unique_id: 'model.jaffle_shop.fct_orders' },
      { unique_id: 'model.jaffle_shop.fct_orders' },
      { unique_id: 'model.jaffle_shop.agg_daily_revenue' },
    ],
  };
  writeFileSync(join(targetDir, 'run_results.json'), JSON.stringify(runResults), 'utf-8');

  return join(targetDir, 'manifest.json');
}

describe('zlens propose engine', () => {
  let projectRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    manifestPath = writeDbtArtifacts(join(projectRoot, 'target'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('proposes a SELECTIVE, business-only queue of parseable DRAFT blocks', () => {
    const summary = propose({ projectRoot, dbtManifestPath: manifestPath, owner: 'me@example.com' });

    expect(summary.projectName).toBe('jaffle_shop');
    // All 4 models are scanned (cheap pass) but only the 3 business models are generated.
    expect(summary.modelsScanned).toBe(4);
    expect(summary.businessModels).toBe(3);
    expect(summary.plumbingExcluded).toBe(1);
    expect(summary.draftsWritten).toBe(3);

    // The staging model is plumbing → EXCLUDED from generation entirely.
    const generated = summary.proposals.map((p) => p.model);
    expect(generated).not.toContain('stg_orders');
    expect(generated).toContain('dim_customers');
    expect(generated).toContain('fct_orders');
    expect(generated).toContain('agg_daily_revenue');

    // Every written draft is valid DQL and lands in a draft folder.
    for (const proposal of summary.proposals) {
      expect(proposal.path).toBeDefined();
      expect(proposal.path).toContain('_drafts/');
      const source = readFileSync(join(projectRoot, proposal.path!), 'utf-8');
      expect(() => parse(source)).not.toThrow();
    }

    // The whole project still parses with no parse diagnostics.
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics?.filter((d) => d.kind === 'parse')).toEqual([]);

    // Ranking: exposure-linked aggregate carries its demand signals.
    const agg = summary.proposals.find((p) => p.model === 'agg_daily_revenue')!;
    expect(agg.ranking.exposureLinked).toBe(true);
    expect(agg.ranking.runCount).toBe(1);
    expect(agg.classification).toBe('business');
  });

  it('infers conservative grain / pattern / outputs and stores certifier results', () => {
    const summary = propose({ projectRoot, dbtManifestPath: manifestPath });

    const dim = summary.proposals.find((p) => p.model === 'dim_customers')!;
    expect(dim.inference.grain).toBe('customer_id');
    expect(dim.inference.pattern).toBe('entity_profile');
    expect(dim.inference.declaredOutputs).toEqual(['customer_id', 'customer_name']);
    expect(dim.inference.invariants).not.toContain('row_count >= 0');
    expect(dim.inference.invariants).toEqual([]);
    expect(dim.inference.examples.map((example) => example.question)).toContain('How many customers are there?');
    expect(dim.inference.examples.every((example) => !/model contain/i.test(example.question))).toBe(true);

    const fct = summary.proposals.find((p) => p.model === 'fct_orders')!;
    expect(fct.inference.grain).toBe('order_id');
    expect(fct.inference.pattern).toBe('entity_rollup');
    expect(fct.inference.declaredOutputs).toEqual(['order_id', 'order_date', 'amount']);

    const agg = summary.proposals.find((p) => p.model === 'agg_daily_revenue')!;
    expect(agg.inference.grain).toBeUndefined();
    expect(agg.inference.pattern).toBe('trend');

    // Every proposal carries a stored, NON-certified verdict with details.
    for (const proposal of summary.proposals) {
      expect(proposal.certification.certified).toBe(false);
    }
  });

  it('NEVER writes a certified block — all drafts are status="draft"', () => {
    propose({ projectRoot, dbtManifestPath: manifestPath });

    for (const model of ['dim_customers', 'fct_orders', 'agg_daily_revenue']) {
      const path = join(projectRoot, 'blocks', '_drafts', `${model}.dql`);
      const source = readFileSync(path, 'utf-8');
      expect(source).toContain('status = "draft"');
      expect(source).not.toContain('status = "certified"');
      expect(source).toContain('NOT certified');
    }
    // The plumbing staging model is never written.
    expect(existsSync(join(projectRoot, 'blocks', '_drafts', 'stg_orders.dql'))).toBe(false);
  });

  it('is idempotent — re-running writes nothing new and never duplicates', () => {
    const first = propose({ projectRoot, dbtManifestPath: manifestPath });
    expect(first.draftsWritten).toBe(3);

    const second = propose({ projectRoot, dbtManifestPath: manifestPath });
    expect(second.draftsWritten).toBe(0);
    expect(second.draftsSkipped).toBe(3);
    for (const proposal of second.proposals) {
      expect(proposal.skipped).toBeDefined();
    }
  });

  it('does not re-propose a model the human already promoted to a canonical path', () => {
    propose({ projectRoot, dbtManifestPath: manifestPath });
    rmSync(join(projectRoot, 'blocks', '_drafts', 'dim_customers.dql'));
    writeFileSync(join(projectRoot, 'blocks', 'dim_customers.dql'), '// promoted', 'utf-8');

    const rerun = propose({ projectRoot, dbtManifestPath: manifestPath });
    const dim = rerun.proposals.find((p) => p.model === 'dim_customers')!;
    expect(dim.skipped).toBeDefined();
    expect(readFileSync(join(projectRoot, 'blocks', 'dim_customers.dql'), 'utf-8')).toBe('// promoted');
  });

  it('writes drafts under the domain-first folder when a matching domain dir exists', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.nodes['model.jaffle_shop.dim_customers'].meta = { domain: 'finance' };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });

    const summary = propose({ projectRoot, dbtManifestPath: manifestPath });
    const dim = summary.proposals.find((p) => p.model === 'dim_customers')!;
    expect(dim.domain).toBe('finance');
    expect(dim.path).toBe('domains/finance/blocks/_drafts/dim_customers.dql');
    expect(existsSync(join(projectRoot, dim.path!))).toBe(true);
  });

  it('honors --limit and dry-run (over the selective queue)', () => {
    const dry = propose({ projectRoot, dbtManifestPath: manifestPath, dryRun: true });
    expect(dry.draftsWritten).toBe(3); // "would write" count (business-only)
    expect(existsSync(join(projectRoot, 'blocks', '_drafts'))).toBe(false);

    const limited = propose({ projectRoot, dbtManifestPath: manifestPath, limit: 2 });
    expect(limited.draftsWritten).toBe(2);
    expect(limited.draftsSkipped).toBe(1);
  });

  it('restricts generation to an approved onlySlugs scope (still business-only)', () => {
    const summary = propose({
      projectRoot,
      dbtManifestPath: manifestPath,
      onlySlugs: ['dim_customers'],
    });
    expect(summary.draftsWritten).toBe(1);
    expect(summary.proposals.map((p) => p.model)).toEqual(['dim_customers']);
    expect(existsSync(join(projectRoot, 'blocks', '_drafts', 'dim_customers.dql'))).toBe(true);
    expect(existsSync(join(projectRoot, 'blocks', '_drafts', 'fct_orders.dql'))).toBe(false);
  });

  it('never generates plumbing even when an approved slug names a plumbing model', () => {
    const summary = propose({
      projectRoot,
      dbtManifestPath: manifestPath,
      onlySlugs: ['stg_orders'],
    });
    expect(summary.draftsWritten).toBe(0);
    expect(summary.proposals).toEqual([]);
  });

  it('applies AI enrichment (enrichedBySlug) over deterministic content; structure stays deterministic', () => {
    const enrichedBySlug = new Map([
      ['dim_customers', {
        description: 'Curated customer profile for revenue questions.',
        llmContext: 'AI-written: use for customer-grain questions; one row per customer.',
        examples: ['How many active customers are there?', 'Top customers by lifetime value?'],
      }],
    ]);
    const summary = propose({
      projectRoot,
      dbtManifestPath: manifestPath,
      onlySlugs: ['dim_customers'],
      enrichedBySlug,
    });
    const dim = summary.proposals.find((p) => p.model === 'dim_customers')!;
    const source = readFileSync(join(projectRoot, dim.path!), 'utf-8');
    // llmContext + examples are enriched (they're only templated deterministically).
    expect(source).toContain('AI-written: use for customer-grain questions');
    expect(source).toContain('How many active customers are there?');
    // But a real dbt description is authoritative — it wins over the AI one.
    expect(source).toContain('One row per customer with lifetime attributes');
    expect(source).not.toContain('Curated customer profile for revenue questions.');
    // Structure is still deterministic (grain/status unchanged).
    expect(source).toContain('grain = "customer_id"');
    expect(source).toContain('status = "draft"');
  });
});

describe('classifier cascade precedence', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-cascade-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  function manifestWith(nodes: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    const targetDir = join(projectRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    const manifest = { metadata: { project_name: 'p' }, nodes, sources: {}, exposures: {}, ...extra };
    const path = join(targetDir, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest), 'utf-8');
    return path;
  }

  it('meta.dql.business wins over a plumbing folder/name', () => {
    const path = manifestWith({
      'model.p.stg_promoted': {
        resource_type: 'model',
        name: 'stg_promoted',
        original_file_path: 'models/staging/stg_promoted.sql',
        config: {},
        tags: [],
        depends_on: { nodes: [] },
        columns: { id: { name: 'id' } },
        meta: { dql: { business: true } },
      },
    });
    const summary = propose({ projectRoot, dbtManifestPath: path });
    const m = summary.proposals.find((p) => p.model === 'stg_promoted')!;
    expect(m.classification).toBe('business');
    expect(m.evidence[0]).toMatch(/meta\.dql\.business/);
  });

  it('meta.dql.business=false demotes a marts-folder model to plumbing', () => {
    const path = manifestWith({
      'model.p.mart_excluded': {
        resource_type: 'model',
        name: 'mart_excluded',
        original_file_path: 'models/marts/mart_excluded.sql',
        config: {},
        tags: [],
        depends_on: { nodes: [] },
        columns: { id: { name: 'id' } },
        meta: { dql: { business: false } },
      },
    });
    const plan = proposePlan(projectRoot, path);
    expect(plan.totals.businessModels).toBe(0);
    expect(plan.totals.plumbingExcluded).toBe(1);
    expect(plan.willGenerate).toBe(0);
  });

  it('exposure linkage outranks a plumbing name', () => {
    const path = manifestWith(
      {
        'model.p.stg_in_exposure': {
          resource_type: 'model',
          name: 'stg_in_exposure',
          original_file_path: 'models/staging/stg_in_exposure.sql',
          config: {},
          tags: [],
          depends_on: { nodes: [] },
          columns: { id: { name: 'id' } },
          meta: {},
        },
      },
      {
        exposures: {
          'exposure.p.dash': { name: 'dash', depends_on: { nodes: ['model.p.stg_in_exposure'] } },
        },
      },
    );
    const summary = propose({ projectRoot, dbtManifestPath: path });
    const m = summary.proposals.find((p) => p.model === 'stg_in_exposure')!;
    expect(m.classification).toBe('business');
    expect(m.evidence).toContain('feeds a dbt exposure');
  });

  it('folder classifies when no meta/exposure/semantic signal exists', () => {
    const path = manifestWith({
      'model.p.reporting_widget': {
        resource_type: 'model',
        name: 'reporting_widget',
        original_file_path: 'models/reporting/reporting_widget.sql',
        config: {},
        tags: [],
        depends_on: { nodes: [] },
        columns: { id: { name: 'id' } },
        meta: {},
      },
      'model.p.base_thing': {
        resource_type: 'model',
        name: 'base_thing',
        original_file_path: 'models/base/base_thing.sql',
        config: {},
        tags: [],
        depends_on: { nodes: [] },
        columns: { id: { name: 'id' } },
        meta: {},
      },
    });
    const plan = proposePlan(projectRoot, path);
    expect(plan.totals.businessModels).toBe(1); // reporting/
    expect(plan.totals.plumbingExcluded).toBe(1); // base/
    expect(plan.domains.flatMap((d) => d.candidates).map((c) => c.model)).toEqual(['reporting_widget']);
  });

  it('tag classification beats a name fallback', () => {
    const path = manifestWith({
      'model.p.weird_name': {
        resource_type: 'model',
        name: 'weird_name',
        original_file_path: 'models/zone/weird_name.sql',
        config: {},
        tags: ['reporting'],
        depends_on: { nodes: [] },
        columns: { id: { name: 'id' } },
        meta: {},
      },
    });
    const summary = propose({ projectRoot, dbtManifestPath: path });
    expect(summary.proposals.find((p) => p.model === 'weird_name')!.classification).toBe('business');
  });

  it('name prefix is the LAST resort (no other signal)', () => {
    const path = manifestWith({
      'model.p.stg_lonely': {
        resource_type: 'model',
        name: 'stg_lonely',
        original_file_path: 'models/zone/stg_lonely.sql',
        config: {},
        tags: [],
        depends_on: { nodes: [] },
        columns: { id: { name: 'id' } },
        meta: {},
      },
      'model.p.dim_lonely': {
        resource_type: 'model',
        name: 'dim_lonely',
        original_file_path: 'models/zone/dim_lonely.sql',
        config: {},
        tags: [],
        depends_on: { nodes: [] },
        columns: { id: { name: 'id' } },
        meta: {},
      },
    });
    const plan = proposePlan(projectRoot, path);
    expect(plan.totals.plumbingExcluded).toBe(1); // stg_
    expect(plan.totals.businessModels).toBe(1); // dim_
  });
});

describe('config overrides', () => {
  let projectRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-config-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    manifestPath = writeDbtArtifacts(join(projectRoot, 'target'));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('maxPerDomain bounds the per-domain selection', () => {
    // Force everything into one domain via folder=marts and cap at 1.
    const summary = propose({
      projectRoot,
      dbtManifestPath: manifestPath,
      config: { maxPerDomain: 1 },
    });
    const byDomain = new Map<string, number>();
    for (const p of summary.proposals) byDomain.set(p.domain, (byDomain.get(p.domain) ?? 0) + 1);
    for (const count of byDomain.values()) expect(count).toBeLessThanOrEqual(1);
  });

  it('businessLayers/excludeLayers overrides flip classification', () => {
    // Treat "staging" as business and "marts" as plumbing.
    const plan = proposePlan(projectRoot, manifestPath, {
      config: { businessLayers: ['staging'], excludeLayers: ['marts'] },
    });
    const generated = plan.domains.flatMap((d) => d.candidates).map((c) => c.model);
    expect(generated).toContain('stg_orders');
    // dim_customers is marts-folder; with marts as excludeLayer it should be plumbing.
    // (fct_orders / agg are still exposure/semantic-free here, so folder governs.)
    expect(generated).not.toContain('dim_customers');
  });

  it('minScore filters low-demand candidates out of the selection', () => {
    const high = propose({ projectRoot, dbtManifestPath: manifestPath, config: { minScore: 1000 } });
    expect(high.draftsWritten).toBe(0);
  });
});

describe('proposePlan (deterministic, writes nothing)', () => {
  let projectRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-plan-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    manifestPath = writeDbtArtifacts(join(projectRoot, 'target'));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('returns a plan and writes nothing to disk', () => {
    const plan = proposePlan(projectRoot, manifestPath);

    expect(plan.totals.modelsScanned).toBe(4);
    expect(plan.totals.businessModels).toBe(3);
    expect(plan.totals.plumbingExcluded).toBe(1);
    expect(plan.willGenerate).toBe(3);
    expect(plan.willSkip).toBe(1);
    expect(plan.domains.flatMap((d) => d.candidates)).toHaveLength(3);

    // Each candidate has human-readable evidence + cheap hints.
    for (const candidate of plan.domains.flatMap((d) => d.candidates)) {
      expect(candidate.classification).toBe('business');
      expect(candidate.evidence.length).toBeGreaterThan(0);
    }

    // The plan must never write any draft files.
    expect(existsSync(join(projectRoot, 'blocks', '_drafts'))).toBe(false);
    expect(existsSync(join(projectRoot, 'blocks'))).toBe(false);
  });

  it('is deterministic — same input yields an identical plan', () => {
    const a = proposePlan(projectRoot, manifestPath);
    const b = proposePlan(projectRoot, manifestPath);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('buildProposePreview (spec 14, part A — transparent preview)', () => {
  let projectRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-preview-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    manifestPath = writeDbtArtifacts(join(projectRoot, 'target'));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('fills the preview fields for a single slug with REAL SQL (not select-*)', () => {
    const candidate = buildProposePreview(projectRoot, manifestPath, 'dim_customers', {
      owner: 'owner@example.com',
    });
    expect(candidate).toBeDefined();
    // Real narrowed projection over declared outputs — grain column leads.
    expect(candidate!.sqlPreview).toBeDefined();
    expect(candidate!.sqlPreview).toContain('customer_id');
    expect(candidate!.sqlPreview).not.toMatch(/SELECT \* FROM/i);
    expect(candidate!.outputs).toEqual(['customer_id', 'customer_name']);
    expect(candidate!.grain).toBe('customer_id');
    expect(typeof candidate!.description).toBe('string');
    expect(Array.isArray(candidate!.examples)).toBe(true);
  });

  it('returns a certifierVerdict of the contract shape with owner stamped', () => {
    const candidate = buildProposePreview(projectRoot, manifestPath, 'fct_orders', {
      owner: 'owner@example.com',
    });
    expect(candidate!.certifierVerdict).toMatchObject({
      blocking: expect.any(Array),
      warnings: expect.any(Array),
      ready: expect.any(Boolean),
    });
    // Owner stamped → "Missing owner" is never a blocking strike.
    expect(candidate!.certifierVerdict!.blocking).not.toContain('Missing owner');
  });

  it('writes NOTHING (preview only)', () => {
    buildProposePreview(projectRoot, manifestPath, 'fct_orders', { owner: 'o@e.com' });
    expect(existsSync(join(projectRoot, 'blocks'))).toBe(false);
    expect(existsSync(join(projectRoot, 'blocks', '_drafts'))).toBe(false);
  });

  it('returns undefined for a slug outside the bounded business selection', () => {
    // stg_orders is plumbing — never part of the selection.
    expect(buildProposePreview(projectRoot, manifestPath, 'stg_orders')).toBeUndefined();
    expect(buildProposePreview(projectRoot, manifestPath, 'no_such_model')).toBeUndefined();
  });

  it('produces a metric/aggregation-shaped SQL for a metric-backed model', () => {
    // agg_daily_revenue has a measure column + time → trend projection over outputs.
    const candidate = buildProposePreview(projectRoot, manifestPath, 'agg_daily_revenue', {
      owner: 'o@e.com',
    });
    expect(candidate!.sqlPreview).toContain('total_revenue');
    expect(candidate!.sqlPreview).not.toMatch(/SELECT \* FROM/i);
  });
});

describe('large synthetic manifest — bounded + cheap', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-large-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  /**
   * Generate ~1200 nodes across mixed meta / folders / tags / exposures so the
   * cascade and bounded selection are exercised at scale. Staging dominates so
   * the business slice is a small fraction of the scanned set.
   */
  function writeLargeManifest(): string {
    const targetDir = join(projectRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    const nodes: Record<string, unknown> = {};
    const exposures: Record<string, unknown> = {};

    const domains = ['finance', 'marketing', 'product', 'ops'];
    // 1000 staging (plumbing) + 200 marts (business across 4 domains).
    for (let i = 0; i < 1000; i++) {
      const id = `model.p.stg_${i}`;
      nodes[id] = {
        resource_type: 'model',
        name: `stg_${i}`,
        original_file_path: `models/staging/stg_${i}.sql`,
        config: {},
        tags: [],
        depends_on: { nodes: [] },
        columns: { id: { name: `id` } },
        meta: {},
      };
    }
    for (let i = 0; i < 200; i++) {
      const domain = domains[i % domains.length];
      const id = `model.p.mart_${i}`;
      nodes[id] = {
        resource_type: 'model',
        name: `mart_${i}`,
        original_file_path: `models/marts/${domain}/mart_${i}.sql`,
        config: {},
        tags: [],
        depends_on: { nodes: [] },
        columns: { entity_id: { name: 'entity_id' }, amount: { name: 'amount' } },
        meta: { domain },
      };
      // Give a handful of them exposures so demand-scoring varies.
      if (i % 25 === 0) {
        exposures[`exposure.p.e_${i}`] = { name: `e_${i}`, depends_on: { nodes: [id] } };
      }
    }

    const path = join(targetDir, 'manifest.json');
    writeFileSync(
      path,
      JSON.stringify({ metadata: { project_name: 'big' }, nodes, sources: {}, exposures }),
      'utf-8',
    );
    return path;
  }

  it('scans all but generates a small bounded business-only seed', () => {
    const manifestPath = writeLargeManifest();
    const summary = propose({ projectRoot, dbtManifestPath: manifestPath, config: { maxPerDomain: 8 } });

    expect(summary.modelsScanned).toBe(1200);
    expect(summary.plumbingExcluded).toBe(1000); // all staging excluded
    expect(summary.businessModels).toBe(200);

    // Bounded: 4 domains × maxPerDomain 8 = 32 generated, far less than scanned.
    expect(summary.draftsWritten).toBe(32);
    expect(summary.draftsWritten).toBeLessThan(summary.modelsScanned / 10);

    // Per-domain bound holds.
    const byDomain = new Map<string, number>();
    for (const p of summary.proposals) byDomain.set(p.domain, (byDomain.get(p.domain) ?? 0) + 1);
    for (const count of byDomain.values()) expect(count).toBeLessThanOrEqual(8);

    // No staging model is ever generated.
    expect(summary.proposals.every((p) => !p.model.startsWith('stg_'))).toBe(true);
  });

  it('plan reports the bounded scope and writes nothing at scale', () => {
    const manifestPath = writeLargeManifest();
    const plan = proposePlan(projectRoot, manifestPath, { config: { maxPerDomain: 5 } });
    expect(plan.totals.modelsScanned).toBe(1200);
    expect(plan.willGenerate).toBe(20); // 4 domains × 5
    expect(plan.willSkip).toBe(1180);
    expect(existsSync(join(projectRoot, 'blocks'))).toBe(false);
  });
});

describe('Slice 2 — business-block SQL generation', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-gen-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  /**
   * A metric-backed mart (`orders` with a `revenue` SUM measure + a time
   * dimension and primary entity) and a plain dimension mart (`dim_customers`).
   * Semantic metrics/models use the ARRAY shape of semantic_manifest.json.
   */
  function writeSemanticManifest(): string {
    const targetDir = join(projectRoot, 'target');
    mkdirSync(targetDir, { recursive: true });

    const manifest = {
      metadata: { project_name: 'sem' },
      nodes: {
        'model.sem.orders': {
          resource_type: 'model',
          name: 'orders',
          original_file_path: 'models/marts/orders.sql',
          config: {},
          tags: [],
          depends_on: { nodes: [] },
          columns: {
            order_id: { name: 'order_id' },
            order_date: { name: 'order_date' },
            revenue: { name: 'revenue' },
          },
          meta: {},
        },
        'model.sem.dim_customers': {
          resource_type: 'model',
          name: 'dim_customers',
          original_file_path: 'models/marts/dim_customers.sql',
          config: {},
          tags: [],
          depends_on: { nodes: [] },
          columns: {
            customer_id: { name: 'customer_id' },
            customer_name: { name: 'customer_name' },
            customer_type: { name: 'customer_type' },
          },
          meta: {},
        },
      },
      sources: {},
      exposures: {},
    };
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');

    const semantic = {
      semantic_models: [
        {
          name: 'orders',
          node_relation: { alias: 'orders' },
          entities: [{ name: 'order_id', type: 'primary' }],
          dimensions: [{ name: 'order_date', type: 'time' }],
          measures: [{ name: 'revenue', agg: 'sum', expr: 'revenue' }],
        },
      ],
      metrics: [
        {
          name: 'total_revenue',
          description: 'Total order revenue.',
          type: 'simple',
          type_params: { measure: { name: 'revenue' } },
        },
      ],
    };
    writeFileSync(join(targetDir, 'semantic_manifest.json'), JSON.stringify(semantic), 'utf-8');
    return join(targetDir, 'manifest.json');
  }

  it('metric-backed model yields a canonical metric-bound semantic block', () => {
    const manifestPath = writeSemanticManifest();
    const summary = propose({ projectRoot, dbtManifestPath: manifestPath });

    const orders = summary.proposals.find((p) => p.model === 'orders')!;
    expect(orders.classification).toBe('business');
    expect(orders.inference.pattern).toBe('metric_wrapper');
    expect(summary.metricsFound).toBe(1);

    const source = readFileSync(join(projectRoot, orders.path!), 'utf-8');
    // The semantic block stores meaning only. The shared compiler owns SQL, so
    // every surface sees the same metrics/dimensions form without an embedded query.
    expect(source).toMatch(/type\s*=\s*"semantic"/i);
    expect(source).toMatch(/metrics\s*=\s*\["total_revenue"\]/i);
    expect(source).toMatch(/dimensions\s*=\s*\["order_date"\]/i);
    expect(source).not.toMatch(/\bmetric\s*=/i);
    expect(source).not.toMatch(/\bquery\s*=/i);
  });

  it('entity/dim mart yields a NARROWED projection (not SELECT *)', () => {
    const manifestPath = writeSemanticManifest();
    const summary = propose({ projectRoot, dbtManifestPath: manifestPath });

    const dim = summary.proposals.find((p) => p.model === 'dim_customers')!;
    const source = readFileSync(join(projectRoot, dim.path!), 'utf-8');
    // Narrowed projection over the declared outputs, grain first.
    expect(source).not.toMatch(/SELECT \* FROM/i);
    expect(source).toContain('customer_id');
    expect(source).toContain('customer_name');
    expect(source).toContain('customer_type');
    // Grain column leads the projection.
    expect(source).toMatch(/SELECT\s+customer_id/);
  });

  it('generated business blocks still parse + compile', () => {
    const manifestPath = writeSemanticManifest();
    const summary = propose({ projectRoot, dbtManifestPath: manifestPath });

    for (const proposal of summary.proposals) {
      const source = readFileSync(join(projectRoot, proposal.path!), 'utf-8');
      expect(() => parse(source)).not.toThrow();
    }
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics?.filter((d) => d.kind === 'parse')).toEqual([]);
  });
});
