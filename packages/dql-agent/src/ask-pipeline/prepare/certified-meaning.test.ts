import { describe, expect, it } from 'vitest';
import { extractBlockContract, type BlockDeclarationLike } from '../block-contract.js';
import { parseIntent, type AnalyticalIntentV1 } from '../intent.js';
import { buildVocabularyIndex, type VocabularySource } from '../vocabulary.js';
import { entails, prepareCertified } from './certified.js';
import type { PrepareDeps } from './types.js';

/**
 * A certified block answers a question when it computes the same thing as the
 * metric the question resolved to, whatever its output column is called.
 */

const OPEN_CLAIMS_SQL = "SELECT region, COUNT(DISTINCT claim_id) AS open_claims FROM claims WHERE status = 'open' GROUP BY region";

const vocabularyFor = (block: Omit<BlockDeclarationLike, 'name'> & { name?: string }, metrics?: VocabularySource['metrics']) => {
  const name = block.name ?? 'open_claims_by_region';
  const source: VocabularySource = {
    metrics: metrics ?? [
      { name: 'claim_count', model: 'claims', aggregation: 'count_distinct', physical: { relation: 'claims', expr: '"claims"."claim_id"', aggregate: 'count_distinct' } },
      { name: 'claim_rows', model: 'claims', aggregation: 'count', physical: { relation: 'claims', expr: '"claims"."claim_id"', aggregate: 'count' } },
      { name: 'open_claim_count', model: 'claims', aggregation: 'count_distinct', physical: { relation: 'claims', expr: `CASE WHEN "claims"."status" = 'open' THEN "claims"."claim_id" END`, aggregate: 'count_distinct' } },
    ],
    dimensions: [
      { name: 'region', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'region' } },
      { name: 'status', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'status' } },
      { name: 'channel', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'channel' } },
    ],
    blocks: [{ name, domain: 'claims', certified: true, sql: block.sql, contract: extractBlockContract({ ...block, name, domain: 'claims' }) }],
  };
  return buildVocabularyIndex(source);
};

const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
  const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'How many open claims are there by region?', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'breakdown', ...raw });
  if (!parsed.intent) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  return parsed.intent;
};

const openByRegion = (metric = 'metric:claims.claim_count', status = 'open') => intent({
  measures: [{ ref: metric }],
  groupBy: [{ ref: 'dimension:claims.region', role: 'categorical' }],
  filters: [{ ref: 'dimension:claims.status', op: 'eq', values: [status], source: 'question' }],
});

const blockRef = 'block:claims.open_claims_by_region';
const verdictFor = (sql: string, asked: AnalyticalIntentV1, extra: Partial<BlockDeclarationLike> = {}) => {
  const vocabulary = vocabularyFor({ sql, ...extra });
  return entails(vocabulary.get(blockRef)!, asked, vocabulary);
};

