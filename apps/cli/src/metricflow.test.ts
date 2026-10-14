import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compileMetricFlowQuery,
  composeMetricFlowFailure,
  hasMetricFlowCli,
  metricFlowCompileMode,
  MetricFlowUnavailableError,
  repairMetricFlowGroupBy,
  parseMetricFlowDimensionList,
  buildMetricFlowArgs,
  resolveSemanticManifestPath,
} from './metricflow.js';

describe('MetricFlow compile wrapper', () => {
  let tmpDir: string;
  let previousBin: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-mf-'));
    previousBin = process.env.ZLENS_METRICFLOW_BIN;
  });

  afterEach(() => {
    if (previousBin === undefined) {
      delete process.env.ZLENS_METRICFLOW_BIN;
    } else {
      process.env.ZLENS_METRICFLOW_BIN = previousBin;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compiles through mf and extracts SQL from mixed stdout', async () => {
    mkdirSync(join(tmpDir, 'target'), { recursive: true });
    writeFileSync(join(tmpDir, 'target', 'semantic_manifest.json'), '{}', 'utf-8');
    const bin = join(tmpDir, 'mf');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.13.0"; exit 0; fi',
        'printf "%s\\n" "$*" > args.txt',
        'printf "%s\\n" "info: compiling"',
        'printf "%s\\n" "SELECT metric_time, revenue FROM compiled_metric_sql"',
      ].join('\n'),
      'utf-8',
    );
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;

    const result = await compileMetricFlowQuery({
      projectRoot: tmpDir,
      metrics: ['revenue'],
      dimensions: ['region'],
      timeDimension: { name: 'metric_time', granularity: 'month' },
      filters: [{ expression: "{{ Dimension('region') }} = 'NA'" }],
      limit: 25,
    });

    expect(result.sql).toBe('SELECT metric_time, revenue FROM compiled_metric_sql');
    expect(result.command).toContain('--explain');
    expect(result.command).toContain('--quiet');
    expect(result.command).not.toContain('--compile');
    expect(result.command).toContain('--metrics');
    expect(hasMetricFlowCli()).toBe(true);
  });

  /**
   * The office freeze: `mf query` ran through `spawnSync` with no timeout, so a
   * single slow compile blocked Node's event loop and the whole server stopped
   * answering — diagnostics showed zero provider, tool and SQL activity for
   * ~45s because nothing at all could run. These three assertions are the
   * properties that failure needed: the compile yields, a deadline can end it,
   * and a cancelled run does not leave a child behind.
   */
  it('yields the event loop while MetricFlow runs', async () => {
    mkdirSync(join(tmpDir, 'target'), { recursive: true });
    writeFileSync(join(tmpDir, 'target', 'semantic_manifest.json'), '{}', 'utf-8');
    const bin = join(tmpDir, 'mf');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.13.0"; exit 0; fi',
        'sleep 1',
        'printf "%s\\n" "SELECT 1"',
      ].join('\n'),
      'utf-8',
    );
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;

    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 50);
    try {
      await compileMetricFlowQuery({ projectRoot: tmpDir, metrics: ['revenue'], dimensions: [] });
    } finally {
      clearInterval(ticker);
    }
    // A blocking spawnSync would have starved the timer completely.
    expect(ticks).toBeGreaterThan(2);
  });

  it('ends a compile that outlives its timeout instead of hanging the run', async () => {
    mkdirSync(join(tmpDir, 'target'), { recursive: true });
    writeFileSync(join(tmpDir, 'target', 'semantic_manifest.json'), '{}', 'utf-8');
    const bin = join(tmpDir, 'mf');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.13.0"; exit 0; fi',
        'sleep 30',
      ].join('\n'),
      'utf-8',
    );
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;
    const started = Date.now();
    await expect(compileMetricFlowQuery({
      projectRoot: tmpDir,
      metrics: ['revenue'],
      dimensions: [],
      timeoutMs: 300,
    })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('ends a compile when the run is cancelled', async () => {
    mkdirSync(join(tmpDir, 'target'), { recursive: true });
    writeFileSync(join(tmpDir, 'target', 'semantic_manifest.json'), '{}', 'utf-8');
    const bin = join(tmpDir, 'mf');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.13.0"; exit 0; fi',
        'sleep 30',
      ].join('\n'),
      'utf-8',
    );
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;
    const controller = new AbortController();
    const pending = compileMetricFlowQuery({
      projectRoot: tmpDir,
      metrics: ['revenue'],
      dimensions: [],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('keeps the legacy compile flag for older user-managed runtimes', () => {
    expect(metricFlowCompileMode('mf, version 0.13.0')).toBe('explain');
    expect(metricFlowCompileMode('mf, version 0.12.2')).toBe('legacy-compile');
    expect(metricFlowCompileMode('mf test')).toBe('legacy-compile');
  });

  it('returns a setup error when semantic_manifest.json is missing', async () => {
    await expect(compileMetricFlowQuery({
      projectRoot: tmpDir,
      metrics: ['revenue'],
      dimensions: [],
    })).rejects.toThrow(MetricFlowUnavailableError);
  });

  it('reports a missing MetricFlow executable as unavailable', () => {
    process.env.ZLENS_METRICFLOW_BIN = join(tmpDir, 'missing-mf');
    expect(hasMetricFlowCli()).toBe(false);
  });

  it('reports a failing MetricFlow executable as unavailable', () => {
    const bin = join(tmpDir, 'failing-mf');
    writeFileSync(bin, '#!/bin/sh\nexit 1\n', 'utf-8');
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;
    expect(hasMetricFlowCli()).toBe(false);
  });
});


describe('repairMetricFlowGroupBy (entity-qualified group-by retry)', () => {
  // Verbatim shape of the office failure: bare dimension name sent, MetricFlow
  // suggests the entity-qualified candidates.
  const OFFICE_ERROR = `ERROR: Got error(s) during query resolution.
Error #1: Message:
The given input does not match any of the available group-by-items for SimpleMetric('total_bcm'). Common issues are:
    Incorrect names.
    No valid join paths exist from the measure to the group-by-item.
Suggestions: [ 'bcm_hdr__effective_customer_account_name', 'bcm_tdp_pc__customer_account_id',
'bcm_hdr__customer_account_id', 'bcm_ccu_pc__customer_account_id',
'bcm_ccu_pc__bcm_dtl__customer_account_id', 'bcm_tdp_pc__bcm_dtl__customer_account_id', ]
Query Input:
effective_customer_account_name
Issue Location:
[Resolve Query(['percent_mom_bcm'])]`;

  const request = {
    projectRoot: '/tmp/p',
    metrics: ['total_bcm'],
    dimensions: ['effective_customer_account_name'],
    orderBy: [{ name: 'total_bcm', direction: 'desc' as const }],
    limit: 10,
  };

  it('rewrites the failing bare dimension to the unique qualified suggestion', () => {
    const repaired = repairMetricFlowGroupBy(request, OFFICE_ERROR);
    expect(repaired?.dimensions).toEqual(['bcm_hdr__effective_customer_account_name']);
    // Untouched fields survive.
    expect(repaired?.metrics).toEqual(['total_bcm']);
    expect(repaired?.limit).toBe(10);
  });

  it('repairs a --where filter on a dimension spelled by its semantic model, from the suggestion MetricFlow wraps in Dimension()', () => {
    // Verbatim shape of MetricFlow 0.13's filter failure: the input is named on
    // the "Object Builder Input" line and suggestions are Dimension('…') calls.
    const FILTER_ERROR = `ERROR: Got error(s) during query resolution.
Error #1:
  Message:
    The given input does not match any of the available group-by-items for
    SimpleMetric('total_policy_amount'). Common issues are:
      * Incorrect names.
    Suggestions:
      [
        "Dimension('policy_amount__has_premium')",
        "Dimension('policy__status_code')",
        "Dimension('policy__policy_number')",
      ]
  Query Input:
    WhereFilter(
      ["{{ Dimension('premium__has_premium') }} = 1"]
    )
    Filter Path:
      [Resolve Query(['total_policy_amount'])]
    Object Builder Input:
      Dimension('premium__has_premium')`;
    const repaired = repairMetricFlowGroupBy({
      projectRoot: '/tmp/p',
      metrics: ['total_policy_amount'],
      dimensions: ['policy__policy_number'],
      filters: [{ dimension: 'premium__has_premium', operator: 'equals', values: ['1'] }],
    }, FILTER_ERROR);
    expect(repaired?.filters).toEqual([{ dimension: 'policy_amount__has_premium', operator: 'equals', values: ['1'] }]);
    expect(repaired?.dimensions).toEqual(['policy__policy_number']);
  });

  it('refuses to guess when multiple suggestions tie at the same hop depth', () => {
    const ambiguous = OFFICE_ERROR.replace('effective_customer_account_name\n', 'customer_account_id\n')
      .replace('Query Input:\neffective_customer_account_name', 'Query Input:\ncustomer_account_id');
    const repaired = repairMetricFlowGroupBy(
      { ...request, dimensions: ['customer_account_id'] },
      ambiguous,
    );
    // bcm_tdp_pc__, bcm_hdr__, bcm_ccu_pc__customer_account_id all sit at 2 hops.
    expect(repaired).toBeNull();
  });

  it('ignores unrelated failures', () => {
    expect(repairMetricFlowGroupBy(request, 'ERROR: database is locked')).toBeNull();
  });

  it('qualifies time dimensions and filter dimensions with the same rename', () => {
    const timeError = `The given input does not match any of the available group-by-items for SimpleMetric('total_bcm').
Suggestions: [ 'bcm_hdr__consumption_date', ]
Query Input:
consumption_date`;
    const repaired = repairMetricFlowGroupBy(
      {
        ...request,
        dimensions: [],
        timeDimension: { name: 'consumption_date', granularity: 'day' },
        filters: [{ dimension: 'consumption_date', operator: 'gte', values: ['2026-01-01'] }],
      },
      timeError,
    );
    expect(repaired?.timeDimension?.name).toBe('bcm_hdr__consumption_date');
    expect(repaired?.filters?.[0]?.dimension).toBe('bcm_hdr__consumption_date');
  });
});


describe('parseMetricFlowDimensionList (mf list dimensions output)', () => {
  it('parses entity-qualified names and time-dimension grains', () => {
    const stdout = [
      "✔ 🔍 Found 3 dimensions for metrics ['total_bcm']",
      '• bcm_hdr__customer_name',
      '• bcm_hdr__region',
      '• metric_time',
      "  Queryable Granularities: ['day', 'week', 'month']",
    ].join('\n');
    const dims = parseMetricFlowDimensionList(stdout);
    expect(dims.map((d) => d.qualifiedName)).toEqual([
      'bcm_hdr__customer_name',
      'bcm_hdr__region',
      'metric_time',
    ]);
    const metricTime = dims.find((d) => d.qualifiedName === 'metric_time');
    expect(metricTime?.granularities).toEqual(['day', 'week', 'month']);
    // A non-time dimension carries no grains.
    expect(dims.find((d) => d.qualifiedName === 'bcm_hdr__region')?.granularities).toBeUndefined();
  });

  it('tolerates bare names, alternate bullets, and unknown header lines', () => {
    const dims = parseMetricFlowDimensionList([
      'Dimensions:',
      '- customer_name',
      '  * bcm_ccu_pc__product_category',
      'total: 2',
    ].join('\n'));
    expect(dims.map((d) => d.qualifiedName)).toContain('customer_name');
    expect(dims.map((d) => d.qualifiedName)).toContain('bcm_ccu_pc__product_category');
  });

  it('returns [] for output with no recognizable dimension lines', () => {
    expect(parseMetricFlowDimensionList('ERROR: could not connect to warehouse')).toEqual([]);
  });
});

describe('buildMetricFlowArgs', () => {
  it('orders by the time group-by item with its grain, exactly as MetricFlow names it', () => {
    const args = buildMetricFlowArgs({
      metrics: ['revenue', 'revenue_growth_mom'], dimensions: [],
      timeDimension: { name: 'metric_time', granularity: 'month' },
      orderBy: [{ name: 'metric_time', direction: 'asc' }, { name: 'revenue', direction: 'desc' }],
      filters: [{ dimension: 'metric_time', operator: 'gte', values: ['2025-07-01'] }],
    } as never, 'legacy-compile');
    expect(args).toContain('--group-by');
    expect(args[args.indexOf('--group-by') + 1]).toBe('metric_time__month');
    const orders = args.flatMap((arg, index) => (arg === '--order' ? [args[index + 1]] : []));
    expect(orders).toEqual(['metric_time__month asc', 'revenue desc']);
  });
});

describe('the semantic manifest is looked up where dbt writes it', () => {
  it('under the dbt project directory, beside the dbt manifest — not under the DQL root', () => {
    expect(resolveSemanticManifestPath('/proj')).toBe('/proj/target/semantic_manifest.json');
    expect(resolveSemanticManifestPath('/proj', { dbtProjectDir: '.' })).toBe('/proj/target/semantic_manifest.json');
    expect(resolveSemanticManifestPath('/proj', { dbtProjectDir: 'dbt' })).toBe('/proj/dbt/target/semantic_manifest.json');
    expect(resolveSemanticManifestPath('/proj', { dbtProjectDir: '../dbt_core_models' })).toBe('/dbt_core_models/target/semantic_manifest.json');
    expect(resolveSemanticManifestPath('/proj', { dbtProjectDir: 'dbt', dbtManifestPath: 'build/manifest.json' })).toBe('/proj/dbt/build/semantic_manifest.json');
    expect(resolveSemanticManifestPath('/proj', { dbtProjectDir: 'dbt', provenanceManifestPath: '/elsewhere/target/manifest.json' })).toBe('/elsewhere/target/semantic_manifest.json');
  });
});

describe('a MetricFlow failure is reported by its error, not its update banner', () => {
  // Captured from `mf query --metrics tax_paid --group-by metric_time__month
  // --explain --quiet` (mf 0.14.0, jaffle-shop): the banner and the resolver
  // error share stdout, and stderr is empty.
  const BANNER = [
    '‼️ Warning: A new version of the MetricFlow CLI is available.',
    '💡 Please update to version 0.15.0, released 2026-09-10 20:36:50 by running:',
    '\t$ pip install --upgrade dbt-metricflow',
    '',
    '',
  ].join('\n');
  const UNKNOWN_METRIC = `${BANNER}
ERROR: Got error(s) during query resolution.

Error #1:
  Message:

    The given input does not exactly match any known metrics.

    Suggestions:
      [
        'large_orders',
        'count_lifetime_orders',
        'lifetime_spend_pretax',
        'order_gross_profit',
        'average_order_value',
        'new_customer_orders',
      ]

  Query Input:

    tax_paid

Log File:: /Users/u/jaffle-shop-duckdb/logs/metricflow.log
Artifact Path: /Users/u/jaffle-shop-duckdb/target/semantic_manifest.json
Artifact Modified Time: 2026-09-12T20:59:27.657645

If you think you found a bug, please report it here:
    https://github.com/dbt-labs/metricflow/issues
`;

  const expectNoBanner = (text: string) => {
    expect(text).not.toContain('A new version of the MetricFlow CLI');
    expect(text).not.toContain('Please update to version');
    expect(text).not.toContain('pip install');
    expect(text).not.toContain('report it here');
    expect(text).not.toContain('Log File');
  };

  it('leads with the resolver message and the input it rejected', () => {
    const text = composeMetricFlowFailure(UNKNOWN_METRIC, '');
    expect(text.split('\n')[0]).toBe('The given input does not exactly match any known metrics. Query input: tax_paid.');
    expect(text).toContain('ERROR: Got error(s) during query resolution.');
    expect(text).toContain("'average_order_value'");
    expectNoBanner(text);
  });

  it('reads the error from stderr when stdout holds only the banner, without the traceback frames', () => {
    const stderr = [
      'ERROR:root:Logging exception handled by the CLI exception handler',
      'Traceback (most recent call last):',
      '  File "/venv/site-packages/dbt/adapters/factory.py", line 68, in load_plugin',
      '    mod: Any = import_module("." + name, "dbt.adapters")',
      '               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
      "ModuleNotFoundError: No module named 'dbt.adapters.duckdb'",
    ].join('\n');
    const text = composeMetricFlowFailure(BANNER, stderr);
    expect(text).toBe("ModuleNotFoundError: No module named 'dbt.adapters.duckdb'");
  });

  it('keeps a long failure bounded', () => {
    const text = composeMetricFlowFailure(`${BANNER}ERROR: ${'x'.repeat(5_000)}`, '');
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text.startsWith('ERROR: x')).toBe(true);
  });

  it('carries the real error into the compile failure thrown by compileMetricFlowQuery', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dql-mf-banner-'));
    const previousBin = process.env.ZLENS_METRICFLOW_BIN;
    try {
      mkdirSync(join(tmpDir, 'target'), { recursive: true });
      writeFileSync(join(tmpDir, 'target', 'semantic_manifest.json'), '{}', 'utf-8');
      const fixture = join(tmpDir, 'mf-output.txt');
      writeFileSync(fixture, UNKNOWN_METRIC, 'utf-8');
      const bin = join(tmpDir, 'mf');
      writeFileSync(
        bin,
        [
          '#!/bin/sh',
          'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.14.0"; exit 0; fi',
          `cat "${fixture}"`,
          'exit 1',
        ].join('\n'),
        'utf-8',
      );
      chmodSync(bin, 0o755);
      process.env.ZLENS_METRICFLOW_BIN = bin;

      const failure = await compileMetricFlowQuery({
        projectRoot: tmpDir,
        metrics: ['tax_paid'],
        dimensions: [],
        timeDimension: { name: 'metric_time', granularity: 'month' },
      }).then(() => undefined, (error: Error) => error);
      expect(failure?.message.split('\n')[0])
        .toBe('MetricFlow compile failed (1): The given input does not exactly match any known metrics. Query input: tax_paid.');
      expectNoBanner(failure?.message ?? '');
    } finally {
      if (previousBin === undefined) delete process.env.ZLENS_METRICFLOW_BIN;
      else process.env.ZLENS_METRICFLOW_BIN = previousBin;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
