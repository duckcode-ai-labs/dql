import { describe, expect, it } from 'vitest';
import type { AgentRun } from '@duckcodeailabs/dql-agent';
import { answerFactsFromRun } from './answer-facts.js';
import { shouldWithhold, WITHHELD_ANSWER, withholdRunFigures } from './answer-figures.js';

/**
 * RFC 0010 HH-14: a host can keep a needs-review answer's figures from a
 * person until someone checks it. What they get holds no value, but still
 * says what the answer was built on so it can be checked.
 */
const run = {
  id: 'run-1', question: 'Which adjusters have the most open claims?', status: 'answered', trustState: 'review_required', stopReason: 'answered',
  summary: 'Leading rows: ADJ-16 · Test Adjuster 16 · 15', answer: 'Test Adjuster 16 has 15 open claims.',
  steps: [{ id: 's1', index: 0, route: 'generated_answer', goal: 'answer', successCriteria: [], status: 'completed', attempts: 1, summary: 'ADJ-16 leads with 15', evaluations: [{ message: '15 rows' }], artifacts: [] }],
  events: [{ type: 'step', message: 'Found 15 open claims for ADJ-16' }], evaluations: [{ message: 'ADJ-16: 15' }],
  diagnosticReceiptV8: { sample: [{ adjuster: 'ADJ-16', open_claims: 15 }] },
  artifacts: [{
    id: 'a1', kind: 'answer', title: 'AI-drafted answer', trustState: 'review_required', payloadRef: 'sha256:abc',
    payload: {
      sql: 'SELECT adjuster_id, COUNT(*) AS open_claims FROM harbor.main.claims GROUP BY 1',
      sourceId: 'app:block:claims:abc',
      result: { sql: 'SELECT adjuster_id, COUNT(*) AS open_claims FROM harbor.main.claims GROUP BY 1', sqlFingerprint: 'fp-1', columns: [{ name: 'adjuster_id' }, { name: 'open_claims' }], rows: [{ adjuster_id: 'ADJ-16', open_claims: 15 }, { adjuster_id: 'ADJ-04', open_claims: 7 }] },
      narrative: 'ADJ-16 has 15.',
      preview: [{ adjuster_id: 'ADJ-16', open_claims: 15 }],
    },
  }],
} as unknown as AgentRun;

describe('figures withheld until an answer is checked (RFC 0010 HH-14)', () => {
  it('keeps no value anywhere in the run, but keeps what it is built on', () => {
    const withheld = withholdRunFigures(run);
    const text = JSON.stringify(withheld);
    for (const value of ['ADJ-16', 'ADJ-04', '"15"', ':15', 'Test Adjuster', 'narrative', 'preview', 'sample', 'sha256:abc']) expect(text).not.toContain(value);
    expect(withheld).toMatchObject({ figuresWithheld: true, answer: WITHHELD_ANSWER, summary: WITHHELD_ANSWER, trustState: 'review_required', events: [], evaluations: [] });
    expect(withheld.artifacts[0]!.payload).toMatchObject({ sourceId: 'app:block:claims:abc', result: { columns: ['adjuster_id', 'open_claims'], rowCount: 2, rows: [] } });
    // The host can still route it for a check: its SQL, tables and sources survive.
    expect(answerFactsFromRun(withheld as unknown as Record<string, unknown>)).toMatchObject({ sql: run.artifacts[0]!.payload && (run.artifacts[0]!.payload as { sql: string }).sql, tables: ['harbor.main.claims'] });
  });

  it('applies only to answers that need review, and only when the host asks', () => {
    expect(shouldWithhold('withhold_review', { trustState: 'review_required' })).toBe(true);
    expect(shouldWithhold('withhold_review', { trustState: 'certified' })).toBe(false);
    expect(shouldWithhold('show', { trustState: 'review_required' })).toBe(false);
    expect(shouldWithhold(undefined, { trustState: 'review_required' })).toBe(false);
  });
});
