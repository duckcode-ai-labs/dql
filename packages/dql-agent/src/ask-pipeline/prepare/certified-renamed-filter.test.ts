import { describe, expect, it } from 'vitest';
import { extractBlockContract } from '../block-contract.js';
import { parseIntent } from '../intent.js';
import { buildVocabularyIndex } from '../vocabulary.js';
import { prepareCertified } from './certified.js';
import type { PrepareDeps } from './types.js';

const SQL = "SELECT region, COUNT(DISTINCT claim_id) AS open_claims FROM claims WHERE status = 'open' GROUP BY region";
const contract = { ...extractBlockContract({ name: 'open_claims_by_region', domain: 'claims', sql: SQL }), allowedFilters: ['region'] };

// The region dimension is named differently from the physical column the block outputs.
const vocabulary = buildVocabularyIndex({
  metrics: [{ name: 'claim_count', model: 'claims', aggregation: 'count_distinct', physical: { relation: 'claims', expr: '"claims"."claim_id"', aggregate: 'count_distinct' } }],
  dimensions: [
    { name: 'claim_region', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'region' } },
    { name: 'claim_status', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'status' } },
  ],
  blocks: [{ name: 'open_claims_by_region', domain: 'claims', certified: true, sql: SQL, contract }],
});
const deps: PrepareDeps = { joinPath: () => undefined, blockSql: (ref) => vocabulary.get(ref)?.sql };

const asked = (value: string) => {
  const parsed = parseIntent({
    version: 1, kind: 'analytics', reading: 'Open claims in a region', display: [], unresolved: [], provenance: {}, expectedShape: 'breakdown',
    measures: [{ ref: 'metric:claims.claim_count' }],
    groupBy: [{ ref: 'dimension:claims.claim_region', role: 'categorical' }],
    filters: [
      { ref: 'dimension:claims.claim_status', op: 'eq', values: ['open'], source: 'question' },
      { ref: 'dimension:claims.claim_region', op: 'eq', values: [value], source: 'question' },
    ],
  });
  if (!parsed.intent) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  return parsed.intent;
};

describe('a renamed dimension on an allowed-filter column', () => {
  it('applies the question filter over the block output, or refuses; it never drops it', () => {
    const prepared = prepareCertified(asked('West'), vocabulary, deps);
    if (prepared.candidates.length === 0) {
      expect(prepared.refusals[0]).toMatchObject({ code: 'block_not_applicable' });
      return;
    }
    const candidate = prepared.candidates[0]!;
    expect(candidate.sql).toMatch(/WHERE .*"region"/);
    expect(candidate.params).toContain('west');
  });
});
