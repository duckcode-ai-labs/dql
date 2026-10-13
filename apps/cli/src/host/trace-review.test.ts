import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ColumnNames, maskSqlLiterals, maskSqlNames, RECEIPT_V9_FIELDS, reviewerAnswer, reviewerDecisionSummary, reviewerReceiptV9, reviewerSpans, rowCountBucket, traceDetailForReviewer, traceRekey } from './trace-review.js';

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
  const catalog = ['jaffle_shop', 'dev', 'orders', 'customers', 'locations', 'customer_name', 'customer_id', 'location_name', 'location_id', 'order_total', 'order_id', 'id'];

  it('renames, as whole tokens, every identifier the project does not name: aliases with or without AS, quoted, bracketed; tables stay readable', () => {
    const names = new ColumnNames(catalog);
    const sql = maskSqlNames(maskSqlLiterals('SELECT c.customer_name, SUM(CASE WHEN l.location_name = \'Chicago\' THEN o.order_total END) AS Chicago, SUM(o.order_total) AS "Brittany Johnson", CAST(o.order_total AS INTEGER) AS order_total, o.order_total::text WHVAL17, o.order_id WHVAL18, SUM(o.order_total) Brooklyn FROM "jaffle_shop"."dev"."orders" AS o JOIN customers c ON c.id = o.customer_id', 'duckdb'), names);
    expect(sql).toBe('SELECT t_1.customer_name, SUM(CASE WHEN t_2.location_name = \'?\' THEN t_3.order_total END) AS column_1, SUM(t_3.order_total) AS "column_2", CAST(t_3.order_total AS INTEGER) AS order_total, t_3.order_total::text column_3, t_3.order_id column_4, SUM(t_3.order_total) column_5 FROM "jaffle_shop"."dev"."orders" AS t_3 JOIN customers t_1 ON t_1.id = t_3.customer_id');
    expect(['customer_name', 'Chicago', 'Brittany Johnson', 'order_total', 'WHVAL17'].map((column) => names.name(column))).toEqual(['customer_name', 'column_1', 'column_2', 'order_total', 'column_3']);
    expect(reviewerAnswer({ columns: ['West', 'CA', 'M-0003', '2024', 'a@b.test'] }, 'duckdb', new ColumnNames([]))?.columns).toEqual(['column_1', 'column_2', 'column_3', 'column_4', 'column_5']);
  });

  it('an alias carried through a CTE or a subquery is renamed where it is made and wherever it is read', () => {
    for (const sql of [
      'WITH p AS (SELECT c.customer_name, SUM(o.order_total) AS Chicago FROM orders o JOIN customers c ON c.customer_id = o.customer_id GROUP BY 1) SELECT p.customer_name, p.Chicago FROM p ORDER BY p.Chicago DESC',
      'SELECT s.customer_name, s.Chicago FROM (SELECT c.customer_name, SUM(o.order_total) AS Chicago FROM orders o JOIN customers c ON c.customer_id = o.customer_id GROUP BY 1) s',
      'WITH p(customer_name, Chicago) AS (SELECT c.customer_name, SUM(o.order_total) FROM orders o JOIN customers c ON c.customer_id = o.customer_id GROUP BY 1) SELECT * FROM p',
    ]) {
      const names = new ColumnNames(catalog);
      const masked = maskSqlNames(maskSqlLiterals(sql, 'duckdb'), names);
      expect(masked, sql).not.toMatch(/Chicago/);
      expect(names.name('Chicago')).toMatch(/^column_\d+$/);
      expect(masked).toContain('customer_name');
    }
  });

  it('brackets: [Chicago] on SQLite and SQL Server is renamed; an array or an index is not an identifier', () => {
    for (const dialect of ['sqlite', 'sqlserver', 'mssql', undefined]) {
      const names = new ColumnNames(catalog);
      expect(maskSqlNames(maskSqlLiterals('SELECT [WHVAL14], SUM(order_total) AS [Chicago] FROM orders', dialect), names), String(dialect)).toBe('SELECT [column_1], SUM(order_total) AS [column_2] FROM orders');
    }
    expect(maskSqlNames(maskSqlLiterals("SELECT list_value(1, 2)[1], x['k'] FROM orders", 'duckdb'), new ColumnNames(catalog))).toBe("SELECT list_value(?, ?)[?], column_1['?'] FROM orders");
  });

  it('where "…" may be a string, the project\'s own relation names stay readable and a "…" value is masked, never garbled', () => {
    for (const dialect of ['sqlite', 'mysql', 'databricks', undefined]) {
      const names = new ColumnNames(catalog);
      expect(maskSqlNames(maskSqlLiterals('SELECT o.order_total FROM "jaffle_shop"."dev"."orders" o JOIN "jaffle_shop"."dev"."customers" c ON c.customer_id = o.customer_id WHERE c.customer_name = "Ryan Byrd"', dialect, (content) => names.isKnown(content)), names), String(dialect))
        .toBe('SELECT t_1.order_total FROM "jaffle_shop"."dev"."orders" t_1 JOIN "jaffle_shop"."dev"."customers" t_2 ON t_2.customer_id = t_1.customer_id WHERE t_2.customer_name = "?"');
    }
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
    expect(detail.decisionSummary).toEqual({ evidenceByRole: [], tierDecisions: [] });
    expect(reviewerAnswer({ sql: "SELECT 'x'" }, 'duckdb')).toEqual({ sql: "SELECT '?'", sqlLiteralsMasked: true, columns: [] });
  });
});

describe('reviewerDecisionSummary', () => {
  it('keeps counts and enums, re-keys its fingerprint, and leaves out a field it does not know', () => {
    const summary = reviewerDecisionSummary({
      version: 1, summaryFingerprint: 'sha256:abc', understoodRequest: { measures: 1, dimensions: 2, entityRequested: true, outputCount: 3, conversationBinding: 'none', note: 'Ryan Byrd' },
      evidenceByRole: [{ role: 'metric', candidateCount: 2, candidateIds: ['member:x=["Ryan Byrd"]'] }], tierDecisions: [{ tier: 'semantic', outcome: 'executable', planFrozen: true }],
      terminalIncident: { version: 1, code: 'ANALYTICAL_EXECUTION_FAILED', boundary: 'sql.execute', origin: 'warehouse', impact: 'execution_failed', safeAction: 'inspect_failure', message: 'Ryan Byrd' },
      safeNextAction: 'none', aFieldAddedTomorrow: 'Ryan Byrd',
    }, rekey) as any;
    expect(JSON.stringify(summary)).not.toMatch(/Ryan|sha256/);
    expect(summary.summaryFingerprint).toMatch(/^hmac:/);
    expect(summary.understoodRequest).toEqual({ measures: 1, dimensions: 2, entityRequested: true, outputCount: 3, conversationBinding: 'none' });
    expect(summary.terminalIncident.code).toBe('ANALYTICAL_EXECUTION_FAILED');
  });
});
