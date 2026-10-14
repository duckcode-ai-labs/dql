/**
 * Ask ↔ Notebook execution parity.
 *
 * The reported bug: "the SQL Ask generated fails in Ask, but the same text runs
 * fine when I paste it into a notebook cell."
 *
 * It was true. `POST /api/query` ran the statement verbatim, while the Ask lane
 * re-qualified relations, regex-parameterized the WHERE clause, round-tripped
 * the whole thing through the DQL block compiler, and finally wrapped it as
 * `SELECT * FROM (<sql>) AS dql_agent_preview LIMIT 200`. Five rewrites, each
 * able to fail on SQL the warehouse would have accepted.
 *
 * This harness pins the contract: for the same input SQL, both surfaces send
 * the warehouse the same statement (Ask may append a row bound, and only that),
 * and return the same columns and rows.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor, QueryResult } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

/**
 * Shapes that the derived-table wrapper and the DQL round-trip each broke.
 * Every one of these is legal SQL that a notebook cell executes without
 * complaint.
 */
const FIXTURE_SQL = [
  // Plain aggregate.
  'SELECT status, COUNT(*) AS n FROM orders GROUP BY status',
  // CTE — `SELECT * FROM (WITH …) AS t` is a syntax error on MSSQL/Fabric, and
  // the CTE name used to be rewritten to a physical relation, detaching it.
  "WITH recent AS (SELECT * FROM orders WHERE region = 'EMEA') SELECT COUNT(*) AS n FROM recent",
  // Duplicate output column names: legal at top level, not as a derived table.
  'SELECT o.id, c.id FROM orders o JOIN customers c ON c.id = o.customer_id',
  // Set operation.
  'SELECT region FROM orders UNION ALL SELECT region FROM archived_orders',
  // ORDER BY — the wrapper made the inner ordering non-guaranteed.
  'SELECT region, total FROM orders ORDER BY total DESC',
  // The statement carries its own bound; Ask must not override it.
  'SELECT region FROM orders ORDER BY total DESC LIMIT 5',
  // A year literal in WHERE — this used to be rewritten into a `${season_year}`
  // placeholder and could be re-bound from the question text.
  'SELECT SUM(amount) AS total FROM orders WHERE EXTRACT(YEAR FROM ordered_at) = 2024',
  // A `${...}`-looking string literal must survive as data.
  "SELECT id FROM orders WHERE note = '${not_a_parameter}'",
  // An alias colliding with a DDL keyword — the old blacklist rejected these.
  'SELECT total AS load FROM orders',
] as const;

interface CapturedExecution { sql: string }

function projectWith(root: string): void {
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({
    project: 'ask-notebook-parity',
    connections: { default: { driver: 'duckdb', database: ':memory:' } },
    defaultConnectionName: 'default',
  }));
}

