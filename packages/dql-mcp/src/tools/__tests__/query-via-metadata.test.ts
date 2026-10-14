import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { deriveSlug, queryViaMetadata, queryViaMetadataInput } from '../query-via-metadata.js';
import { makeCtx } from './_helpers.js';

describe('deriveSlug', () => {
  it('drops stopwords + lowercases + snake_cases', () => {
    expect(deriveSlug('How many active customers in Q1?')).toBe('many_active_customers_q1');
  });

  it('produces the same slug on paraphrase that hits the same content tokens', () => {
    const a = deriveSlug('what was monthly revenue last month?');
    const b = deriveSlug('What was last month\'s monthly revenue?');
    // Token sets are: {monthly, revenue, last, month} for both. v1 keeps insertion order.
    expect(a).toContain('monthly_revenue');
    expect(b).toContain('monthly_revenue');
  });

  it('falls back to a sentinel for empty / pure-stopword inputs', () => {
    expect(deriveSlug('   the of  ')).toBe('untitled_proposal');
  });

  it('truncates very long questions', () => {
    const question = 'how many distinct customer ids placed at least one order ' +
      'each calendar month last year by region and channel and product type';
    expect(deriveSlug(question).length).toBeLessThanOrEqual(60);
  });
});

describe('queryViaMetadata — Tier-2 promotion loop entry point', () => {
  let tmpProject: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'dql-tier2-'));
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpProject, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function ctxFor(root: string) {
    return makeCtx({}, { projectRoot: root } as never);
  }

  it('accepts prior result and DQL artifact references in the public tool schema', () => {
    const parsed = z.object(queryViaMetadataInput).parse({
      question: 'include product details with previous results',
      followUp: {
        kind: 'contextual',
        sourceQuestion: 'give me the info of product and supply',
        priorResultColumns: ['product_id', 'supply_id', 'supply_name'],
        priorResultValues: {
          product_id: ['BEV-001'],
        },
        priorResultRef: {
          id: 'turn_1',
          question: 'give me the info of product and supply',
          columns: ['product_id', 'supply_id', 'supply_name'],
          rowCount: 65,
          sourceSql: 'SELECT product_id, supply_id, supply_name FROM SHOP.ANALYTICS.supplies',
        },
        priorDqlArtifact: {
          kind: 'sql_block',
          name: 'previous_product_supply',
          source: 'block "previous_product_supply" { query = """SELECT product_id, supply_id, supply_name FROM SHOP.ANALYTICS.supplies""" }',
          dimensions: ['product_id', 'supply_id', 'supply_name'],
          limit: 65,
        },
        priorLimit: 65,
        priorMeasures: ['supply_cost'],
      },
    });

    expect(parsed.followUp?.kind).toBe('contextual');
    expect(parsed.followUp?.priorResultRef?.sourceSql).toContain('SHOP.ANALYTICS.supplies');
    expect(parsed.followUp?.priorDqlArtifact?.kind).toBe('sql_block');
    expect(parsed.followUp?.priorResultValues?.product_id).toEqual(['BEV-001']);
  });

  it('executes the proposed SQL and surfaces uncertified=true on the happy path', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: { columns: [{ name: 'n', type: 'integer' }], rows: [{ n: 42 }], executionTime: 5 },
      }),
    } as unknown as Response)) as unknown as typeof fetch;

    const result = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'How many active customers last month?',
      proposedSql: 'SELECT COUNT(DISTINCT customer_id) AS n FROM fct_orders',
      proposedDomain: 'customer',
      proposedEntity: 'Customer',
      upstreamRefs: ['fct_orders'],
    });

    expect(result.uncertified).toBe(true);
    expect((result as { reviewStatus: string }).reviewStatus).toBe('draft_ready');
    expect((result as { trustStatus: { uncertified: boolean } }).trustStatus.uncertified).toBe(true);
    expect((result as { evidence: { planner: { mode: string; steps: string[] } } }).evidence.planner.mode).toBe('metadata_text_to_sql');
    expect((result as { evidence: { planner: { steps: string[] } } }).evidence.planner.steps).toContain('trust check');
    expect((result as { rowCount: number }).rowCount).toBe(1);
    expect((result as { returnedRowCount: number }).returnedRowCount).toBe(1);
    expect((result as { maxRowsReturned: number }).maxRowsReturned).toBe(200);
    expect((result as { rowsTruncated: boolean }).rowsTruncated).toBe(false);
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(String(call[1].body));
    expect(body.cell.source).toContain('SELECT * FROM (');
    expect(body.cell.source).toContain('LIMIT 200');
    expect(result.draftBlock?.path).toMatch(/blocks\/_drafts\/.*\.dql$/);
    expect(result.draftBlock?.proposedContractId).toBe(
      'customer.Customer.many_active_customers_last_month',
    );
    expect((result as {
      dqlArtifact: { kind: string; name: string; sourcePath?: string; source: string };
    }).dqlArtifact).toMatchObject({
      kind: 'sql_block',
      name: 'many_active_customers_last_month',
      sourcePath: result.draftBlock?.path,
    });
    expect((result as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('block "many_active_customers_last_month"');
    expect((result as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('status = "draft"');
    expect((result as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('query = """');
    expect((result as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('SELECT COUNT(DISTINCT customer_id) AS n FROM fct_orders');
    expect(result.promote).toContain('zlens certify --from-draft');
  });

  it('writes a draft .dql file with status=draft and the proposal metadata', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'What was monthly revenue last quarter?',
      proposedSql: 'SELECT month, revenue FROM fct_orders',
      proposedDomain: 'finance',
      proposedEntity: 'Order',
      outputs: ['month', 'revenue'],
    });

    const draftPath = join(tmpProject, out.draftBlock!.path);
    const content = readFileSync(draftPath, 'utf-8');
    expect(content).toContain('status = "draft"');
    expect(content).toContain('asked_times = 1');
    expect(content).toContain('outputs = ["month", "revenue"]');
    expect(content).toContain('proposed_contract_id = "finance.Order.monthly_revenue_last_quarter"');
    expect(content).toContain('What was monthly revenue last quarter?');
    expect((out as { dqlArtifact: { sourcePath?: string; source: string } }).dqlArtifact.sourcePath).toBe(out.draftBlock?.path);
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('outputs = ["month", "revenue"]');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('owner = "');
  });

  it('increments asked_times when the same question is asked again (dedupe via slug)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const ctx = ctxFor(tmpProject);
    const first = await queryViaMetadata(ctx, {
      question: 'how many active customers?',
      proposedSql: 'SELECT month, revenue FROM fct_orders',
    });
    const second = await queryViaMetadata(ctx, {
      question: 'how many active customers?',
      proposedSql: 'SELECT month, revenue FROM fct_orders',
    });
    expect(first.draftBlock?.askedTimes).toBe(1);
    expect(second.draftBlock?.askedTimes).toBe(2);

    const draftPath = join(tmpProject, second.draftBlock!.path);
    expect(readFileSync(draftPath, 'utf-8')).toContain('asked_times = 2');
  });

  it('skips the draft when saveDraft=false (one-off introspection)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'just curious',
      proposedSql: 'SELECT month, revenue FROM fct_orders',
      saveDraft: false,
    });
    expect(out.draftBlock).toBeUndefined();
    expect((out as { dqlArtifact: { kind: string; sourcePath?: string; source: string } }).dqlArtifact.kind).toBe('sql_block');
    expect((out as { dqlArtifact: { sourcePath?: string } }).dqlArtifact.sourcePath).toBeUndefined();
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('block "just_curious"');
  });

  it('returns the proposal without executing when dryRun=true', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'how many?',
      proposedSql: 'SELECT month, revenue FROM fct_orders',
      dryRun: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.uncertified).toBe(true);
    expect((out as { proposedSql: string }).proposedSql).toBe('SELECT month, revenue FROM fct_orders');
    expect((out as { trustStatus: { label: string; reviewStatus: string } }).trustStatus.label).toBe('AI-generated metadata research');
    expect((out as { evidence: { execution: { status: string } } }).evidence.execution.status).toBe('dry_run');
    expect(out.draftBlock).toBeDefined();
    expect((out as { dqlArtifact: { kind: string; sourcePath?: string; source: string } }).dqlArtifact).toMatchObject({
      kind: 'sql_block',
      sourcePath: out.draftBlock?.path,
    });
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('SELECT month, revenue FROM fct_orders');
  });

  it('flags a no-rows result as review-required (0-row honesty parity with the answer loop)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [{ name: 'month' }, { name: 'revenue' }], rows: [], executionTime: 3 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'revenue for a filter that matches nothing',
      proposedSql: 'SELECT month, revenue FROM fct_orders WHERE 1=0',
    });

    expect((out as { noRows: boolean }).noRows).toBe(true);
    expect((out as { reason: string }).reason).toMatch(/no rows/i);
    expect((out as { validationWarnings: string[] }).validationWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('returned no rows')]),
    );
  });

  it('returns selected relation reasoning when planning from metadata', async () => {
    seedNbaMetadataProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Show NBA player points by season',
    });

    expect(out.uncertified).toBe(true);
    expect((out as { planningOnly: boolean }).planningOnly).toBe(true);
    expect((out as { contextPack?: unknown }).contextPack).toBeUndefined();
    expect((out as { contextPackId?: string }).contextPackId).toBeTruthy();
    expect((out as { contextPackSummary?: { selectedRelations: unknown[] } }).contextPackSummary?.selectedRelations.length).toBeGreaterThan(0);
    expect((out as { selectedRelations: Array<{ relation: string; reason: string; columns: string[] }> }).selectedRelations[0]).toMatchObject({
      relation: expect.stringContaining('fct_player_performance'),
    });
    expect((out as { selectedRelations: Array<{ relation: string; reason: string; columns: string[] }> }).selectedRelations[0]?.reason).toMatch(/metric terms matched|dimension terms matched|relation shape/);
    expect((out as { selectedRelations: Array<{ relation: string; reason: string; columns: string[] }> }).selectedRelations[0]?.columns).toEqual(
      expect.arrayContaining(['player_name', 'season', 'total_points']),
    );
    expect((out as {
      evidence: {
        certifiedContext: {
          selectedRelations: Array<{ relation: string; reason: string; rank: number }>;
          selectedJoinPaths: Array<{ leftRelation: string; leftColumn: string; rightRelation: string; rightColumn: string }>;
        };
      };
    }).evidence.certifiedContext.selectedRelations[0]).toMatchObject({
      relation: expect.stringContaining('fct_player_performance'),
      rank: 1,
    });
  });

  it('uses prior result references to ground vague follow-up metadata plans', async () => {
    seedNbaMetadataProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Include more details with the previous results',
      followUp: {
        kind: 'drilldown',
        sourceQuestion: 'Who scored least points?',
        priorResultRef: {
          id: 'turn_1',
          question: 'Who scored least points?',
          columns: ['player_name', 'season', 'total_points'],
          rowCount: 10,
          sourceSql: 'SELECT player_name, season, total_points FROM NBA_DB.ANALYTICS.fct_player_performance ORDER BY total_points ASC LIMIT 10',
        },
        priorDqlArtifact: {
          kind: 'sql_block',
          name: 'least_points_previous_result',
          source: 'block "least_points_previous_result" { query = """SELECT player_name, season, total_points FROM NBA_DB.ANALYTICS.fct_player_performance ORDER BY total_points ASC LIMIT 10""" }',
          dimensions: ['player_name', 'season'],
          metrics: ['total_points'],
          limit: 10,
        },
      },
    });

    expect(out.uncertified).toBe(true);
    expect((out as { planningOnly: boolean }).planningOnly).toBe(true);
    expect((out as { selectedRelations: Array<{ relation: string; columns: string[] }> }).selectedRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: expect.stringContaining('fct_player_performance'),
          columns: expect.arrayContaining(['player_name', 'season', 'total_points']),
        }),
      ]),
    );
    expect((out as {
      evidence: {
        certifiedContext: {
          selectedRelations: Array<{ relation: string; columns: string[] }>;
        };
      };
    }).evidence.certifiedContext.selectedRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: expect.stringContaining('fct_player_performance'),
          columns: expect.arrayContaining(['player_name', 'season', 'total_points']),
        }),
      ]),
    );
  });

  it('persists prior DQL artifact provenance on generated metadata drafts', async () => {
    seedNbaMetadataProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Include more details with the previous results',
      proposedSql: 'SELECT player_name, season, total_points FROM NBA_DB.ANALYTICS.fct_player_performance ORDER BY total_points ASC LIMIT 10',
      dryRun: true,
      followUp: {
        kind: 'drilldown',
        sourceQuestion: 'Who scored least points?',
        priorDqlArtifact: {
          kind: 'sql_block',
          name: 'least_points_previous_result',
          source: 'block "least_points_previous_result" { query = """SELECT player_name, season, total_points FROM NBA_DB.ANALYTICS.fct_player_performance ORDER BY total_points ASC LIMIT 10""" }',
          dimensions: ['player_name', 'season'],
          metrics: ['total_points'],
          orderBy: [{ name: 'total_points', direction: 'asc' }],
          limit: 10,
        },
      },
    });

    expect((out as { reviewStatus: string }).reviewStatus).toBe('draft_ready');
    const draftPath = join(tmpProject, out.draftBlock!.path);
    const content = readFileSync(draftPath, 'utf-8');
    expect(content).toContain('source_question = "Who scored least points?"');
    expect(content).toContain('followup_kind = "drilldown"');
    expect(content).toContain('source_dql_kind = "sql_block"');
    expect(content).toContain('source_dql_name = "least_points_previous_result"');
    expect(content).toContain('source_dql_metrics = ["total_points"]');
    expect(content).toContain('source_dql_dimensions = ["player_name", "season"]');
    expect(content).toContain('source_dql_order_by = ["total_points asc"]');
    expect(content).toContain('source_dql_limit = 10');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('source_dql_name = "least_points_previous_result"');
  });

  it('returns selected join paths when planning needs related dbt models', async () => {
    seedNbaMetadataProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Show NBA player points by position',
    });

    expect(out.uncertified).toBe(true);
    expect((out as { planningOnly: boolean }).planningOnly).toBe(true);
    expect((out as {
      selectedJoinPaths: Array<{ leftRelation: string; leftColumn: string; rightRelation: string; rightColumn: string; reason: string; source?: string }>;
    }).selectedJoinPaths[0]).toMatchObject({
      leftRelation: expect.stringContaining('fct_player_performance'),
      leftColumn: 'player_id',
      rightRelation: expect.stringContaining('dim_players'),
      rightColumn: 'player_id',
      reason: expect.stringContaining('dbt lineage'),
      source: 'dbt_lineage',
    });
    expect((out as {
      evidence: {
        certifiedContext: {
          selectedJoinPaths: Array<{ leftColumn: string; rightColumn: string; reason: string; source?: string }>;
        };
      };
    }).evidence.certifiedContext.selectedJoinPaths[0]).toMatchObject({
      leftColumn: 'player_id',
      rightColumn: 'player_id',
      reason: expect.stringContaining('dbt lineage'),
      source: 'dbt_lineage',
    });
  });

  it('returns schema-shape candidates when planning over catalog-only dbt models', async () => {
    seedLargeDbtProfileProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Can you research Kevin Durant profile and provide complete stats',
    });

    expect(out.uncertified).toBe(true);
    expect((out as { planningOnly: boolean }).planningOnly).toBe(true);
    expect((out as {
      schemaShapeCandidates: Array<{ objectKey: string; relation: string; reason: string; columns: string[] }>;
    }).schemaShapeCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectKey: 'dbt:model:athlete_box_scores',
          relation: 'NBA_DB.ANALYTICS.athlete_box_scores',
          reason: expect.stringContaining('entity identifiers: athlete_name'),
          columns: expect.arrayContaining(['athlete_name', 'game_date', 'pts']),
        }),
      ]),
    );
    expect((out as {
      evidence: {
        certifiedContext: {
          schemaShapeCandidates: Array<{ objectKey: string; relation: string }>;
        };
      };
    }).evidence.certifiedContext.schemaShapeCandidates[0]).toMatchObject({
      objectKey: 'dbt:model:athlete_box_scores',
      relation: 'NBA_DB.ANALYTICS.athlete_box_scores',
    });
  });

  it('carries selected relation reasoning through dry-run evidence', async () => {
    seedNbaMetadataProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Who scored least points?',
      proposedSql: 'SELECT player_name, season, total_points FROM NBA_DB.ANALYTICS.fct_player_performance ORDER BY total_points ASC LIMIT 10',
      dryRun: true,
    });

    expect((out as { reviewStatus: string }).reviewStatus).toBe('draft_ready');
    expect((out as { contextPack?: unknown }).contextPack).toBeUndefined();
    expect((out as { contextPackId?: string }).contextPackId).toBeTruthy();
    expect((out as { contextPackSummary?: { selectedRelations: unknown[] } }).contextPackSummary?.selectedRelations.length).toBeGreaterThan(0);
    expect((out as {
      evidence: {
        certifiedContext: {
          selectedRelations: Array<{ relation: string; reason: string; columns: string[] }>;
        };
      };
    }).evidence.certifiedContext.selectedRelations[0]).toMatchObject({
      relation: expect.stringContaining('fct_player_performance'),
      columns: expect.arrayContaining(['player_name', 'season', 'total_points']),
    });
  });

  it('returns a structured grounding gap and suggested expansion for catalog relations outside the inspected context', async () => {
    seedOrderHeavySupplyProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Show order totals by order date',
      proposedSql: 'SELECT supply_id, supply_name FROM SHOP.ANALYTICS.supplies',
      dryRun: true,
    });

    expect(out.uncertified).toBe(true);
    expect((out as { reviewStatus: string }).reviewStatus).toBe('rejected');
    expect((out as { errorCode: string }).errorCode).toBe('unknown_relation');
    expect((out as { groundingGap: { code: string; offending?: { relation?: string } } }).groundingGap).toMatchObject({
      code: 'unknown_relation',
      offending: { relation: expect.stringMatching(/supplies/i) },
    });
    expect((out as {
      groundingGap: {
        suggestedExpansion: {
          relations: Array<{ relation: string; columns: Array<{ name: string }> }>;
        };
      };
    }).groundingGap.suggestedExpansion.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'SHOP.ANALYTICS.supplies',
          columns: expect.arrayContaining([
            expect.objectContaining({ name: 'supply_id' }),
            expect.objectContaining({ name: 'supply_name' }),
          ]),
        }),
      ]),
    );
    expect((out as { repairAction: { kind: string; hint: string } }).repairAction).toMatchObject({
      kind: 'retry',
      hint: expect.stringContaining('SHOP.ANALYTICS.supplies'),
    });
    expect((out as { contextPack?: unknown }).contextPack).toBeUndefined();
    expect((out as { contextPackId?: string }).contextPackId).toBeTruthy();
    expect((out as {
      contextPackSummary: {
        id: string;
        selectedRelations: Array<{ relation: string; columns: string[] }>;
      };
    }).contextPackSummary).toMatchObject({
      id: expect.any(String),
      selectedRelations: expect.any(Array),
    });
    expect((out as {
      repairBudget: {
        kind: string;
        attemptsUsed: number;
        maxAttempts: number;
        attemptsRemaining: number;
        nextTool: string;
      };
    }).repairBudget).toEqual({
      kind: 'reground',
      attemptsUsed: 0,
      maxAttempts: 1,
      attemptsRemaining: 1,
      nextTool: 'expand_context',
    });
    expect((out as {
      repairPlan: {
        reason: string;
        nextTool: string;
        contextPackId: string;
        relations: string[];
        retryTool: string;
        retryHint: string;
        budget: { attemptsRemaining: number };
      };
    }).repairPlan).toMatchObject({
      reason: 'allowed_context_gap',
      nextTool: 'expand_context',
      contextPackId: (out as { contextPackId: string }).contextPackId,
      relations: expect.arrayContaining(['SHOP.ANALYTICS.supplies']),
      retryTool: 'query_via_metadata',
      retryHint: expect.stringContaining('SHOP.ANALYTICS.supplies'),
      budget: { attemptsRemaining: 1 },
    });
    expect(out.draftBlock).toBeUndefined();
  });

  it('does not advertise another re-ground retry after the MCP tier-2 repair budget is exhausted', async () => {
    seedOrderHeavySupplyProject(tmpProject);

    const first = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Show order totals by order date',
      proposedSql: 'SELECT supply_id, supply_name FROM SHOP.ANALYTICS.supplies',
      dryRun: true,
    });
    const contextPackId = (first as { contextPackId: string }).contextPackId;
    expect(contextPackId).toBeTruthy();

    const second = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Show order totals by order date',
      contextPackId,
      proposedSql: 'SELECT missing_column FROM SHOP.ANALYTICS.supplies',
      dryRun: true,
      regroundAttemptsUsed: 1,
    });

    expect((second as { reviewStatus: string }).reviewStatus).toBe('rejected');
    expect((second as { repairAction?: unknown }).repairAction).toBeUndefined();
    expect((second as {
      repairBudget: {
        attemptsUsed: number;
        attemptsRemaining: number;
      };
    }).repairBudget).toMatchObject({
      attemptsUsed: 1,
      attemptsRemaining: 0,
    });
    expect((second as {
      repairPlan: {
        exhausted: boolean;
        nextTool: string;
        relations: string[];
        retryHint: string;
      };
    }).repairPlan).toMatchObject({
      exhausted: true,
      nextTool: 'inspect_metadata_context',
      relations: [],
      retryHint: expect.stringContaining('budget is exhausted'),
    });
  });

  it('reports a clear runtime-down error and still saves the draft for later', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'how many active customers?',
      proposedSql: 'SELECT month, revenue FROM fct_orders',
    });
    expect((out as { error: string }).error).toMatch(/Could not reach ZLens runtime/);
    expect(out.draftBlock).toBeDefined();
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('SELECT month, revenue FROM fct_orders');
  });

  it('honors the limit parameter on returned rows', async () => {
    seedNbaMetadataProject(tmpProject);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: { columns: [], rows: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }], executionTime: 1 },
      }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Show NBA player points by season',
      proposedSql: 'SELECT player_name, season, total_points FROM NBA_DB.ANALYTICS.fct_player_performance',
      limit: 2,
    });
    expect((out as { rows: unknown[] }).rows).toHaveLength(2);
    expect((out as { rowCount: number }).rowCount).toBe(4);
    expect((out as { returnedRowCount: number }).returnedRowCount).toBe(2);
    expect((out as { maxRowsReturned: number }).maxRowsReturned).toBe(2);
    expect((out as { rowsTruncated: boolean }).rowsTruncated).toBe(true);
    expect((out as { contextPack?: unknown }).contextPack).toBeUndefined();
    expect((out as { contextPackId?: string }).contextPackId).toBeTruthy();
    expect((out as { contextPackSummary?: { selectedRelations: unknown[] } }).contextPackSummary?.selectedRelations.length).toBeGreaterThan(0);
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(String(call[1].body));
    expect(body.cell.source).toContain('LIMIT 2');
  });

  it('bounds returned rows to 200 by default even if the runtime returns more', async () => {
    seedNbaMetadataProject(tmpProject);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          columns: [],
          rows: Array.from({ length: 250 }, (_, index) => ({ index })),
          executionTime: 1,
        },
      }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Show NBA player points by season',
      proposedSql: 'SELECT player_name, season, total_points FROM NBA_DB.ANALYTICS.fct_player_performance',
    });

    expect((out as { rowCount: number }).rowCount).toBe(250);
    expect((out as { returnedRowCount: number }).returnedRowCount).toBe(200);
    expect((out as { maxRowsReturned: number }).maxRowsReturned).toBe(200);
    expect((out as { rowsTruncated: boolean }).rowsTruncated).toBe(true);
    expect((out as { rows: unknown[] }).rows).toHaveLength(200);
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(String(call[1].body));
    expect(body.cell.source).toContain('LIMIT 200');
  });

  it('rejects unsafe SQL before execution or draft capture', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'delete bad data',
      proposedSql: 'DELETE FROM orders',
    });
    expect(out.uncertified).toBe(true);
    expect((out as { reviewStatus: string }).reviewStatus).toBe('rejected');
    expect((out as { error: string }).error).toContain('read-only SELECT or WITH');
    expect(out.draftBlock).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(tmpProject, 'blocks', '_drafts'))).toBe(false);
  });
});

