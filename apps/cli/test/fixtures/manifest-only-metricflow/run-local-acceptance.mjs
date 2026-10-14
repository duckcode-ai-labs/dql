#!/usr/bin/env node

/**
 * Executable acceptance gate for the manifest-only fixture.
 *
 * It deliberately creates all dbt and DQL state under /tmp, never in the
 * repository fixture.  It has three independent proofs:
 *   1. dbt builds the external project and the generated manifest has >50k
 *      columns (the generator refuses a missing opportunity model);
 *   2. the built ZLens CLI compiles that manifest without a DQL domain/block;
 *   3. the configured local MetricFlow runtime executes the authored metric
 *      twice, returns one scalar `total_bcm` value of 700, and records cold /
 *      warm wall times.
 *
 * This runner never installs adapters or changes a local runtime. A missing
 * `dbt-metricflow[dbt-duckdb]` adapter is an environment gate, not a fixture
 * pass. Snowflake target behaviour is covered by target-bound mock tests;
 * this fixture is intentionally a local DuckDB MetricFlow proof.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(fixtureRoot, '../../../../..');
const cli = (process.env.ZLENS_MANIFEST_ONLY_CLI ?? process.env.DQL_MANIFEST_ONLY_CLI) ?? join(repoRoot, 'apps/cli/dist/index.js');
const mf = (process.env.ZLENS_METRICFLOW_BIN ?? process.env.DQL_METRICFLOW_BIN) ?? process.env.METRICFLOW_BIN ?? 'mf';
const dbtBin = (process.env.ZLENS_MANIFEST_ONLY_DBT_BIN ?? process.env.DQL_MANIFEST_ONLY_DBT_BIN) ?? 'dbt';

function run(command, args, options = {}) {
  const start = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
  const ms = Math.round(performance.now() - start);
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const adapterMissing = /Could not find adapter type duckdb|dbt-metricflow\[dbt-duckdb\]/i.test(detail);
    const hint = adapterMissing
      ? '\nThe installed MetricFlow CLI does not include its DuckDB adapter. Install it in the same MetricFlow runtime, then rerun; this script does not mutate runtimes.'
      : '';
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error?.message ?? 'unknown'}):\n${detail}${hint}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', ms };
}

function readCsv(path) {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',').map((value) => value.trim());
  const rows = lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, line.split(',')[index]?.trim() ?? ''])));
  return { headers, rows };
}

function scalar(path, metric, expected) {
  const result = readCsv(path);
  if (result.rows.length !== 1) throw new Error(`Expected one scalar MetricFlow row for ${metric}, received ${result.rows.length}.`);
  if (result.headers.includes('metric_time')) throw new Error(`MetricFlow added metric_time to scalar ${metric}. The output shape changed.`);
  const actual = Number(result.rows[0]?.[metric]);
  if (actual !== expected) throw new Error(`Expected ${metric} = ${expected}, received ${result.rows[0]?.[metric] ?? '(missing)'}.`);
  return { shape: result.headers, value: actual };
}

if (!existsSync(cli)) {
  throw new Error(`Built ZLens CLI not found at ${cli}. Run \`pnpm --filter @zlens/cli build\` first, or set ZLENS_MANIFEST_ONLY_CLI.`);
}

const root = mkdtempSync(join(tmpdir(), 'dql-manifest-only-metricflow-'));
try {
  cpSync(join(fixtureRoot, 'dbt'), join(root, 'dbt'), { recursive: true });
  cpSync(join(fixtureRoot, 'workspace'), join(root, 'workspace'), { recursive: true });
  const dbtRoot = join(root, 'dbt');
  const workspace = join(root, 'workspace');
  const database = join(dbtRoot, 'target', 'manifest_only_metricflow.duckdb');
  const manifest = join(dbtRoot, 'target', 'manifest.json');
  const enterpriseManifest = join(dbtRoot, 'target', 'manifest.enterprise.json');
  const dbtEnv = { ZLENS_MANIFEST_ONLY_METRICFLOW_DB: database };

  const dbtBuild = run(dbtBin, ['build', '--project-dir', dbtRoot, '--profiles-dir', dbtRoot], { env: dbtEnv });
  run(process.execPath, [join(fixtureRoot, 'generate-enterprise-manifest.mjs'), manifest, enterpriseManifest]);
  const compile = run(process.execPath, [cli, 'compile', workspace, '--dbt-manifest', enterpriseManifest, '--no-cache']);
  console.log('dbt build and built-DQL manifest compile passed; running local MetricFlow acceptance queries.');

  const query = (name, args) => {
    const csv = join(root, `${name}.csv`);
    const timing = run(mf, ['query', ...args, '--csv', csv, '--quiet'], { cwd: dbtRoot, env: { ...dbtEnv, DBT_PROFILES_DIR: dbtRoot } });
    return { ...timing, csv };
  };
  const coldCsv = join(root, 'cold.csv');
  const cold = run(mf, ['query', '--metrics', 'total_bcm', '--csv', coldCsv, '--quiet'], { cwd: dbtRoot, env: { ...dbtEnv, DBT_PROFILES_DIR: dbtRoot } });
  const total = scalar(coldCsv, 'total_bcm', 700);

  const top = query('top-customers', ['--metrics', 'total_bcm', '--group-by', 'customer__customer_name', '--order', '-total_bcm', '--limit', '3']);
  const topRows = readCsv(top.csv);
  if (JSON.stringify(topRows.rows.map((row) => [row.customer__customer_name, Number(row.total_bcm)])) !== JSON.stringify([['Capital One', 300], ['Mercadolibre', 200], ['Genesys Telecommunications', 110]])) {
    throw new Error(`Top-customer semantic result diverged: ${JSON.stringify(topRows.rows)}.`);
  }

  const lost = query('lost-opportunities', [
    '--metrics', 'lost_opportunity_count,lost_amount', '--group-by', 'metric_time__month',
    '--where', "{{ Dimension('opportunity__fiscal_year') }} = 'FY26'",
    '--where', "{{ Dimension('opportunity__competitor') }} = 'Splunk'",
  ]);
  const lostRows = readCsv(lost.csv);
  // No ordering was requested for this monthly result. MetricFlow's adapter
  // may emit the same two periods in either physical order, so compare the
  // declared members and values rather than mistaking adapter row order for
  // a business-result difference.
  const lostActual = lostRows.rows
    .map((row) => [String(row.metric_time__month ?? '').slice(0, 10), Number(row.lost_opportunity_count), Number(row.lost_amount)])
    .sort(([left], [right]) => left.localeCompare(right));
  const lostExpected = [['2026-09-01', 1, 1000], ['2026-10-01', 1, 500]];
  if (JSON.stringify(lostActual) !== JSON.stringify(lostExpected)) {
    throw new Error(`FY26/Splunk lost-opportunity result diverged: ${JSON.stringify(lostRows.rows)}.`);
  }

  const dod = query('dod', ['--metrics', 'dod_ccu_bcm_change_qty,dod_ccu_bcm_change_pct']);
  const dodRows = readCsv(dod.csv);
  if (dodRows.rows.length !== 1 || Number(dodRows.rows[0]?.dod_ccu_bcm_change_qty) !== 20 || Number(dodRows.rows[0]?.dod_ccu_bcm_change_pct) !== 0.2) {
    throw new Error(`DOD quantity/percentage result diverged: ${JSON.stringify(dodRows.rows)}.`);
  }

  const capitalOne = ["--where", "{{ Dimension('customer__customer_name') }} = 'Capital One'"];
  const current = query('capital-one-current-month', ['--metrics', 'total_bcm', ...capitalOne, '--start-time', '2026-09-01', '--end-time', '2026-09-30']);
  const previous = query('capital-one-previous-month', ['--metrics', 'total_bcm', ...capitalOne, '--start-time', '2026-08-01', '--end-time', '2026-08-31']);
  const currentBcm = scalar(current.csv, 'total_bcm', 120);
  const previousBcm = scalar(previous.csv, 'total_bcm', 100);
  if ((currentBcm.value - previousBcm.value) / previousBcm.value !== 0.2) throw new Error('Current/previous-month comparison arithmetic diverged.');

  const yoy = query('capital-one-yoy', [
    '--metrics', 'total_bcm,previous_year_bcm', '--group-by', 'metric_time__month', ...capitalOne,
    '--start-time', '2026-09-01', '--end-time', '2026-09-30',
  ]);
  const yoyRows = readCsv(yoy.csv);
  if (yoyRows.rows.length !== 1 || Number(yoyRows.rows[0]?.total_bcm) !== 120 || Number(yoyRows.rows[0]?.previous_year_bcm) !== 80) {
    throw new Error(`Authored previous-year MetricFlow result diverged: ${JSON.stringify(yoyRows.rows)}.`);
  }
  if ((Number(yoyRows.rows[0].total_bcm) - Number(yoyRows.rows[0].previous_year_bcm)) / Number(yoyRows.rows[0].previous_year_bcm) !== 0.5) {
    throw new Error('Year-over-year comparison arithmetic diverged.');
  }

  const warmCsv = join(root, 'warm.csv');
  const warm = run(mf, ['query', '--metrics', 'total_bcm', '--csv', warmCsv, '--quiet'], { cwd: dbtRoot, env: { ...dbtEnv, DBT_PROFILES_DIR: dbtRoot } });
  const warmTotal = scalar(warmCsv, 'total_bcm', 700);

  console.log(JSON.stringify({
    fixture: 'manifest-only-metricflow',
    dbtBuildMs: dbtBuild.ms,
    dqlCompileMs: compile.ms,
    metricFlow: {
      coldMs: cold.ms, warmMs: warm.ms, scalar: total,
      routes: {
        topCustomers: { shape: topRows.headers, rows: topRows.rows },
        lostOpportunities: { shape: lostRows.headers, rows: lostRows.rows },
        dod: { shape: dodRows.headers, rows: dodRows.rows },
        currentPreviousMonth: { current: currentBcm.value, previous: previousBcm.value, change: 0.2 },
        authoredYearOverYear: { shape: yoyRows.headers, current: 120, previous: 80, change: 0.5, compilerSupportGrain: 'metric_time__month' },
      },
    },
    warm: { shape: warmTotal.shape, totalBcm: warmTotal.value },
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
