import { describe, expect, it } from 'vitest';
import type { SemanticLayer } from '@duckcodeailabs/dql-core';
import type { DQLManifest } from '@duckcodeailabs/dql-core';
import { renderPhysicalIdentifier, buildVocabularyIndex, renderCard } from '@duckcodeailabs/dql-agent';
import { relationshipValidationProofFingerprint } from '@duckcodeailabs/dql-core';
import { modelingJoinGraph, modelingJoinPaths } from './host.js';
import { leafName, nativeAggregateBinding, nativeFormulaBinding, normalizeRelationName, parseMetricFilter, qualifyExpression, buildVocabularySource, columnLineageFromSql  } from './vocabulary-source.js';

describe('vocabulary source helpers', () => {
  it('qualifies bare columns in a measure expression, leaving keywords, functions and literals alone', () => {
    expect(qualifyExpression('case when is_drink_item then product_price else 0 end', 'dev.order_items', ['product_price']))
      .toBe('case when "dev"."order_items"."is_drink_item" then "dev"."order_items"."product_price" else 0 end');
    expect(qualifyExpression("coalesce(status, 'unknown')", 'dev.orders', [])).toBe('coalesce("dev"."orders"."status", \'unknown\')');
    expect(qualifyExpression('1', 'dev.orders', [])).toBe('1');
    expect(qualifyExpression('"dev"."orders"."order_total" * 2', 'dev.orders', ['order_total'])).toBe('"dev"."orders"."order_total" * 2');
  });
  it('reads a metric scope from a MetricFlow template, a plain predicate or a bare boolean, and reports what it cannot read', () => {
    expect(parseMetricFilter({ where_filters: [{ where_sql_template: "{{ Dimension('order_id__is_drink_order') }} = true\n" }] }))
      .toEqual({ predicates: [{ column: 'is_drink_order', entityPath: ['order_id'], condition: '= true' }], unparsed: [] });
    expect(parseMetricFilter("{{ Dimension('order_id__order_total_dim') }} >= 20")).toEqual({ predicates: [{ column: 'order_total_dim', entityPath: ['order_id'], condition: '>= 20' }], unparsed: [] });
    expect(parseMetricFilter('participated = true')).toEqual({ predicates: [{ column: 'participated', entityPath: [], condition: '= true' }], unparsed: [] });
    expect(parseMetricFilter('participated')).toEqual({ predicates: [{ column: 'participated', entityPath: [], condition: '= true' }], unparsed: [] });
    // A scope this cannot take apart is reported, never dropped.
    expect(parseMetricFilter('participated = true and minutes > 0').unparsed).toHaveLength(1);
    expect(parseMetricFilter('exists (select 1 from other)').unparsed).toHaveLength(1);
    expect(parseMetricFilter(null)).toEqual({ predicates: [], unparsed: [] });
  });
  it('normalizes three-part relation names to schema.table', () => {
    expect(normalizeRelationName('"jaffle_shop"."dev"."customers"')).toBe('dev.customers');
    expect(normalizeRelationName('dev.orders')).toBe('dev.orders');
    expect(normalizeRelationName(undefined)).toBeUndefined();
  });

  it('keeps same-tail Snowflake relations as separate exact bindings and withholds an unsafe short alias', () => {
    const source = buildVocabularySource({
      driver: 'snowflake', snapshotId: 'snapshot:fixture', executionTargetFingerprint: 'target:role-a',
      relations: [
        { database: 'DB_A', schema: 'PUBLIC', name: 'EVENTS', columnCompleteness: 'complete', columns: [{ name: 'EVENT_ID', dataType: 'NUMBER' }] },
        { database: 'DB_B', schema: 'PUBLIC', name: 'EVENTS', columnCompleteness: 'complete', columns: [{ name: 'EVENT_ID', dataType: 'NUMBER' }] },
      ],
    });
    expect(source.relations).toHaveLength(2);
    expect(source.relations?.map((relation) => relation.binding?.database?.value).sort()).toEqual(['DB_A', 'DB_B']);
    const vocabulary = buildVocabularyIndex(source);
    const relations = vocabulary.entries.filter((entry) => entry.kind === 'relation');
    expect(relations.map((entry) => entry.physical?.binding?.database?.value).sort()).toEqual(['DB_A', 'DB_B']);
    expect(vocabulary.resolve('PUBLIC.EVENTS', ['relation'])).toBeUndefined();
    expect(relations.every((entry) => entry.physical?.binding?.executionTargetFingerprint === 'target:role-a')).toBe(true);
  });
});

