import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorQueryError, type ConnectionConfig, type QueryExecutor, type QueryResult } from '@zlens/connectors';
import type { SemanticRuntimeCompileResult } from '../semantic-runtime.js';
import { saveTestedSemanticRuntimeSettings } from '../semantic-runtime-settings.js';
import { createWarehouseTargetIdentity } from '@zlens/core';
import { executeTargetBoundSemanticQuery } from './execution-gateway.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dql-execution-gateway-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const connection: ConnectionConfig = {
  driver: 'snowflake',
  account: 'acme-prod',
  database: 'PROD',
  schema: 'SEMANTIC',
  role: 'ANALYST',
  warehouse: 'REPORTING',
};

function result(rows: Array<Record<string, unknown>>): QueryResult {
  return {
    columns: Object.keys(rows[0] ?? {}).map((name) => ({ name, type: 'string', driverType: 'TEXT' })),
    rows,
    rowCount: rows.length,
    executionTimeMs: 1,
  };
}

function compiled(engine: SemanticRuntimeCompileResult['engine'] = 'native'): SemanticRuntimeCompileResult {
  return {
    sql: 'SELECT 42 AS REVENUE',
    joins: [],
    tables: [],
    engine,
    effectiveRequest: { metrics: ['revenue'], dimensions: [] },
    semanticTrace: {
      version: 1,
      adapter: engine,
      status: 'compiled',
      authoringRequest: { metrics: ['revenue'], dimensions: [] },
      bindings: [],
      warnings: [],
      steps: [
        { id: 'resolve_members', label: 'Resolve', status: 'completed', detail: 'ok' },
        { id: 'bind_entity_paths', label: 'Bind', status: 'completed', detail: 'ok' },
        { id: 'compile_semantic_query', label: 'Compile', status: 'completed', detail: 'ok' },
        { id: 'execute_query', label: 'Execute', status: 'not_started', detail: 'pending' },
      ],
    },
  };
}

function observedSnowflakeTarget(database: string) {
  return {
    DQL_ACCOUNT: 'ACME-PROD',
    DQL_ACCOUNT_LOCATOR: 'XY12345',
    DQL_ACCOUNT_NAME: 'PROD',
    DQL_ORGANIZATION: 'ACME',
    DQL_DATABASE: database,
    DQL_SCHEMA: 'SEMANTIC',
    DQL_ROLE: 'ANALYST',
    DQL_WAREHOUSE: 'REPORTING',
  };
}

