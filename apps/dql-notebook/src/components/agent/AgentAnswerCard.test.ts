import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AgentAnswerCardModule from './AgentAnswerCard';

let resolveDqlArtifactMeta: typeof AgentAnswerCardModule.resolveDqlArtifactMeta;
let resolveAgentOutcome: typeof AgentAnswerCardModule.resolveAgentOutcome;
let formatCascadeOutcome: typeof AgentAnswerCardModule.formatCascadeOutcome;
let resolveAnswerTrustState: typeof AgentAnswerCardModule.resolveAnswerTrustState;

describe('AgentAnswerCard DQL artifact metadata', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./AgentAnswerCard');
    resolveDqlArtifactMeta = module.resolveDqlArtifactMeta;
    resolveAgentOutcome = module.resolveAgentOutcome;
    formatCascadeOutcome = module.formatCascadeOutcome;
    resolveAnswerTrustState = module.resolveAnswerTrustState;
  });

  it('renders the badge from the canonical trustLabelInfo (R2.1)', () => {
    // A certified-metric answer stamps canonical 'reviewed' -> UI 'review'.
    expect(resolveAnswerTrustState({ kind: 'uncertified', certification: 'ai_generated', reviewStatus: 'draft_ready', trustLabelInfo: { id: 'reviewed' } })).toBe('review');
    expect(resolveAnswerTrustState({ kind: 'uncertified', trustLabelInfo: { id: 'certified' } })).toBe('certified');
    expect(resolveAnswerTrustState({ kind: 'uncertified', trustLabelInfo: { id: 'ai_generated' } })).toBe('ai_generated');
    expect(resolveAnswerTrustState({ kind: 'no_answer', trustLabelInfo: { id: 'insufficient_context' } })).toBe('no_answer');
    // Legacy fallback still works when trustLabelInfo is absent.
    expect(resolveAnswerTrustState({ kind: 'certified', certification: 'certified' })).toBe('certified');
  });

  it('uses the effective host trust decision when legacy fields disagree', () => {
    expect(resolveAnswerTrustState({
      kind: 'uncertified',
      certification: 'governed',
      reviewStatus: 'governed',
      result: { trustState: 'review_required' },
    })).toBe('review');
    expect(resolveAnswerTrustState({
      kind: 'uncertified',
      trustState: 'governed',
      result: { trustState: 'governed' },
    })).toBe('reviewed');
  });

  it('normalizes semantic artifact metadata for the DQL tab', () => {
    const meta = resolveDqlArtifactMeta({
      kind: 'uncertified',
      text: 'Review required.',
      dqlArtifact: {
        kind: 'semantic_block',
        name: 'monthly_revenue',
        sourcePath: 'semantic-layer/blocks/revenue/monthly_revenue.yaml',
        source: '  block "monthly_revenue" {\n    type = "semantic"\n  }\n',
        metrics: ['total_revenue', ''],
        dimensions: ['channel'],
        filters: [{ dimension: 'channel', operator: 'equals', values: ['Online'] }],
        timeDimension: { name: 'order_date', granularity: 'month' },
        orderBy: [{ name: 'total_revenue', direction: 'desc' }],
        limit: 5,
      },
    });

    expect(meta).toEqual({
      kind: 'semantic_block',
      name: 'monthly_revenue',
      sourcePath: 'semantic-layer/blocks/revenue/monthly_revenue.yaml',
      source: 'block "monthly_revenue" {\n    type = "semantic"\n  }',
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      filters: ['channel equals Online'],
      timeDimension: 'order_date / month',
      orderBy: ['total_revenue desc'],
      limit: 5,
    });
  });

  it('does not expose an empty artifact panel without source', () => {
    expect(resolveDqlArtifactMeta({
      kind: 'uncertified',
      text: 'Review required.',
      dqlArtifact: { kind: 'sql_block', source: '   ' },
    })).toBeNull();
  });

  it('treats returned DQL artifacts as the primary generated review target', () => {
    const outcome = resolveAgentOutcome({
      kind: 'uncertified',
      text: 'Review required.',
      proposedSql: 'SELECT 1',
      dqlArtifact: {
        kind: 'sql_block',
        name: 'revenue_preview',
        source: 'block "revenue_preview" {\n  status = "draft"\n}',
      },
    }, {
      sql: 'SELECT 1',
      result: { columns: ['n'], rows: [{ n: 1 }], rowCount: 1 },
    });

    expect(outcome).toMatchObject({
      kind: 'create_dql_draft',
      label: 'Review DQL draft',
      nextAction: expect.stringContaining('Review DQL metadata'),
    });
  });

  it('labels SQL-only generated outputs as previews, not the default artifact', () => {
    const outcome = resolveAgentOutcome({
      kind: 'uncertified',
      text: 'Review required.',
      proposedSql: 'SELECT 1',
    }, {
      sql: 'SELECT 1',
      result: { columns: ['n'], rows: [{ n: 1 }], rowCount: 1 },
    });

    expect(outcome).toMatchObject({
      kind: 'generate_sql_cell',
      label: 'Review SQL preview',
      nextAction: expect.stringContaining('insert SQL only as a notebook preview'),
    });
  });

  it('formats cascade terminal lanes for answer provenance', () => {
    expect(formatCascadeOutcome({
      terminalLane: 'semantic',
      routeTier: 'semantic_metric',
      outcome: { lane: 'semantic' },
    })).toBe('Lane 2 semantic · Semantic metric');

    expect(formatCascadeOutcome({
      terminalLane: 'generated',
      routeTier: 'generated_sql',
      outcome: { lane: 'generated' },
    })).toBe('Lane 3 generated · Generated SQL');
  });
});
