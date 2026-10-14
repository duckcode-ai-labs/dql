import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbtProvider } from './dbt-provider.js';
import { writeBcmYamlProject, writeBcmManifestProject } from './__fixtures__/bcm-fixture.js';

describe('DbtProvider', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dbt-provider-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(manifest: object): void {
    const targetDir = join(tmpDir, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  }

  function writeSemanticYaml(path: string, yaml: string): void {
    const full = join(tmpDir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, yaml, 'utf-8');
  }

  it('prefers target/manifest.json over models YAML when both are present', () => {
    // YAML says one metric
    writeSemanticYaml(
      'models/_semantic.yml',
      `
semantic_models:
  - name: orders
    model: "ref('orders')"
    measures:
      - name: order_count
        agg: count
metrics:
  - name: yaml_only_metric
    type: simple
    type_params:
      measure: order_count
`,
    );

    // manifest.json says a different metric
    writeManifest({
      semantic_models: {
        'semantic_model.demo.orders': {
          name: 'orders',
          model: "ref('orders')",
          measures: [{ name: 'order_count', agg: 'count' }],
          dimensions: [],
          entities: [],
        },
      },
      metrics: {
        'metric.demo.manifest_metric': {
          name: 'manifest_metric',
          label: 'Manifest Metric',
          type: 'simple',
          type_params: { measure: 'order_count' },
        },
      },
    });

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);

    const metricNames = layer.listMetrics().map((m) => m.name);
    expect(metricNames).toContain('manifest_metric');
    expect(metricNames).not.toContain('yaml_only_metric');
  });

  it('a semantic dimension with no description inherits the dbt column description', () => {
    writeManifest({
      nodes: {
        'model.demo.customers': {
          name: 'customers', resource_type: 'model',
          columns: { customer_type: { name: 'customer_type', description: "Options are 'new' or 'returning'." }, signed_up_at: { name: 'signed_up_at', description: 'When the customer signed up.' } },
        },
      },
      semantic_models: {
        'semantic_model.demo.customers': {
          name: 'customers', model: "ref('customers')", defaults: { agg_time_dimension: 'signed_up_at' },
          entities: [{ name: 'customer_id', type: 'primary' }],
          dimensions: [
            { name: 'customer_type', type: 'categorical' },
            { name: 'described', type: 'categorical', description: 'Declared on the semantic model.', expr: 'customer_type' },
            { name: 'signed_up_at', type: 'time', type_params: { time_granularity: 'day' } },
          ],
          measures: [{ name: 'customer_count', agg: 'count' }],
        },
      },
      metrics: { 'metric.demo.total_customers': { name: 'total_customers', type: 'simple', type_params: { measure: 'customer_count' } } },
    });
    const layer = new DbtProvider().load({ provider: 'dbt' }, tmpDir);
    const cube = layer.listCubes().find((c) => c.name === 'customers')!;
    expect(cube.dimensions.find((d) => d.name === 'customer_type')?.description).toBe("Options are 'new' or 'returning'.");
    expect(cube.dimensions.find((d) => d.name === 'described')?.description).toBe('Declared on the semantic model.');
    expect(cube.timeDimensions.find((d) => d.name === 'signed_up_at')?.description).toBe('When the customer signed up.');
  });

  it('reads semantic_models and metrics from manifest.json', () => {
    writeManifest({
      semantic_models: {
        'semantic_model.demo.customers': {
          name: 'customers',
          model: "ref('customers')",
          defaults: { agg_time_dimension: 'signed_up_at' },
          entities: [{ name: 'customer_id', type: 'primary' }],
          dimensions: [
            { name: 'region', type: 'categorical' },
            { name: 'signed_up_at', type: 'time', type_params: { time_granularity: 'day' } },
          ],
          measures: [
            { name: 'customer_count', agg: 'count' },
            { name: 'lifetime_value', agg: 'sum', expr: 'ltv' },
          ],
        },
      },
      metrics: {
        'metric.demo.total_customers': {
          name: 'total_customers',
          label: 'Total Customers',
          description: 'Count of all customers',
          type: 'simple',
          type_params: { measure: 'customer_count' },
        },
        'metric.demo.total_ltv': {
          name: 'total_ltv',
          type: 'simple',
          type_params: { measure: 'lifetime_value' },
        },
      },
    });

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);

    const cubes = layer.listCubes();
    expect(cubes.map((c) => c.name)).toContain('customers');

    const cube = cubes.find((c) => c.name === 'customers')!;
    expect(cube.measures.map((m) => m.name)).toEqual(['customer_count', 'lifetime_value']);
    expect(cube.dimensions.map((d) => d.name)).toContain('region');
    expect(cube.timeDimensions.map((d) => d.name)).toContain('signed_up_at');
    expect(cube.timeDimensions.find((d) => d.name === 'signed_up_at')?.primaryTime).toBe(true);

    const metrics = layer.listMetrics();
    const metricNames = metrics.map((m) => m.name);
    expect(metricNames).toContain('total_customers');
    expect(metricNames).toContain('total_ltv');
    const totalCustomers = metrics.find((m) => m.name === 'total_customers')!;
    expect(totalCustomers.sql).toBe('COUNT(customer_count)');
    expect(totalCustomers.table).toBe('customers');

    const totalLtv = metrics.find((m) => m.name === 'total_ltv')!;
    expect(totalLtv.sql).toBe('SUM(ltv)');
  });

  it('resolves a foreign entity to the target cube + key so cross-table composeQuery joins (not degenerate)', () => {
    // Reproduces the real bug: a foreign entity `location` on `orders` (expr
    // location_id) must join to the `locations` model whose PRIMARY entity is
    // `location`. The old code set the join's target/right-column to the ENTITY
    // name, so `orders.location_id = locations.location` pointed at a non-existent
    // column and findJoinPath never matched the `locations` cube → composeQuery
    // returned NULL → every cross-table governed query fell to generated SQL.
    writeManifest({
      semantic_models: {
        'semantic_model.demo.orders': {
          name: 'orders',
          model: "ref('orders')",
          entities: [
            { name: 'order', type: 'primary', expr: 'order_id' },
            { name: 'location', type: 'foreign', expr: 'location_id' },
          ],
          measures: [{ name: 'tax_paid', agg: 'sum' }],
        },
        'semantic_model.demo.locations': {
          name: 'locations',
          model: "ref('locations')",
          entities: [{ name: 'location', type: 'primary', expr: 'location_id' }],
          dimensions: [{ name: 'location_name', type: 'categorical' }],
        },
      },
    });

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);

    // The join must target the CUBE (`locations`) with the real key on both sides.
    const orders = layer.getCube('orders')!;
    expect(orders.joins).toEqual([
      { name: 'locations', left: 'orders', right: 'locations', type: 'left', sql: '${left}.location_id = ${right}.location_id', entity: 'location' },
    ]);

    // End-to-end: the metric on orders composes by a dimension on locations.
    const composed = layer.composeQuery({ metrics: ['tax_paid'], dimensions: ['location_name'] });
    expect(composed).not.toBeNull();
    expect(composed!.sql).toContain('LEFT JOIN locations AS locations ON orders.location_id = locations.location_id');
    expect(composed!.sql).toContain('SUM(orders.tax_paid)');
    expect(composed!.sql).toContain('locations.location_name AS location_name');
  });

  it('surfaces regular dbt models when manifest has no MetricFlow semantic nodes', () => {
    writeManifest({
      nodes: {
        'model.demo.fct_player_performance': {
          unique_id: 'model.demo.fct_player_performance',
          resource_type: 'model',
          package_name: 'demo',
          name: 'fct_player_performance',
          alias: 'FCT_PLAYER_PERFORMANCE',
          database: 'NBA_ANALYTICS',
          schema: 'TRANSFORMED',
          description: 'Player performance fact model',
          fqn: ['demo', 'fct', 'fct_player_performance'],
          columns: {
            player_name: { name: 'player_name', description: 'Player name', data_type: 'varchar' },
            total_points: { name: 'total_points', description: 'Total points', data_type: 'number' },
            game_date_est: { name: 'game_date_est', description: 'Game date', data_type: 'date' },
          },
        },
      },
      semantic_models: {},
      metrics: {},
    });

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);

    expect(layer.listSemanticModels().map((model) => model.name)).toContain('fct_player_performance');
    expect(layer.listMetrics()).toEqual([]);
    expect(layer.getDimension('fct_player_performance.player_name')?.type).toBe('string');
    expect(layer.getDimension('fct_player_performance.total_points')?.type).toBe('number');
    expect(layer.getDimension('fct_player_performance.game_date_est')?.isTimeDimension).toBe(true);
    expect(layer.getSemanticModel('fct_player_performance')?.domain).toBe('fct');
  });

  it('extracts table name from ref() syntax in model field', () => {
    writeManifest({
      semantic_models: {
        'semantic_model.demo.orders': {
          name: 'orders_semantic',
          model: "ref('stg_orders')",
          measures: [{ name: 'n', agg: 'count' }],
        },
      },
      metrics: {
        'metric.demo.n_orders': {
          name: 'n_orders',
          type: 'simple',
          type_params: { measure: 'n' },
        },
      },
    });

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    const metric = layer.listMetrics()[0];
    expect(metric.table).toBe('stg_orders');
  });

  it('preserves metrics whose simple measure is unresolved so MetricFlow can compile them later', () => {
    writeManifest({
      semantic_models: {},
      metrics: {
        'metric.demo.dangling': {
          name: 'dangling',
          type: 'simple',
          type_params: { measure: 'nowhere' },
        },
      },
    });

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    const metric = layer.getMetric('dangling');
    expect(metric).toBeDefined();
    expect(metric?.metricType).toBe('simple');
    expect(metric?.typeParams?.measure).toBe('nowhere');
    expect(metric?.table).toBe('');
  });

  it('prefers semantic_manifest.json and imports dbt semantic object groups', () => {
    const targetDir = join(tmpDir, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'semantic_manifest.json'), JSON.stringify({
      semantic_models: {
        'semantic_model.demo.orders': {
          unique_id: 'semantic_model.demo.orders',
          package_name: 'demo',
          original_file_path: 'models/semantic.yml',
          name: 'orders',
          model: "ref('fct_orders')",
          defaults: { agg_time_dimension: 'ordered_at' },
          entities: [
            { name: 'order_id', type: 'primary' },
            { name: 'customer_id', type: 'foreign', expr: 'customer_id' },
          ],
          dimensions: [
            { name: 'region', type: 'categorical', description: 'Customer region' },
            { name: 'ordered_at', type: 'time', type_params: { time_granularity: 'day', validity_params: { is_start: true } } },
          ],
          measures: [
            {
              name: 'order_total',
              agg: 'sum',
              expr: 'amount',
              agg_time_dimension: 'ordered_at',
              non_additive_dimension: { name: 'account_id', window_choice: 'max' },
            },
          ],
        },
      },
      metrics: {
        'metric.demo.revenue': {
          unique_id: 'metric.demo.revenue',
          name: 'revenue',
          type: 'simple',
          type_params: { measure: 'order_total' },
          filter: "{{ Dimension('region') }} = 'NA'",
        },
        'metric.demo.revenue_ratio': {
          unique_id: 'metric.demo.revenue_ratio',
          name: 'revenue_ratio',
          type: 'ratio',
          type_params: {
            numerator: { name: 'revenue' },
            denominator: { name: 'revenue' },
          },
        },
      },
      saved_queries: {
        'saved_query.demo.revenue_by_region': {
          unique_id: 'saved_query.demo.revenue_by_region',
          name: 'revenue_by_region',
          query_params: {
            metrics: ['revenue'],
            group_by: ['region', 'metric_time__month'],
            where: "{{ Dimension('region') }} != 'test'",
          },
        },
      },
    }), 'utf-8');

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);

    expect(layer.listSemanticModels().map((m) => m.name)).toContain('orders');
    expect(layer.listMeasures().map((m) => m.name)).toContain('order_total');
    expect(layer.listEntities().map((e) => e.name)).toEqual(expect.arrayContaining(['order_id', 'customer_id']));
    expect(layer.listTimeDimensions().map((d) => d.name)).toContain('ordered_at');
    expect(layer.getMetric('revenue')?.filter).toBe("{{ Dimension('region') }} = 'NA'");
    expect(layer.getMetric('revenue_ratio')?.metricType).toBe('ratio');
    expect(layer.getSavedQuery('revenue_by_region')?.granularity).toBe('month');
  });

  it('imports array-shaped MetricFlow semantic manifests', () => {
    const targetDir = join(tmpDir, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'semantic_manifest.json'), JSON.stringify({
      semantic_models: [{
        name: 'customers',
        node_relation: {
          alias: 'customers',
          schema_name: 'analytics',
          database: 'warehouse',
          relation_name: '"warehouse"."analytics"."customers"',
        },
        measures: [
          { name: 'lifetime_spend', agg: 'sum', expr: 'lifetime_spend' },
          { name: 'median_lifetime_spend', agg: 'median', expr: 'lifetime_spend' },
        ],
        dimensions: [
          { name: 'customer_name', type: 'categorical' },
          { name: 'customer_tier', type: 'categorical' },
        ],
      }],
      metrics: [
        {
          name: 'customer_lifetime_spend',
          type: 'simple',
          type_params: { measure: { name: 'lifetime_spend' }, input_measures: [{ name: 'lifetime_spend' }] },
          filter: { where_filters: [{ where_sql_template: "{{ Dimension('customer__customer_tier') }} = 'enterprise'" }] },
        },
        {
          name: 'average_customer_spend',
          type: 'derived',
          type_params: { expr: 'customer_lifetime_spend / customer_count', metrics: [{ name: 'customer_lifetime_spend' }] },
        },
        {
          name: 'median_customer_spend',
          type: 'simple',
          type_params: { measure: { name: 'median_lifetime_spend' } },
        },
      ],
      saved_queries: [{
        name: 'top_customers',
        query_params: { metrics: ['customer_lifetime_spend'], group_by: ['customer_name'] },
      }],
    }), 'utf-8');

    const layer = new DbtProvider().load({ provider: 'dbt' }, tmpDir);

    expect(layer.listSemanticModels().map((model) => model.name)).toContain('customers');
    expect(layer.listMetrics().map((metric) => metric.name)).toContain('customer_lifetime_spend');
    expect(layer.listSavedQueries().map((query) => query.name)).toContain('top_customers');
    expect(layer.getMetric('customer_lifetime_spend')?.table).toBe('"warehouse"."analytics"."customers"');
    const composed = layer.composeQuery({ metrics: ['customer_lifetime_spend'], dimensions: ['customer_name'] });
    expect(composed?.sql).toContain('FROM "warehouse"."analytics"."customers"');
    expect(composed?.sql).toContain("customer_tier = 'enterprise'");
    expect(layer.composeQuery({ metrics: ['average_customer_spend'], dimensions: [] })).toBeNull();
    expect(layer.composeQuery({ metrics: ['median_customer_spend'], dimensions: [] })).toBeNull();
  });

  it('honors absolute dbt roots, configured manifest paths, and dbt model-paths', () => {
    const externalDbtRoot = join(tmpDir, 'external-dbt-project');
    mkdirSync(join(externalDbtRoot, 'compiled'), { recursive: true });
    writeFileSync(join(externalDbtRoot, 'dbt_project.yml'), [
      'name: enterprise_project',
      'target-path: compiled',
      'model-paths: [warehouse_models]',
    ].join('\n'), 'utf-8');
    writeFileSync(join(externalDbtRoot, 'compiled', 'manifest.json'), JSON.stringify({
      semantic_models: [{
        name: 'subscriptions',
        model: "ref('subscriptions')",
        measures: [{ name: 'mrr_amount', agg: 'sum', expr: 'mrr' }],
      }],
      metrics: [{
        name: 'monthly_recurring_revenue',
        type: 'simple',
        type_params: { measure: 'mrr_amount' },
      }],
    }), 'utf-8');

    const fromTargetPath = new DbtProvider().load({ provider: 'dbt', projectPath: externalDbtRoot }, tmpDir);
    expect(fromTargetPath.listMetrics().map((metric) => metric.name)).toContain('monthly_recurring_revenue');

    rmSync(join(externalDbtRoot, 'compiled'), { recursive: true, force: true });
    writeSemanticYaml(
      'external-dbt-project/warehouse_models/semantic.yml',
      `
semantic_models:
  - name: accounts
    model: "ref('accounts')"
    measures:
      - name: account_count
        agg: count
metrics:
  - name: active_accounts
    type: simple
    type_params:
      measure: account_count
`,
    );
    const fromModelPaths = new DbtProvider().load({ provider: 'dbt', projectPath: externalDbtRoot }, tmpDir);
    expect(fromModelPaths.listMetrics().map((metric) => metric.name)).toContain('active_accounts');

    mkdirSync(join(externalDbtRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(externalDbtRoot, 'artifacts', 'enterprise-manifest.json'), JSON.stringify({
      semantic_models: [{
        name: 'usage',
        model: "ref('usage')",
        measures: [{ name: 'usage_total', agg: 'sum' }],
      }],
      metrics: [{ name: 'total_usage', type: 'simple', type_params: { measure: 'usage_total' } }],
    }), 'utf-8');
    const configuredArtifact = new DbtProvider().load({
      provider: 'dbt',
      projectPath: externalDbtRoot,
      manifestPath: 'artifacts/enterprise-manifest.json',
    }, tmpDir);
    expect(configuredArtifact.listMetrics().map((metric) => metric.name)).toContain('total_usage');
  });

  it('falls back to YAML walker when manifest.json is missing', () => {
    writeSemanticYaml(
      'models/_semantic.yml',
      `
semantic_models:
  - name: orders
    model: "ref('orders')"
    measures:
      - name: n
        agg: count
metrics:
  - name: yaml_metric
    type: simple
    type_params:
      measure: n
`,
    );

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    expect(layer.listMetrics().map((m) => m.name)).toContain('yaml_metric');
  });

  it('falls back to YAML when manifest.json has no semantic content', () => {
    // A stock dbt project without semantic models still emits manifest.json,
    // but with empty semantic_models/metrics objects. We should fall back.
    writeManifest({ semantic_models: {}, metrics: {}, nodes: {} });
    writeSemanticYaml(
      'models/_semantic.yml',
      `
semantic_models:
  - name: products
    model: "ref('products')"
    measures:
      - name: product_count
        agg: count
metrics:
  - name: yaml_fallback
    type: simple
    type_params:
      measure: product_count
`,
    );

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    expect(layer.listMetrics().map((m) => m.name)).toContain('yaml_fallback');
  });

  it('loads semantic YAML even when manifest.json contains only regular dbt models', () => {
    writeManifest({
      nodes: {
        'model.demo.products': {
          unique_id: 'model.demo.products',
          resource_type: 'model',
          package_name: 'demo',
          name: 'products',
          columns: { product_name: { name: 'product_name', data_type: 'varchar' } },
        },
      },
      semantic_models: {},
      metrics: {},
    });
    writeSemanticYaml(
      'models/_semantic.yml',
      `
semantic_models:
  - name: customers
    model: "ref('customers')"
    measures:
      - name: lifetime_spend
        agg: sum
metrics:
  - name: customer_lifetime_spend
    type: simple
    type_params:
      measure: lifetime_spend
`,
    );

    const layer = new DbtProvider().load({ provider: 'dbt' }, tmpDir);

    expect(layer.listMetrics().map((metric) => metric.name)).toContain('customer_lifetime_spend');
    expect(layer.listSemanticModels().map((model) => model.name)).toEqual(
      expect.arrayContaining(['products', 'customers']),
    );
  });

  it('supplements model-only compiled semantic artifacts with source YAML metrics', () => {
    writeManifest({
      semantic_models: {
        'semantic_model.demo.customers': {
          name: 'customers',
          model: "ref('customers')",
          measures: [{ name: 'lifetime_spend', agg: 'sum' }],
        },
      },
      metrics: {},
    });
    writeSemanticYaml(
      'models/_semantic.yml',
      `
semantic_models:
  - name: customers
    model: "ref('customers')"
    measures:
      - name: lifetime_spend
        agg: sum
metrics:
  - name: customer_lifetime_spend
    type: simple
    type_params:
      measure: lifetime_spend
`,
    );

    const layer = new DbtProvider().load({ provider: 'dbt' }, tmpDir);

    expect(layer.listMetrics().map((metric) => metric.name)).toContain('customer_lifetime_spend');
  });

  it('falls back to YAML when manifest.json is malformed', () => {
    mkdirSync(join(tmpDir, 'target'), { recursive: true });
    writeFileSync(join(tmpDir, 'target', 'manifest.json'), '{ not valid json', 'utf-8');
    writeSemanticYaml(
      'models/_semantic.yml',
      `
semantic_models:
  - name: items
    model: "ref('items')"
    measures:
      - name: item_count
        agg: count
metrics:
  - name: malformed_fallback
    type: simple
    type_params:
      measure: item_count
`,
    );

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    expect(layer.listMetrics().map((m) => m.name)).toContain('malformed_fallback');
  });

  it('returns an empty layer when neither manifest nor YAML exist', () => {
    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    expect(layer.listMetrics()).toEqual([]);
    expect(layer.listCubes()).toEqual([]);
  });
});