function seedNbaMetadataProject(root: string): void {
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'nba_ops' }), 'utf-8');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(
    join(root, 'blocks', 'top_10_scorers.dql'),
    `block "Top 10 Scorers" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Top NBA players by total points scored."
  tags = ["nba", "player", "points", "scoring"]
  llmContext = "Use for top scorers. For bottom rankings, use this as context only."
  query = """
    SELECT player_name, season, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1, 2
    ORDER BY total_points DESC
    LIMIT 10
  """
}`,
    'utf-8',
  );
  writeFileSync(
    join(root, 'target', 'manifest.json'),
    JSON.stringify({
      metadata: { project_name: 'nba_analysis' },
      nodes: {
        'model.nba_analysis.fct_player_performance': {
          resource_type: 'model',
          name: 'fct_player_performance',
          alias: 'fct_player_performance',
          database: 'NBA_DB',
          schema: 'ANALYTICS',
          description: 'Player performance fact table with scoring, assists, and season grain.',
          depends_on: { nodes: ['model.nba_analysis.dim_players'] },
          tags: ['nba', 'player'],
          original_file_path: 'models/marts/fct_player_performance.sql',
          config: { materialized: 'table' },
          columns: {
            player_id: {
              name: 'player_id',
              data_type: 'text',
              description: 'Player identifier for joining to player attributes.',
            },
            player_name: {
              name: 'player_name',
              data_type: 'text',
              description: 'Player full name.',
            },
            season: {
              name: 'season',
              data_type: 'number',
              description: 'NBA season year.',
            },
            points: {
              name: 'points',
              data_type: 'number',
              description: 'Points scored in a game.',
            },
            total_points: {
              name: 'total_points',
              data_type: 'number',
              description: 'Aggregated points for a player and season.',
            },
          },
        },
        'model.nba_analysis.dim_players': {
          resource_type: 'model',
          name: 'dim_players',
          alias: 'dim_players',
          database: 'NBA_DB',
          schema: 'ANALYTICS',
          description: 'Player dimension table with profile attributes.',
          depends_on: { nodes: [] },
          tags: ['nba', 'player'],
          original_file_path: 'models/marts/dim_players.sql',
          config: { materialized: 'table' },
          columns: {
            player_id: {
              name: 'player_id',
              data_type: 'text',
              description: 'Player identifier.',
            },
            position: {
              name: 'position',
              data_type: 'text',
              description: 'Primary court position.',
            },
          },
        },
      },
      sources: {},
    }),
    'utf-8',
  );
}

