import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ColumnNames, maskSqlLiterals, maskSqlNames, RECEIPT_V9_FIELDS, reviewerAnswer, reviewerReceiptV9, reviewerSpans, rowCountBucket, traceDetailForReviewer, traceRekey } from './trace-review.js';

const rekey = traceRekey('secret', 'trace-1');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('maskSqlLiterals', () => {
  it('masks strings, IN lists, numbers and comments and keeps the statement\'s shape', () => {
    expect(maskSqlLiterals("SELECT name, SUM(amount) AS total FROM sales WHERE region IN ('West', 'East') AND amount > 1234.56 -- for Ryan\nGROUP BY name LIMIT 10", 'duckdb'))
      .toBe("SELECT name, SUM(amount) AS total FROM sales WHERE region IN ('?', '?') AND amount > ? --?\nGROUP BY name LIMIT ?");
    expect(maskSqlLiterals("SELECT * FROM t /* Ryan Byrd */ WHERE d = DATE '2025-01-01' AND x = -42 AND y = 1e5 AND z = 0x1F")).toBe("SELECT * FROM t /*?*/ WHERE d = DATE '?' AND x = -? AND y = ? AND z = ?");
  });

  it('keeps identifiers, including digits inside them and double-quoted names on an engine that quotes identifiers that way', () => {
    expect(maskSqlLiterals('SELECT t1.col_2 FROM "jaffle_shop"."dev"."orders" t1', 'duckdb')).toBe('SELECT t1.col_2 FROM "jaffle_shop"."dev"."orders" t1');
    expect(maskSqlLiterals('SELECT `order id` FROM `proj.ds.orders`', 'bigquery')).toBe('SELECT `order id` FROM `proj.ds.orders`');
  });

  it('masks "…" where it may be a string (BigQuery, MySQL, Databricks, an engine name that is not a dialect, or none)', () => {
    for (const dialect of ['bigquery', 'mysql', 'databricks', 'native', 'metricflow-cli', 'dbt-cloud', undefined]) expect(maskSqlLiterals('SELECT * FROM t WHERE name = "Ryan Byrd"', dialect), String(dialect)).toBe('SELECT * FROM t WHERE name = "?"');
  });

  it('reads quotes, escapes and comments every way a dialect could: a value never survives', () => {
    const cases: Array<[string, string | undefined]> = [
      ["SELECT 1 WHERE a = 'it''s Ryan' AND b = 'Byrd'", undefined],
      ["SELECT 1 WHERE a = 'C:\\' AND b = 'Ryan Byrd'", 'postgres'],
      ["SELECT 1 WHERE a = 'it\\'s' AND b = 'Ryan Byrd'", 'mysql'],
      ["SELECT 1 WHERE a = E'x\\'' AND b = 'Ryan Byrd'", 'postgres'],
      ['SELECT 1 WHERE a = $$Ryan Byrd$$ AND b = $tag$Ryan $ Byrd$tag$', 'postgres'],
      ["SELECT 1 WHERE a = '''Ryan's''' AND b = '''Byrd'''", undefined],
      ["SELECT 1 WHERE a = r'''Ryan's \\''' AND b = 'Byrd'", 'native'],
      ["SELECT 1 WHERE a = 'unterminated Ryan Byrd", undefined],
      ["SELECT 1 /* a /* Ryan */ Byrd */ WHERE a = ?", 'postgres'],
      ["SELECT 1 /* a /* Ryan */ Byrd */ WHERE a = ?", undefined],
      ["SELECT 1 # Ryan Byrd\nWHERE a = ?", 'mysql'],
      ["SELECT 1 # Ryan Byrd\nWHERE a = ?", undefined],
      ["SELECT 1 WHERE a = q'[Ryan's Byrd]' AND b = ?", 'oracle'],
      ["SELECT 1 WHERE a = q'{Ryan}' AND b = Q'!Byrd!'", undefined],
    ];
    for (const [sql, dialect] of cases) {
      const masked = maskSqlLiterals(sql, dialect);
      expect(masked, `${dialect}: ${sql}`).not.toMatch(/Ryan|Byrd/);
      expect(masked.startsWith('SELECT ?'), sql).toBe(true);
    }
  });
});