describe('target-bound semantic execution gateway', () => {
  it('uses one ordered identity, physical preflight, and bounded execution path', async () => {
    const sqlCalls: string[] = [];
    const executor = {
      executePositional: vi.fn(async (sql: string) => {
        sqlCalls.push(sql);
        if (sql.includes('CURRENT_ACCOUNT()')) {
          return result([observedSnowflakeTarget('PROD')]);
        }
        if (sql.startsWith('EXPLAIN USING TEXT')) return result([{ plan: 'ok' }]);
        return { ...result([{ REVENUE: 42 }]), queryId: 'query-123' };
      }),
    } as unknown as QueryExecutor;

    const execution = await executeTargetBoundSemanticQuery({
      executor,
      connection,
      projectRoot: root,
      plannedAdapter: 'native',
      compile: async () => compiled(),
      rowBound: 5,
    });

    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[0]).toContain('CURRENT_ACCOUNT()');
    expect(sqlCalls[1]).toBe('EXPLAIN USING TEXT SELECT 42 AS REVENUE');
    expect(sqlCalls[2]).toBe('SELECT 42 AS REVENUE');
    expect(execution?.executionReceipt).toMatchObject({
      adapterId: 'native',
      queryId: 'query-123',
      rowBound: 5,
      outcome: 'succeeded',
    });
    expect(execution?.semanticTrace.steps.map((step) => step.id)).toContain('preflight_physical_sql');
  });

  it('forwards the page-run abort signal through semantic preflight and execution', async () => {
    const controller = new AbortController();
    const optionSignals: Array<AbortSignal | undefined> = [];
    const executor = {
      executePositional: vi.fn(async (sql: string, _params: unknown[], _connection: unknown, options?: { signal?: AbortSignal }) => {
        optionSignals.push(options?.signal);
        if (sql.includes('CURRENT_ACCOUNT()')) return result([observedSnowflakeTarget('PROD')]);
        if (sql.startsWith('EXPLAIN USING TEXT')) return result([{ plan: 'ok' }]);
        return result([{ REVENUE: 42 }]);
      }),
    } as unknown as QueryExecutor;

    await executeTargetBoundSemanticQuery({
      executor,
      connection,
      projectRoot: root,
      plannedAdapter: 'native',
      compile: async () => compiled(),
      signal: controller.signal,
    });

    expect(optionSignals).toContain(controller.signal);
    controller.abort(new Error('new filter selection'));
    await expect(executeTargetBoundSemanticQuery({
      executor,
      connection,
      projectRoot: root,
      plannedAdapter: 'native',
      compile: async () => compiled(),
      signal: controller.signal,
    })).rejects.toThrow('new filter selection');
  });

  it('uses an injected private final-statement executor without bypassing target binding', async () => {
    const sqlCalls: string[] = [];
    const scopedCalls: string[] = [];
    const executor = {
      executePositional: vi.fn(async (sql: string) => {
        sqlCalls.push(sql);
        if (sql.includes('CURRENT_ACCOUNT()')) return result([observedSnowflakeTarget('PROD')]);
        if (sql.startsWith('EXPLAIN USING TEXT')) return result([{ plan: 'ok' }]);
        throw new Error('the shared executor must not run the final semantic statement');
      }),
    } as unknown as QueryExecutor;

    const execution = await executeTargetBoundSemanticQuery({
      executor,
      connection,
      projectRoot: root,
      plannedAdapter: 'native',
      compile: async () => compiled(),
      executePrepared: async ({ sql, connection: preparedConnection, options }) => {
        scopedCalls.push(sql);
        expect(preparedConnection).toEqual(connection);
        expect(options.maxRows).toBe(10_000);
        return result([{ REVENUE: 42 }]);
      },
    });

    expect(sqlCalls).toEqual([
      expect.stringContaining('CURRENT_ACCOUNT()'),
      'EXPLAIN USING TEXT SELECT 42 AS REVENUE',
    ]);
    expect(scopedCalls).toEqual(['SELECT 42 AS REVENUE']);
    expect(execution?.result.rows).toEqual([{ REVENUE: 42 }]);
  });

  it('rejects target drift before calling the selected dbt Cloud compiler', async () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'semantic-layer.cloud.getdbt.com',
        environmentId: '99',
        serviceToken: 'secret',
      },
    }, {
      ok: true,
      message: 'ok',
      dialect: 'snowflake',
      metricCount: 1,
      metricNames: ['revenue'],
      semanticCatalogFingerprint: 'cloud-catalog-99',
      metricInventoryComplete: true,
    }, createWarehouseTargetIdentity({
      connectionRef: 'connection:prod',
      driver: 'snowflake',
      redactedContext: {
        account: 'ACME-PROD',
        database: 'PROD',
        schema: 'SEMANTIC',
        role: 'ANALYST',
        warehouse: 'REPORTING',
      },
    }));
    const compile = vi.fn(async () => compiled('dbt-cloud'));
    const executor = {
      executePositional: vi.fn(async () => result([observedSnowflakeTarget('DEV')])),
    } as unknown as QueryExecutor;

    await expect(executeTargetBoundSemanticQuery({
      executor,
      connection: { ...connection, database: 'DEV' },
      projectRoot: root,
      plannedAdapter: 'dbt-cloud',
      compile,
    })).rejects.toMatchObject({ code: 'EXECUTION_TARGET_MISMATCH' });
    expect(compile).not.toHaveBeenCalled();
  });

  it('API-007/UI-012 preserves the invalid identifier and bounded SQL context from physical preflight', async () => {
    const executor = {
      executePositional: vi.fn(async (sql: string) => {
        if (sql.includes('CURRENT_ACCOUNT()')) {
          return result([observedSnowflakeTarget('PROD')]);
        }
        throw new ConnectorQueryError({
          driver: 'snowflake',
          message: "SQL compilation error: error line 5 at position 8 invalid identifier 'CDM.BCM_ADJUSTMENT_TYPE'",
          line: 5,
          position: 8,
        });
      }),
    } as unknown as QueryExecutor;
    const query = [
      'WITH cdm AS (',
      '  SELECT',
      '    account_id,',
      '    amount,',
      '    CDM.BCM_ADJUSTMENT_TYPE',
      '  FROM analytics.consumption_daily_metrics CDM',
      ')',
      'SELECT * FROM cdm',
    ].join('\n');

    await expect(executeTargetBoundSemanticQuery({
      executor,
      connection,
      projectRoot: root,
      plannedAdapter: 'native',
      compile: async () => ({ ...compiled(), sql: query }),
    })).rejects.toMatchObject({
      code: 'IDENTIFIER_SCOPE_INVALID',
      details: {
        identifier: 'CDM.BCM_ADJUSTMENT_TYPE',
        line: 5,
        position: 8,
        compiledSql: query,
        compiledSqlTruncated: false,
        sqlExcerpt: {
          startLine: 2,
          endLine: 8,
          text: expect.stringContaining('5 |     CDM.BCM_ADJUSTMENT_TYPE'),
        },
        targetBinding: {
          adapterId: 'native',
        },
      },
    });
  });
});