function seedOrderHeavySupplyProject(root: string): void {
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'order_heavy_supply' }), 'utf-8');
  mkdirSync(join(root, 'target'), { recursive: true });
  const nodes: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < 80; index += 1) {
    nodes[`model.order_heavy_supply.order_events_${index}`] = {
      resource_type: 'model',
      name: `order_events_${index}`,
      alias: `order_events_${index}`,
      database: 'SHOP',
      schema: 'ANALYTICS',
      description: `Order totals by order date for retail operations ${index}.`,
      depends_on: { nodes: [] },
      tags: ['orders', 'totals'],
      original_file_path: `models/orders/order_events_${index}.sql`,
      config: { materialized: 'table' },
      columns: {
        order_id: { name: 'order_id', data_type: 'number' },
        order_date: { name: 'order_date', data_type: 'date' },
        order_total: { name: 'order_total', data_type: 'number' },
      },
    };
  }
  nodes['model.order_heavy_supply.supplies'] = {
    resource_type: 'model',
    name: 'supplies',
    alias: 'supplies',
    database: 'SHOP',
    schema: 'ANALYTICS',
    description: 'Supply rows linked to products for supply-chain analysis.',
    depends_on: { nodes: [] },
    tags: ['supplies'],
    original_file_path: 'models/supply/supplies.sql',
    config: { materialized: 'table' },
    columns: {
      supply_id: { name: 'supply_id', data_type: 'text' },
      product_id: { name: 'product_id', data_type: 'text' },
      supply_name: { name: 'supply_name', data_type: 'text' },
      supply_cost: { name: 'supply_cost', data_type: 'number' },
    },
  };
  writeFileSync(
    join(root, 'target', 'manifest.json'),
    JSON.stringify({
      metadata: { project_name: 'order_heavy_supply' },
      nodes,
      sources: {},
    }),
    'utf-8',
  );
}