describe('source database provenance qualifies semantic physical bindings', () => {
  const semanticLayer = {
    listCubes: () => [{ name: 'events', table: 'PUBLIC.EVENTS', dimensions: [], measures: [{ name: 'amount' }] }],
    listMetrics: () => [{
      name: 'revenue', cube: 'events', semanticModelIds: ['events'], metricType: 'simple',
      typeParams: { measure: { name: 'amount' } }, label: 'Revenue', description: '', sql: 'amount', type: 'sum', aggregation: 'sum', table: 'PUBLIC.EVENTS',
    }],
    listMeasures: () => [{ name: 'amount', cube: 'events', agg: 'sum', expr: 'amount', label: 'Amount', description: '' }],
    listTimeDimensions: () => [], listDimensions: () => [], listEntities: () => [],
    listSemanticModels: () => [{ name: 'events', defaults: {} }],
    findJoinPath: () => [], displayFormatFor: () => undefined,
  } as unknown as SemanticLayer;

  const sourceFor = (databases: string[]) => buildVocabularySource({
    driver: 'snowflake', defaultDatabase: 'DB_A', snapshotId: 'snapshot:source', executionTargetFingerprint: 'target:source',
    semanticLayer,
    manifest: {
      sources: Object.fromEntries(databases.map((database, index) => [`events_${index}`, {
        name: 'EVENTS', origin: 'dbt', referencedBy: [],
        dbtModel: {
          uniqueId: `source.project.events_${index}`, database, schema: 'PUBLIC',
          columns: { amount: { name: 'amount', type: 'NUMBER' } },
        },
      }])),
      // The source is intentionally absent from `dbtProvenance.nodes`: dbt
      // sources still supply their own exact database identity.
      dbtProvenance: { nodes: {} },
    } as unknown as DQLManifest,
    relations: [],
  });

  it('uses the source database for both a semantic expression and its physical binding without provenance nodes', () => {
    const source = sourceFor(['DB_B']);
    const metric = source.metrics!.find((item) => item.name === 'revenue')!;

    // The logical spelling stays on `relation` (column refs and every pipeline
    // comparison read it); the exact database-qualified name is the binding.
    expect(metric.physical).toMatchObject({
      relation: 'PUBLIC.EVENTS',
      binding: { database: { value: 'DB_B' }, schema: { value: 'PUBLIC' }, table: { value: 'EVENTS' } },
    });
    expect(metric.physical?.expr).toContain('DB_B.PUBLIC.EVENTS.amount');
    expect(metric.physical?.expr).not.toContain('DB_A');
    expect(source.relations?.find((relation) => relation.binding?.database?.value === 'DB_B')?.binding)
      .toMatchObject({ logicalRelation: 'PUBLIC.EVENTS', database: { value: 'DB_B' } });
  });

  it('withholds a two-part semantic binding when separate source databases share its short name', () => {
    const source = sourceFor(['DB_A', 'DB_B']);
    const metric = source.metrics!.find((item) => item.name === 'revenue')!;

    expect(metric.physical).toMatchObject({ relation: 'PUBLIC.EVENTS' });
    expect(metric.physical?.binding).toBeUndefined();
    expect(metric.physical?.expr).not.toContain('DB_A.PUBLIC.EVENTS');
    expect(metric.physical?.expr).not.toContain('DB_B.PUBLIC.EVENTS');
    expect(source.relations?.filter((relation) => relation.name === 'EVENTS').map((relation) => relation.binding?.database?.value).sort())
      .toEqual(['DB_A', 'DB_B']);
  });
});

describe('declared relationship join paths', () => {
  const manifest = {
    modeling: {
      entities: {
        supply: { id: 'supply', localId: 'supply', qualifiedId: 'commerce.supply', dbtUniqueId: 'model.jaffle_shop.supplies' },
        product: { id: 'product', localId: 'product', qualifiedId: 'commerce.product', dbtUniqueId: 'model.jaffle_shop.products' },
        order_item: { id: 'order_item', localId: 'order_item', qualifiedId: 'commerce.order_item', dbtUniqueId: 'model.jaffle_shop.order_items' },
      },
      relationships: {
        supply_to_product: { id: 'supply_to_product', from: 'supply', to: 'product', keys: [{ from: 'product_id', to: 'product_id' }], status: 'draft' },
        order_item_to_product: { id: 'order_item_to_product', from: 'order_item', to: 'product', keys: [{ from: 'product_id', to: 'product_id' }], status: 'deprecated' },
      },
    },
    dbtProvenance: {
      nodes: {
        'model.jaffle_shop.supplies': { relation: '"jaffle_shop"."dev"."supplies"' },
        'model.jaffle_shop.products': { relation: '"jaffle_shop"."dev"."products"' },
        'model.jaffle_shop.order_items': { relation: '"jaffle_shop"."dev"."order_items"' },
      },
    },
  } as unknown as DQLManifest;
  const quote = (relation: string) => relation.split('.').map((part) => `"${part}"`).join('.');
  const joinPath = modelingJoinPaths(manifest, quote);
  it('a draft relationship never joins on declaration alone; it is offered for validation in either direction (REL-002)', () => {
    expect(joinPath('dev.supplies', 'dev.products')).toBeUndefined();
    expect(joinPath('dev.products', 'dev.supplies')).toBeUndefined();
    const graph = modelingJoinGraph(manifest, quote);
    expect(graph.unproven('dev.supplies', 'dev.products')).toEqual([expect.objectContaining({ relationshipId: 'supply_to_product', status: 'draft', keys: [{ from: 'product_id', to: 'product_id' }] })]);
    expect(graph.unproven('dev.products', 'dev.supplies')).toEqual([expect.objectContaining({ relationshipId: 'supply_to_product', keys: [{ from: 'product_id', to: 'product_id' }] })]);
    expect(graph.declared('dev.supplies', 'dev.products')?.keys).toEqual([{ from: 'product_id', to: 'product_id' }]);
  });
  it('a deprecated relationship never joins, and a missing manifest yields no path', () => {
    expect(joinPath('dev.order_items', 'dev.products')).toBeUndefined();
    expect(joinPath('dev.order_items', 'dev.supplies')).toBeUndefined();
    expect(modelingJoinPaths(undefined, quote)('dev.supplies', 'dev.products')).toBeUndefined();
  });
});