describe('names a result and its SQL may keep', () => {
  it('renames an alias or a quoted identifier the project does not name (a value), the same way in the columns', () => {
    const names = new ColumnNames([]);
    names.addRef('metric:orders.order_total');
    const sql = maskSqlNames(maskSqlLiterals('SELECT c.customer_name, SUM(CASE WHEN l.location_name = \'Chicago\' THEN o.order_total END) AS Chicago, SUM(o.order_total) AS "Brittany Johnson", CAST(o.order_total AS INTEGER) AS order_total FROM "jaffle_shop"."dev"."orders" AS o JOIN customers c ON c.id = o.customer_id', 'duckdb'), names);
    expect(sql).toBe('SELECT c.customer_name, SUM(CASE WHEN l.location_name = \'?\' THEN o.order_total END) AS column_2, SUM(o.order_total) AS "column_1", CAST(o.order_total AS INTEGER) AS order_total FROM "jaffle_shop"."dev"."orders" AS o JOIN customers c ON c.id = o.customer_id');
    expect(['customer_name', 'Chicago', 'Brittany Johnson', 'order_total'].map((column) => names.name(column))).toEqual(['customer_name', 'column_2', 'column_1', 'order_total']);
    expect(reviewerAnswer({ columns: ['West', 'CA', 'M-0003', '2024', 'a@b.test'] }, 'duckdb', new ColumnNames([]))?.columns).toEqual(['column_1', 'column_2', 'column_3', 'column_4', 'column_5']);
  });
});

