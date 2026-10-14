import { describe, it, expect } from 'vitest';
import { TestRunner } from './test-runner.js';
import { Certifier, PROMOTABLE_RULES } from './certifier.js';
import { CostEstimator } from './cost-estimator.js';
import { PolicyEngine } from './policy-engine.js';
import type { BlockRecord, TestResultSummary } from '@zlens/project';
import type { BlockTestAssertion, QueryExecutor } from './test-runner.js';

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  const now = new Date();
  return {
    id: 'block-1',
    name: 'test-block',
    domain: 'revenue',
    type: 'chart.bar',
    version: '1.0.0',
    status: 'draft',
    gitRepo: 'github.com/acme/analytics',
    gitPath: 'blocks/test.dql',
    gitCommitSha: 'abc123',
    owner: 'kranthi',
    tags: ['revenue'],
    dependencies: ['orders'],
    usedInCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// Mock query executor
class MockExecutor implements QueryExecutor {
  private results: Record<string, Record<string, unknown>[]> = {};

  setResult(sql: string, rows: Record<string, unknown>[]): void {
    this.results[sql] = rows;
  }

  async execute(sql: string): Promise<Record<string, unknown>[]> {
    return this.results[sql] ?? [];
  }
}

describe('TestRunner', () => {
  it('passes when assertion is satisfied', async () => {
    const executor = new MockExecutor();
    executor.setResult('SELECT COUNT(*) as cnt FROM orders', [{ cnt: 42 }]);
    const runner = new TestRunner(executor);

    const assertions: BlockTestAssertion[] = [
      { name: 'row_count > 0', sql: 'SELECT COUNT(*) as cnt FROM orders', operator: '>', threshold: 0 },
    ];

    const result = await runner.runTests(assertions);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.assertions[0].passed).toBe(true);
  });

  it('fails when assertion is not satisfied', async () => {
    const executor = new MockExecutor();
    executor.setResult('SELECT COUNT(*) as cnt FROM orders', [{ cnt: 0 }]);
    const runner = new TestRunner(executor);

    const assertions: BlockTestAssertion[] = [
      { name: 'row_count > 0', sql: 'SELECT COUNT(*) as cnt FROM orders', operator: '>', threshold: 0 },
    ];

    const result = await runner.runTests(assertions);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.assertions[0].passed).toBe(false);
  });

  it('fails when query returns no rows', async () => {
    const executor = new MockExecutor();
    const runner = new TestRunner(executor);

    const assertions: BlockTestAssertion[] = [
      { name: 'has data', sql: 'SELECT 1 FROM empty', operator: '>', threshold: 0 },
    ];

    const result = await runner.runTests(assertions);
    expect(result.failed).toBe(1);
    expect(result.assertions[0].error).toContain('no rows');
  });

  it('supports all comparison operators', async () => {
    const executor = new MockExecutor();
    executor.setResult('q1', [{ v: 10 }]);
    executor.setResult('q2', [{ v: 10 }]);
    executor.setResult('q3', [{ v: 10 }]);
    executor.setResult('q4', [{ v: 10 }]);
    const runner = new TestRunner(executor);

    const assertions: BlockTestAssertion[] = [
      { name: 'gte', sql: 'q1', operator: '>=', threshold: 10 },
      { name: 'lte', sql: 'q2', operator: '<=', threshold: 10 },
      { name: 'eq', sql: 'q3', operator: '==', threshold: 10 },
      { name: 'neq', sql: 'q4', operator: '!=', threshold: 5 },
    ];

    const result = await runner.runTests(assertions);
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  it('supports IN operator for scalar values', async () => {
    const executor = new MockExecutor();
    executor.setResult('q1', [{ v: 'Enterprise' }]);
    const runner = new TestRunner(executor);

    const assertions: BlockTestAssertion[] = [
      { name: 'segment_in', sql: 'q1', operator: 'IN', threshold: ['Enterprise', 'SMB'] },
    ];

    const result = await runner.runTests(assertions);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('fails IN operator when expected value is not an array', async () => {
    const executor = new MockExecutor();
    executor.setResult('q1', [{ v: 'Enterprise' }]);
    const runner = new TestRunner(executor);

    const assertions: BlockTestAssertion[] = [
      // Intentionally malformed input shape to verify fail-closed behavior.
      { name: 'segment_in_bad', sql: 'q1', operator: 'IN', threshold: 'Enterprise' },
    ];

    const result = await runner.runTests(assertions);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.assertions[0].error).toContain('IN operator requires an array');
  });
});

describe('Certifier', () => {
  it('certifies a valid block with passing tests', () => {
    const certifier = new Certifier();
    const block = makeBlock({ description: 'Revenue by segment' });
    const testResults: TestResultSummary = {
      passed: 2, failed: 0, skipped: 0, duration: 100,
      assertions: [
        { name: 'test1', passed: true },
        { name: 'test2', passed: true },
      ],
      runAt: new Date(),
    };

    const result = certifier.evaluate(block, testResults);
    expect(result.certified).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('treats a missing description as a warning, not a hard gate (AI drafts it; owner is the gate)', () => {
    const certifier = new Certifier();
    const block = makeBlock({ description: undefined });
    const result = certifier.evaluate(block);
    // Description is advisory now — it must NOT appear as a blocking error.
    expect(result.errors.some((e) => e.rule === 'Block has description')).toBe(false);
    expect(result.warnings.some((w) => w.rule === 'Block has description')).toBe(true);
  });

  it('rejects a block without an owner (owner is the one required field)', () => {
    const certifier = new Certifier();
    const block = makeBlock({ description: 'Test', owner: undefined });
    const testResults: TestResultSummary = {
      passed: 1, failed: 0, skipped: 0, duration: 10,
      assertions: [{ name: 'test1', passed: true }],
      runAt: new Date(),
    };
    const result = certifier.evaluate(block, testResults);
    expect(result.certified).toBe(false);
    expect(result.errors.some((e) => e.rule === 'Block has owner')).toBe(true);
  });

  it('rejects block with failing tests', () => {
    const certifier = new Certifier();
    const block = makeBlock({ description: 'Test' });
    const testResults: TestResultSummary = {
      passed: 1, failed: 1, skipped: 0, duration: 50,
      assertions: [
        { name: 'test1', passed: true },
        { name: 'test2', passed: false, error: 'failed' },
      ],
      runAt: new Date(),
    };

    const result = certifier.evaluate(block, testResults);
    expect(result.certified).toBe(false);
    expect(result.errors.some((e) => e.rule === 'All tests pass')).toBe(true);
  });

  it('warns about missing tags', () => {
    const certifier = new Certifier();
    const block = makeBlock({ description: 'Test', tags: [] });
    const testResults: TestResultSummary = {
      passed: 1, failed: 0, skipped: 0, duration: 10,
      assertions: [{ name: 'test1', passed: true }],
      runAt: new Date(),
    };

    const result = certifier.evaluate(block, testResults);
    expect(result.certified).toBe(true); // warnings don't block certification
    expect(result.warnings.some((w) => w.rule === 'Block has tags')).toBe(true);
  });

  it('rejects promotable certification for draft-only git paths', () => {
    const certifier = new Certifier(PROMOTABLE_RULES);
    const block = makeBlock({
      description: 'Test',
      gitPath: 'blocks/_drafts/revenue/test-block.dql',
    });
    const testResults: TestResultSummary = {
      passed: 1, failed: 0, skipped: 0, duration: 10,
      assertions: [{ name: 'test1', passed: true }],
      runAt: new Date(),
    };

    const result = certifier.evaluate(block, testResults);
    expect(result.certified).toBe(false);
    expect(result.errors.some((e) => e.rule === 'Block is in a canonical Git path')).toBe(true);
  });
});

describe('CostEstimator', () => {
  it('gives low score to simple filtered query', () => {
    const estimator = new CostEstimator();
    const result = estimator.estimate('SELECT * FROM orders WHERE id = 1 LIMIT 10');
    expect(result.score).toBeLessThan(20);
  });

  it('penalizes full table scan', () => {
    const estimator = new CostEstimator();
    const result = estimator.estimate('SELECT * FROM orders');
    expect(result.factors.some((f) => f.name === 'no-filter')).toBe(true);
    expect(result.score).toBeGreaterThan(20);
  });

  it('penalizes JOINs', () => {
    const estimator = new CostEstimator();
    const result = estimator.estimate('SELECT * FROM orders JOIN customers ON orders.cid = customers.id WHERE 1=1');
    expect(result.factors.some((f) => f.name === 'joins')).toBe(true);
  });

  it('penalizes CROSS JOIN heavily', () => {
    const estimator = new CostEstimator();
    const result = estimator.estimate('SELECT * FROM a CROSS JOIN b WHERE 1=1');
    expect(result.factors.some((f) => f.name === 'cross-join')).toBe(true);
    expect(result.score).toBeGreaterThan(40);
  });

  it('detects subqueries', () => {
    const estimator = new CostEstimator();
    const result = estimator.estimate('SELECT * FROM (SELECT id FROM orders) sub WHERE 1=1');
    expect(result.factors.some((f) => f.name === 'subqueries')).toBe(true);
  });
});

describe('PolicyEngine', () => {
  it('allows access when no policies exist', () => {
    const engine = new PolicyEngine();
    const result = engine.checkAccess(
      { userId: 'user1', roles: ['analyst'] },
      'revenue',
      'internal',
    );
    expect(result.allowed).toBe(true);
  });

  it('allows access when user has matching role', () => {
    const engine = new PolicyEngine([
      {
        id: 'p1',
        name: 'Revenue access',
        description: 'Analysts can read revenue data',
        domain: 'revenue',
        minClassification: 'internal',
        allowedRoles: ['analyst'],
        allowedUsers: [],
        accessLevel: 'read',
        enabled: true,
      },
    ]);

    const result = engine.checkAccess(
      { userId: 'user1', roles: ['analyst'] },
      'revenue',
      'internal',
    );
    expect(result.allowed).toBe(true);
  });

  it('denies access when user lacks role', () => {
    const engine = new PolicyEngine([
      {
        id: 'p1',
        name: 'Restricted access',
        description: 'Only admins',
        domain: 'revenue',
        minClassification: 'confidential',
        allowedRoles: ['admin'],
        allowedUsers: [],
        accessLevel: 'read',
        enabled: true,
      },
    ]);

    const result = engine.checkAccess(
      { userId: 'user1', roles: ['analyst'] },
      'revenue',
      'confidential',
    );
    expect(result.allowed).toBe(false);
  });

  it('allows explicit user override', () => {
    const engine = new PolicyEngine([
      {
        id: 'p1',
        name: 'VIP access',
        description: 'Specific user allowed',
        domain: 'revenue',
        minClassification: 'restricted',
        allowedRoles: [],
        allowedUsers: ['cxo-jane'],
        accessLevel: 'read',
        enabled: true,
      },
    ]);

    const result = engine.checkAccess(
      { userId: 'cxo-jane', roles: [] },
      'revenue',
      'restricted',
    );
    expect(result.allowed).toBe(true);
  });

  it('classifies data based on table map', () => {
    const engine = new PolicyEngine();
    const cls = engine.classifyData(
      ['orders', 'salary_data', 'products'],
      { orders: 'internal', salary_data: 'restricted', products: 'public' },
    );
    expect(cls).toBe('restricted');
  });
});