describe('DbtProvider — semantic catalog foundation (Phase 1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dbt-bcm-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const variant of ['yaml', 'manifest'] as const) {
    describe(`${variant} parse path`, () => {
      function loadBcm() {
        if (variant === 'yaml') writeBcmYamlProject(tmpDir);
        else writeBcmManifestProject(tmpDir);
        return new DbtProvider().load({ provider: 'dbt' }, tmpDir);
      }

      it('stamps entity-qualified dimension names from the model primary entity', () => {
        const layer = loadBcm();
        const customer = layer.getDimension('customer_name');
        expect(customer?.qualifiedName).toBe('bcm_hdr__customer_name');
        expect(customer?.entityLink).toBe('bcm_hdr');
      });

      it('extracts the real time grain and narrows granularities to >= base', () => {
        const layer = loadBcm();
        const month = layer.getTimeDimension('consumption_month');
        expect(month?.baseGranularity).toBe('month');
        expect(month?.granularities).toEqual(['month', 'quarter', 'year']);
        expect(month?.granularities).not.toContain('day');
      });

      it('tags measures as objectKind measure and real metrics as metric', () => {
        const layer = loadBcm();
        const all = layer.listMetrics();
        const bcmAmount = all.find((m) => m.name === 'bcm_amount');
        const totalBcm = all.find((m) => m.name === 'total_bcm');
        expect(bcmAmount?.objectKind).toBe('measure');
        expect(totalBcm?.objectKind).toBe('metric');
      });

      it('excludes measures from the metric list when asked', () => {
        const layer = loadBcm();
        const metricsOnly = layer.listMetrics(undefined, { includeMeasures: false }).map((m) => m.name);
        expect(metricsOnly).toContain('total_bcm');
        expect(metricsOnly).toContain('percent_mom_bcm');
        expect(metricsOnly).not.toContain('bcm_amount');
        expect(metricsOnly).not.toContain('bcm_line_amount');
      });

      it('keeps derived metrics as catalog-only (not natively composable)', () => {
        const layer = loadBcm();
        expect(layer.canComposeMetric('total_bcm')).toBe(true);
        expect(layer.canComposeMetric('percent_mom_bcm')).toBe(false);
      });

      it('ID-001 infers a same-model derived metric owner without changing its runtime semantics', () => {
        const layer = loadBcm();
        const metric = layer.getMetric('percent_mom_bcm');
        expect(metric?.cube).toBe('bcm_hdr');
        expect(metric?.semanticModelIds).toEqual(['bcm_hdr']);
        expect(metric?.domain).not.toBe('uncategorized');
        expect(layer.canComposeMetric('percent_mom_bcm')).toBe(false);
      });

      it('records the foreign-entity name on the derived join', () => {
        const layer = loadBcm();
        const dtl = layer.getCube('bcm_dtl');
        const join = dtl?.joins.find((j) => j.right === 'bcm_hdr');
        expect(join?.entity).toBe('bcm_hdr');
      });

      it('resolveGroupBy accepts bare and qualified spellings identically', () => {
        const layer = loadBcm();
        const bare = layer.resolveGroupBy('customer_name');
        const qualified = layer.resolveGroupBy('bcm_hdr__customer_name');
        expect(bare?.name).toBe('customer_name');
        expect(qualified?.name).toBe('customer_name');
      });
    });
  }

  it('parses saved queries on the raw-YAML path (previously dropped)', () => {
    writeBcmYamlProject(tmpDir);
    writeFileSync(
      join(tmpDir, 'models', 'saved_queries.yml'),
      `
saved_queries:
  - name: bcm_by_customer
    query_params:
      metrics: [total_bcm]
      group_by: [customer_name]
      order_by: ["-total_bcm"]
      limit: 10
`,
      'utf-8',
    );
    const layer = new DbtProvider().load({ provider: 'dbt' }, tmpDir);
    const saved = layer.getSavedQuery('bcm_by_customer');
    expect(saved?.metrics).toEqual(['total_bcm']);
    expect(saved?.orderBy).toEqual([{ name: 'total_bcm', direction: 'desc' }]);
    expect(saved?.limit).toBe(10);
  });

  it('measure-backed native composition still works after de-conflation', () => {
    writeBcmYamlProject(tmpDir);
    const layer = new DbtProvider().load({ provider: 'dbt' }, tmpDir);
    // total_bcm is a simple metric over the bcm_amount measure — it must still
    // compose to executable SQL even though bcm_amount is now tagged a measure.
    const composed = layer.composeQuery({ metrics: ['total_bcm'], dimensions: ['customer_name'], driver: 'duckdb' });
    expect(composed?.sql).toContain('SUM');
    expect(composed?.sql?.toLowerCase()).toContain('customer_name');
  });

  describe('explainCompatibleDimensions (Phase 2)', () => {
    function bcmLayer() {
      writeBcmYamlProject(tmpDir);
      return new DbtProvider().load({ provider: 'dbt' }, tmpDir);
    }

    it('returns a compatible dimension on the metric own model with its qualified name', () => {
      const layer = bcmLayer();
      const { compatible } = layer.explainCompatibleDimensions(['total_bcm']);
      const customer = compatible.find((d) => d.name === 'customer_name');
      expect(customer).toBeTruthy();
      expect(customer?.qualifiedName).toBe('bcm_hdr__customer_name');
    });

    it('CONTRACT-002 gives a derived metric the same governed dimensions as its referenced base metric', () => {
      const layer = bcmLayer();
      const base = layer.explainCompatibleDimensions(['total_bcm']).compatible
        .map((dimension) => `${dimension.cube}.${dimension.name}`)
        .sort();
      const derived = layer.explainCompatibleDimensions(['percent_mom_bcm']).compatible
        .map((dimension) => `${dimension.cube}.${dimension.name}`)
        .sort();
      expect(derived).toEqual(base);
    });

    it('flags a disjoint-model dimension as no_join_path', () => {
      const layer = bcmLayer();
      const { incompatible } = layer.explainCompatibleDimensions(['total_bcm']);
      // product_category lives on bcm_ccu_pc, which never joins to bcm_hdr.
      const pc = incompatible.find((d) => d.name === 'product_category');
      expect(pc?.reason).toBe('no_join_path');
    });

    it('reports metric_unresolved for an unknown metric name', () => {
      const layer = bcmLayer();
      const { incompatible } = layer.explainCompatibleDimensions(['does_not_exist']);
      expect(incompatible).toContainEqual({ name: 'does_not_exist', reason: 'metric_unresolved' });
    });

    it('preserves repeated foreign/primary entities across a production-shaped multi-hop path', () => {
      const targetDir = join(tmpDir, 'target');
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
        semantic_models: {
          'semantic_model.demo.order_item': {
            name: 'order_item', model: "ref('order_items')",
            entities: [
              { name: 'order_item', type: 'primary', expr: 'order_item_id' },
              { name: 'order_id', type: 'foreign', expr: 'order_id' },
            ],
            dimensions: [{ name: 'is_drink_item', type: 'categorical' }],
            measures: [{ name: 'revenue_measure', agg: 'sum', expr: 'revenue' }],
          },
          'semantic_model.demo.orders': {
            name: 'orders', model: "ref('orders')",
            entities: [
              { name: 'order_id', type: 'primary', expr: 'order_id' },
              { name: 'customer', type: 'foreign', expr: 'customer_id' },
            ],
            dimensions: [{ name: 'customer_order_number', type: 'categorical' }], measures: [],
          },
          'semantic_model.demo.customers': {
            name: 'customers', model: "ref('customers')",
            entities: [{ name: 'customer', type: 'primary', expr: 'customer_id' }],
            dimensions: [{ name: 'customer_name', label: 'Customer', type: 'categorical' }], measures: [],
          },
        },
        metrics: {
          'metric.demo.revenue': {
            name: 'revenue', label: 'Revenue', type: 'simple',
            type_params: { measure: 'revenue_measure' },
          },
        },
      }), 'utf-8');

      const layer = new DbtProvider().load({ provider: 'dbt' }, tmpDir);
      expect(layer.listEntities().filter((entity) => entity.name === 'customer')).toEqual(expect.arrayContaining([
        expect.objectContaining({ cube: 'orders', type: 'foreign' }),
        expect.objectContaining({ cube: 'customers', type: 'primary' }),
      ]));
      expect(layer.explainCompatibleDimensions(['revenue']).compatible).toContainEqual(expect.objectContaining({
        cube: 'customers',
        name: 'customer_name',
        qualifiedName: 'order_id__customer__customer_name',
        entityPath: ['order_id', 'customer'],
      }));
      // The per-metric MetricFlow spelling is not a global leaf alias. It must
      // nevertheless be accepted by the same native compatibility graph that
      // produced it, so a frozen Ask plan cannot pass proof then fail its
      // compiler before SQL is generated.
      expect(layer.resolveDimension('order_id__customer__customer_name', ['revenue']))
        .toMatchObject({ cube: 'customers', name: 'customer_name' });
      expect(layer.composeQuery({
        metrics: ['revenue'],
        dimensions: ['order_id__customer__customer_name'],
      })).not.toBeNull();
    });

    it('fails closed when a foreign entity has two primary model targets', () => {
      const targetDir = join(tmpDir, 'target');
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
        semantic_models: {
          'semantic_model.demo.orders': {
            name: 'orders', model: "ref('orders')",
            entities: [{ name: 'order_id', type: 'primary' }, { name: 'customer', type: 'foreign' }],
            dimensions: [], measures: [{ name: 'revenue_measure', agg: 'sum', expr: 'revenue' }],
          },
          'semantic_model.demo.customers_current': {
            name: 'customers_current', model: "ref('customers_current')",
            entities: [{ name: 'customer', type: 'primary' }], dimensions: [{ name: 'customer_name', type: 'categorical' }], measures: [],
          },
          'semantic_model.demo.customers_archive': {
            name: 'customers_archive', model: "ref('customers_archive')",
            entities: [{ name: 'customer', type: 'primary' }], dimensions: [{ name: 'customer_label', type: 'categorical' }], measures: [],
          },
        },
        metrics: { 'metric.demo.revenue': { name: 'revenue', type: 'simple', type_params: { measure: 'revenue_measure' } } },
      }), 'utf-8');

      const layer = new DbtProvider().load({ provider: 'dbt' }, tmpDir);
      expect(layer.listEntities().filter((entity) => entity.name === 'customer')).toHaveLength(3);
      const compatible = layer.explainCompatibleDimensions(['revenue']).compatible;
      expect(compatible.map((dimension) => `${dimension.cube}.${dimension.name}`)).not.toContain('customers_current.customer_name');
      expect(compatible.map((dimension) => `${dimension.cube}.${dimension.name}`)).not.toContain('customers_archive.customer_label');
    });
  });

  it('native composeQuery accepts qualified names identically to bare (Phase 3)', () => {
    writeBcmYamlProject(tmpDir);
    const layer = new DbtProvider().load({ provider: 'dbt' }, tmpDir);
    const bare = layer.composeQuery({ metrics: ['total_bcm'], dimensions: ['customer_name'], driver: 'duckdb' });
    const qualified = layer.composeQuery({ metrics: ['total_bcm'], dimensions: ['bcm_hdr__customer_name'], driver: 'duckdb' });
    expect(qualified?.sql).toBeTruthy();
    expect(qualified?.sql).toBe(bare?.sql);
  });
});

