import { describe, expect, it } from 'vitest';
import { SemanticLayer, type DQLManifest } from '@zlens/core';
import { buildKGFromManifest, buildKGFromSemanticLayer } from './build.js';
import { buildResolvedAnalyticalPlan } from '../resolved-analytical-plan.js';
import type { AgentEvidenceCandidate } from '../meaning-resolution.js';

describe('buildKGFromManifest', () => {
  it('indexes business terms and business views as first-class KG context', () => {
    const manifest = {
      manifestVersion: 2,
      dqlVersion: 'test',
      generatedAt: '2026-06-12T00:00:00.000Z',
      project: 'test',
      projectRoot: '/tmp/dql',
      domains: {
        revenue: {
          name: 'revenue',
          filePath: 'domains/revenue/domain.dql',
          owner: 'revenue-analytics',
          businessOwner: 'Revenue Operations',
          boundedContext: 'Revenue bookings, recognition, refunds, and health.',
          sourceSystems: ['orders'],
          primaryTerms: ['Net Revenue'],
          reviewCadence: 'monthly',
          tags: ['revenue'],
        },
      },
      blocks: {
        'Revenue Total': {
          name: 'Revenue Total',
          filePath: 'blocks/revenue_total.dql',
          domain: 'revenue',
          owner: 'analytics',
          status: 'certified',
          blockType: 'custom',
          sql: 'select sum(amount) as revenue from fct_orders',
          rawTableRefs: ['fct_orders'],
          tableDependencies: ['fct_orders'],
          refDependencies: [],
          allDependencies: ['fct_orders'],
          tests: [],
          termRefs: ['Net Revenue'],
          description: 'Certified net revenue block.',
          datalexContract: 'commerce.Revenue.net_revenue@1',
        },
      },
      businessViews: {
        'Revenue Health': {
          name: 'Revenue Health',
          filePath: 'business-views/revenue_health.dql',
          domain: 'revenue',
          owner: 'revenue-ops',
          status: 'certified',
          tags: ['revenue', 'health'],
          description: 'Revenue scorecard for leadership review.',
          businessOutcome: 'Leadership can inspect revenue health in one place.',
          decisionUse: 'Weekly business review',
          reviewCadence: 'weekly',
          blockRefs: ['Revenue Total'],
          businessViewRefs: [],
          termRefs: ['Net Revenue'],
          declaredTermRefs: ['Net Revenue'],
          inheritedTermRefs: [],
          unresolvedTermRefs: [],
          unresolvedBlockRefs: [],
          unresolvedBusinessViewRefs: [],
        },
      },
      terms: {
        'Net Revenue': {
          name: 'Net Revenue',
          filePath: 'terms/net_revenue.dql',
          domain: 'revenue',
          owner: 'finance',
          status: 'certified',
          termType: 'metric',
          tags: ['revenue'],
          description: 'Revenue after refunds and test-account exclusions.',
          identifiers: ['order_id'],
          synonyms: ['recognized revenue'],
          businessOwner: 'finance-leadership',
        },
      },
      notebooks: {},
      metrics: {},
      dimensions: {},
      sources: {},
      apps: {},
      dashboards: {},
      lineage: { nodes: [], edges: [] },
      diagnostics: [],
    } as DQLManifest;

    const graph = buildKGFromManifest(manifest);

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'domain:revenue',
          kind: 'domain',
          sourceTier: 'business_context',
          boundedContext: 'Revenue bookings, recognition, refunds, and health.',
          primaryTerms: ['Net Revenue'],
        }),
        expect.objectContaining({
          nodeId: 'term:Net Revenue',
          kind: 'term',
          sourceTier: 'business_context',
          certification: 'certified',
          llmContext: expect.stringContaining('synonyms: recognized revenue'),
        }),
        expect.objectContaining({
          nodeId: 'block:Revenue Total',
          payload: expect.objectContaining({ qualifiedId: 'revenue::block::Revenue Total' }),
          datalexContract: 'commerce.Revenue.net_revenue@1',
          sql: 'select sum(amount) as revenue from fct_orders',
        }),
        expect.objectContaining({
          nodeId: 'business_view:Revenue Health',
          kind: 'business_view',
          sourceTier: 'business_context',
          certification: 'certified',
          businessOutcome: 'Leadership can inspect revenue health in one place.',
          llmContext: expect.stringContaining('blocks: Revenue Total'),
        }),
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { src: 'term:Net Revenue', dst: 'block:Revenue Total', kind: 'defines' },
        { src: 'term:Net Revenue', dst: 'business_view:Revenue Health', kind: 'defines' },
        { src: 'block:Revenue Total', dst: 'business_view:Revenue Health', kind: 'composes' },
        { src: 'domain:revenue', dst: 'term:Net Revenue', kind: 'contains' },
        { src: 'domain:revenue', dst: 'block:Revenue Total', kind: 'contains' },
        { src: 'domain:revenue', dst: 'business_view:Revenue Health', kind: 'contains' },
      ]),
    );
  });

  it('indexes dbt model runtime relation names for SQL generation', () => {
    const manifest = {
      manifestVersion: 2,
      dqlVersion: 'test',
      generatedAt: '2026-06-12T00:00:00.000Z',
      project: 'test',
      projectRoot: '/tmp/dql',
      domains: {},
      blocks: {},
      businessViews: {},
      terms: {},
      notebooks: {},
      metrics: {},
      dimensions: {},
      sources: {
        customers: {
          name: 'customers',
          origin: 'dbt',
          referencedBy: [],
          dbtModel: {
            uniqueId: 'model.jaffle_shop.customers',
            database: 'jaffle_shop',
            schema: 'dev',
            materializedAs: 'table',
            description: 'Customer mart.',
            columns: {
              customer_type: {
                name: 'customer_type',
                description: 'New or returning customer.',
              },
            },
          },
        },
      },
      apps: {},
      dashboards: {},
      lineage: { nodes: [], edges: [] },
      diagnostics: [],
    } as DQLManifest;

    const graph = buildKGFromManifest(manifest);

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'dbt_model:customers',
          kind: 'dbt_model',
          llmContext: expect.stringContaining('runtime relation: dev.customers'),
        }),
      ]),
    );
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'dbt_model:customers',
          llmContext: expect.stringContaining('customer_type'),
        }),
      ]),
    );
  });

  it('maps manifest semantic metric and dimension status into KG certification', () => {
    const manifest = {
      manifestVersion: 2,
      dqlVersion: 'test',
      generatedAt: '2026-06-12T00:00:00.000Z',
      project: 'test',
      projectRoot: '/tmp/dql',
      domains: {},
      blocks: {},
      businessViews: {},
      terms: {},
      notebooks: {},
      metrics: {
        total_revenue: {
          name: 'total_revenue',
          type: 'sum',
          table: 'orders',
          domain: 'finance',
          status: 'certified',
        },
      },
      dimensions: {
        channel: {
          name: 'channel',
          table: 'orders',
          type: 'string',
          status: 'review',
        },
      },
      sources: {},
      apps: {},
      dashboards: {},
      lineage: { nodes: [], edges: [] },
      diagnostics: [],
    } as DQLManifest;

    const graph = buildKGFromManifest(manifest);

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'metric:total_revenue',
        status: 'certified',
        certification: 'certified',
      }),
      expect.objectContaining({
        nodeId: 'dimension:channel',
        status: 'review',
        certification: 'reviewed',
      }),
    ]));
  });


  it('keeps a metric retrievable when its dbt-derived domain is not a declared DQL domain', () => {
    // The exact enterprise failure: dbt derives a metric domain from
    // meta.group/fqn[1]/package_name, DQL domains are declared separately, and
    // the two namespaces were never reconciled. Pinning DQL domain "growth"
    // SQL-filtered this metric out BEFORE ranking, silently demoting the answer
    // from the governed semantic lane to raw SQL.
    const layer = new SemanticLayer({
      metrics: [{
        name: 'net_revenue', label: 'Net Revenue', description: 'Revenue.',
        domain: 'finance', status: 'certified', sql: 'amount', type: 'sum', table: 'orders',
      }],
      dimensions: [],
    });

    const declared = new Set(['growth', 'commerce']);
    const metric = buildKGFromSemanticLayer(layer, declared).nodes.find((node) => node.nodeId === 'metric:net_revenue');

    // Unreconciled: no governed domain, so the retrieval filter (which passes
    // NULL) can never exclude it...
    expect(metric?.domain).toBeUndefined();
    // ...but the dbt origin survives for ranking and workspace grouping.
    expect(metric?.sourceDomain).toBe('finance');

    // A derived domain that DOES name a declared domain stays governed.
    const governed = buildKGFromSemanticLayer(layer, new Set(['finance', 'growth'])).nodes
      .find((node) => node.nodeId === 'metric:net_revenue');
    expect(governed?.domain).toBe('finance');

    // No declared domains at all (nothing can be pinned) keeps prior behaviour --
    // both when the argument is omitted and when the project simply declares
    // none, which is the common case and must not lose every domain.
    const ungoverned = buildKGFromSemanticLayer(layer).nodes.find((node) => node.nodeId === 'metric:net_revenue');
    expect(ungoverned?.domain).toBe('finance');
    const noDomainsDeclared = buildKGFromSemanticLayer(layer, new Set<string>()).nodes
      .find((node) => node.nodeId === 'metric:net_revenue');
    expect(noDomainsDeclared?.domain).toBe('finance');
  });

  it('maps semantic-layer metric and dimension status into KG certification', () => {
    const layer = new SemanticLayer({
      metrics: [{
        name: 'total_revenue',
        label: 'Total Revenue',
        description: 'Revenue metric.',
        domain: 'finance',
        status: 'certified',
        sql: 'amount',
        type: 'sum',
        table: 'orders',
      }],
      dimensions: [{
        name: 'channel',
        label: 'Channel',
        description: 'Sales channel.',
        domain: 'finance',
        status: 'draft',
        sql: 'channel',
        type: 'string',
        table: 'orders',
      }],
    });

    const graph = buildKGFromSemanticLayer(layer);

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'metric:total_revenue',
        status: 'certified',
        certification: 'certified',
        payload: expect.objectContaining({
          dimensions: [expect.stringContaining('channel')],
        }),
      }),
      expect.objectContaining({
        nodeId: 'dimension:channel',
        status: 'draft',
        certification: 'ai_generated',
      }),
    ]));
  });

  it('CONTRACT-002 indexes technical measures separately without duplicating them as business metrics', () => {
    const layer = new SemanticLayer();
    layer.addCube({
      name: 'orders',
      label: 'Orders',
      description: '',
      domain: 'commerce',
      table: 'orders',
      sql: 'select * from orders',
      measures: [{
        name: 'gross_revenue',
        label: 'Gross revenue',
        description: '',
        domain: 'commerce',
        sql: 'revenue_amount',
        type: 'sum',
        table: 'orders',
      }],
      dimensions: [],
      timeDimensions: [],
      joins: [],
      segments: [],
      preAggregations: [],
    });
    layer.addMeasure({
      name: 'gross_revenue',
      label: 'Gross revenue',
      description: '',
      domain: 'commerce',
      agg: 'sum',
      expr: 'revenue_amount',
      table: 'orders',
      cube: 'orders',
    });

    const graph = buildKGFromSemanticLayer(layer);
    expect(graph.nodes.filter((node) => node.kind === 'metric')).toHaveLength(0);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'measure:orders.gross_revenue' }),
    ]));
  });

  it('ID-001/AGT-010 indexes repeated dimension leaves as distinct model-owned evidence', () => {
    const layer = new SemanticLayer({
      metrics: [],
      dimensions: [
        {
          name: 'report_date', label: 'Usage reporting date', description: '', domain: 'usage',
          sql: 'report_as_of_dt', type: 'date', table: 'analytics.usage_daily', cube: 'usage_daily',
          qualifiedName: 'usage__report_date', entityLink: 'usage', isTimeDimension: true,
        },
        {
          name: 'report_date', label: 'Account snapshot date', description: '', domain: 'usage',
          sql: 'report_as_of_dt', type: 'date', table: 'analytics.account_snapshot', cube: 'account_snapshot',
          qualifiedName: 'account__report_date', entityLink: 'account', isTimeDimension: true,
        },
      ],
    });

    const dimensions = buildKGFromSemanticLayer(layer).nodes.filter((node) => node.kind === 'dimension');
    expect(dimensions.map((node) => node.nodeId).sort()).toEqual([
      'dimension:account_snapshot.report_date',
      'dimension:usage_daily.report_date',
    ]);
    expect(dimensions.map((node) => node.payload?.registryQualifiedId).sort()).toEqual([
      'semantic:usage:dimension:account_snapshot.report_date',
      'semantic:usage:dimension:usage_daily.report_date',
    ]);
  });

  it('AGT-005 retains non-additive semantic measure contracts for retrieval and SQL guards', () => {
    const layer = new SemanticLayer({
      dimensions: [],
      metrics: [{
        name: 'ending_balance',
        label: 'Ending Balance',
        description: 'Account balance at the end of the reporting date.',
        domain: 'finance',
        sql: '',
        type: 'custom',
        metricType: 'simple',
        typeParams: { measure: { name: 'ending_balance' } },
        table: '',
      }],
      measures: [{
        name: 'ending_balance',
        label: 'Ending Balance',
        description: 'Ending balance snapshot.',
        domain: 'finance',
        agg: 'sum',
        expr: 'ending_balance_amount',
        table: 'account_snapshot',
        nonAdditiveDimension: { name: 'snapshot_date', window_choice: 'max' },
      }],
    });

    const graph = buildKGFromSemanticLayer(layer);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'metric:ending_balance',
        payload: expect.objectContaining({
          backingMeasureNames: ['ending_balance'],
          nonAdditiveMeasures: [{
            name: 'ending_balance',
            table: 'account_snapshot',
            expression: 'ending_balance_amount',
            nonAdditiveDimension: { name: 'snapshot_date', window_choice: 'max' },
          }],
          nonAdditiveDimensions: [{ name: 'snapshot_date', window_choice: 'max' }],
        }),
      }),
      expect.objectContaining({
        nodeId: 'measure:ending_balance',
        payload: expect.objectContaining({
          expression: 'ending_balance_amount',
          nonAdditiveDimension: { name: 'snapshot_date', window_choice: 'max' },
        }),
      }),
    ]));
  });

  it('AGT-014 preserves a metric model dimension/time contract when flattened dimensions were deduplicated', () => {
    const layer = {
      listMetrics: () => [{
        name: 'rollover_balance_amount', cube: 'consumption_balance', domain: 'consumption',
        typeParams: {},
      }],
      listDimensions: () => [],
      listMeasures: () => [],
      listEntities: () => [],
      listSemanticModels: () => [{
        name: 'consumption_balance', domain: 'consumption', table: 'fct_consumption', model: 'fct_consumption',
        entities: ['customer'], measures: [], dimensions: ['customer', 'region'], timeDimensions: ['metric_date'],
      }],
      listSavedQueries: () => [],
    } as unknown as SemanticLayer;

    const graph = buildKGFromSemanticLayer(layer);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'metric:consumption_balance.rollover_balance_amount',
        payload: expect.objectContaining({
          dimensions: [
            'semantic:consumption:dimension:consumption_balance.customer',
            'semantic:consumption:dimension:consumption_balance.region',
            'semantic:consumption:dimension:consumption_balance.metric_date',
          ],
          timeGrains: ['day', 'week', 'month', 'quarter', 'year'],
        }),
      }),
    ]));
  });

  it('CONTRACT-002 normalizes explicit semantic metric capability without name inference', () => {
    const layer = new SemanticLayer();
    const source = {
      provider: 'dbt', objectType: 'metric', objectId: 'metric.sales.revenue',
      extra: { raw: { meta: { dql: { completeness_policy: 'latest_complete' } } } },
    };
    layer.addCube({
      name: 'orders', label: 'Orders', description: '', domain: 'sales',
      sql: 'select * from analytics.orders', table: 'analytics.orders',
      measures: [],
      dimensions: [{
        name: 'customer_name', label: 'Customer', description: '', sql: 'customer_name',
        type: 'string', table: 'analytics.orders', cube: 'orders', entityLink: 'order',
      }],
      timeDimensions: [{
        name: 'ordered_at', label: 'Ordered at', description: '', sql: 'ordered_at',
        type: 'date', table: 'analytics.orders', cube: 'orders', isTimeDimension: true,
        granularities: ['day', 'week', 'month', 'quarter', 'year'],
        source: {
          provider: 'dbt', objectType: 'time_dimension', objectId: 'dimension.orders.ordered_at',
          extra: { raw: { meta: { dql: { time_role: 'order_event_time' } } } },
        },
      }, {
        name: 'loaded_at', label: 'Loaded at', description: '', sql: 'loaded_at',
        type: 'date', table: 'analytics.orders', cube: 'orders', isTimeDimension: true,
        granularities: ['day', 'week', 'month'], primaryTime: true,
      }],
      joins: [], segments: [], preAggregations: [], defaultTimeDimension: 'ordered_at',
    });
    layer.addEntity({
      name: 'order', label: 'Order', description: '', type: 'primary', expr: 'order_id',
      table: 'analytics.orders', cube: 'orders', domain: 'sales',
    });
    layer.addMeasure({
      name: 'revenue', label: 'Revenue', description: '', agg: 'sum', expr: 'revenue_amount',
      table: 'analytics.orders', cube: 'orders', domain: 'sales', aggTimeDimension: 'ordered_at',
    });
    layer.addMeasure({
      name: 'median_revenue_measure', label: 'Median revenue', description: '', agg: 'median', expr: 'revenue_amount',
      table: 'analytics.orders', cube: 'orders', domain: 'sales', aggTimeDimension: 'ordered_at',
    });
    layer.addMeasure({
      name: 'order_count', label: 'Order count', description: '', agg: 'count', expr: 'order_id',
      table: 'analytics.orders', cube: 'orders', domain: 'sales', aggTimeDimension: 'ordered_at',
    });
    layer.addSemanticModel({
      name: 'orders', label: 'Orders', description: '', domain: 'sales', table: 'analytics.orders',
      entities: ['order'], measures: ['revenue', 'median_revenue_measure', 'order_count'], dimensions: ['customer_name'], timeDimensions: ['ordered_at', 'loaded_at'],
    });
    layer.addMetric({
      name: 'revenue', label: 'Revenue', description: 'Recognized revenue.', domain: 'sales',
      sql: 'revenue', type: 'simple', metricType: 'simple', aggregation: 'simple', table: '',
      cube: 'orders', aggTimeDimension: 'ordered_at', typeParams: { measure: { name: 'revenue' } },
      source,
    });
    layer.addMetric({
      name: 'median_revenue', label: 'Median revenue', description: '', domain: 'sales',
      sql: 'median_revenue_measure', type: 'simple', metricType: 'simple', aggregation: 'simple', table: '',
      cube: 'orders', typeParams: { measure: { name: 'median_revenue_measure' } }, source,
    });
    layer.addMetric({
      name: 'revenue_per_order', label: 'Revenue per order', description: '', domain: 'sales',
      sql: 'revenue / order_count', type: 'ratio', metricType: 'ratio', aggregation: 'ratio', table: '',
      cube: 'orders', typeParams: { input_measures: [{ name: 'revenue' }, { name: 'order_count' }] }, source,
    });

    const graph = buildKGFromSemanticLayer(layer);
    const metric = graph.nodes.find((node) => node.nodeId === 'metric:orders.revenue');
    expect(metric?.payload?.analyticalCapability).toMatchObject({
      // MetricFlow execution carries the canonical metric-qualified identity;
      // the legacy domain-scoped value remains a retrieval alias only.
      metricId: 'semantic:metric:orders.revenue',
      semanticModelId: 'semantic:sales:model:orders',
      primaryEntityId: 'semantic:sales:entity:orders.order',
      defaultResultGrainId: 'semantic:sales:entity:orders.order',
      aggregation: 'sum',
      dimensions: [{
        dimensionId: 'semantic:sales:dimension:orders.customer_name',
        entityId: 'semantic:sales:entity:orders.order',
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        label: 'Customer',
        aliases: expect.arrayContaining(['customer_name', 'Customer', 'orders.customer_name']),
        nativeGroupingReference: 'customer_name',
        nativeGroupingPath: [],
      }],
      timeDimensions: [{
        dimensionId: 'semantic:sales:dimension:orders.ordered_at',
        role: 'order_event_time',
        defaultFor: ['scalar', 'trend', 'comparison'],
      }, {
        dimensionId: 'semantic:sales:dimension:orders.loaded_at',
        role: 'semantic:sales:dimension:orders.loaded_at',
        supportedGrains: ['day', 'week', 'month'],
      }],
      freshness: { defaultCompletenessPolicy: 'latest_complete' },
      operations: ['filter', 'group', 'trend', 'rank'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
      sourceFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(graph.nodes.find((node) => node.nodeId === 'metric:orders.median_revenue')?.payload?.analyticalCapability).toMatchObject({
      aggregation: 'median',
      additivity: { entities: 'non_additive', time: 'non_additive' },
    });
    expect(graph.nodes.find((node) => node.nodeId === 'metric:orders.revenue_per_order')?.payload?.analyticalCapability).toMatchObject({
      aggregation: 'ratio',
      additivity: { entities: 'non_additive', time: 'non_additive' },
      measureIds: expect.arrayContaining([
        'semantic:sales:measure:orders.revenue',
        'semantic:sales:measure:orders.order_count',
      ]),
    });
  });

  it('AGT-047 keeps Jaffle-shaped MetricFlow metric_time axes model-qualified through the semantic KG', () => {
    const layer = new SemanticLayer();
    const models = ['customers', 'orders', 'locations', 'order_item'] as const;
    for (const model of models) {
      layer.addCube({
        name: model,
        label: model,
        description: '',
        domain: 'commerce',
        sql: `select * from ${model}`,
        table: model,
        measures: [],
        dimensions: [],
        timeDimensions: [{
          // MetricFlow synthesizes this same runtime field for every semantic
          // model. The owner, not the leaf, is the compiler capability.
          name: 'metric_time',
          label: 'Metric time',
          description: '',
          sql: 'metric_time',
          type: 'time',
          table: model,
          cube: model,
          entityLink: model,
          isTimeDimension: true,
          granularities: ['day', 'month', 'year'],
          qualifiedName: `${model}__metric_time`,
        }],
        joins: [],
        preAggregations: [],
        segments: [],
      });
      layer.addEntity({
        name: model,
        label: model,
        description: '',
        type: 'primary',
        expr: `${model}_id`,
        table: model,
        cube: model,
        domain: 'commerce',
      });
      layer.addSemanticModel({
        name: model,
        label: model,
        description: '',
        table: model,
        domain: 'commerce',
        entities: [model],
        measures: model === 'order_item' ? ['revenue_measure'] : [],
        dimensions: [],
        timeDimensions: ['metric_time'],
      });
    }
    layer.addMeasure({
      name: 'revenue_measure',
      label: 'Revenue',
      description: '',
      agg: 'sum',
      expr: 'revenue',
      table: 'order_item',
      cube: 'order_item',
      domain: 'commerce',
      aggTimeDimension: 'metric_time',
    });
    layer.addMetric({
      name: 'revenue',
      label: 'Revenue',
      description: '',
      sql: 'revenue_measure',
      type: 'simple',
      metricType: 'simple',
      aggregation: 'sum',
      table: 'order_item',
      cube: 'order_item',
      domain: 'commerce',
      aggTimeDimension: 'metric_time',
      typeParams: { measure: { name: 'revenue_measure' } },
    });

    const graph = buildKGFromSemanticLayer(layer);
    const metricTimeNodes = graph.nodes
      .filter((node) => node.kind === 'dimension' && node.name.endsWith('.metric_time'))
      .sort((left, right) => left.name.localeCompare(right.name));
    const metricTimeIds = metricTimeNodes.map((node) => node.payload?.qualifiedId);

    expect(metricTimeIds).toEqual([
      'semantic:commerce:dimension:customers.metric_time',
      'semantic:commerce:dimension:locations.metric_time',
      'semantic:commerce:dimension:order_item.metric_time',
      'semantic:commerce:dimension:orders.metric_time',
    ]);
    expect(new Set(metricTimeIds).size).toBe(4);
    expect(metricTimeNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'order_item.metric_time',
        payload: expect.objectContaining({
          registryQualifiedId: 'semantic:commerce:dimension:order_item.metric_time',
          aliases: expect.arrayContaining(['semantic:commerce:dimension:metric_time']),
        }),
      }),
    ]));
    const revenueCapability = graph.nodes.find((node) => node.nodeId === 'metric:order_item.revenue')
      ?.payload?.analyticalCapability as { timeDimensions?: Array<{ dimensionId: string; supportedGrains?: string[] }> } | undefined;
    expect(revenueCapability?.timeDimensions).toEqual([
      expect.objectContaining({
        dimensionId: 'semantic:commerce:dimension:order_item.metric_time',
        supportedGrains: ['day', 'month', 'year'],
      }),
    ]);
  });

  it('AGT-012 admits only exact non-ambiguous native cross-model grouping paths', () => {
    const layer = new SemanticLayer();
    layer.addCube({
      name: 'order_item', label: 'Order item', description: '', sql: 'select * from order_items', table: 'order_items',
      measures: [],
      dimensions: [
        { name: 'is_drink_item', label: 'Is drink item', description: '', sql: 'is_drink_item', type: 'boolean', table: 'order_items', cube: 'order_item', entityLink: 'order_item', qualifiedName: 'order_item__is_drink_item' },
        { name: 'is_food_item', label: 'Is food item', description: '', sql: 'is_food_item', type: 'boolean', table: 'order_items', cube: 'order_item', entityLink: 'order_item', qualifiedName: 'order_item__is_food_item' },
      ],
      timeDimensions: [], preAggregations: [], segments: [],
      joins: [{ name: 'orders', left: 'order_item', right: 'orders', type: 'left', sql: '${left}.order_id = ${right}.order_id', entity: 'order_id' }],
    });
    layer.addCube({
      name: 'orders', label: 'Orders', description: '', sql: 'select * from orders', table: 'orders', measures: [],
      dimensions: [
        { name: 'customer_order_number', label: 'Customer order number', description: '', sql: 'customer_order_number', type: 'number', table: 'orders', cube: 'orders', entityLink: 'order_id', qualifiedName: 'order_id__customer_order_number' },
      ],
      timeDimensions: [], preAggregations: [], segments: [],
      joins: [{ name: 'customers', left: 'orders', right: 'customers', type: 'left', sql: '${left}.customer_id = ${right}.customer_id', entity: 'customer' }],
    });
    layer.addCube({
      name: 'customers', label: 'Customers', description: '', sql: 'select * from customers', table: 'customers', measures: [],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: 'Customer display identity.', sql: 'customer_name', type: 'string', table: 'customers', cube: 'customers', entityLink: 'customer', qualifiedName: 'customer__customer_name' },
        { name: 'customer_type', label: 'Customer type', description: '', sql: 'customer_type', type: 'string', table: 'customers', cube: 'customers', entityLink: 'customer', qualifiedName: 'customer__customer_type' },
      ],
      timeDimensions: [], joins: [], preAggregations: [], segments: [],
    });
    layer.addEntity({ name: 'order_item', label: 'Order item', description: '', type: 'primary', expr: 'order_item_id', table: 'order_items', cube: 'order_item', domain: 'commerce' });
    layer.addEntity({ name: 'order_id', label: 'Order', description: '', type: 'foreign', expr: 'order_id', table: 'order_items', cube: 'order_item', domain: 'commerce' });
    layer.addEntity({ name: 'order_id', label: 'Order', description: '', type: 'primary', expr: 'order_id', table: 'orders', cube: 'orders', domain: 'commerce' });
    layer.addEntity({ name: 'customer', label: 'Customer', description: '', type: 'foreign', expr: 'customer_id', table: 'orders', cube: 'orders', domain: 'commerce' });
    layer.addEntity({ name: 'customer', label: 'Customer', description: '', type: 'primary', expr: 'customer_id', table: 'customers', cube: 'customers', domain: 'commerce' });
    layer.addMeasure({ name: 'revenue_measure', label: 'Revenue', description: '', agg: 'sum', expr: 'revenue', table: 'order_items', cube: 'order_item', domain: 'commerce' });
    layer.addSemanticModel({ name: 'order_item', label: 'Order item', description: '', table: 'order_items', domain: 'commerce', entities: ['order_item', 'order_id'], measures: ['revenue_measure'], dimensions: ['is_drink_item', 'is_food_item'], timeDimensions: [] });
    layer.addSemanticModel({ name: 'orders', label: 'Orders', description: '', table: 'orders', domain: 'commerce', entities: ['order_id', 'customer'], measures: [], dimensions: ['customer_order_number'], timeDimensions: [] });
    layer.addSemanticModel({ name: 'customers', label: 'Customers', description: '', table: 'customers', domain: 'commerce', entities: ['customer'], measures: [], dimensions: ['customer_name', 'customer_type'], timeDimensions: [] });
    layer.addMetric({ name: 'revenue', label: 'Revenue', description: '', sql: 'revenue_measure', type: 'simple', metricType: 'simple', aggregation: 'sum', table: 'order_items', cube: 'order_item', domain: 'commerce', typeParams: { measure: { name: 'revenue_measure' } } });

    const capability = buildKGFromSemanticLayer(layer).nodes
      .find((node) => node.nodeId === 'metric:order_item.revenue')?.payload?.analyticalCapability as NonNullable<AgentEvidenceCandidate['analyticalCapability']>;
    const dimensions = capability.dimensions ?? [];
    expect(dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dimensionId: 'semantic:customers:dimension:customers.customer_name',
        entityId: 'semantic:commerce:entity:customers.customer',
        label: 'Customer',
        nativeGroupingReference: 'order_id__customer__customer_name',
        nativeGroupingPath: ['order_id', 'customer'],
      }),
      expect.objectContaining({ dimensionId: 'semantic:customers:dimension:customers.customer_type', nativeGroupingReference: 'order_id__customer__customer_type' }),
      expect.objectContaining({ dimensionId: 'semantic:order_item:dimension:order_item.is_drink_item' }),
    ]));
    const repeated = buildKGFromSemanticLayer(layer).nodes
      .find((node) => node.nodeId === 'metric:order_item.revenue')?.payload?.analyticalCapability as { sourceFingerprint?: string };
    expect(repeated.sourceFingerprint).toBe(capability.sourceFingerprint);

    const metric: AgentEvidenceCandidate = {
      id: 'metric:order_item.revenue', qualifiedId: capability.metricId, kind: 'semantic_metric', trustTier: 'semantic',
      name: 'Revenue', aliases: ['revenue'], relevanceScore: 1, matchReasons: ['exact metric'], compatibility: 'compatible', analyticalCapability: capability,
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'Which customers have the highest revenue?',
      resolution: {
        interpretedQuestion: 'Rank customers by revenue.', questionType: 'ranking', selectedConceptIds: [metric.id], recommendedExecutionId: metric.id,
        queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
        rejectedCandidates: [], confidence: 'high', missingInformation: [], recommendedRoute: 'semantic',
      },
      evidence: { snapshotId: 'snapshot-cross-model', candidates: [metric] },
      candidates: [metric],
    });
    expect(plan.query.dimensions).toEqual([expect.objectContaining({
      qualifiedId: 'semantic:customers:dimension:customers.customer_name',
      status: 'resolved',
    })]);
    expect(plan.capability).toBe('semantic_execution');
    expect(plan.compatibilityProof).toContainEqual(expect.objectContaining({
      facts: expect.arrayContaining([
        'capability:native_grouping:semantic:customers:dimension:customers.customer_name:order_id__customer__customer_name',
      ]),
    }));
  });

  it('AGT-012 excludes cross-model dimensions when the native path is absent', () => {
    const layer = new SemanticLayer();
    layer.addCube({ name: 'work_order', label: 'Work order', description: '', sql: 'select * from work_orders', table: 'work_orders', measures: [], dimensions: [], timeDimensions: [], joins: [], preAggregations: [], segments: [] });
    layer.addCube({ name: 'workspaces', label: 'Workspaces', description: '', sql: 'select * from workspaces', table: 'workspaces', measures: [], dimensions: [{ name: 'workspace_label', label: 'Workspace', description: '', sql: 'workspace_label', type: 'string', table: 'workspaces', cube: 'workspaces', entityLink: 'workspace', qualifiedName: 'workspace__workspace_label' }], timeDimensions: [], joins: [], preAggregations: [], segments: [] });
    layer.addEntity({ name: 'work_order', label: 'Work order', description: '', type: 'primary', table: 'work_orders', cube: 'work_order', domain: 'maintenance' });
    layer.addEntity({ name: 'workspace', label: 'Workspace', description: '', type: 'primary', table: 'workspaces', cube: 'workspaces', domain: 'maintenance' });
    layer.addMeasure({ name: 'open_cost_measure', label: 'Open cost', description: '', agg: 'sum', table: 'work_orders', cube: 'work_order', domain: 'maintenance' });
    layer.addSemanticModel({ name: 'work_order', label: 'Work order', description: '', table: 'work_orders', domain: 'maintenance', entities: ['work_order'], measures: ['open_cost_measure'], dimensions: [], timeDimensions: [] });
    layer.addSemanticModel({ name: 'workspaces', label: 'Workspaces', description: '', table: 'workspaces', domain: 'maintenance', entities: ['workspace'], measures: [], dimensions: ['workspace_label'], timeDimensions: [] });
    layer.addMetric({ name: 'open_cost', label: 'Open cost', description: '', sql: 'open_cost_measure', type: 'simple', metricType: 'simple', aggregation: 'sum', table: 'work_orders', cube: 'work_order', domain: 'maintenance', typeParams: { measure: { name: 'open_cost_measure' } } });

    const capability = buildKGFromSemanticLayer(layer).nodes
      .find((node) => node.nodeId === 'metric:work_order.open_cost')?.payload?.analyticalCapability as { dimensions?: Array<{ dimensionId: string }> };
    expect(capability.dimensions?.map((dimension) => dimension.dimensionId)).not.toContain('semantic:maintenance:dimension:workspaces.workspace_label');

    layer.addCube({
      name: 'work_order', label: 'Work order', description: '', sql: 'select * from work_orders', table: 'work_orders', measures: [], dimensions: [], timeDimensions: [], preAggregations: [], segments: [],
      joins: [{ name: 'workspaces', left: 'work_order', right: 'workspaces', type: 'left', sql: '${left}.workspace_id = ${right}.workspace_id', entity: 'workspace' }],
    });
    const reachable = buildKGFromSemanticLayer(layer).nodes
      .find((node) => node.nodeId === 'metric:work_order.open_cost')?.payload?.analyticalCapability as { dimensions?: Array<Record<string, unknown>> };
    expect(reachable.dimensions).toContainEqual(expect.objectContaining({
      dimensionId: 'semantic:workspaces:dimension:workspaces.workspace_label',
      entityId: 'semantic:maintenance:entity:workspaces.workspace',
      label: 'Workspace',
      nativeGroupingReference: 'workspace__workspace_label',
      nativeGroupingPath: ['workspace'],
    }));

    // Two model-owned dimensions that compile to the same native grouping
    // reference are not safe capability evidence. The adapter can expose both
    // as reachable, but the KG must refuse to choose either one.
    layer.addCube({
      name: 'workspace_archive', label: 'Workspace archive', description: '', sql: 'select * from workspace_archive', table: 'workspace_archive', measures: [],
      dimensions: [{ name: 'workspace_label', label: 'Archived workspace', description: '', sql: 'workspace_label', type: 'string', table: 'workspace_archive', cube: 'workspace_archive', entityLink: 'workspace', qualifiedName: 'workspace__workspace_label' }],
      timeDimensions: [], joins: [], preAggregations: [], segments: [],
    });
    layer.addEntity({ name: 'workspace', label: 'Workspace archive', description: '', type: 'primary', table: 'workspace_archive', cube: 'workspace_archive', domain: 'maintenance' });
    layer.addSemanticModel({ name: 'workspace_archive', label: 'Workspace archive', description: '', table: 'workspace_archive', domain: 'maintenance', entities: ['workspace'], measures: [], dimensions: ['workspace_label'], timeDimensions: [] });
    layer.addCube({
      name: 'work_order', label: 'Work order', description: '', sql: 'select * from work_orders', table: 'work_orders', measures: [], dimensions: [], timeDimensions: [], preAggregations: [], segments: [],
      joins: [
        { name: 'workspaces', left: 'work_order', right: 'workspaces', type: 'left', sql: '${left}.workspace_id = ${right}.workspace_id', entity: 'workspace' },
        { name: 'workspace_archive', left: 'work_order', right: 'workspace_archive', type: 'left', sql: '${left}.workspace_id = ${right}.workspace_id', entity: 'workspace' },
      ],
    });
    const ambiguous = buildKGFromSemanticLayer(layer).nodes
      .find((node) => node.nodeId === 'metric:work_order.open_cost')?.payload?.analyticalCapability as { dimensions?: Array<{ dimensionId: string }> };
    expect(ambiguous.dimensions?.map((dimension) => dimension.dimensionId)).not.toContain('semantic:workspaces:dimension:workspaces.workspace_label');
    expect(ambiguous.dimensions?.map((dimension) => dimension.dimensionId)).not.toContain('semantic:workspace_archive:dimension:workspace_archive.workspace_label');
  });

  it('keeps synthetic physical dimensions model-scoped above the PERF-001 threshold', () => {
    const dimensions = Array.from({ length: 50_001 }, (_, index) => ({
      name: `column_${index}`,
      cube: 'large_model',
      table: 'large_model',
      type: 'string' as const,
    }));
    const layer = {
      listMetrics: () => [],
      listDimensions: () => dimensions,
      listMeasures: () => [],
      listEntities: () => [],
      listSemanticModels: () => [{
        name: 'large_model', table: 'large_model', model: 'large_model',
        entities: [], measures: [], dimensions: dimensions.map((item) => item.name), timeDimensions: [],
      }],
      listSavedQueries: () => [],
    } as unknown as SemanticLayer;

    const graph = buildKGFromSemanticLayer(layer);
    expect(graph.nodes.filter((node) => node.kind === 'dimension')).toHaveLength(0);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'semantic_model:large_model' }),
    ]));
  });

  it('maps app and dashboard lifecycle into KG certification', () => {
    const manifest = {
      manifestVersion: 2,
      dqlVersion: 'test',
      generatedAt: '2026-06-12T00:00:00.000Z',
      project: 'test',
      projectRoot: '/tmp/dql',
      domains: {},
      blocks: {},
      businessViews: {},
      terms: {},
      notebooks: {},
      metrics: {},
      dimensions: {},
      sources: {},
      apps: {
        'growth-app': {
          id: 'growth-app',
          name: 'Growth App',
          domain: 'growth',
          visibility: 'shared',
          lifecycle: 'review',
          owners: ['analytics'],
          tags: [],
          filePath: 'apps/growth',
          members: [],
          roles: [],
          policies: [],
          rlsBindings: [],
          schedules: [],
          dashboards: ['overview'],
          notebooks: [],
        },
      },
      dashboards: {
        'growth-app/overview': {
          id: 'overview',
          appId: 'growth-app',
          qualifiedId: 'growth-app/overview',
          title: 'Overview',
          domain: 'growth',
          lifecycle: 'draft',
          tags: [],
          filePath: 'apps/growth/dashboards/overview.dqld',
          blockIds: [],
          blockPathRefs: [],
          unresolvedBlockRefs: [],
        },
      },
      lineage: { nodes: [], edges: [] },
      diagnostics: [],
    } as DQLManifest;

    const graph = buildKGFromManifest(manifest);

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'app:growth-app',
        status: 'review',
        certification: 'reviewed',
      }),
      expect.objectContaining({
        nodeId: 'dashboard:growth-app/overview',
        status: 'draft',
        certification: 'ai_generated',
      }),
    ]));
  });

  it('indexes manifest v3 relationship proof, contracts, and domain interfaces as planning evidence', () => {
    const manifest = {
      manifestVersion: 3,
      dqlVersion: 'test',
      generatedAt: '1970-01-01T00:00:00.000Z',
      project: 'test',
      projectRoot: '/tmp/dql',
      domains: {
        commerce: { id: 'commerce', name: 'Commerce', filePath: 'domains/commerce/domain.dql' },
      },
      blocks: {}, businessViews: {}, terms: {}, notebooks: {}, metrics: {}, dimensions: {}, sources: {},
      lineage: { nodes: [], edges: [] }, diagnostics: [],
      dbtProvenance: {
        manifestPath: '/tmp/manifest.json', manifestFingerprint: 'm', nodes: {
          'model.shop.orders': {
            uniqueId: 'model.shop.orders', resourceType: 'model', name: 'orders', relation: 'analytics.orders',
            identityFingerprint: 'orders', available: { description: true, columns: true, tests: true, catalogTypes: true, dqlMeta: true },
          },
          'model.shop.customers': {
            uniqueId: 'model.shop.customers', resourceType: 'model', name: 'customers', relation: 'analytics.customers',
            identityFingerprint: 'customers', available: { description: true, columns: true, tests: true, catalogTypes: true, dqlMeta: true },
          },
        }, metricFlow: {},
      },
      modeling: {
        mode: 'dbt-first',
        packages: { commerce: { id: 'commerce', filePath: 'domains/commerce/domain.dql', exports: [] } },
        areas: {
          lifecycle: {
            id: 'commerce::model_area::lifecycle', localId: 'lifecycle', qualifiedId: 'commerce::model_area::lifecycle',
            domain: 'commerce', name: 'Customer lifecycle', description: 'Repeat purchase and retention questions.',
            intentExamples: ['Which customers purchased again?'], entityIds: ['order'], relationshipIds: ['order_to_customer'],
            referencedEntityIds: ['customer'], sourcePath: 'domains/commerce/modeling/areas/lifecycle.dql.yaml',
          },
        },
        entities: {
          order: { id: 'order', domain: 'commerce', areaId: 'commerce::model_area::lifecycle', dbtUniqueId: 'model.shop.orders', grain: 'order_id', keys: ['customer_id'], sourcePath: 'entities', identityFingerprint: 'o' },
          customer: { id: 'customer', domain: 'commerce', dbtUniqueId: 'model.shop.customers', grain: 'customer_id', keys: ['customer_id'], sourcePath: 'entities', identityFingerprint: 'c' },
        },
        relationships: {
          order_to_customer: {
            id: 'order_to_customer', from: 'order', to: 'customer', keys: [{ from: 'customer_id', to: 'customer_id' }],
            cardinality: 'many_to_one', fanout: 'safe', status: 'certified', crossDomain: false,
            sourcePath: 'relationships', fingerprint: 'r', staleCertification: false, automaticJoinAllowed: true,
          },
        },
        contracts: {
          revenue: { id: 'revenue', domain: 'commerce', entities: ['order'], blocks: [], status: 'certified', sourcePath: 'contracts', requiredEvaluation: true },
        },
        interfaces: { exports: {}, imports: {} }, conformance: {}, rules: {}, domainLineage: [],
      },
    } as DQLManifest;

    const graph = buildKGFromManifest(manifest);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'model_area:commerce::model_area::lifecycle', name: 'Customer lifecycle', domain: 'commerce' }),
      expect.objectContaining({ nodeId: 'entity:order', payload: expect.objectContaining({ dbtUniqueId: 'model.shop.orders' }) }),
      expect.objectContaining({ nodeId: 'relationship:order_to_customer', certification: 'certified' }),
      expect.objectContaining({ nodeId: 'contract:revenue', certification: 'certified' }),
    ]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: 'domain:commerce', dst: 'model_area:commerce::model_area::lifecycle', kind: 'contains' }),
      expect.objectContaining({ src: 'model_area:commerce::model_area::lifecycle', dst: 'entity:order', kind: 'contains' }),
      expect.objectContaining({ src: 'entity:order', dst: 'relationship:order_to_customer', kind: 'proves_join' }),
      expect.objectContaining({ src: 'entity:order', dst: 'dbt_model:model.shop.orders', kind: 'binds_to' }),
    ]));
  });

  it('projects a native model-scoped semantic Dataset capability without relabeling it as a block', () => {
    const layer = new SemanticLayer();
    layer.addCube({
      name: 'order_lines', label: 'Order lines', description: '', domain: 'commerce',
      sql: 'SELECT * FROM order_lines', table: 'order_lines',
      measures: [
        { name: 'semantic_revenue', label: 'Revenue', description: '', sql: 'SUM(net_amount)', type: 'sum', aggregation: 'sum', table: 'order_lines', cube: 'order_lines', domain: 'commerce', aggTimeDimension: 'order_date' },
        { name: 'semantic_customer_count', label: 'Distinct customers', description: '', sql: 'COUNT(DISTINCT customer_id)', type: 'count_distinct', aggregation: 'count_distinct', table: 'order_lines', cube: 'order_lines', domain: 'commerce', aggTimeDimension: 'order_date' },
      ],
      dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'order_lines', cube: 'order_lines', domain: 'commerce', entityLink: 'order_line' }],
      timeDimensions: [{ name: 'order_date', label: 'Order date', description: '', sql: 'order_date', type: 'date', table: 'order_lines', cube: 'order_lines', domain: 'commerce', entityLink: 'order_line', isTimeDimension: true, granularities: ['day', 'month'], primaryTime: true }],
      joins: [], segments: [], preAggregations: [], defaultTimeDimension: 'order_date',
      source: { provider: 'dql', objectType: 'cube', objectId: 'order_lines' },
    });
    layer.addEntity({
      name: 'order_line', label: 'Order line', description: '', domain: 'commerce', type: 'primary',
      expr: 'order_line_id', table: 'order_lines', cube: 'order_lines',
      source: { provider: 'dql', objectType: 'entity', objectId: 'order_line' },
    });
    layer.addSemanticModel({
      name: 'order_lines', label: 'Order lines', description: '', domain: 'commerce', table: 'order_lines',
      entities: ['order_line'], measures: ['semantic_revenue', 'semantic_customer_count'],
      dimensions: ['region'], timeDimensions: ['order_date'],
      source: { provider: 'dql', objectType: 'semantic_model', objectId: 'order_lines' },
    });
    layer.addMetric({
      name: 'semantic_revenue', label: 'Revenue', description: '', domain: 'commerce', status: 'certified',
      sql: 'SUM(net_amount)', type: 'sum', aggregation: 'sum', metricType: 'simple', table: 'order_lines', cube: 'order_lines',
      typeParams: { measure: 'semantic_revenue' }, aggTimeDimension: 'order_date',
      source: { provider: 'dql', objectType: 'metric', objectId: 'order_lines.semantic_revenue' },
    });
    layer.addMetric({
      name: 'semantic_customer_count', label: 'Distinct customers', description: '', domain: 'commerce', status: 'certified',
      sql: 'COUNT(DISTINCT customer_id)', type: 'count_distinct', aggregation: 'count_distinct', metricType: 'simple', table: 'order_lines', cube: 'order_lines',
      typeParams: { measure: 'semantic_customer_count' }, aggTimeDimension: 'order_date',
      source: { provider: 'dql', objectType: 'metric', objectId: 'order_lines.semantic_customer_count' },
    });

    const graph = buildKGFromSemanticLayer(layer, ['commerce']);
    const revenue = graph.nodes.find((node) => node.nodeId === 'metric:order_lines.semantic_revenue');
    const customerCount = graph.nodes.find((node) => node.nodeId === 'metric:order_lines.semantic_customer_count');

    expect(revenue?.payload?.analyticalCapability).toMatchObject({
      semanticModelId: 'semantic:commerce:model:order_lines',
      aggregation: 'sum',
      additivity: { entities: 'additive', time: 'additive' },
      operations: expect.arrayContaining(['having']),
      executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
    });
    expect(customerCount?.payload?.analyticalCapability).toMatchObject({
      aggregation: 'count_distinct',
      additivity: { entities: 'non_additive', time: 'non_additive' },
      executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
    });
  });
});
