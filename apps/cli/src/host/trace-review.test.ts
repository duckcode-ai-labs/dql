import { describe, expect, it } from 'vitest';
import { maskSqlLiterals, RECEIPT_V9_FIELDS, reviewerAnswer, reviewerReceiptV9, traceDetailForReviewer } from './trace-review.js';

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

  it('masks "…" where it may be a string (BigQuery, MySQL, Databricks, or an unknown engine)', () => {
    for (const engine of ['bigquery', 'mysql', 'databricks', undefined]) expect(maskSqlLiterals('SELECT * FROM t WHERE name = "Ryan Byrd"', engine), String(engine)).toBe('SELECT * FROM t WHERE name = "?"');
  });

  it('reads quotes and escapes every way a dialect could: a value never survives a backslash or doubled quote', () => {
    for (const sql of [
      "SELECT 1 WHERE a = 'it''s Ryan' AND b = 'Byrd'",
      "SELECT 1 WHERE a = 'C:\\' AND b = 'Ryan Byrd'",
      "SELECT 1 WHERE a = 'it\\'s' AND b = 'Ryan Byrd'",
      "SELECT 1 WHERE a = E'x\\'' AND b = 'Ryan Byrd'",
      'SELECT 1 WHERE a = $$Ryan Byrd$$ AND b = $tag$Ryan $ Byrd$tag$',
      "SELECT 1 WHERE a = '''Ryan's''' AND b = '''Byrd'''",
      "SELECT 1 WHERE a = 'unterminated Ryan Byrd",
    ]) {
      const masked = maskSqlLiterals(sql);
      expect(masked, sql).not.toMatch(/Ryan|Byrd/);
      expect(masked.startsWith('SELECT ? WHERE a = '), sql).toBe(true);
    }
  });
});

describe('reviewerReceiptV9', () => {
  it('names every field of the receipt (keep, reduce or drop), and leaves out one it does not know', () => {
    expect(Object.values(RECEIPT_V9_FIELDS).every((how) => ['keep', 'reduce', 'drop'].includes(how))).toBe(true);
    const reduced = reviewerReceiptV9({ version: 1, vocabularyFingerprint: 'sha256:v', dispatches: [], candidates: [], refusals: [], tiers: [], timings: { total: 3 }, somethingNew: 'CANARY' });
    expect(reduced).toEqual({ version: 1, vocabularyFingerprint: 'sha256:v', dispatches: [], candidates: [], refusals: [], tiers: [], timings: { total: 3 } });
  });

  it('keeps no free text: a value in an identifier slot that is not an identifier is dropped', () => {
    const reduced = reviewerReceiptV9({ version: 1, dispatches: [{ purpose: 'intent:resolve', ms: 1, reply: 'Ryan Byrd spent 2581' }], intent: { kind: 'analytics', display: ['dimension:customers.customer_name', 'Ryan Byrd'], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan Byrd'] }], measures: [], groupBy: [] }, refusals: [{ tier: 'semantic', code: 'Ryan Byrd is not here', message: 'Ryan Byrd' }], tiers: [], candidates: [], timings: {} });
    expect(JSON.stringify(reduced)).not.toMatch(/Ryan|2581/);
  });
});

describe('traceDetailForReviewer', () => {
  it('keeps only the fields it names, and marks the trace as one with its values withheld', () => {
    const detail = traceDetailForReviewer({
      envelope: { traceId: 't' }, spans: [], candidateDecisions: [], links: [], decisionSummary: { x: 1 }, runtimeMode: 'pipeline_v3',
      runtimeReceiptV5: { a: 'CANARY' }, runtimeReceiptV6: { a: 'CANARY' }, runtimeReceiptV8: { a: 'CANARY' }, runtimeDecisionSummary: { a: 'CANARY' }, extra: 'CANARY',
      runtimeAnswerV1: { status: 'completed', sql: "SELECT 1 WHERE a = 'CANARY'", rowsSample: [{ a: 'CANARY' }], proof: ['CANARY'], columns: ['a', 'CANARY with space'], rowCount: 1 },
    });
    expect(JSON.stringify(detail)).not.toMatch(/CANARY/);
    expect(Object.keys(detail).sort()).toEqual(['candidateDecisions', 'decisionSummary', 'envelope', 'links', 'runtimeAnswerV1', 'runtimeMode', 'spans', 'valuesWithheld']);
    expect(reviewerAnswer({ sql: "SELECT 'x'" }, 'duckdb')).toEqual({ sql: "SELECT '?'", sqlLiteralsMasked: true, columns: [] });
  });
});
