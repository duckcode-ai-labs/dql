import { describe, expect, it } from 'vitest';
import { parseIntent } from '../intent.js';
import { buildVocabularyIndex } from '../vocabulary.js';
import { prepare } from './index.js';
import { readOnlyStatementProblem } from './exploratory.js';

describe('the last tier: SQL drafted from the schema when nothing governed prepares', () => {
  const vocabulary = buildVocabularyIndex({ relations: [{ schema: 'ada', name: 'ada_sfdc_opportunity', columns: [{ name: 'opportunity_id', dataType: 'VARCHAR' }, { name: 'amount', dataType: 'NUMBER' }, { name: 'stage_name', dataType: 'VARCHAR' }] }] });
  // A reading the governed tiers cannot prepare: a metric ref nothing binds physically.
  const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'lost opportunities', measures: [{ ref: 'column:ada.ada_sfdc_opportunity.opportunity_id', aggregation: 'count', scope: [{ ref: 'column:ada.ada_sfdc_opportunity.stage_name', op: 'eq', values: ['Closed Lost'] }] }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
  const draft = { sql: "SELECT COUNT(opportunity_id) AS lost FROM ada.ada_sfdc_opportunity WHERE stage_name = 'Closed Lost'", relations: ['ada.ada_sfdc_opportunity'], proof: ['validated against the catalog: it reads ada.ada_sfdc_opportunity'] };
  it('one read-only statement is required', () => {
    expect(readOnlyStatementProblem('SELECT 1')).toBeUndefined();
    expect(readOnlyStatementProblem('WITH x AS (SELECT 1) SELECT * FROM x;')).toBeUndefined();
    expect(readOnlyStatementProblem("SELECT * FROM t WHERE note = 'drop; table'")).toBeUndefined();
    expect(readOnlyStatementProblem('DELETE FROM t')).toContain('does not start with SELECT');
    expect(readOnlyStatementProblem('SELECT 1; DROP TABLE t')).toContain('more than one statement');
    expect(readOnlyStatementProblem('SELECT * FROM t; INSERT INTO t VALUES (1)')).toBeDefined();
    expect(readOnlyStatementProblem('SELECT * FROM t WHERE 1 = 1 UNION ALL SELECT 2 FROM t2 -- update')).toBeUndefined();
    expect(readOnlyStatementProblem('CREATE TABLE x AS SELECT 1')).toContain('does not start');
  });
  it('runs on its own when nothing governed prepares and automatic exploration is on, and the candidate is review-required', async () => {
    const result = await prepare({ intent, vocabulary, deps: { draftSql: async () => draft }, explorationAuto: true, question: 'how many lost opportunities' });
    // The relational tier prepares this reading itself (a count over a column), so the drafted tier is never needed here...
    const drafted = result.candidates.find((candidate) => candidate.tier === 'exploratory');
    const relational = result.candidates.find((candidate) => candidate.tier === 'relational');
    expect(relational ?? drafted).toBeDefined();
    // ...so force the case: an intent the composer refuses (a metric with no physical binding).
    const unbound = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:sales.lost_amount' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    const withMetric = buildVocabularyIndex({ metrics: [{ name: 'lost_amount', model: 'sales', aggregation: 'sum' }], relations: [{ schema: 'ada', name: 'ada_sfdc_opportunity', columns: [{ name: 'amount', dataType: 'NUMBER' }] }] });
    const forced = await prepare({ intent: unbound, vocabulary: withMetric, deps: { draftSql: async () => draft }, explorationAuto: true, question: 'lost amount' });
    expect(forced.chosen?.tier).toBe('exploratory');
    expect(forced.chosen?.trust).toBe('review_required');
    expect(forced.chosen?.sql).toContain('SELECT COUNT(opportunity_id)');
    expect(forced.chosen?.proof[0]).toContain('review-required');
    expect(forced.attempts.find((attempt) => attempt.tier === 'exploratory')?.outcome).toBe('prepared');
  });
  it('an unproven clause travels with the answer as a caveat instead of ending the turn', async () => {
    // The host ran its checks, could not see a stated value applied, and says
    // so. The statement is read-only and in scope, so the reader gets the
    // answer AND the doubt, rather than silence.
    const unbound = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:sales.lost_amount' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    const withMetric = buildVocabularyIndex({ metrics: [{ name: 'lost_amount', model: 'sales', aggregation: 'sum' }], relations: [{ schema: 'ada', name: 'ada_sfdc_opportunity', columns: [{ name: 'amount', dataType: 'NUMBER' }] }] });
    const unmet = ['it does not apply "Closed Lost" from the question'];
    const result = await prepare({ intent: unbound, vocabulary: withMetric, deps: { draftSql: async () => ({ ...draft, unmetChecks: unmet }) }, explorationAuto: true, question: 'lost amount' });
    expect(result.chosen?.tier).toBe('exploratory');
    expect(result.chosen?.trust).toBe('review_required');
    expect(result.chosen?.caveats).toEqual(unmet);
    expect(result.refusals.some((refusal) => refusal.code === 'exploration_check_failed')).toBe(false);
  });

  it('a check the host refused outright still ends the turn', async () => {
    const unbound = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:sales.lost_amount' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    const withMetric = buildVocabularyIndex({ metrics: [{ name: 'lost_amount', model: 'sales', aggregation: 'sum' }] });
    const refused = await prepare({ intent: unbound, vocabulary: withMetric, deps: { draftSql: async () => ({ refused: 'its join of a and b on id = id repeats the key on both sides' }) }, explorationAuto: true, question: 'lost amount' });
    expect(refused.candidates).toEqual([]);
    expect(refused.refusals.some((refusal) => refusal.code === 'exploration_check_failed')).toBe(true);
  });

  it('stays opt-in when automatic exploration is off; a failed or unsafe draft is a refusal, never an execution', async () => {
    const unbound = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:sales.lost_amount' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    const withMetric = buildVocabularyIndex({ metrics: [{ name: 'lost_amount', model: 'sales', aggregation: 'sum' }] });
    const optIn = await prepare({ intent: unbound, vocabulary: withMetric, deps: { draftSql: async () => draft }, explorationAuto: false, question: 'lost amount' });
    expect(optIn.candidates).toEqual([]);
    expect(optIn.refusals.some((refusal) => refusal.code === 'exploration_not_opted_in')).toBe(true);
    const failed = await prepare({ intent: unbound, vocabulary: withMetric, deps: { draftSql: async () => ({ error: 'the drafted SQL was not accepted: unknown relation sales.x' }) }, explorationAuto: true, question: 'lost amount' });
    expect(failed.candidates).toEqual([]);
    expect(failed.refusals.find((refusal) => refusal.tier === 'exploratory')?.code).toBe('exploration_failed');
    const unsafe = await prepare({ intent: unbound, vocabulary: withMetric, deps: { draftSql: async () => ({ ...draft, sql: 'DELETE FROM ada.ada_sfdc_opportunity' }) }, explorationAuto: true, question: 'lost amount' });
    expect(unsafe.candidates).toEqual([]);
    expect(unsafe.refusals.find((refusal) => refusal.tier === 'exploratory')?.code).toBe('exploration_not_read_only');
    const none = await prepare({ intent: unbound, vocabulary: withMetric, deps: {}, explorationAuto: true, question: 'lost amount' });
    expect(none.refusals.find((refusal) => refusal.tier === 'exploratory')?.code).toBe('exploration_unavailable');
  });
});
