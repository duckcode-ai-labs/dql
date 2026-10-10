import { describe, expect, it } from 'vitest';
import { answerFactsFromRun } from './answer-facts.js';

const certifiedRun = (payload: Record<string, unknown>) => ({
  id: 'run-owner', question: 'Open claims by region', status: 'completed', trustState: 'certified', route: 'ask',
  artifacts: [{ kind: 'answer', payload: {
    kind: 'certified', certifiedBlockRef: 'block:claims.open_claims_by_region',
    result: { sql: 'SELECT region, COUNT(*) FROM claims.claims GROUP BY 1', rows: [{ region: 'West', open_claims: 41 }] },
    ...payload,
  } }],
});

describe('answer facts carry the certified block owner', () => {
  it('puts the block owner on source.owner, with no data values', () => {
    const facts = answerFactsFromRun(certifiedRun({ certifiedBlockOwner: 'maria@harbor.example' }));
    expect(facts.source).toEqual({ kind: 'block', name: 'open_claims_by_region', owner: 'maria@harbor.example' });
    expect(JSON.stringify(facts)).not.toContain('41');
  });

  it('leaves source.owner out when the block records none', () => {
    const facts = answerFactsFromRun(certifiedRun({ certifiedBlockOwner: '  ' }));
    expect(facts.source).toEqual({ kind: 'block', name: 'open_claims_by_region' });
  });

  it('ignores an owner on an answer that ran no certified block', () => {
    const facts = answerFactsFromRun({ id: 'r', question: 'q', artifacts: [{ kind: 'answer', payload: { certifiedBlockOwner: 'maria@harbor.example' } }] });
    expect(facts.source).toBeUndefined();
  });
});
