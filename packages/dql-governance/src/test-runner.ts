import type { TestResultSummary, TestAssertionResult } from '@zlens/project';

/**
 * A block test assertion parsed from DQL `tests { assert ... }` blocks.
 */
export interface BlockTestAssertion {
  name: string;
  sql: string;
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=' | 'IN';
  threshold: number | string | boolean | Array<number | string | boolean>;
}

/**
 * QueryExecutor is an adapter interface for running SQL queries.
 * Implementations can use DuckDB, Postgres, etc.
 */
export interface QueryExecutor {
  execute(sql: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

/**
 * TestRunner executes block test assertions against a database.
 */
export class TestRunner {
  private executor: QueryExecutor;

  constructor(executor: QueryExecutor) {
    this.executor = executor;
  }

  /**
   * Run all assertions for a block and return a summary.
   */
  async runTests(
    assertions: BlockTestAssertion[],
    params?: Record<string, unknown>,
  ): Promise<TestResultSummary> {
    const start = Date.now();
    const results: TestAssertionResult[] = [];
    let passed = 0;
    let failed = 0;

    for (const assertion of assertions) {
      try {
        const result = await this.runAssertion(assertion, params);
        results.push(result);
        if (result.passed) passed++;
        else failed++;
      } catch (err) {
        results.push({
          name: assertion.name,
          passed: false,
          error: err instanceof Error ? err.message : String(err),
        });
        failed++;
      }
    }

    return {
      passed,
      failed,
      skipped: 0,
      duration: Date.now() - start,
      assertions: results,
      runAt: new Date(),
    };
  }

  /**
   * Run a single assertion.
   */
  private async runAssertion(
    assertion: BlockTestAssertion,
    params?: Record<string, unknown>,
  ): Promise<TestAssertionResult> {
    const rows = await this.executor.execute(assertion.sql, params);

    if (rows.length === 0) {
      return {
        name: assertion.name,
        passed: false,
        error: 'Query returned no rows',
      };
    }

    // The assertion SQL should return a single scalar value
    const firstRow = rows[0];
    const keys = Object.keys(firstRow);
    const rawActual = firstRow[keys[0]];
    const comparison = compare(rawActual, assertion.operator, assertion.threshold);

    return {
      name: assertion.name,
      passed: comparison.passed,
      actual: rawActual,
      expected: assertion.threshold,
      error: comparison.error,
    };
  }
}

function compare(
  actual: unknown,
  op: string,
  threshold: unknown,
): { passed: boolean; error?: string } {
  if (op === 'IN') {
    if (!Array.isArray(threshold)) {
      return { passed: false, error: 'IN operator requires an array expected value' };
    }
    const pass = threshold.some((candidate) => candidate === actual);
    return {
      passed: pass,
      error: pass ? undefined : `${String(actual)} IN ${JSON.stringify(threshold)} is false`,
    };
  }

  const actualNumber = Number(actual);
  const thresholdNumber = Number(threshold);
  if (!Number.isFinite(actualNumber) || !Number.isFinite(thresholdNumber)) {
    return {
      passed: false,
      error: `Operator '${op}' requires numeric values (actual=${String(actual)}, expected=${String(threshold)})`,
    };
  }

  switch (op) {
    case '>':
      return {
        passed: actualNumber > thresholdNumber,
        error: actualNumber > thresholdNumber ? undefined : `${actualNumber} > ${thresholdNumber} is false`,
      };
    case '<':
      return {
        passed: actualNumber < thresholdNumber,
        error: actualNumber < thresholdNumber ? undefined : `${actualNumber} < ${thresholdNumber} is false`,
      };
    case '>=':
      return {
        passed: actualNumber >= thresholdNumber,
        error: actualNumber >= thresholdNumber ? undefined : `${actualNumber} >= ${thresholdNumber} is false`,
      };
    case '<=':
      return {
        passed: actualNumber <= thresholdNumber,
        error: actualNumber <= thresholdNumber ? undefined : `${actualNumber} <= ${thresholdNumber} is false`,
      };
    case '==':
      return {
        passed: actualNumber === thresholdNumber,
        error: actualNumber === thresholdNumber ? undefined : `${actualNumber} == ${thresholdNumber} is false`,
      };
    case '!=':
      return {
        passed: actualNumber !== thresholdNumber,
        error: actualNumber !== thresholdNumber ? undefined : `${actualNumber} != ${thresholdNumber} is false`,
      };
    default:
      return { passed: false, error: `Unsupported operator '${op}'` };
  }
}
