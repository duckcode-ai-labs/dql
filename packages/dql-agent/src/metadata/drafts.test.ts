import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, parse } from '@zlens/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveGeneratedDraftSlug, deriveSemanticDraftName, upsertGeneratedDqlArtifactDraft, upsertGeneratedDraft } from './drafts.js';

describe('generated draft blocks', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-generated-draft-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'drafts' }), 'utf-8');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes parseable DQL with flat Tier-2 review metadata', () => {
    const draft = upsertGeneratedDraft(projectRoot, {
      slug: 'enterprise_revenue_by_week',
      question: 'Break revenue down by Enterprise week',
      proposedSql: `
        SELECT week_start, SUM(revenue) AS revenue
        FROM main.revenue_events
        WHERE segment = 'Enterprise'
        GROUP BY 1
      `,
      proposedContractId: 'finance.Revenue.enterprise_revenue_by_week',
      proposedDomain: 'finance',
      proposedEntity: 'Revenue',
      upstreamRefs: ['revenue_total'],
      sourceDqlArtifact: {
        kind: 'semantic_block',
        name: 'certified_revenue_by_week',
        sourcePath: 'semantic-layer/blocks/revenue/certified_revenue_by_week.dql',
        source: 'block "certified_revenue_by_week" {\n  type = "semantic"\n  metric = "revenue"\n}',
        metrics: ['revenue'],
        dimensions: ['week'],
        filters: [
          { dimension: 'segment', operator: 'equals', values: ['Enterprise'] },
          { dimension: 'week', operator: 'equals', values: ['last week'] },
        ],
        timeDimension: { name: 'week', granularity: 'week' },
        orderBy: [{ name: 'revenue', direction: 'desc' }],
        limit: 10,
      },
      sourceQuestion: 'What was revenue last week?',
      sourceBlock: 'revenue_total',
      followupKind: 'drilldown',
      requestedFilters: ['Enterprise', 'last week'],
      requestedDimensions: ['week'],
      outputs: ['week_start', 'revenue'],
      contextPackId: 'ctx_test',
      routeIntent: 'entity_drilldown',
      validationWarnings: ['review_required'],
    });

    const source = readFileSync(join(projectRoot, draft.path), 'utf-8');

    expect(source).toContain('// Tier-2 generated proposal');
    expect(source).not.toContain('# Tier-2');
    expect(source).toContain('outputs = ["week_start", "revenue"]');
    expect(source).toContain('source_dql_kind = "semantic_block"');
    expect(source).toContain('source_dql_name = "certified_revenue_by_week"');
    expect(source).toContain('source_dql_path = "semantic-layer/blocks/revenue/certified_revenue_by_week.dql"');
    expect(source).toMatch(/source_dql_hash = "[a-f0-9]{64}"/);
    expect(source).toContain('source_dql_metrics = ["revenue"]');
    expect(source).toContain('source_dql_dimensions = ["week"]');
    expect(source).toContain('source_dql_filters = ["segment=Enterprise", "week=last week"]');
    expect(source).toContain('source_dql_time_dimension = "week"');
    expect(source).toContain('source_dql_granularity = "week"');
    expect(source).toContain('source_dql_order_by = ["revenue desc"]');
    expect(source).toContain('source_dql_limit = 10');
    expect(() => parse(source)).not.toThrow();

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics?.filter((diagnostic) => diagnostic.kind === 'parse')).toEqual([]);
    expect(manifest.blocks.enterprise_revenue_by_week?.declaredOutputs).toEqual(['week_start', 'revenue']);
    expect(manifest.blocks.enterprise_revenue_by_week?.draftMetadata).toMatchObject({
      sourceQuestion: 'What was revenue last week?',
      sourceBlock: 'revenue_total',
      sourceDqlKind: 'semantic_block',
      sourceDqlName: 'certified_revenue_by_week',
      sourceDqlPath: 'semantic-layer/blocks/revenue/certified_revenue_by_week.dql',
      sourceDqlHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceDqlMetrics: ['revenue'],
      sourceDqlDimensions: ['week'],
      sourceDqlFilters: ['segment=Enterprise', 'week=last week'],
      sourceDqlTimeDimension: 'week',
      sourceDqlGranularity: 'week',
      sourceDqlOrderBy: ['revenue desc'],
      sourceDqlLimit: 10,
      followupKind: 'drilldown',
      requestedFilters: ['Enterprise', 'last week'],
      requestedDimensions: ['week'],
      contextPackId: 'ctx_test',
      routeIntent: 'entity_drilldown',
      askedTimes: 1,
      validationWarnings: ['review_required'],
    });
  });

  it('writes generated drafts under the domain-first draft folder when the domain exists', () => {
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });

    const draft = upsertGeneratedDraft(projectRoot, {
      slug: 'enterprise_revenue_by_week',
      question: 'Break revenue down by Enterprise week',
      proposedSql: 'SELECT 1 AS revenue',
      proposedContractId: 'finance.Revenue.enterprise_revenue_by_week',
      proposedDomain: 'finance',
      proposedEntity: 'Revenue',
    });

    expect(draft.path).toBe('domains/finance/blocks/_drafts/enterprise_revenue_by_week.dql');

    const source = readFileSync(join(projectRoot, draft.path), 'utf-8');
    expect(source).toContain('zlens certify --from-draft domains/finance/blocks/_drafts/enterprise_revenue_by_week.dql');
    expect(() => parse(source)).not.toThrow();

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.blocks.enterprise_revenue_by_week?.filePath).toBe(draft.path);
    expect(manifest.blocks.enterprise_revenue_by_week?.draftMetadata?.askedTimes).toBe(1);
  });

  it('persists semantic DQL artifacts without wrapping them as custom SQL drafts', () => {
    const draft = upsertGeneratedDqlArtifactDraft(projectRoot, {
      slug: 'monthly_revenue_by_channel',
      question: 'Show monthly revenue by channel',
      proposedContractId: 'finance.Unknown.monthly_revenue_by_channel',
      proposedDomain: 'finance',
      dqlArtifact: {
        kind: 'semantic_block',
        source: `block "monthly_revenue_by_channel" {
  status = "draft"
  domain = "finance"
  type = "semantic"
  description = "Show monthly revenue by channel"
  metric = "total_revenue"
  dimensions = ["channel"]
  time_dimension = "order_date"
  granularity = "month"
}`,
        metrics: ['total_revenue'],
        dimensions: ['channel'],
      },
      contextPackId: 'ctx_semantic',
      routeIntent: 'ad_hoc_breakdown',
      outputs: ['channel', 'order_date_month', 'total_revenue'],
      validationWarnings: ['semantic_draft_review_required'],
    });

    const source = readFileSync(join(projectRoot, draft.path), 'utf-8');

    expect(source).toContain('type = "semantic"');
    expect(source).toContain('metric = "total_revenue"');
    expect(source).toContain('dimensions = ["channel"]');
    expect(source).toContain('owner = "');
    expect(source).toContain('asked_times = 1');
    expect(source).toContain('context_pack_id = "ctx_semantic"');
    expect(source).toContain('outputs = ["channel", "order_date_month", "total_revenue"]');
    expect(source).toContain('validation_warnings = ["semantic_draft_review_required"]');
    expect(source).not.toContain('type = "custom"');
    expect(source).not.toContain('query = """');
    expect(() => parse(source)).not.toThrow();

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics?.filter((diagnostic) => diagnostic.kind === 'parse')).toEqual([]);
    expect(manifest.blocks.monthly_revenue_by_channel?.filePath).toBe(draft.path);
    expect(manifest.blocks.monthly_revenue_by_channel?.draftMetadata?.askedTimes).toBe(1);
  });
});

