#!/usr/bin/env node

/**
 * Run the built Ask host against the external MetricFlow fixture.
 *
 * The interpreter is deliberately deterministic.  It proves the product
 * boundary after interpretation: the built host loads the compiled DQL
 * manifest, loads the sibling dbt semantic layer, asks the real local
 * MetricFlow compiler for SQL, validates/binds it, and executes it through
 * the real DuckDB connector.  This is not a substitute for a live provider
 * acceptance test, and it never contacts an external model.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repoRoot = resolve(fixtureRoot, '../../../../..');
const root = process.argv[2];
if (!root) throw new Error('Usage: run-built-ask.mjs <temporary-fixture-root>');

const workspace = join(root, 'workspace');
const dbtRoot = join(root, 'dbt');
const database = (process.env.ZLENS_MANIFEST_ONLY_METRICFLOW_DB ?? process.env.DQL_MANIFEST_ONLY_METRICFLOW_DB) ?? join(dbtRoot, 'target', 'manifest_only_metricflow.duckdb');
const manifest = JSON.parse(readFileSync(join(workspace, 'dql-manifest.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(workspace, 'dql.config.json'), 'utf8'));

const hostModule = await import(pathToFileURL(join(repoRoot, 'apps/cli/dist/ask-pipeline-host/host.js')).href);
const runtimeModule = await import(pathToFileURL(join(repoRoot, 'apps/cli/dist/semantic-runtime.js')).href);
const coreModule = await import(pathToFileURL(join(repoRoot, 'packages/dql-core/dist/index.js')).href);
await import(pathToFileURL(join(repoRoot, 'packages/dql-connectors/dist/index.js')).href);

const semanticLayer = coreModule.resolveSemanticLayer({ provider: 'dbt', projectPath: '../dbt' }, workspace);
if (!semanticLayer) throw new Error('The external dbt semantic layer did not load.');

const connection = { driver: 'duckdb', filepath: database };
const configuredDbt = (process.env.ZLENS_MANIFEST_ONLY_DBT_BIN ?? process.env.DQL_MANIFEST_ONLY_DBT_BIN);
const python = (process.env.ZLENS_MANIFEST_ONLY_PYTHON ?? process.env.DQL_MANIFEST_ONLY_PYTHON)
  ?? (configuredDbt && configuredDbt.includes('/') ? join(dirname(resolve(configuredDbt)), 'python') : undefined);
if (!python) {
  throw new Error('Set ZLENS_MANIFEST_ONLY_PYTHON, or set ZLENS_MANIFEST_ONLY_DBT_BIN to the matching dbt virtual-environment executable.');
}

// The local fixture runtime supplies DuckDB through the dbt/MetricFlow Python
// environment.  DQL deliberately keeps connectors optional, so the fixture
// cannot assume a repository-wide native `duckdb` module.  This tiny test
// adapter executes the exact SQL the built host received from real MetricFlow;
// it is not a SQL mock and is confined to this acceptance fixture.
const PYTHON_DUCKDB_EXECUTOR = [
  'import json, sys, duckdb',
  'payload = json.load(sys.stdin)',
  'conn = duckdb.connect(payload["database"], read_only=True)',
  'cursor = conn.execute(payload["sql"], payload.get("params") or [])',
  'columns = [item[0] for item in (cursor.description or [])]',
  'rows = [dict(zip(columns, row)) for row in cursor.fetchall()]',
  'print(json.dumps({"columns": columns, "rows": rows, "rowCount": len(rows)}, default=str))',
].join('; ');
const executor = {
  async executePositional(sql, params = []) {
    const started = performance.now();
    const result = spawnSync(python, ['-c', PYTHON_DUCKDB_EXECUTOR], {
      input: JSON.stringify({ database, sql, params }),
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Fixture DuckDB execution failed: ${(result.stderr || result.error?.message || '').trim()}`);
    }
    const parsed = JSON.parse(result.stdout);
    return { ...parsed, executionTimeMs: Math.round(performance.now() - started) };
  },
  async executeQuery(sql, _parameters, _variables, _connection, options) {
    return this.executePositional(sql, [], _connection, options);
  },
};
const compileSemantic = async (request) => {
  const compiled = await runtimeModule.compileSemanticRuntimeQuery({ ...request, engine: 'metricflow-cli' }, {
    projectRoot: workspace,
    projectConfig: config,
    detectedProvider: 'dbt',
    semanticLayer,
    driver: connection.driver,
    tableMapping: {},
  });
  if (!compiled) throw new Error(`MetricFlow could not compile ${request.metrics.join(', ')}.`);
  return { sql: compiled.sql, engine: compiled.engine };
};

function reading(payload) {
  return JSON.stringify({
    version: 1,
    kind: 'analytics',
    groupBy: [],
    display: [],
    filters: [],
    unresolved: [],
    provenance: {},
    expectedShape: 'scalar',
    ...payload,
  });
}

function runAsk(payload, question) {
  const provider = {
    name: 'fixture-interpreter',
    available: async () => true,
    generate: async () => reading(payload),
  };
  const ask = hostModule.createAskPipelineRouteExecutor({
    projectRoot: workspace,
    executor,
    resolveConnection: async () => connection,
    getSemanticLayer: () => semanticLayer,
    getManifest: () => ({ manifest, snapshotId: 'fixture:manifest-only' }),
    selectProvider: async () => provider,
    semanticEngine: async () => 'metricflow-cli',
    compileSemantic,
    priorIntent: () => undefined,
    autoExploration: true,
  });
  return ask({
    runId: `fixture-${Math.random().toString(16).slice(2)}`,
    request: { question, requestedMode: 'ask', runBudget: { hardDeadlineMs: Date.now() + 120_000 } },
    route: 'generated_answer',
    maxRepairAttempts: 0,
    attempt: 0,
    emit: () => {},
  });
}

function answered(result, label) {
  if (result.status !== 'completed' || !result.askPipelineReceipt) {
    throw new Error(`${label} did not complete through Ask: ${result.answer ?? result.error ?? JSON.stringify(result)}`);
  }
  const receipt = result.askPipelineReceipt;
  if (receipt.executed?.tier !== 'semantic') {
    throw new Error(`${label} used ${JSON.stringify(receipt.executed ?? 'no')} route, expected semantic. ${JSON.stringify(receipt.tiersTried)}`);
  }
  return result;
}

const totalPayload = {
  reading: 'Show total BCM.',
  measures: [{ ref: 'metric:bcm.total_bcm' }],
};
const coldStarted = performance.now();
const cold = answered(await runAsk(totalPayload, 'What is total BCM?'), 'cold total BCM');
const coldMs = Math.round(performance.now() - coldStarted);
const warmStarted = performance.now();
const warm = answered(await runAsk(totalPayload, 'What is total BCM?'), 'warm total BCM');
const warmMs = Math.round(performance.now() - warmStarted);

for (const result of [cold, warm]) {
  const rows = result.result?.rows ?? [];
  if (rows.length !== 1 || Number(rows[0]?.total_bcm) !== 700) {
    throw new Error(`Ask total BCM result diverged: ${JSON.stringify(result.result)}`);
  }
  if (result.result?.columns?.some((column) => column === 'metric_time' || column.startsWith('metric_time__'))) {
    throw new Error(`Ask scalar total BCM exposed an unexpected time column: ${JSON.stringify(result.result?.columns)}`);
  }
}

console.log(JSON.stringify({
  fixture: 'manifest-only-metricflow-built-ask',
  ask: {
    deterministicInterpreter: true,
    coldMs,
    warmMs,
    route: cold.askPipelineReceipt.executed?.tier,
    warehouse: cold.askPipelineReceipt.warehouse,
    shape: cold.result?.columns,
    rows: cold.result?.rows,
    bindings: cold.askPipelineReceipt.physicalBindings,
  },
}, null, 2));