describe('reviewerReceiptV9', () => {
  it('names every field of the receipt (keep, reduce or drop), and leaves out one it does not know', () => {
    expect(Object.values(RECEIPT_V9_FIELDS).every((how) => ['keep', 'reduce', 'drop'].includes(how))).toBe(true);
    const reduced = reviewerReceiptV9({ version: 1, dispatches: [], candidates: [], refusals: [], tiers: [], timings: { total: 3 }, somethingNew: 'CANARY' }, rekey);
    expect(reduced).toEqual({ version: 1, dispatches: [], candidates: [], refusals: [], tiers: [], timings: { total: 3 } });
  });

  it('keeps no free text, re-keys SQL fingerprints, gives a row-count range and no Research program ids', () => {
    const sqlFingerprint = `sha256:${sha("SELECT 1 WHERE a = 'Ryan Byrd'").slice(0, 16)}`;
    const reduced = reviewerReceiptV9({
      version: 1, dispatches: [{ purpose: 'intent:resolve', ms: 1, reply: 'Ryan Byrd spent 2581' }],
      intent: { kind: 'analytics', display: ['dimension:customers.customer_name', 'Ryan Byrd'], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan Byrd'] }], measures: [{ ref: 'metric:orders.order_total', alias: 'Chicago' }], groupBy: [] },
      refusals: [{ tier: 'semantic', code: 'Ryan Byrd is not here', message: 'Ryan Byrd' }], tiers: [],
      candidates: [{ tier: 'exploratory', trust: 'review_required', sqlFingerprint }], executed: { tier: 'exploratory', sqlFingerprint, rowCount: 5, ms: 2, proofs: ['Ryan Byrd'] },
      story: [{ phase: 'drill', title: 'Drilled into Ryan Byrd', programId: 'drill:Ryan Byrd:dimension:customers.customer_name', queryId: 'q:Ryan Byrd', state: 'done', at: 1 }],
      timings: {},
    }, rekey) as any;
    expect(JSON.stringify(reduced)).not.toMatch(/Ryan|2581|Chicago|sha256/);
    expect(reduced.executed).toEqual({ tier: 'exploratory', sqlFingerprint: rekey(sqlFingerprint), rowCountBucket: '2-10', ms: 2, proofs: [] });
    expect(reduced.candidates[0].sqlFingerprint).toBe(rekey(sqlFingerprint));
    expect(reduced.story).toEqual([{ phase: 'drill', title: 'Drilled in', state: 'done', at: 1 }]);
  });

  it('re-keys per trace and per secret: the same statement is not the same key elsewhere', () => {
    expect(rekey('sha256:abc')).toMatch(/^hmac:[0-9a-f]{32}$/);
    expect(rekey('sha256:abc')).toBe(rekey('sha256:abc'));
    expect(traceRekey('secret', 'trace-2')('sha256:abc')).not.toBe(rekey('sha256:abc'));
    expect(traceRekey('other', 'trace-1')('sha256:abc')).not.toBe(rekey('sha256:abc'));
  });

  it('row-count ranges', () => {
    expect([0, 1, 2, 10, 11, 100, 101, 1000, 1001].map(rowCountBucket)).toEqual(['none', '1', '2-10', '2-10', '11-100', '11-100', '101-1000', '101-1000', 'more than 1000']);
  });
});

describe('the trace store\'s own records', () => {
  it('spans keep names, timings, outcomes and codes; no fingerprint, no exact row count, no value-named candidate or branch', () => {
    const spans = reviewerSpans([
      { version: 1, traceId: 't', spanId: 's1', ordinal: 0, name: 'sql.execute', stage: 'sql', startedAt: 'x', outcome: 'ok', reasonCode: 'completed', payload: { kind: 'sql', execution: { version: 1, tier: 'exploratory', sqlFingerprint: `sha256:${sha('x')}`, resultFingerprint: `sha256:${sha('y')}`, planFingerprint: 'p', reviewRequired: true } } },
      { version: 1, traceId: 't', spanId: 's2', ordinal: 1, name: 'result.normalize', stage: 'result', startedAt: 'x', outcome: 'ok', reasonCode: 'result_accepted', payload: { kind: 'result', resultFingerprint: 'sha256:r', schemaFingerprint: 'sha256:s', rowCount: 37, trustState: 'review_required' } },
      { version: 1, traceId: 't', spanId: 's3', ordinal: 2, name: 'tool.call', stage: 'tool', startedAt: 'x', outcome: 'ok', reasonCode: 'completed', payload: { kind: 'tool', call: { version: 1, toolCallId: 'Ryan', toolKind: 'search_values', attemptIndex: 1, inputFingerprint: 'sha256:i', outputFingerprint: 'sha256:o' } } },
      { version: 1, traceId: 't', spanId: 's4', ordinal: 3, name: 'meaning.resolve', stage: 'meaning', startedAt: 'x', outcome: 'ok', reasonCode: 'meaning_resolved', payload: { kind: 'meaning', selectedCandidateIds: ['metric:orders.order_total', 'member:dimension:customers.customer_name=["Ryan Byrd"]'], rejectedCandidateIds: [] } },
      { version: 1, traceId: 't', spanId: 's5', ordinal: 4, name: 'research.validate', stage: 'research', startedAt: 'x', outcome: 'ok', reasonCode: 'completed', payload: { kind: 'research', branchId: 'drill:Ryan Byrd:x', hypothesisFingerprint: 'sha256:h', verdict: 'supported' } },
    ]);
    const text = JSON.stringify(spans);
    expect(text).not.toMatch(/Fingerprint|sha256|Ryan|37/);
    expect(spans.map((span: any) => span.payload)).toEqual([
      { kind: 'sql', execution: { version: 1, tier: 'exploratory', reviewRequired: true } },
      { kind: 'result', rowCountBucket: '11-100', trustState: 'review_required' },
      { kind: 'tool', call: { version: 1, toolKind: 'search_values', attemptIndex: 1 } },
      { kind: 'meaning', selectedCandidateIds: ['metric:orders.order_total', 'candidate_1'], rejectedCandidateIds: [] },
      { kind: 'research', verdict: 'supported' },
    ]);
  });
});

describe('traceDetailForReviewer', () => {
  it('keeps only the fields it names, re-keys the envelope\'s fingerprints, leaves links\' out, and marks the trace', () => {
    const detail = traceDetailForReviewer({
      envelope: { version: 1, traceId: 'trace-1', runId: 'r', questionFingerprint: `sha256:${sha('who is Ryan Byrd')}`, traceFingerprint: 'sha256:t', status: 'completed', spanCount: 1, extra: 'CANARY' },
      spans: [], candidateDecisions: [{ version: 1, sequence: 1, candidateId: 'value:Ryan Byrd', decision: 'admitted', reasonCode: 'exact_name_match' }],
      links: [{ version: 1, kind: 'clarification_continuation', sourceTraceId: 'a', sourceRunId: 'b', choiceFingerprint: `sha256:${sha('member:x=["Ryan Byrd"]')}`, createdAt: 'x' }],
      decisionSummary: { x: 1, someFingerprint: 'sha256:abc' }, runtimeMode: 'pipeline_v3',
      runtimeReceiptV5: { a: 'CANARY' }, runtimeReceiptV6: { a: 'CANARY' }, runtimeReceiptV8: { a: 'CANARY' }, runtimeDecisionSummary: { a: 'CANARY' }, extra: 'CANARY',
      runtimeAnswerV1: { status: 'completed', sql: "SELECT 1 WHERE a = 'CANARY'", rowsSample: [{ a: 'CANARY' }], proof: ['CANARY'], columns: ['a', 'CANARY with space'], rowCount: 1 },
    }, { secret: 'secret' }) as any;
    const text = JSON.stringify(detail);
    expect(text).not.toMatch(/CANARY|Ryan|sha256|choiceFingerprint/);
    expect(Object.keys(detail).sort()).toEqual(['candidateDecisions', 'decisionSummary', 'envelope', 'links', 'runtimeAnswerV1', 'runtimeMode', 'spans', 'valuesWithheld']);
    expect(detail.envelope.questionFingerprint).toMatch(/^hmac:/);
    expect(detail.candidateDecisions[0].candidateId).toBe('candidate_1');
    expect(detail.decisionSummary.someFingerprint).toMatch(/^hmac:/);
    expect(reviewerAnswer({ sql: "SELECT 'x'" }, 'duckdb')).toEqual({ sql: "SELECT '?'", sqlLiteralsMasked: true, columns: [] });
  });
});