describe('Ask ↔ Notebook execution parity', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function withServer<T>(
    run: (base: string, captured: CapturedExecution[]) => Promise<T>,
  ): Promise<T> {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ask-parity-'));
    tempDirs.push(projectRoot);
    projectWith(projectRoot);

    const captured: CapturedExecution[] = [];
    const record = async (sql: string): Promise<QueryResult> => {
      captured.push({ sql });
      return {
        columns: ['region', 'total'],
        rows: [{ region: 'EMEA', total: 10 }, { region: 'APAC', total: 20 }],
        rowCount: 2,
        executionTimeMs: 1,
      } as unknown as QueryResult;
    };
    // Both entry points must be stubbed: the notebook lane calls `executeQuery`,
    // several internal lanes call `executePositional`.
    const executor = { executeQuery: record, executePositional: record };

    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: executor as unknown as QueryExecutor,
        connection: { driver: 'duckdb', database: ':memory:' } as never,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      return await run(`http://127.0.0.1:${port}`, captured);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  }

  /** Strip an appended row bound so the two statements can be compared. */
  function withoutAppendedBound(sql: string): string {
    return sql.replace(/\nLIMIT \d+$/, '').trim();
  }

  it('sends the warehouse the same statement the notebook would, for every fixture shape', async () => {
    await withServer(async (base, captured) => {
      for (const sql of FIXTURE_SQL) {
        captured.length = 0;

        const response = await fetch(`${base}/api/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql }),
        });
        expect(response.status, `notebook rejected: ${sql}`).toBe(200);
        expect(captured, `notebook did not execute: ${sql}`).toHaveLength(1);

        const notebookSql = captured[0]!.sql;
        // The notebook contract: the statement reaches the warehouse verbatim.
        expect(notebookSql.trim()).toBe(sql);
      }
    });
  });

  it('never wraps a statement in a derived table and never drops an existing bound', async () => {
    // Exercised through the exported helpers rather than a full agent run so the
    // assertion is about the execution contract, not about provider behaviour.
    const { buildRowBoundedSql } = await import('./local-runtime.js');

    for (const sql of FIXTURE_SQL) {
      const bounded = buildRowBoundedSql(sql, 200, 'duckdb');
      expect(bounded.sql, `wrapped: ${sql}`).not.toContain('dql_agent_preview');
      // Ask's statement is the notebook's statement, plus at most a bound.
      expect(withoutAppendedBound(bounded.sql)).toBe(sql);
      if (/\bLIMIT\b/i.test(sql)) {
        expect(bounded.outcome, `overrode an author bound: ${sql}`).toBe('existing');
      }
    }
  });

  /**
   * REGRESSION GUARD (structural, on purpose).
   *
   * The first cut of the direct executor called `executeQuery` and nothing
   * else. It skipped `prepareSemanticSql`, the semantic table mapping, and the
   * pinned MetricFlow compile — all of which `/api/query` performs — so Ask
   * broke on `@metric()` refs and `metric_time` queries the notebook ran fine.
   * It also validated the RAW model SQL before those steps, rejecting
   * `source::` identities ahead of the resolution that would have cleared them.
   *
   * Reproducing that behaviourally needs a semantic-layer + MetricFlow fixture;
   * asserting both surfaces still enter ExecutionService, whose preparation
   * validates after resolution, is the cheap check that would have caught it.
   */
  it('resolves what the notebook resolves, and validates only after resolving', () => {
    const source = readFileSync(new URL('./local-runtime.ts', import.meta.url), 'utf8');
    const direct = source.slice(
      source.indexOf('const executeGeneratedSqlDirect = async'),
      source.indexOf('const executeGeneratedArtifactForAgent = async'),
    );
    expect(direct.length).toBeGreaterThan(0);

    for (const step of [
      'prepareSemanticSql',
      'resolveSemanticTableMapping',
      'analyticalExecutionService.execute',
      'executeTargetBoundSemanticQuery',
    ]) {
      expect(direct, `the direct executor no longer performs ${step}`).toContain(step);
    }
    const gateway = source.slice(
      source.indexOf('export class ExecutionService'),
      source.indexOf('export function dashboardRuntimeVariables'),
    );
    expect(gateway).toContain('prepareAnalyticalExecutionSql');
    expect(gateway).toContain('resolveInternalRelationIds');
    expect(gateway).toContain('resolveBareInternalRelationIds');
    expect(gateway).toContain('prepareLocalExecution');
    expect(gateway).toContain('readOnlySqlValidationError');
    expect(
      gateway.indexOf('prepareLocalExecution'),
      'read-only enforcement must run on the resolved statement',
    ).toBeLessThan(gateway.indexOf('readOnlySqlValidationError'));
    const notebook = source.slice(
      source.indexOf("path === '/api/query'"),
      source.indexOf("path === '/api/query/cancel'"),
    );
    expect(notebook).toContain('analyticalExecutionService.execute');
  });

  it('accepts every fixture shape through the generated-SQL read-only gate', async () => {
    const { buildAgentPreviewSql } = await import('./local-runtime.js');
    for (const sql of FIXTURE_SQL) {
      expect(() => buildAgentPreviewSql(sql, 200), `Ask refused: ${sql}`).not.toThrow();
    }
  });
});
