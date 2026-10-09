import { describe, expect, it } from 'vitest';
import { extractBlockContract } from '../block-contract.js';
import { parseIntent, type AnalyticalIntentV1 } from '../intent.js';
import { buildVocabularyIndex } from '../vocabulary.js';
import { entails } from './certified.js';

/**
 * A certified block is never served at a grain it was not proved to have: a
 * time grain is matched on date_trunc, and a mapped block must declare outputs.
 */

const vocabularyFor = (block: Parameters<typeof extractBlockContract>[0]) => buildVocabularyIndex({
  metrics: [{ name: 'claim_count', model: 'claims', aggregation: 'count_distinct', physical: { relation: 'claims', expr: '"claims"."claim_id"', aggregate: 'count_distinct' } }],
  dimensions: [
    { name: 'region', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'region' } },
    { name: 'status', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'status' } },
    { name: 'created_at', model: 'claims', dataType: 'timestamp', isTime: true, physical: { relation: 'claims', column: 'created_at' } },
  ],
  blocks: [{ name: block.name, domain: 'claims', certified: true, sql: block.sql, contract: extractBlockContract({ ...block, domain: 'claims' }) }],
});

const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
  const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'q', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'breakdown', ...raw });
  if (!parsed.intent) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  return parsed.intent;
};

const open = { ref: 'dimension:claims.status', op: 'eq', values: ['open'], source: 'question' };
const byMonth = intent({ measures: [{ ref: 'metric:claims.claim_count' }], filters: [open], groupBy: [{ ref: 'dimension:claims.created_at', role: 'time', grain: 'month' }], expectedShape: 'trend' });
const verdict = (block: Parameters<typeof extractBlockContract>[0], asked: AnalyticalIntentV1) => {
  const vocabulary = vocabularyFor(block);
  return entails(vocabulary.get(`block:claims.${block.name}`)!, asked, vocabulary);
};

describe('time grain is proved, not assumed', () => {
  it('a block grouped by the raw date column does not answer a monthly question', () => {
    const result = verdict({ name: 'open_by_day', sql: "SELECT created_at, COUNT(DISTINCT claim_id) AS open_claims FROM claims WHERE status = 'open' GROUP BY created_at" }, byMonth);
    expect(result.ok).toBe(false);
    expect(result.missing.join(' ')).toMatch(/groups by created_at, not by month/);
  });

  it('a block that truncates the column to the asked grain answers it', () => {
    const result = verdict({ name: 'open_by_month', sql: "SELECT DATE_TRUNC('month', created_at) AS month, COUNT(DISTINCT claim_id) AS open_claims FROM claims WHERE status = 'open' GROUP BY DATE_TRUNC('month', created_at)" }, byMonth);
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('a block truncated to another grain does not answer', () => {
    const result = verdict({ name: 'open_by_year', sql: "SELECT DATE_TRUNC('year', created_at) AS year, COUNT(DISTINCT claim_id) AS open_claims FROM claims WHERE status = 'open' GROUP BY DATE_TRUNC('year', created_at)" }, byMonth);
    expect(result.ok).toBe(false);
  });
});

describe('a mapped block must declare its outputs', () => {
  const complex = "WITH c AS (SELECT * FROM claims WHERE status = 'open') SELECT region, COUNT(DISTINCT claim_id) AS open_claims FROM c GROUP BY region";
  const mapping = [{ output: 'open_claims', metric: 'claim_count', filter: "status = 'open'" }];
  const scalar = intent({ measures: [{ ref: 'metric:claims.claim_count' }], filters: [open], expectedShape: 'scalar' });

  it('without outputs the mapping is not served for a scalar question', () => {
    const result = verdict({ name: 'open_claims', sql: complex, metricMappings: mapping }, scalar);
    expect(result.ok).toBe(false);
    expect(result.missing.join(' ')).toMatch(/declares a metric mapping but no outputs/);
  });

  it('with outputs, the one-row-per-region block still does not answer a scalar question', () => {
    const result = verdict({ name: 'open_claims', sql: complex, declaredOutputs: ['region', 'open_claims'], metricMappings: mapping }, scalar);
    expect(result.ok).toBe(false);
    expect(result.missing.join(' ')).toMatch(/breaks the answer down by region/);
  });
});
