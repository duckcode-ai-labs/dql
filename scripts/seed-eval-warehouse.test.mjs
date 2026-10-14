import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const seedScript = join(repoRoot, 'scripts', 'seed-eval-warehouse.mjs');

test('seeds through an explicit disposable connector root', () => {
  const root = mkdtempSync(join(tmpdir(), 'dql-seed-connectors-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"private":true}\n');
    const moduleDir = join(root, 'node_modules', 'duckdb');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, 'index.js'), `
      const fs = require('node:fs');
      class Database {
        constructor(path) { this.path = path; fs.writeFileSync(path, 'fake duckdb'); }
        connect() { return { run(sql, done) { if ((process.env.ZLENS_TEST_SEED_SQL_LOG ?? process.env.DQL_TEST_SEED_SQL_LOG)) fs.appendFileSync((process.env.ZLENS_TEST_SEED_SQL_LOG ?? process.env.DQL_TEST_SEED_SQL_LOG), sql + '\\n'); done(null); }, close(done) { done(null); } }; }
        close(done) { done(null); }
      }
      module.exports = { Database };
    `);

    const out = join(root, 'seeded.duckdb');
    const sqlLog = join(root, 'seed.sql');
    const result = spawnSync(process.execPath, [seedScript, '--connector-root', root, '--out', out], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ZLENS_TEST_SEED_SQL_LOG: sqlLog },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Seeded 4 tables/);
    assert.equal(readFileSync(out, 'utf8'), 'fake duckdb');
    const statements = readFileSync(sqlLog, 'utf8');
    assert.match(statements, /CREATE TABLE "dim_customers"/);
    assert.doesNotMatch(statements, /CREATE SCHEMA|"dev"\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not resolve DuckDB from a parent of an explicit connector root', () => {
  const root = mkdtempSync(join(tmpdir(), 'dql-seed-ambient-'));
  try {
    const connectorRoot = join(root, 'connector');
    mkdirSync(connectorRoot, { recursive: true });
    writeFileSync(join(connectorRoot, 'package.json'), '{"private":true}\n');
    const ambientModuleDir = join(root, 'node_modules', 'duckdb');
    mkdirSync(ambientModuleDir, { recursive: true });
    writeFileSync(join(ambientModuleDir, 'index.js'), `
      const fs = require('node:fs');
      class Database {
        constructor(path) { fs.writeFileSync(path, 'ambient duckdb'); }
        connect() { return { run(_sql, done) { done(null); }, close(done) { done(null); } }; }
        close(done) { done(null); }
      }
      module.exports = { Database };
    `);

    const out = join(root, 'seeded.duckdb');
    const result = spawnSync(process.execPath, [seedScript, '--connector-root', connectorRoot, '--out', out], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duckdb is not installed/i);
    assert.doesNotMatch(result.stdout, /Seeded 4 tables/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const integrationConnectorRoot = (process.env.ZLENS_TEST_DUCKDB_CONNECTOR_ROOT ?? process.env.DQL_TEST_DUCKDB_CONNECTOR_ROOT);

test('seeds the manifest-qualified DuckDB catalog and schema with the pinned connector root', {
  skip: integrationConnectorRoot ? false : 'set ZLENS_TEST_DUCKDB_CONNECTOR_ROOT to the pinned disposable DuckDB root',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dql-seed-qualified-'));
  try {
    const out = join(root, 'jaffle_shop.duckdb');
    const seed = spawnSync(process.execPath, [
      seedScript,
      '--connector-root', integrationConnectorRoot,
      '--out', out,
      '--schema', 'dev',
    ], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);

    const connectorRoot = realpathSync(integrationConnectorRoot);
    const requireFromConnector = createRequire(join(connectorRoot, 'package.json'));
    const duckdb = requireFromConnector(realpathSync(requireFromConnector.resolve('duckdb')));
    const db = new duckdb.Database(out);
    const connection = db.connect();
    const all = (sql) => new Promise((resolveRows, rejectRows) => connection.all(sql, (error, rows) => error ? rejectRows(error) : resolveRows(rows)));
    try {
      const tables = await all([
        'SELECT table_catalog, table_schema, table_name',
        'FROM information_schema.tables',
        "WHERE table_catalog = 'jaffle_shop' AND table_schema = 'dev'",
        'ORDER BY table_name',
      ].join(' '));
      assert.deepEqual(tables, [
        { table_catalog: 'jaffle_shop', table_schema: 'dev', table_name: 'dim_customers' },
        { table_catalog: 'jaffle_shop', table_schema: 'dev', table_name: 'fct_orders' },
        { table_catalog: 'jaffle_shop', table_schema: 'dev', table_name: 'order_items' },
        { table_catalog: 'jaffle_shop', table_schema: 'dev', table_name: 'supplies' },
      ]);
      const orderCounts = await all([
        'SELECT customer_name AS customer_name, count_lifetime_orders AS count_lifetime_orders',
        'FROM jaffle_shop.dev.dim_customers',
        'ORDER BY customer_name',
      ].join(' '));
      assert.deepEqual(orderCounts, [
        { customer_name: 'Alice', count_lifetime_orders: 2 },
        { customer_name: 'Bob', count_lifetime_orders: 1 },
        { customer_name: 'Carol', count_lifetime_orders: 1 },
      ]);
    } finally {
      await new Promise((resolveClose, rejectClose) => connection.close((error) => error ? rejectClose(error) : resolveClose()));
      await new Promise((resolveClose, rejectClose) => db.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
