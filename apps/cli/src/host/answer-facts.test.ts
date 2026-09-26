import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { answerFactsFromRun, tablesRead } from './answer-facts.js';
import { withRunOwnership } from './run-ownership.js';
import type { DqlPrincipal } from './request-context.js';

describe('what a host may keep about an answer (HH-10)', () => {
  it('reads the tables a statement reads, without its own CTEs', () => {
    expect(tablesRead(`WITH paid AS (SELECT * FROM "claims"."payments" p JOIN claims.claims c ON c.id = p.claim_id)
      SELECT region, SUM(amount) FROM paid LEFT JOIN ref.regions r ON r.code = paid.region -- FROM secret.table
      WHERE note <> 'from nowhere' GROUP BY 1`)).toEqual(['claims.claims', 'claims.payments', 'ref.regions']);
    expect(tablesRead('select 1')).toEqual([]);
  });

  it('keeps the question, SQL, tables and fingerprints — never the answer or rows', () => {
    const facts = answerFactsFromRun({
      id: 'run-1', question: 'Claims paid last week', status: 'needs_review', trustState: 'review_required', route: 'ask', startedAt: '2026-09-26T10:00:00Z',
      answer: 'Claims paid were $4.21M', summary: '$4.21M',
      artifacts: [{ kind: 'query_result', payload: { result: { sql: 'SELECT SUM(amount) FROM claims.payments', rows: [{ sum: 4210000 }] } } }],
      diagnosticReceiptV9: { executed: { sqlFingerprint: 'sha256:abc', rowCount: 1 } },
      traceReference: { traceId: 'trace-9' },
      selectedObject: { kind: 'app', title: 'Claims Weekly' },
    });
    expect(facts).toEqual({
      runId: 'run-1', question: 'Claims paid last week', status: 'needs_review', trustState: 'review_required', route: 'ask', askedAt: '2026-09-26T10:00:00Z',
      sql: 'SELECT SUM(amount) FROM claims.payments', sqlOrigin: 'executed', sqlFingerprint: 'sha256:abc', tables: ['claims.payments'], traceId: 'trace-9',
      source: { kind: 'app', name: 'Claims Weekly' },
      sqlSha256: [], sources: [],
    });
    expect(JSON.stringify(facts)).not.toContain('4.21');
    // The identifiers match what the answer's audit event carries.
    const withIds = answerFactsFromRun({ id: 'r', question: 'q', artifacts: [{ sourceId: 'block:claims_paid', payload: { sql: 'SELECT 1', datasetId: 'ds:claims' } }] });
    expect(withIds.sources).toEqual(['block:claims_paid', 'ds:claims']);
    expect(withIds.sqlSha256).toEqual([createHash('sha256').update('SELECT 1').digest('hex')]);
  });
});

describe('run ownership', () => {
  it('stamps the asker, hides others\' runs, and changes nothing without a host person', async () => {
    const runs = new Map<string, { id: string; ownerId?: string }>();
    const store = {
      save(run: { id: string; ownerId?: string }) { runs.set(run.id, run); },
      get(id: string) { return runs.get(id); },
      list(_limit?: number, options?: { ownerId?: string }) { return [...runs.values()].filter((run) => !options?.ownerId || run.ownerId === options.ownerId); },
      count(options?: { ownerId?: string }) { return this.list(undefined, options).length; },
    };
    let who: DqlPrincipal | null = { id: 'u-priya', kind: 'person', source: 'host' };
    const owned = withRunOwnership(store, () => who);
    owned.save({ id: 'a' });
    who = { id: 'u-dan', kind: 'person', source: 'host' };
    owned.save({ id: 'b' });
    expect(runs.get('a')?.ownerId).toBe('u-priya');
    expect(owned.get('a')).toBeUndefined();
    expect(owned.get('b')?.id).toBe('b');
    expect(owned.list().map((run) => run.id)).toEqual(['b']);
    expect(owned.count()).toBe(1);
    who = { id: 'owner', kind: 'person', source: 'local' };
    expect(owned.list().map((run) => run.id)).toEqual(['a', 'b']);
    owned.save({ id: 'c' });
    expect(runs.get('c')?.ownerId).toBeUndefined();
  });
});
