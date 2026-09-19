import { describe, expect, it } from 'vitest';
import { boundedResult, inlineParameters, isReadOnlyQuery, redactSecrets, sqlLiteral, withDeadline } from './shared.js';

describe('inlineParameters', () => {
  it('binds each placeholder outside quotes and comments', () => {
    const sql = "SELECT '?' AS q, \"a?\" FROM t -- ?\nWHERE x = ? /* ? */ AND y = ?";
    expect(inlineParameters(sql, ["O'Brien", 3])).toBe(
      "SELECT '?' AS q, \"a?\" FROM t -- ?\nWHERE x = 'O''Brien' /* ? */ AND y = 3",
    );
  });

  it('escapes backslashes for engines that treat them as escapes', () => {
    expect(inlineParameters('SELECT ?', ["a\\'b"], 'backslash')).toBe("SELECT 'a\\\\\\'b'");
  });

  it('refuses a count mismatch rather than guessing', () => {
    expect(() => inlineParameters('SELECT ?, ?', [1])).toThrow(/more placeholders/);
    expect(() => inlineParameters('SELECT ?', [1, 2])).toThrow(/fewer placeholders/);
  });

  it('writes NULL, booleans and non-finite numbers safely', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(true)).toBe('TRUE');
    expect(() => sqlLiteral(Number.NaN)).toThrow();
  });
});

describe('isReadOnlyQuery', () => {
  it('accepts one SELECT or WITH after comments', () => {
    expect(isReadOnlyQuery('-- note\n/* x */ with a as (select 1) select * from a;')).toBe(true);
  });

  it('rejects scripts and writes', () => {
    expect(isReadOnlyQuery('select 1; drop table t')).toBe(false);
    expect(isReadOnlyQuery('insert into t select 1')).toBe(false);
    expect(isReadOnlyQuery('select * into t2 from t')).toBe(false);
    expect(isReadOnlyQuery('show tables')).toBe(false);
  });

  it('does not mistake a column name for a write', () => {
    expect(isReadOnlyQuery('select last_update, created_at from t')).toBe(true);
  });
});

describe('boundedResult', () => {
  const columns = [{ name: 'n', type: 'number' as const, driverType: 'int' }];
  it('reports a cut as truncated', () => {
    const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const result = boundedResult(columns, rows, performance.now(), { maxRows: 2 });
    expect(result.rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('does not claim a cut when everything fits', () => {
    const result = boundedResult(columns, [{ n: 1 }], performance.now(), { maxRows: 1 });
    expect(result.truncated).toBeUndefined();
  });

  it('caps by serialized bytes too', () => {
    const rows = Array.from({ length: 10 }, (_, n) => ({ n }));
    const result = boundedResult(columns, rows, performance.now(), { maxBytes: 20 });
    expect(result.rows.length).toBeLessThan(10);
    expect(result.truncated).toBe(true);
  });
});

describe('withDeadline', () => {
  it('releases the caller at the deadline and asks the server to stop', async () => {
    let cancelled = false;
    const started = Date.now();
    await expect(withDeadline('Test', { deadlineMs: 50 }, () => new Promise(() => undefined), () => { cancelled = true; }))
      .rejects.toThrow(/exceeded the 50ms deadline/);
    expect(cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('releases the caller on abort', async () => {
    const controller = new AbortController();
    const pending = withDeadline('Test', { signal: controller.signal }, () => new Promise(() => undefined));
    controller.abort('user stopped');
    await expect(pending).rejects.toThrow(/cancelled: user stopped/);
  });

  it('refuses to start after the caller gave up', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await expect(withDeadline('Test', { signal: controller.signal }, async () => { ran = true; })).rejects.toThrow(/cancelled/);
    expect(ran).toBe(false);
  });

  it('passes a result through untouched', async () => {
    await expect(withDeadline('Test', { deadlineMs: 1_000 }, async () => 42)).resolves.toBe(42);
  });
});

describe('redactSecrets', () => {
  it('removes a configured password from an error', () => {
    expect(redactSecrets('password authentication failed for hunter22', { driver: 'postgresql', password: 'hunter22' }))
      .toBe('password authentication failed for ***');
  });
});
