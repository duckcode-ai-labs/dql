import { describe, expect, it } from 'vitest';
import { prefillCertificationMetadata } from './certification-prefill.js';

const skeleton = 'block "x" {\n  status = "draft"\n}\n';
const draft = (sql: string) => prefillCertificationMetadata(skeleton, { sql }).source;

describe('prefillCertificationMetadata reads grain only from the outermost query', () => {
  it('does not take the grain from a GROUP BY inside a CTE', () => {
    const source = draft(
      'WITH top AS (SELECT customer_id FROM orders GROUP BY customer_id HAVING count(*) > 5) '
      + 'SELECT o.region, o.amount FROM orders o JOIN top USING (customer_id)',
    );
    expect(source).not.toContain('one row per customer_id');
    expect(source).not.toContain('grain = ');
    expect(source).toContain('outputs = ["region", "amount"]');
  });

  it('does not take outputs from a CTE SELECT', () => {
    const source = draft(
      'WITH b AS (SELECT amount, region FROM t) SELECT region, SUM(amount) FROM b GROUP BY 1',
    );
    expect(source).not.toContain('one row per amount');
    expect(source).toContain('grain = "one row per region"');
  });

  it('leaves grain and outputs unset for a set operation', () => {
    const source = draft('SELECT a FROM t1 GROUP BY a UNION ALL SELECT b FROM t2 GROUP BY b');
    expect(source).not.toContain('grain = ');
    expect(source).not.toContain('outputs = ');
  });

  it('still reads a plain GROUP BY', () => {
    expect(draft('SELECT region, COUNT(*) AS n FROM orders GROUP BY region'))
      .toContain('grain = "one row per region"');
  });
});