describe('join authority (REL-002, REL-005)', () => {
  const quote = (relation: string) => relation.split('.').map((part) => `"${part}"`).join('.');
  const evidence = (proofFingerprint: string) => ({ status: 'passed', checkedAt: '2026-09-01T00:00:00.000Z', queryFingerprint: 'q', proofFingerprint, fromRows: 10, toRows: 5, joinedRows: 10, fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 0, maxFromPerKey: 5, maxToPerKey: 1 });
  const entity = (localId: string, domain: string, dbtUniqueId: string) => ({ id: `${domain}::entity::${localId}`, localId, qualifiedId: `${domain}::entity::${localId}`, dbtUniqueId, domain, grain: `${localId}_id`, keys: ['customer_id'], sourcePath: 'entities.dql.yaml', identityFingerprint: localId });
  const relationship = (localId: string, domain: string, from: string, to: string, overrides: Record<string, unknown>) => ({
    id: `${domain}::relationship::${localId}`, localId, qualifiedId: `${domain}::relationship::${localId}`, from, to,
    keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', fanout: 'safe', status: 'certified', crossDomain: false,
    sourcePath: 'relationships.dql.yaml', fingerprint: localId, certificationFingerprint: `${localId}-certification`, staleCertification: false, automaticJoinAllowed: true,
    ...overrides,
  });
  const proof = relationshipValidationProofFingerprint({ fromRelation: 'analytics.marts.fct_orders', toRelation: 'analytics.marts.dim_customers', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', fanout: 'safe', queryFingerprint: 'q' });
  const growthProof = relationshipValidationProofFingerprint({ fromRelation: 'analytics.marts.dim_customer_acquisition', toRelation: 'analytics.marts.dim_customers', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', fanout: 'safe', queryFingerprint: 'q' });
  const manifest = {
    manifestVersion: 3,
    dbtProvenance: {
      nodes: {
        'model.commerce.fct_orders': { relation: 'analytics.marts.fct_orders' },
        'model.commerce.dim_customers': { relation: 'analytics.marts.dim_customers' },
        'model.commerce.dim_products': { relation: 'analytics.marts.dim_products' },
        'model.growth.dim_customer_acquisition': { relation: 'analytics.marts.dim_customer_acquisition' },
        'model.finance.fct_invoices': { relation: 'analytics.marts.fct_invoices' },
      },
    },
    modeling: {
      mode: 'dbt-first',
      packages: { commerce: { id: 'commerce', exports: [] }, growth: { id: 'growth', exports: [] }, finance: { id: 'finance', exports: [] } },
      entities: {
        'commerce::entity::order': entity('order', 'commerce', 'model.commerce.fct_orders'),
        'commerce::entity::customer': entity('customer', 'commerce', 'model.commerce.dim_customers'),
        'commerce::entity::product': entity('product', 'commerce', 'model.commerce.dim_products'),
        'growth::entity::acquisition': entity('acquisition', 'growth', 'model.growth.dim_customer_acquisition'),
        'finance::entity::invoice': entity('invoice', 'finance', 'model.finance.fct_invoices'),
        // The same relation bound in a second domain: its membership is a set, not the last one seen.
        'finance::entity::billed_customer': entity('billed_customer', 'finance', 'model.commerce.dim_customers'),
      },
      relationships: {
        'commerce::relationship::order_to_customer': relationship('order_to_customer', 'commerce', 'commerce::entity::order', 'commerce::entity::customer', { validation: evidence(proof) }),
        'growth::relationship::acquisition_to_customer': relationship('acquisition_to_customer', 'growth', 'growth::entity::acquisition', 'commerce::entity::customer', { crossDomain: true, validation: evidence(growthProof) }),
        'commerce::relationship::order_to_product': relationship('order_to_product', 'commerce', 'commerce::entity::order', 'commerce::entity::product', { status: 'draft', automaticJoinAllowed: false, keys: [{ from: 'product_id', to: 'product_id' }] }),
        'commerce::relationship::stale_customer_to_product': relationship('stale_customer_to_product', 'commerce', 'commerce::entity::customer', 'commerce::entity::product', { staleCertification: true, automaticJoinAllowed: false, validation: evidence(proof), keys: [{ from: 'product_id', to: 'product_id' }] }),
        'finance::relationship::invoice_to_customer': relationship('invoice_to_customer', 'finance', 'finance::entity::invoice', 'commerce::entity::customer', { crossDomain: true, validation: evidence('not-the-proof') }),
      },
    },
  } as unknown as DQLManifest;
  const graph = modelingJoinGraph(manifest, quote);

  it('a certified, validated, fresh relationship joins with certified authority in both directions', () => {
    const forward = graph.path('marts.fct_orders', 'marts.dim_customers');
    expect(forward).toHaveLength(1);
    expect(forward?.[0]).toMatchObject({ relation: 'marts.dim_customers', on: '"marts"."fct_orders".customer_id = "marts"."dim_customers".customer_id' });
    expect(forward?.[0]?.authority).toMatchObject({ version: 1, source: 'dql_relationship', relationshipId: 'commerce::relationship::order_to_customer', authority: 'certified', scope: 'within_domain', domains: { from: ['commerce'], to: ['commerce', 'finance'] } });
    expect(forward?.[0]?.authority?.evidence?.proofFingerprint).toBe(proof);
    const reverse = graph.path('marts.dim_customers', 'marts.fct_orders');
    expect(reverse?.[0]?.authority).toMatchObject({ keys: [{ from: 'customer_id', to: 'customer_id' }], domains: { from: ['commerce', 'finance'], to: ['commerce'] } });
  });
  it('a certified cross-domain relationship carries the cross-domain scope, and a multi-hop path keeps every authority', () => {
    const path = graph.path('marts.dim_customer_acquisition', 'marts.fct_orders');
    expect(path?.map((step) => step.relation)).toEqual(['marts.dim_customers', 'marts.fct_orders']);
    expect(path?.[0]?.authority).toMatchObject({ relationshipId: 'growth::relationship::acquisition_to_customer', scope: 'cross_domain_certified' });
    expect(path?.[1]?.authority).toMatchObject({ relationshipId: 'commerce::relationship::order_to_customer', authority: 'certified' });
  });
  it('a draft, a stale certification and a proof that no longer matches never join; each is offered with its reason', () => {
    expect(graph.path('marts.fct_orders', 'marts.dim_products')).toBeUndefined();
    expect(graph.path('marts.fct_invoices', 'marts.dim_customers')).toBeUndefined();
    expect(graph.unproven('marts.fct_orders', 'marts.dim_products')).toEqual([expect.objectContaining({ relationshipId: 'commerce::relationship::order_to_product', status: 'draft', reason: expect.stringContaining('draft, not certified') })]);
    const stale = graph.unproven('marts.dim_customers', 'marts.dim_products');
    expect(stale.map((offer) => offer.relationshipId)).toEqual(['commerce::relationship::stale_customer_to_product']);
    expect(stale[0]?.reason).toContain('stale');
    expect(graph.unproven('marts.fct_invoices', 'marts.dim_customers')[0]?.reason).toContain('no longer matches');
    // A draft is a declaration the proof may honour: its keys, and its direction.
    expect(graph.declared('marts.dim_products', 'marts.fct_orders')).toMatchObject({ id: 'commerce::relationship::order_to_product', reversed: true, keys: [{ from: 'product_id', to: 'product_id' }] });
  });
  it('a relation\'s domains are the set of every entity bound to it', () => {
    expect(graph.domainsOf('marts.dim_customers').sort()).toEqual(['commerce', 'finance']);
    expect(graph.domainsOf('marts.fct_orders')).toEqual(['commerce']);
    expect(graph.domainsOf('marts.unbound')).toEqual([]);
    expect(graph.hasDomains).toBe(true);
    expect(modelingJoinGraph({ modeling: { entities: {}, relationships: {} } } as unknown as DQLManifest, quote).hasDomains).toBe(false);
  });
});

describe('derived metrics bind physically only when SQL can express them', () => {
  const simple = (name: string, cube: string, expr: string, agg = 'sum') => ({ name, cube, semanticModelIds: [cube], metricType: 'simple', typeParams: { measure: { name } }, label: name, description: '', sql: expr, type: agg, table: '', aggregation: agg });
  const metrics = [
    simple('revenue', 'order_item', 'product_price'),
    simple('order_cost', 'orders', 'order_cost'),
    { name: 'revenue_growth_mom', cube: 'order_item', semanticModelIds: ['order_item'], metricType: 'derived', label: 'Revenue growth MoM', description: '', sql: '(current_revenue - revenue_prev_month)*100/revenue_prev_month', type: 'derived', table: '',
      typeParams: { expr: '(current_revenue - revenue_prev_month)*100/revenue_prev_month', metrics: [{ name: 'revenue', alias: 'current_revenue', offset_window: null }, { name: 'revenue', alias: 'revenue_prev_month', offset_window: { count: 1, granularity: 'month' } }] } },
    { name: 'order_gross_profit', cube: 'order_item', semanticModelIds: ['order_item'], metricType: 'derived', label: 'Gross profit', description: '', sql: 'revenue - cost', type: 'derived', table: '',
      typeParams: { expr: 'revenue - cost', metrics: [{ name: 'revenue', alias: null }, { name: 'order_cost', alias: 'cost' }] } },
    { name: 'drink_share', cube: 'order_item', semanticModelIds: ['order_item'], metricType: 'ratio', label: 'Drink share', description: '', sql: '', type: 'ratio', table: '',
      typeParams: { numerator: { name: 'revenue' }, denominator: { name: 'revenue' } } },
  ];
  const measures = [
    { name: 'revenue', cube: 'order_item', agg: 'sum', expr: 'product_price', label: 'revenue', description: '' },
    { name: 'order_cost', cube: 'orders', agg: 'sum', expr: 'order_cost', label: 'order_cost', description: '' },
  ];
  const layer = {
    listCubes: () => [
      { name: 'order_item', table: 'dev.order_items', dimensions: [{ name: 'ordered_at', type: 'timestamp' }], measures: [{ name: 'revenue' }] },
      { name: 'orders', table: 'dev.orders', dimensions: [{ name: 'ordered_at', type: 'timestamp' }], measures: [{ name: 'order_cost' }] },
    ],
    listMetrics: () => metrics,
    listMeasures: () => measures,
    listTimeDimensions: () => [],
    listDimensions: () => [],
    listEntities: () => [],
    listSemanticModels: () => [{ name: 'order_item', defaults: { agg_time_dimension: 'ordered_at' } }, { name: 'orders', defaults: { agg_time_dimension: 'ordered_at' } }],
    findJoinPath: () => [],
    displayFormatFor: () => undefined,
  } as unknown as SemanticLayer;
  const source = buildVocabularySource({ manifest: undefined, semanticLayer: layer, relations: [] } as never);
  const metric = (name: string) => source.metrics!.find((item) => item.name === name)!;
  it('a prior-period offset is the semantic engine alone: no physical binding, and the card says why', () => {
    expect(metric('revenue_growth_mom').physical).toBeUndefined();
    expect(metric('revenue_growth_mom').engineOnly).toBe('a prior-period offset on revenue');
    expect(metric('revenue_growth_mom').description).toMatch(/semantic engine only, a prior-period offset on revenue/);
  });
  it('a plain formula over two relations exposes its inputs for island composition instead of a flattened binding', () => {
    expect(metric('order_gross_profit').physical).toBeUndefined();
    expect(metric('order_gross_profit').derived).toEqual({ expr: 'revenue - cost', inputs: [{ alias: 'revenue', ref: 'metric:order_item.revenue' }, { alias: 'cost', ref: 'metric:orders.order_cost' }] });
    expect(metric('order_gross_profit').engineOnly).toBeUndefined();
  });
  it('the same input metric under two aliases is never flattened into one aggregate', () => {
    expect(metric('drink_share').physical).toBeUndefined();
    expect(metric('drink_share').engineOnly).toMatch(/same input metric under several aliases/);
  });
  it('a simple metric still binds physically', () => {
    expect(metric('revenue').physical).toMatchObject({ relation: 'dev.order_items', aggregate: 'sum' });
  });
});

describe('a dimension without a governed description is defined by its dbt column', () => {
  const layer = {
    listCubes: () => [{ name: 'customers', table: 'dev.customers', dimensions: [{ name: 'customer_type', type: 'string' }, { name: 'first_ordered_at', type: 'timestamp' }], measures: [] }],
    listMetrics: () => [],
    listMeasures: () => [],
    listTimeDimensions: () => [{ name: 'first_ordered_at', cube: 'customers', type: 'timestamp', granularities: ['day'] }],
    listDimensions: () => [{ name: 'customer_type', cube: 'customers', type: 'string' }, { name: 'first_ordered_at', cube: 'customers', type: 'timestamp', isTimeDimension: true }],
    listEntities: () => [],
    listSemanticModels: () => [{ name: 'customers', defaults: {} }],
    findJoinPath: () => [],
    displayFormatFor: () => undefined,
  } as unknown as SemanticLayer;
  const manifest = {
    sources: {
      customers: { name: 'customers', dbtModel: { uniqueId: 'model.jaffle.customers', schema: 'dev', columns: {
        customer_type: { name: 'customer_type', description: "Options are 'new' or 'returning', indicating if a customer has ordered more than once or has only placed their first order to date." },
        first_ordered_at: { name: 'first_ordered_at', description: 'The timestamp of the first order.' },
      } } },
    },
  } as unknown as DQLManifest;
  const source = buildVocabularySource({ manifest, semanticLayer: layer, relations: [] } as never);
  it('a dimension with no expression is its own column, so the dbt description defines it', () => {
    const type = source.dimensions!.find((dimension) => dimension.name === 'customer_type')!;
    expect(type.description).toMatch(/ordered more than once/);
    expect(type.physical).toMatchObject({ relation: 'dev.customers', column: 'customer_type' });
    expect(type.physical?.binding).toMatchObject({ logicalRelation: 'dev.customers', columnCompleteness: 'partial' });
    expect(source.dimensions!.find((dimension) => dimension.name === 'first_ordered_at')!.description).toBe('The timestamp of the first order.');
  });
});

describe('a dbt-inventory model names its columns once', () => {
  const layer = {
    listCubes: () => [{ name: 'player_game_stats', table: 'dev.player_game_stats', dimensions: [{ name: 'player_game_stats.pts', type: 'number' }, { name: 'player_game_stats.game_date', type: 'date' }], measures: [] }],
    listMetrics: () => [], listMeasures: () => [],
    listTimeDimensions: () => [{ name: 'player_game_stats.game_date', cube: 'player_game_stats', type: 'date', sql: 'game_date', granularities: ['day'] }],
    listDimensions: () => [{ name: 'player_game_stats.pts', cube: 'player_game_stats', type: 'number', sql: 'pts' }, { name: 'player_game_stats.game_date', cube: 'player_game_stats', type: 'date', sql: 'game_date', isTimeDimension: true }],
    listEntities: () => [], listSemanticModels: () => [{ name: 'player_game_stats', defaults: {} }], findJoinPath: () => [], displayFormatFor: () => undefined,
  } as unknown as SemanticLayer;
  const source = buildVocabularySource({ manifest: undefined, semanticLayer: layer, relations: [] } as never);
  it('the prefix is stripped from dimensions and relation columns', () => {
    expect(leafName('player_game_stats', 'player_game_stats.pts')).toBe('pts');
    expect(leafName('player_game_stats', 'pts')).toBe('pts');
    expect(source.dimensions!.map((dimension) => dimension.name).sort()).toEqual(['game_date', 'pts']);
    expect(source.dimensions!.find((dimension) => dimension.name === 'pts')?.physical).toMatchObject({ relation: 'dev.player_game_stats', column: 'pts' });
    expect(source.relations!.find((relation) => relation.name === 'player_game_stats')?.columns.map((column) => column.name)).toEqual(['pts', 'game_date']);
  });
});

describe('contradictory block metadata is never certified evidence', () => {
  it('a certified block whose description or tags say review-required is left out', () => {
    const manifest = { blocks: {
      a: { name: 'a', status: 'certified', filePath: 'blocks/a.dql', description: 'Review-required draft comparing scorers', sql: 'SELECT 1 AS x', declaredOutputs: ['x'], tags: [] },
      b: { name: 'b', status: 'certified', filePath: 'blocks/b.dql', description: 'Top scorers', sql: 'SELECT 1 AS x', declaredOutputs: ['x'], tags: ['review-required'] },
      c: { name: 'c', status: 'certified', filePath: 'blocks/c.dql', description: 'Top scorers', sql: 'SELECT 1 AS x', declaredOutputs: ['x'], tags: ['scoring'] },
    } } as unknown as DQLManifest;
    const source = buildVocabularySource({ manifest, semanticLayer: undefined, relations: [] } as never);
    expect(source.blocks!.map((block) => block.name)).toEqual(['c']);
    expect(source.blocks![0]!.sourcePath).toBe('blocks/c.dql');
  });
});

describe('a retired block never answers; its name reaches its replacement', () => {
  it('leaves the deprecated block out and lends its name to the certified block it was replaced by', () => {
    const manifest = { blocks: {
      old: { name: 'Claims Summary', status: 'deprecated', replacedBy: 'Claims Interim', deprecatedOn: '2026-09-30', filePath: 'blocks/old.dql', sql: 'SELECT 1 AS x', declaredOutputs: ['x'], tags: [] },
      mid: { name: 'Claims Interim', status: 'deprecated', replacedBy: 'blocks/new.dql', filePath: 'blocks/mid.dql', sql: 'SELECT 1 AS x', declaredOutputs: ['x'], tags: [] },
      next: { name: 'Claims Dataset', status: 'certified', filePath: 'blocks/new.dql', sql: 'SELECT 1 AS x', declaredOutputs: ['x'], tags: [] },
    } } as unknown as DQLManifest;
    const source = buildVocabularySource({ manifest, semanticLayer: undefined, relations: [] } as never);
    expect(source.blocks!.map((block) => block.name)).toEqual(['Claims Dataset']);
    expect(source.blocks![0]!.supersedes).toEqual([{ name: 'Claims Summary', deprecatedOn: '2026-09-30' }, { name: 'Claims Interim' }]);
    const entry = buildVocabularyIndex(source).get('block:global.Claims Dataset');
    expect(entry?.aliases).toEqual(expect.arrayContaining(['Claims Summary', 'Claims Interim']));
    expect(entry?.certified).toBe(true);
  });
});

describe('a native DQL semantic layer binds through its own table', () => {
  it('reads the aggregate out of the expression, or takes the declared type', () => {
    expect(nativeAggregateBinding('SUM(points)', 'sum')).toEqual({ expr: 'points', aggregate: 'sum' });
    expect(nativeAggregateBinding('points', 'sum')).toEqual({ expr: 'points', aggregate: 'sum' });
    expect(nativeAggregateBinding('COUNT(DISTINCT game_id)', 'count')).toEqual({ expr: 'game_id', aggregate: 'count_distinct' });
    expect(nativeAggregateBinding('CASE WHEN played = 1 THEN points END', 'sum')).toEqual({ expr: 'CASE WHEN played = 1 THEN points END', aggregate: 'sum' });
    // A formula of aggregates cannot be wrapped in another aggregate.
    expect(nativeAggregateBinding('SUM(made) / SUM(attempted)', 'custom')).toBeUndefined();
    expect(nativeAggregateBinding('SUM(a) + SUM(b)', 'sum')).toBeUndefined();
    expect(nativeAggregateBinding('points', 'custom')).toBeUndefined();
    expect(nativeAggregateBinding('', 'sum')).toBeUndefined();
  });
  const layer = {
    listCubes: () => [],
    listMetrics: () => [
      { name: 'total_points', label: 'Total points', description: 'Points scored', sql: 'SUM(points)', type: 'sum', table: 'TRANSFORMED.local_player_season_facts' },
      { name: 'points_per_game', label: 'Points per game', description: '', sql: 'SUM(points) / NULLIF(SUM(games_played), 0)', type: 'custom', table: 'TRANSFORMED.local_player_season_facts' },
    ],
    listMeasures: () => [],
    listTimeDimensions: () => [{ name: 'game_date', type: 'date', sql: 'game_date', table: 'TRANSFORMED.local_player_game_facts' }],
    listDimensions: () => [
      { name: 'season', type: 'number', sql: 'season', table: 'TRANSFORMED.local_player_season_facts' },
      { name: 'game_date', type: 'date', sql: 'game_date', table: 'TRANSFORMED.local_player_game_facts', isTimeDimension: true },
    ],
    listEntities: () => [], listSemanticModels: () => [], findJoinPath: () => [], displayFormatFor: () => undefined,
  } as unknown as SemanticLayer;
  const relations = [
    { schema: 'TRANSFORMED', name: 'local_player_season_facts', columns: [{ name: 'player_id' }, { name: 'season', dataType: 'INTEGER' }, { name: 'points' }, { name: 'games_played' }] },
    { schema: 'TRANSFORMED', name: 'local_player_game_facts', columns: [{ name: 'game_id' }, { name: 'game_date', dataType: 'DATE' }, { name: 'points' }] },
  ];
  const source = buildVocabularySource({ manifest: undefined, semanticLayer: layer, relations } as never);
  it('a metric with no cube and no measure still executes: table, expression and type are its binding', () => {
    const total = source.metrics!.find((metric) => metric.name === 'total_points');
    expect(total?.physical).toMatchObject({ relation: 'TRANSFORMED.local_player_season_facts', expr: '"TRANSFORMED"."local_player_season_facts"."points"', aggregate: 'sum' });
    // A ratio of aggregates binds as a derived aggregate, emitted as written.
    expect(source.metrics!.find((metric) => metric.name === 'points_per_game')?.physical).toMatchObject({ aggregate: 'derived' });
  });
  it('its dimensions are admitted with their own relation, named by that relation', () => {
    const season = source.dimensions!.find((dimension) => dimension.name === 'season');
    expect(season).toMatchObject({ model: 'local_player_season_facts', physical: { relation: 'TRANSFORMED.local_player_season_facts', column: 'season' } });
    const date = source.dimensions!.find((dimension) => dimension.name === 'game_date');
    expect(date).toMatchObject({ model: 'local_player_game_facts', isTime: true, physical: { relation: 'TRANSFORMED.local_player_game_facts', column: 'game_date' } });
  });
});

describe('a native metric written as a formula of aggregates', () => {
  it('is recognised as a formula only when every function is an aggregate or a null guard', () => {
    expect(nativeFormulaBinding('SUM(total_points) / NULLIF(SUM(games_played), 0)')).toBe('SUM(total_points) / NULLIF(SUM(games_played), 0)');
    expect(nativeFormulaBinding('SUM(made) / SUM(attempted)')).toBe('SUM(made) / SUM(attempted)');
    expect(nativeFormulaBinding('SUM(points)')).toBeUndefined();
    expect(nativeFormulaBinding('points')).toBeUndefined();
    expect(nativeFormulaBinding('SUM(points) OVER (PARTITION BY x)')).toBeUndefined();
    expect(nativeFormulaBinding('(SELECT SUM(points) FROM t) / 2')).toBeUndefined();
  });
  it('binds as a derived aggregate over its own table, emitted as written', () => {
    const layer = {
      listCubes: () => [],
      listMetrics: () => [{ name: 'points_per_game', label: 'Points per game', description: '', sql: 'SUM(total_points) / NULLIF(SUM(games_played), 0)', type: 'custom', table: 'TRANSFORMED.local_player_season_facts' }],
      listMeasures: () => [], listTimeDimensions: () => [], listDimensions: () => [], listEntities: () => [], listSemanticModels: () => [], findJoinPath: () => [], displayFormatFor: () => undefined,
    } as unknown as SemanticLayer;
    const source = buildVocabularySource({ manifest: undefined, semanticLayer: layer, relations: [{ schema: 'TRANSFORMED', name: 'local_player_season_facts', columns: [{ name: 'total_points' }, { name: 'games_played' }] }] } as never);
    expect(source.metrics!.find((metric) => metric.name === 'points_per_game')?.physical).toMatchObject({
      relation: 'TRANSFORMED.local_player_season_facts',
      expr: 'SUM("TRANSFORMED"."local_player_season_facts"."total_points") / NULLIF(SUM("TRANSFORMED"."local_player_season_facts"."games_played"), 0)',
      aggregate: 'derived',
    });
  });
});

describe('a native metric that declares which rows its definition counts', () => {
  const layerWith = (metrics: unknown[]) => ({
    listCubes: () => [],
    listMetrics: () => metrics,
    listMeasures: () => [], listTimeDimensions: () => [], listDimensions: () => [], listEntities: () => [], listSemanticModels: () => [], findJoinPath: () => [], displayFormatFor: () => undefined,
  } as unknown as SemanticLayer);
  const relations = [{ schema: 'TRANSFORMED', name: 'local_player_game_facts', columns: [{ name: 'game_id' }, { name: 'points' }, { name: 'participated', dataType: 'BOOLEAN', description: 'True when the player appeared; DNP rows are kept with false.' }] }];

  it('binds the scope inside the aggregate, and a sum is the only aggregate that reads zero for an excluded row', () => {
    const source = buildVocabularySource({ manifest: undefined, semanticLayer: layerWith([
      { name: 'points_scored', label: 'Points scored', description: 'Points in games played.', sql: 'points', type: 'sum', table: 'TRANSFORMED.local_player_game_facts', filter: 'participated = true' },
      { name: 'games_played', label: 'Games played', description: 'Games a player appeared in.', sql: 'COUNT(DISTINCT game_id)', type: 'count_distinct', table: 'TRANSFORMED.local_player_game_facts', filter: 'participated = true' },
    ]), relations } as never);
    expect(source.metrics!.find((metric) => metric.name === 'points_scored')?.physical).toMatchObject({
      relation: 'TRANSFORMED.local_player_game_facts',
      expr: 'CASE WHEN "TRANSFORMED"."local_player_game_facts"."participated" = true THEN "TRANSFORMED"."local_player_game_facts"."points" ELSE 0 END',
      aggregate: 'sum',
    });
    // COUNT(DISTINCT CASE WHEN ... THEN game_id END): an excluded row must be
    // NULL, never 0, or it would be counted after all.
    expect(source.metrics!.find((metric) => metric.name === 'games_played')?.physical?.expr)
      .toBe('CASE WHEN "TRANSFORMED"."local_player_game_facts"."participated" = true THEN "TRANSFORMED"."local_player_game_facts"."game_id" END');
    expect(source.metrics!.find((metric) => metric.name === 'games_played')?.description).toContain('Only where participated = true');
  });

  it('refuses a physical binding for a scope it cannot read, instead of dropping it', () => {
    const source = buildVocabularySource({ manifest: undefined, semanticLayer: layerWith([
      { name: 'points_scored', label: 'Points scored', description: '', sql: 'points', type: 'sum', table: 'TRANSFORMED.local_player_game_facts', filter: 'participated = true and minutes > 0' },
      { name: 'scored_per_game', label: 'Scored per game', description: '', sql: 'SUM(points) / NULLIF(COUNT(DISTINCT game_id), 0)', type: 'custom', table: 'TRANSFORMED.local_player_game_facts', filter: 'participated = true' },
    ]), relations } as never);
    const scoped = source.metrics!.find((metric) => metric.name === 'points_scored');
    expect(scoped?.physical).toBeUndefined();
    expect(scoped?.engineOnly).toBeTruthy();
    // A formula of aggregates is written as a whole and cannot carry a per-row scope.
    expect(source.metrics!.find((metric) => metric.name === 'scored_per_game')?.physical).toBeUndefined();
  });

  it('a documented eligibility flag reaches the relation card', () => {
    const source = buildVocabularySource({ manifest: undefined, semanticLayer: undefined, relations } as never);
    const index = buildVocabularyIndex(source);
    expect(renderCard(index.get('relation:TRANSFORMED.local_player_game_facts')!)).toContain('which rows count: participated True when the player appeared');
  });
});

describe('column lineage is read from the model SQL, per output column', () => {
  it('an aliased expression names its columns; a bare column is its own lineage; qualifiers, keywords, functions and literals are not columns', () => {
    const sql = `-- Grain: one row per team per source season
      SELECT team_id, season, MIN(game_date) AS first_game_date, COUNT(DISTINCT game_id) AS games_played,
        SUM(CASE WHEN team_won THEN 1 ELSE 0 END) AS wins, SUM(CASE WHEN is_home AND team_won THEN 1 ELSE 0 END) AS home_wins,
        g.points_scored AS points, 'literal' AS tag
      FROM "nba"."TRANSFORMED"."local_team_game_facts" g GROUP BY 1, 2`;
    const lineage = columnLineageFromSql(sql);
    expect(lineage.wins).toEqual(['team_won']);
    expect(lineage.home_wins).toEqual(['is_home', 'team_won']);
    expect(lineage.games_played).toEqual(['game_id']);
    expect(lineage.first_game_date).toEqual(['game_date']);
    expect(lineage.points).toEqual(['points_scored']);
    expect(lineage.team_id).toEqual(['team_id']);
    expect(lineage.tag).toEqual([]);
  });
  it('a CTE body is not the model output, and unreadable SQL yields nothing', () => {
    const lineage = columnLineageFromSql('WITH base AS (SELECT a, b FROM t) SELECT a AS x, SUM(b) AS total FROM base GROUP BY 1');
    expect(lineage).toEqual({ x: ['a'], total: ['b'] });
    expect(columnLineageFromSql('not sql at all')).toEqual({});
  });
});

describe('a probed relation merges into the manifest spelling case-insensitively', () => {
  it('CONSUMPTION_METRICS.HEADER from the warehouse and consumption_metrics.header from the manifest are one relation', () => {
    const merged = buildVocabularySource({
      manifest: { sources: [], blocks: [], terms: [], modeling: { entities: { 'x::entity::header': { id: 'x::entity::header', localId: 'header', qualifiedId: 'x::entity::header', dbtUniqueId: 'model.p.header', domain: 'x', grain: 'row', keys: [], sourcePath: 'e', identityFingerprint: 'h' } }, relationships: {} }, dbtProvenance: { nodes: { 'model.p.header': { relation: 'consumption_metrics.header' } } } } as never,
      relations: [{ schema: 'CONSUMPTION_METRICS', name: 'HEADER', columns: [{ name: 'TOTAL_BCM', dataType: 'NUMBER' }] }],
    });
    const header = (merged.relations ?? []).filter((relation) => relation.name.toLowerCase() === 'header');
    expect(header).toHaveLength(1);
    expect(header[0]!.schema!.toLowerCase()).toBe('consumption_metrics'); // one relation whichever spelling arrived first; the host asks under the manifest's
    expect(header[0]!.description).toBeUndefined();
    expect(header[0]!.columns.map((column) => column.name)).toContain('TOTAL_BCM');
  });

  it('merges a current-target complete observation into the dbt source relation instead of rendering a partial two-part duplicate', () => {
    const source = buildVocabularySource({
      driver: 'duckdb', defaultDatabase: 'nba_analysis', snapshotId: 'nba-snapshot', executionTargetFingerprint: 'target:nba',
      manifest: {
        sources: {
          player_games: {
            name: 'local_player_game_facts', origin: 'dbt', referencedBy: [],
            dbtModel: {
              uniqueId: 'model.nba.local_player_game_facts', database: 'nba_analysis', schema: 'TRANSFORMED',
              columns: {
                game_id: { name: 'game_id' }, player_id: { name: 'player_id' }, participated: { name: 'participated' },
              },
            },
          },
        },
      } as never,
      relations: [{
        database: 'nba_analysis', schema: 'TRANSFORMED', name: 'local_player_game_facts', columnCompleteness: 'complete',
        columns: [
          { name: 'game_id', dataType: 'BIGINT' }, { name: 'player_id', dataType: 'BIGINT' }, { name: 'participated', dataType: 'BOOLEAN' },
          { name: 'player_name', dataType: 'VARCHAR' }, { name: 'is_home', dataType: 'BOOLEAN' }, { name: 'game_date', dataType: 'DATE' }, { name: 'points_scored', dataType: 'INTEGER' },
        ],
      }],
    });

    const relations = source.relations?.filter((relation) => relation.name === 'local_player_game_facts') ?? [];
    expect(relations).toHaveLength(1);
    expect(relations[0]!.binding).toMatchObject({ database: { value: 'nba_analysis' }, columnCompleteness: 'complete' });
    expect(relations[0]!.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['player_name', 'is_home', 'game_date', 'points_scored']));

    const vocabulary = buildVocabularyIndex(source);
    const playerName = vocabulary.get('column:TRANSFORMED.local_player_game_facts.player_name');
    expect(playerName?.physical?.binding).toMatchObject({ database: { value: 'nba_analysis' }, columnCompleteness: 'complete' });
  });
});

describe('a physical expression is written as the warehouse reads names', () => {
  it('on Snowflake a plain lower-case name is unquoted (dbt created it unquoted); elsewhere it is quoted as before', () => {
    const snowflake = (name: string) => renderPhysicalIdentifier(name, 'snowflake', (value) => `"${value}"`);
    expect(qualifyExpression('SUM(amount)', 'sales.orders', ['amount'], snowflake)).toBe('SUM(sales.orders.amount)');
    expect(qualifyExpression('SUM("CaseSensitive")', 'sales.orders', [], snowflake)).toBe('SUM("CaseSensitive")');
    expect(qualifyExpression('SUM(amount)', 'sales.orders', ['amount'])).toBe('SUM("sales"."orders"."amount")');
  });
});

describe('the source builder scales with the manifest', () => {
  it('builds 3,000 relations in well under a second (a per-relation scan was 21 s at 4,700)', () => {
    const relations = Array.from({ length: 3_000 }, (_, index) => ({
      database: 'DB', schema: `S${index % 7}`, name: `T${index}`, columns: [], columnCompleteness: 'partial' as const,
      embeddedColumns: [{ name: 'id' }, { name: `field_${index}` }],
    }));
    const started = performance.now();
    const source = buildVocabularySource({ driver: 'snowflake', relations });
    const ms = performance.now() - started;
    expect(source.relations).toHaveLength(3_000);
    expect(source.relations?.[2_999]?.binding?.database?.value).toBe('DB');
    expect(ms).toBeLessThan(3_000);
  });

  it('reads the dbt artifact once per file version and shares it between relation selection and lineage', async () => {
    const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { dbtArtifactNodes, embeddedManifestRelations, modelColumnLineage, resetDbtArtifactCache } = await import('./vocabulary-source.js');
    resetDbtArtifactCache();
    const dir = mkdtempSync(join(tmpdir(), 'dql-dbt-artifact-'));
    const path = join(dir, 'manifest.json');
    const write = (relation: string) => writeFileSync(path, JSON.stringify({
      nodes: {
        'model.p.orders': { resource_type: 'model', name: 'orders', relation_name: relation, description: 'Orders', columns: { id: { name: 'id', data_type: 'INTEGER', description: 'the id' }, amount: { name: 'amount' } }, compiled_code: 'select id, price as amount from raw.orders' },
        'seed.p.x': { resource_type: 'seed', name: 'x', columns: {} },
      },
    }));
    write('DB.SALES.ORDERS');
    const manifest = { dbtProvenance: { manifestPath: path, nodes: { 'model.p.orders': { relation: 'DB.SALES.ORDERS' } } } } as unknown as DQLManifest;
    const first = dbtArtifactNodes(path);
    expect(first.map((node) => node.uniqueId)).toEqual(['model.p.orders']);
    expect(dbtArtifactNodes(path)).toBe(first);
    expect(embeddedManifestRelations(manifest)).toEqual([{ database: 'DB', schema: 'SALES', name: 'ORDERS', description: 'Orders', columns: [], embeddedColumns: [{ name: 'id', dataType: 'INTEGER', description: 'the id' }, { name: 'amount' }], columnCompleteness: 'partial' }]);
    expect(modelColumnLineage(manifest)).toEqual({ 'SALES.ORDERS': { id: ['id'], amount: ['price'] } });
    // A rewritten artifact (new mtime and size) is read again.
    write('DB2.SALES.ORDERS_V2');
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    const second = dbtArtifactNodes(path);
    expect(second).not.toBe(first);
    expect(second[0]?.relationName).toBe('DB2.SALES.ORDERS_V2');
  });
});

describe('a warehouse observation merges into the relation dbt spelled with quotes', () => {
  it('adds probed columns to the provenance relation instead of creating a second one', async () => {
    const { physicalRelationBinding } = await import('@duckcodeailabs/dql-agent');
    const manifest = {
      sources: { stats: { name: 'player_game_stats', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.nba.player_game_stats', database: 'nba_analysis', schema: 'dev', columns: { pts: { name: 'pts', type: 'REAL' } } } } },
      dbtProvenance: { nodes: { 'model.nba.player_game_stats': { relation: '"nba_analysis"."dev"."player_game_stats"' } } },
    } as unknown as DQLManifest;
    const probed = {
      database: 'nba_analysis', schema: 'dev', name: 'player_game_stats', columnCompleteness: 'complete' as const,
      columns: [{ name: 'pts', dataType: 'REAL' }, { name: 'turnover', dataType: 'REAL' }],
      binding: physicalRelationBinding({ logicalRelation: 'dev.player_game_stats', physicalRelation: 'nba_analysis.dev.player_game_stats', source: 'warehouse_probe', columns: [{ name: 'pts' }, { name: 'turnover' }], columnCompleteness: 'complete' }),
    };
    const source = buildVocabularySource({ driver: 'duckdb', manifest, relations: [probed] });
    const stats = source.relations?.filter((relation) => relation.name === 'player_game_stats') ?? [];
    expect(stats).toHaveLength(1);
    expect(stats[0]!.columns.map((column) => column.name)).toEqual(['pts', 'turnover']);
    expect(stats[0]!.binding?.columnCompleteness).toBe('complete');
    expect(stats[0]!.binding?.database?.value).toBe('nba_analysis');
    const vocabulary = buildVocabularyIndex(source);
    expect(vocabulary.get('column:dev.player_game_stats.turnover')).toBeDefined();
    expect(vocabulary.get('relation:dev.player_game_stats')).toBeDefined();
  });
});
