import { describe, expect, it } from 'vitest';
import { extractBlockContract } from '../block-contract.js';
import { parseIntent, type AnalyticalIntentV1 } from '../intent.js';
import { buildVocabularyIndex } from '../vocabulary.js';
import { entails, prepareCertified } from './certified.js';
import { prepare } from './index.js';
import type { PrepareDeps } from './types.js';

const SQL = "SELECT region, COUNT(DISTINCT claim_id) AS open_claims FROM claims WHERE status = 'open' GROUP BY region";
const blockRef = 'block:claims.open_claims_by_region';

// The status dimension is named differently from the physical column the block filters on.
const vocabulary = buildVocabularyIndex({
  metrics: [{ name: 'claim_count', model: 'claims', aggregation: 'count_distinct', physical: { relation: 'claims', expr: '"claims"."claim_id"', aggregate: 'count_distinct' } }],
  dimensions: [
    { name: 'region', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'region' } },
    { name: 'claim_status', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'status' } },
    { name: 'channel', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'channel' } },
  ],
  blocks: [{ name: 'open_claims_by_region', domain: 'claims', certified: true, sql: SQL, contract: extractBlockContract({ name: 'open_claims_by_region', domain: 'claims', sql: SQL }) }],
});

const asked = (filters: Array<{ ref: string; op?: string; values: string[] }>): AnalyticalIntentV1 => {
  const parsed = parseIntent({
    version: 1, kind: 'analytics', reading: 'How many open claims are there by region?', display: [], unresolved: [], provenance: {}, expectedShape: 'breakdown',
    measures: [{ ref: 'metric:claims.claim_count' }],
    groupBy: [{ ref: 'dimension:claims.region', role: 'categorical' }],
    filters: filters.map((filter) => ({ op: 'eq', source: 'question', ...filter })),
  });
  if (!parsed.intent) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  return parsed.intent;
};

const deps: PrepareDeps = { joinPath: () => undefined, blockSql: (ref) => vocabulary.get(ref)?.sql };
const status = (values: string[], op = 'eq') => ({ ref: 'dimension:claims.claim_status', op, values });

describe('a question filter that equals the block literal filter entails it', () => {
  it('exact text "open" on the status dimension is served as the certified block', () => {
    const prepared = prepareCertified(asked([status(['open'])]), vocabulary, deps);
    expect(prepared.refusals).toEqual([]);
    expect(prepared.candidates[0]).toMatchObject({ tier: 'certified', trust: 'certified', sourceRef: blockRef });
  });

  it('the same value written as a one-member set, or in another case, entails too', () => {
    expect(entails(vocabulary.get(blockRef)!, asked([status(['open'], 'in')]), vocabulary).ok).toBe(true);
    expect(entails(vocabulary.get(blockRef)!, asked([status(['OPEN'])]), vocabulary).ok).toBe(true);
  });

  it('a different value is not used and the sentence says which rows differ', () => {
    const verdict = entails(vocabulary.get(blockRef)!, asked([status(['closed'])]), vocabulary);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.join(' ')).toMatch(/only counts rows where status = 'open', which the question did not ask for/);
  });

  it('a filter on a different column, or an extra unmatched filter, still refuses', () => {
    expect(entails(vocabulary.get(blockRef)!, asked([{ ref: 'dimension:claims.channel', op: 'eq', values: ['open'] }]), vocabulary).ok).toBe(false);
    const extra = entails(vocabulary.get(blockRef)!, asked([status(['open']), { ref: 'dimension:claims.channel', op: 'eq', values: ['web'] }]), vocabulary);
    expect(extra.ok).toBe(false);
    expect(extra.missing.join(' ')).toMatch(/does not accept a filter on channel/);
  });
});

describe('the refusal sentence is recorded for every block_not_applicable path', () => {
  it('a value the block does not filter on: the sentence names the block and the filter', () => {
    const prepared = prepareCertified(asked([status(['closed'])]), vocabulary, deps);
    expect(prepared.candidates).toEqual([]);
    expect(prepared.refusals[0]).toMatchObject({ tier: 'certified', code: 'block_not_applicable' });
    expect(prepared.refusals[0]!.message).toMatch(/^block:claims\.open_claims_by_region: .*status = 'open'/);
  });

  it('with more than two reasons the generic refusal still carries them', () => {
    const many = asked([{ ref: 'dimension:claims.channel', op: 'eq', values: ['web'] }, { ref: 'dimension:claims.claim_status', op: 'eq', values: ['closed'] }]);
    const prepared = prepareCertified(many, vocabulary, deps);
    expect(prepared.refusals).toHaveLength(1);
    expect(prepared.refusals[0]!.message).toMatch(/block:claims\.open_claims_by_region: /);
    expect(prepared.refusals[0]!.message).toMatch(/does not accept a filter on channel/);
  });

  it('an unbindable block says why', () => {
    const prepared = prepareCertified(asked([status(['open'])]), vocabulary, { ...deps, prepareBlock: () => ({ error: 'no value for region', parameters: [], unresolved: ['region'] }) as never });
    expect(prepared.refusals[0]!.message).toBe('block:claims.open_claims_by_region: its parameters could not be bound: no value for region');
  });

  it('the tier attempt in the trace carries the sentence next to the code', async () => {
    const result = await prepare({ intent: asked([status(['closed'])]), vocabulary, deps, explorationOptIn: false, explorationAuto: false });
    const certified = result.attempts.find((attempt) => attempt.tier === 'certified');
    expect(certified?.outcome).toBe('refused');
    expect(certified?.detail).toMatch(/^block_not_applicable: block:claims\.open_claims_by_region: .*status = 'open'/);
  });
});