describe('semantic draft naming (spec 14, part D)', () => {
  const QUESTION = 'Can you build the total orders by geography at the daily level?';

  it('never names a block after the literal question', () => {
    const name = deriveSemanticDraftName({ question: QUESTION });
    expect(name).not.toBe(deriveGeneratedDraftSlug(QUESTION));
    expect(name).not.toContain('can_you_build');
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('rule-based extraction yields entity + key dimension + grain', () => {
    const name = deriveSemanticDraftName({ question: QUESTION });
    expect(name).toBe('orders_by_geography_daily');
  });

  it('prefers a valid provider-suggested snake_case name', () => {
    const name = deriveSemanticDraftName({
      question: QUESTION,
      providerName: 'orders_by_region_daily',
    });
    expect(name).toBe('orders_by_region_daily');
  });

  it('coerces a loosely-formatted provider name into snake_case', () => {
    const name = deriveSemanticDraftName({
      question: QUESTION,
      providerName: 'Orders By Region',
    });
    expect(name).toBe('orders_by_region');
  });

  it('dedupes against existing slugs', () => {
    const name = deriveSemanticDraftName({
      question: QUESTION,
      providerName: 'orders_by_region_daily',
      existingSlugs: ['orders_by_region_daily'],
    });
    expect(name).toBe('orders_by_region_daily_2');
  });

  it('falls back to the legacy tokenizer only when no entity is recognizable', () => {
    const question = 'Give me a widget breakdown by sprocket';
    const name = deriveSemanticDraftName({ question });
    // No recognized entity → legacy tokenizer, but still valid + deduped.
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(name.length).toBeGreaterThan(0);
  });
});