function seedLargeDbtProfileProject(root: string): void {
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'large_dbt_profile' }), 'utf-8');
  mkdirSync(join(root, 'target'), { recursive: true });
  const nodes: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < 220; index += 1) {
    nodes[`model.large_dbt_profile.noisy_${index}`] = {
      resource_type: 'model',
      name: `noisy_${index}`,
      alias: `noisy_${index}`,
      database: 'NBA_DB',
      schema: 'ANALYTICS',
      description: `Unrelated model ${index} in a large dbt repo.`,
      depends_on: { nodes: [] },
      tags: ['noise'],
      original_file_path: `models/noisy/noisy_${index}.sql`,
      config: { materialized: 'table' },
      columns: {
        id: { name: 'id', data_type: 'number' },
        created_at: { name: 'created_at', data_type: 'timestamp' },
      },
    };
  }
  nodes['model.large_dbt_profile.athlete_box_scores'] = {
    resource_type: 'model',
    name: 'athlete_box_scores',
    alias: 'athlete_box_scores',
    database: 'NBA_DB',
    schema: 'ANALYTICS',
    description: 'Box score rows at game grain for each athlete.',
    depends_on: { nodes: [] },
    tags: ['profile', 'stats'],
    original_file_path: 'models/marts/athlete_box_scores.sql',
    config: { materialized: 'table' },
    columns: {
      athlete_name: {
        name: 'athlete_name',
        data_type: 'text',
        description: 'Name of the athlete.',
      },
      game_date: {
        name: 'game_date',
        data_type: 'date',
        description: 'Date of the game.',
      },
      pts: {
        name: 'pts',
        data_type: 'number',
        description: 'Points recorded.',
      },
      ast: {
        name: 'ast',
        data_type: 'number',
        description: 'Assists recorded.',
      },
      reb: {
        name: 'reb',
        data_type: 'number',
        description: 'Rebounds recorded.',
      },
    },
  };
  writeFileSync(
    join(root, 'target', 'manifest.json'),
    JSON.stringify({
      metadata: { project_name: 'large_dbt_profile' },
      nodes,
      sources: {},
    }),
    'utf-8',
  );
}