describe('a certified block answers by meaning, not by measure name', () => {
  it('open_claims = COUNT(DISTINCT claim_id) WHERE status = open answers claim_count + status = open by region', () => {
    const verdict = verdictFor(OPEN_CLAIMS_SQL, openByRegion());
    expect(verdict.missing).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('is served as the certified candidate, naming the block', () => {
    const vocabulary = vocabularyFor({ sql: OPEN_CLAIMS_SQL });
    const deps: PrepareDeps = { joinPath: () => undefined, blockSql: (ref) => vocabulary.get(ref)?.sql };
    const prepared = prepareCertified(openByRegion(), vocabulary, deps);
    expect(prepared.refusals).toEqual([]);
    expect(prepared.candidates).toHaveLength(1);
    expect(prepared.candidates[0]).toMatchObject({ tier: 'certified', trust: 'certified', sourceRef: blockRef });
  });

  it('a metric that carries the same filter in its own definition matches without the question restating it', () => {
    const verdict = verdictFor(OPEN_CLAIMS_SQL, intent({ measures: [{ ref: 'metric:claims.open_claim_count' }], groupBy: [{ ref: 'dimension:claims.region', role: 'categorical' }] }));
    expect(verdict.missing).toEqual([]);
  });

  it('a different filter does not match, and the trace says which rows differ', () => {
    const verdict = verdictFor(OPEN_CLAIMS_SQL, openByRegion('metric:claims.claim_count', 'closed'));
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.join(' ')).toMatch(/only counts rows where status = 'open', which the question did not ask for/);
  });

  it('a block restricted to rows the question never mentioned does not match', () => {
    const verdict = verdictFor(OPEN_CLAIMS_SQL, intent({ measures: [{ ref: 'metric:claims.claim_count' }], groupBy: [{ ref: 'dimension:claims.region', role: 'categorical' }] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.join(' ')).toMatch(/status = 'open'/);
  });

  it('a different grain does not match', () => {
    const verdict = verdictFor("SELECT region, channel, COUNT(DISTINCT claim_id) AS open_claims FROM claims WHERE status = 'open' GROUP BY region, channel", openByRegion());
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.join(' ')).toMatch(/breaks the answer down by channel, which the question did not ask for/);
    const total = verdictFor(OPEN_CLAIMS_SQL, intent({ measures: [{ ref: 'metric:claims.claim_count' }], filters: [{ ref: 'dimension:claims.status', op: 'eq', values: ['open'], source: 'question' }], expectedShape: 'scalar' }));
    expect(total.ok).toBe(false);
    expect(total.missing.join(' ')).toMatch(/breaks the answer down by region/);
  });

  it('a non-distinct count does not match a distinct count, and says so', () => {
    const verdict = verdictFor("SELECT region, COUNT(claim_id) AS open_claims FROM claims WHERE status = 'open' GROUP BY region", openByRegion());
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.join(' ')).toMatch(/claim_count counts distinct claim_id in claims, but the block's open_claims counts every row of claim_id/);
  });

  it('a count over another column or table does not match', () => {
    expect(verdictFor("SELECT region, COUNT(DISTINCT policy_id) AS open_claims FROM claims WHERE status = 'open' GROUP BY region", openByRegion()).ok).toBe(false);
    const elsewhere = verdictFor("SELECT region, COUNT(DISTINCT claim_id) AS open_claims FROM archived_claims WHERE status = 'open' GROUP BY region", openByRegion());
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.missing.join(' ')).toMatch(/claim_count reads claims, the block reads archived_claims/);
  });

  it('a block that joins or filters in a way the reader cannot compare does not match by guess', () => {
    const joined = verdictFor("SELECT c.region, COUNT(DISTINCT c.claim_id) AS open_claims FROM claims c JOIN policies p ON p.id = c.policy_id WHERE c.status = 'open' GROUP BY c.region", openByRegion());
    expect(joined.ok).toBe(false);
    expect(joined.missing.join(' ')).toMatch(/does not read from one single table/);
    const odd = verdictFor("SELECT region, COUNT(DISTINCT claim_id) AS open_claims FROM claims WHERE status = 'open' AND region LIKE 'N%' GROUP BY region", openByRegion());
    expect(odd.ok).toBe(false);
    expect(odd.missing.join(' ')).toMatch(/also filters rows by region LIKE 'N%'/);
  });

  it('a metric the reader cannot see as one aggregate is a miss that points at metricMappings', () => {
    const vocabulary = vocabularyFor({ sql: OPEN_CLAIMS_SQL }, [{ name: 'claim_count', model: 'claims', aggregation: 'count_distinct', physical: { relation: 'claims', expr: '"claims"."a" * "claims"."b"', aggregate: 'sum' } }]);
    const verdict = entails(vocabulary.get(blockRef)!, openByRegion(), vocabulary);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.join(' ')).toMatch(/metricMappings/);
  });
});

describe('a block declares the metric it answers', () => {
  const complexSql = "SELECT region, COUNT(DISTINCT claim_id) FILTER (WHERE status = 'open' AND region LIKE 'N%') AS open_claims FROM claims GROUP BY region";
  const mapped = { sql: complexSql, metricMappings: [{ output: 'open_claims', metric: 'claim_count', filter: "status = 'open'" }] };

  it('matches the declared metric when the question asks for the declared filter', () => {
    const vocabulary = vocabularyFor(mapped);
    const verdict = entails(vocabulary.get(blockRef)!, openByRegion(), vocabulary);
    expect(verdict.missing).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('without the mapping the same block is not compared', () => {
    const vocabulary = vocabularyFor({ sql: complexSql });
    expect(entails(vocabulary.get(blockRef)!, openByRegion(), vocabulary).ok).toBe(false);
  });

  it('does not match a question that does not ask for the declared filter, or another metric', () => {
    const vocabulary = vocabularyFor(mapped);
    const block = vocabulary.get(blockRef)!;
    expect(entails(block, intent({ measures: [{ ref: 'metric:claims.claim_count' }], groupBy: [{ ref: 'dimension:claims.region', role: 'categorical' }] }), vocabulary).missing.join(' ')).toMatch(/only read where status = 'open'/);
    expect(entails(block, openByRegion('metric:claims.claim_rows'), vocabulary).ok).toBe(false);
  });

  it('an unreadable declared filter vouches for nothing', () => {
    const vocabulary = vocabularyFor({ sql: complexSql, metricMappings: [{ output: 'open_claims', metric: 'claim_count', filter: "status LIKE 'o%'" }] });
    expect(entails(vocabulary.get(blockRef)!, openByRegion(), vocabulary).ok).toBe(false);
  });
});