describe('MetricFlow global time axis', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'dbt-metric-time-')); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const load = (semanticModel: Record<string, unknown>, measureName: string) => {
    mkdirSync(join(tmpDir, 'target'), { recursive: true });
    writeFileSync(join(tmpDir, 'target', 'manifest.json'), JSON.stringify({
      semantic_models: { 'semantic_model.demo.m': semanticModel },
      metrics: {
        'metric.demo.total': {
          name: 'total', label: 'Total', type: 'simple', type_params: { measure: measureName },
        },
      },
    }));
    return new DbtProvider().load({ provider: 'dbt' }, tmpDir);
  };

  it('synthesizes metric_time from the model aggregate time dimension', () => {
    const layer = load({
      name: 'orders',
      model: "ref('fct_orders')",
      defaults: { agg_time_dimension: 'ordered_at' },
      entities: [{ name: 'order', type: 'primary', expr: 'order_id' }],
      dimensions: [
        { name: 'ordered_at', type: 'time', expr: 'ordered_at_ts', type_params: { time_granularity: 'day' } },
        { name: 'closed_at', type: 'time', type_params: { time_granularity: 'month' } },
      ],
      measures: [{ name: 'revenue', agg: 'sum', expr: 'amount' }],
    }, 'revenue');

    const metricTime = layer.listTimeDimensions(undefined, { includeVariants: true })
      .find((dimension) => dimension.name === 'metric_time');

    // metric_time is never DECLARED — MetricFlow synthesizes it — so ZLens had no
    // such dimension at all and every `metric_time__day` query failed as unknown.
    expect(metricTime).toBeDefined();
    // It projects onto the model's AGGREGATE time column, not just any time dim.
    expect(metricTime?.sql).toBe('ordered_at_ts');
    // Addressed globally: MetricFlow wants `metric_time__day`, never
    // `<entity>__metric_time__day`.
    expect(metricTime?.qualifiedName).toBe('metric_time');
    expect(metricTime?.granularities).toEqual(['day', 'week', 'month', 'quarter', 'year']);

    // It must also be groupable by the model's metrics, or member selection
    // refuses it as incompatible even though it now exists.
    expect(layer.explainCompatibleDimensions(['total']).compatible.map((d) => d.name))
      .toContain('metric_time');
  });

  it('never advertises a grain the aggregate column cannot serve', () => {
    const layer = load({
      name: 'monthly_snapshot',
      model: "ref('fct_monthly')",
      defaults: { agg_time_dimension: 'month_end' },
      entities: [{ name: 'snapshot', type: 'primary', expr: 'id' }],
      dimensions: [{ name: 'month_end', type: 'time', type_params: { time_granularity: 'month' } }],
      measures: [{ name: 'balance', agg: 'sum', expr: 'balance' }],
    }, 'balance');
    const metricTime = layer.listTimeDimensions(undefined, { includeVariants: true })
      .find((dimension) => dimension.name === 'metric_time');
    expect(metricTime?.granularities).toEqual(['month', 'quarter', 'year']);
  });

  it('compiles metric_time to the real column and orders newest first', () => {
    const layer = load({
      name: 'orders',
      model: "ref('fct_orders')",
      defaults: { agg_time_dimension: 'ordered_at' },
      entities: [{ name: 'order', type: 'primary', expr: 'order_id' }],
      dimensions: [{ name: 'ordered_at', type: 'time', type_params: { time_granularity: 'day' } }],
      measures: [{ name: 'revenue', agg: 'sum', expr: 'amount' }],
    }, 'revenue');

    const compiled = layer.composeQuery({
      metrics: ['total'],
      dimensions: [],
      timeDimension: { name: 'metric_time', granularity: 'month' },
      orderBy: [{ name: 'metric_time', direction: 'desc' }],
    });

    expect(compiled?.sql).toContain("DATE_TRUNC('month'");
    expect(compiled?.sql).toContain('ordered_at');
    // The time column is PROJECTED under its grain alias, so ordering by the
    // dimension's bare name would emit a column that is not in the output and
    // the query would fail at the warehouse.
    expect(compiled?.sql).toContain('ORDER BY metric_time_month DESC');
    expect(compiled?.sql).not.toMatch(/ORDER BY metric_time DESC/);
  });
});
