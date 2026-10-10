/**
 * dbt semantic layer provider.
 * Reads dbt's native YAML format (semantic_models + metrics) and maps
 * them to DQL SemanticLayer definitions.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import {
  SemanticLayer,
  type MetricDefinition,
  type DimensionDefinition,
  type MeasureDefinition,
  type EntityDefinition,
  type SemanticModelDefinition,
  type SavedQueryDefinition,
  type JoinDefinition,
  type CubeDefinition,
  type TimeDimensionDefinition,
  parseSemanticDisplayFormat,
} from '../semantic-layer.js';
import type { SemanticLayerProvider, SemanticLayerProviderConfig } from './provider.js';

/** Map dbt aggregation types to DQL metric types. */
const AGG_TYPE_MAP: Record<string, MetricDefinition['type']> = {
  sum: 'sum',
  count: 'count',
  count_distinct: 'count_distinct',
  average: 'avg',
  avg: 'avg',
  min: 'min',
  max: 'max',
};

/** Map dbt dimension types to DQL dimension types. */
const DIM_TYPE_MAP: Record<string, DimensionDefinition['type']> = {
  categorical: 'string',
  time: 'date',
  boolean: 'boolean',
  number: 'number',
};

interface DbtSemanticModel {
  name: string;
  label?: string;
  description?: string;
  model?: string;
  node_relation?: {
    alias?: string;
    schema_name?: string;
    database?: string;
    relation_name?: string;
  };
  defaults?: { agg_time_dimension?: string };
  /** dbt column descriptions of the underlying model, the fallback definition for a dimension that declares none. */
  columnDescriptions?: Record<string, string>;
  entities?: Array<{
    name: string;
    type: string; // primary, foreign, unique, natural
    expr?: string;
    label?: string;
    description?: string;
    role?: string;
    config?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  }>;
  dimensions?: Array<{
    name: string;
    type: string;
    expr?: string;
    label?: string;
    description?: string;
    type_params?: Record<string, unknown> & { time_granularity?: string; validity_params?: Record<string, unknown> };
    config?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  }>;
  measures?: Array<{
    name: string;
    agg: string;
    expr?: string;
    label?: string;
    description?: string;
    agg_time_dimension?: string;
    create_metric?: boolean;
    non_additive_dimension?: Record<string, unknown>;
    filter?: string | Record<string, unknown> | Array<Record<string, unknown>>;
    config?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  }>;
  config?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  package_name?: string;
  original_file_path?: string;
  unique_id?: string;
}

interface DbtMetric {
  name: string;
  label?: string;
  description?: string;
  type: string; // simple, derived, cumulative, etc.
  type_params?: Record<string, unknown> & {
    measure?: string;
    measure_name?: string;
    expr?: string;
    metrics?: unknown[];
    numerator?: unknown;
    denominator?: unknown;
    window?: string;
    grain_to_date?: string;
    conversion_type_params?: Record<string, unknown>;
    cumulative_type_params?: Record<string, unknown>;
    derived_type_params?: Record<string, unknown>;
    ratio_type_params?: Record<string, unknown>;
  };
  filter?: string | Record<string, unknown> | Array<Record<string, unknown>>;
  filters?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  package_name?: string;
  original_file_path?: string;
  unique_id?: string;
}

type DbtMeasureLookup = Map<string, {
  sql: string;
  agg: string;
  modelName: string;
  table: string;
  measure: NonNullable<DbtSemanticModel['measures']>[number];
}>;

interface DbtSavedQuery {
  name: string;
  label?: string;
  description?: string;
  query_params?: {
    metrics?: string[];
    group_by?: string[];
    where?: string | Array<Record<string, unknown>>;
    order_by?: string[];
    limit?: number;
  };
  exports?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  package_name?: string;
  original_file_path?: string;
  unique_id?: string;
}

export class DbtProvider implements SemanticLayerProvider {
  readonly name = 'dbt';

  load(config: SemanticLayerProviderConfig, projectRoot: string): SemanticLayer {
    const dbtRoot = config.projectPath
      ? resolve(projectRoot, config.projectPath)
      : resolve(projectRoot);
    const dbtProjectSettings = readDbtProjectSettings(dbtRoot);
    const manifestPath = resolve(
      dbtRoot,
      config.manifestPath ?? join(dbtProjectSettings.targetPath, 'manifest.json'),
    );
    const semanticManifestPath = resolve(
      dbtRoot,
      config.semanticManifestPath ?? join(dirname(manifestPath), 'semantic_manifest.json'),
    );

    // Prefer target/semantic_manifest.json when available: it is the
    // MetricFlow/dbt Semantic Layer compatibility artifact and includes saved
    // queries plus resolved semantic metadata. Fall back to manifest.json and
    // then source YAML for projects that have not parsed semantic artifacts yet.
    let artifactLayer: SemanticLayer | null = null;
    if (existsSync(semanticManifestPath)) {
      artifactLayer = loadFromManifestJson(semanticManifestPath, 'semantic_manifest');
      if (artifactLayer && artifactHasTopLevelMetrics(semanticManifestPath)) return artifactLayer;
    }

    let manifestInventory: SemanticLayer | null = null;
    if (existsSync(manifestPath)) {
      const layer = loadFromManifestJson(manifestPath, 'manifest');
      if (layer && artifactHasTopLevelMetrics(manifestPath)) return layer;
      artifactLayer ??= layer;
      manifestInventory = loadDbtModelInventoryFromManifestPath(manifestPath);
    }

    // A dbt-core manifest can contain the technical model inventory while its
    // MetricFlow nodes are absent. Keep that inventory, but still scan the
    // configured model paths so semantic YAML is not hidden by an early return.
    const layer = artifactLayer ?? manifestInventory ?? new SemanticLayer();
    const modelPaths = config.modelPaths?.length
      ? config.modelPaths
      : dbtProjectSettings.modelPaths;
    const yamlFiles = Array.from(new Set(
      modelPaths.flatMap((modelPath) => collectYamlFiles(resolve(dbtRoot, modelPath))),
    ));
    if (yamlFiles.length === 0) return layer;

    // First pass: collect all semantic models so we can resolve measure references
    const allModels: DbtSemanticModel[] = [];
    const allDbtMetrics: DbtMetric[] = [];
    const allSavedQueries: DbtSavedQuery[] = [];

    for (const filePath of yamlFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, unknown> | null;
        if (!doc || typeof doc !== 'object') continue;

        if (Array.isArray(doc.semantic_models)) {
          for (const model of doc.semantic_models) {
            if (model && typeof model === 'object') {
              allModels.push(model as DbtSemanticModel);
            }
          }
        }

        if (Array.isArray(doc.metrics)) {
          for (const metric of doc.metrics) {
            if (metric && typeof metric === 'object') {
              allDbtMetrics.push(metric as DbtMetric);
            }
          }
        }

        // Saved queries were parsed only on the manifest-JSON path; a project
        // that authors them in source YAML lost them entirely. Parse here too.
        if (Array.isArray(doc.saved_queries)) {
          for (const savedQuery of doc.saved_queries) {
            if (savedQuery && typeof savedQuery === 'object' && 'name' in savedQuery) {
              allSavedQueries.push(savedQuery as DbtSavedQuery);
            }
          }
        }
      } catch {
        // Skip malformed YAML files
      }
    }

    // Build a measure lookup: measure_name -> { sql, agg, model_name }
    const measureLookup: DbtMeasureLookup = new Map();

    for (const model of allModels) {
      const tableName = resolveTableName(model);
      for (const measure of model.measures ?? []) {
        measureLookup.set(measure.name, {
          sql: measure.expr ?? measure.name,
          agg: measure.agg,
          modelName: model.name,
          table: tableName,
          measure,
        });
      }
    }

    // Convert each semantic model into a DQL CubeDefinition. Build the primary-entity
    // index first so foreign-entity joins resolve to the right target cube + key.
    const entityIndex = buildPrimaryEntityIndex(allModels);
    for (const model of allModels) {
      registerSemanticModel(layer, model, 'yaml', entityIndex);
    }

    // Convert dbt metrics together so derived/ratio/cumulative metrics inherit
    // ownership from their referenced measures and metrics.
    for (const metric of convertDbtMetrics(allDbtMetrics, measureLookup)) layer.addMetric(metric);

    for (const savedQuery of allSavedQueries) {
      layer.addSavedQuery(convertSavedQuery(savedQuery));
    }

    return layer;
  }
}

/**
 * Load semantic_models and metrics from a dbt `target/manifest.json`.
 *
 * dbt's manifest stores these as objects keyed by unique_id
 * (e.g. `semantic_model.jaffle_shop.orders`) with the same field shape as the
 * source YAML — so we can feed them through the existing converters directly.
 *
 * Returns `null` if the manifest is unreadable or contains no semantic nodes,
 * signalling the caller to fall back to the YAML walker.
 */
function loadFromManifestJson(manifestPath: string, artifactKind: 'manifest' | 'semantic_manifest'): SemanticLayer | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  // The dbt model behind a semantic model documents its columns; a semantic
  // dimension that declares no description inherits that column's. The
  // semantic manifest carries no nodes, so the sibling manifest.json is read
  // for them.
  const nodesSource = artifactKind === 'manifest' ? manifest : readSiblingManifestNodes(manifestPath);
  const columnDescriptionsByModel = dbtNodeColumnDescriptions(nodesSource);
  const models: DbtSemanticModel[] = [];
  for (const node of artifactCollection(manifest.semantic_models)) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !('name' in node)) continue;
    const raw = node as DbtManifestSemanticModel;
    const modelRef = typeof raw.model === 'string' ? raw.model : undefined;
    const modelName = modelRef?.match(/ref\(\s*['"]([^'"]+)['"]/)?.[1] ?? raw.node_relation?.alias ?? raw.name;
    const columnDescriptions = columnDescriptionsByModel.get(modelName);
    models.push({
      ...raw,
      name: raw.name,
      // node.model is already a string like "ref('stg_orders')" in manifests
      model: modelRef,
      defaults: raw.defaults,
      entities: raw.entities,
      dimensions: raw.dimensions,
      measures: raw.measures,
      ...(columnDescriptions ? { columnDescriptions } : {}),
    });
  }

  const dbtMetrics: DbtMetric[] = [];
  for (const node of artifactCollection(manifest.metrics)) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !('name' in node)) continue;
    const raw = node as DbtManifestMetric;
    dbtMetrics.push({
      ...raw,
      name: raw.name,
      label: raw.label,
      description: raw.description,
      type: raw.type ?? 'simple',
      type_params: raw.type_params,
    });
  }

  const savedQueries: DbtSavedQuery[] = [];
  for (const node of artifactCollection(manifest.saved_queries ?? manifest.savedQueries)) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !('name' in node)) continue;
    const raw = node as DbtSavedQuery;
    savedQueries.push({ ...raw, name: raw.name });
  }

  if (models.length === 0 && dbtMetrics.length === 0 && savedQueries.length === 0) {
    // No semantic content — let the caller try source YAML. For manifest.json,
    // its technical model inventory is merged into that YAML layer by load().
    return null;
  }

  const layer = new SemanticLayer();

  // Build measure lookup first (identical logic to the YAML path).
  const measureLookup: DbtMeasureLookup = new Map();
  for (const model of models) {
    const tableName = resolveTableName(model);
    for (const measure of model.measures ?? []) {
      measureLookup.set(measure.name, {
        sql: measure.expr ?? measure.name,
        agg: measure.agg,
        modelName: model.name,
        table: tableName,
        measure,
      });
    }
  }

  const entityIndex = buildPrimaryEntityIndex(models);
  for (const model of models) {
    registerSemanticModel(layer, model, artifactKind, entityIndex);
  }
  for (const metric of convertDbtMetrics(dbtMetrics, measureLookup)) layer.addMetric(metric);
  for (const savedQuery of savedQueries) {
    layer.addSavedQuery(convertSavedQuery(savedQuery));
  }

  return layer;
}

/** Shape of a `semantic_models.*` entry in dbt's manifest.json. */
interface DbtManifestSemanticModel extends DbtSemanticModel {
  // dbt adds unique_id, package_name, etc. — we only care about the DbtSemanticModel fields.
}

/** Shape of a `metrics.*` entry in dbt's manifest.json. */
interface DbtManifestMetric extends DbtMetric {
  // Same story — manifest.json has extra metadata we don't consume.
}

interface DbtManifestModelNode {
  name: string;
  alias?: string;
  relation_name?: string;
  database?: string;
  schema?: string;
  description?: string;
  resource_type?: string;
  columns?: Record<string, Record<string, unknown>>;
  config?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  tags?: string[];
  package_name?: string;
  original_file_path?: string;
  path?: string;
  unique_id?: string;
  fqn?: string[];
}

/** `model name → column name → description` from a manifest's model nodes. */
function dbtNodeColumnDescriptions(manifest: Record<string, unknown> | undefined): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (!manifest) return out;
  for (const node of artifactCollection(manifest.nodes)) {
    const raw = asRecord(node);
    if (raw.resource_type !== 'model' || typeof raw.name !== 'string') continue;
    const descriptions: Record<string, string> = {};
    for (const [columnKey, columnValue] of Object.entries(asRecord(raw.columns))) {
      const column = asRecord(columnValue);
      const name = firstString(column.name, columnKey);
      const description = firstString(column.description);
      if (name && description) descriptions[name] = description;
    }
    if (Object.keys(descriptions).length > 0) out.set(raw.name, descriptions);
  }
  return out;
}

function readSiblingManifestNodes(manifestPath: string): Record<string, unknown> | undefined {
  const sibling = join(dirname(manifestPath), 'manifest.json');
  if (resolve(sibling) === resolve(manifestPath) || !existsSync(sibling)) return undefined;
  try {
    return JSON.parse(readFileSync(sibling, 'utf-8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function artifactCollection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return Object.values(asRecord(value));
}

function readDbtProjectSettings(dbtRoot: string): { targetPath: string; modelPaths: string[] } {
  const defaults = { targetPath: 'target', modelPaths: ['models'] };
  const path = join(dbtRoot, 'dbt_project.yml');
  if (!existsSync(path)) return defaults;
  try {
    const parsed = yaml.load(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    const targetPath = typeof parsed['target-path'] === 'string' && parsed['target-path'].trim()
      ? parsed['target-path'].trim()
      : defaults.targetPath;
    const rawModelPaths = parsed['model-paths'];
    const modelPaths = Array.isArray(rawModelPaths)
      ? rawModelPaths.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim())
      : defaults.modelPaths;
    return { targetPath, modelPaths: modelPaths.length ? modelPaths : defaults.modelPaths };
  } catch {
    return defaults;
  }
}

function loadDbtModelInventoryFromManifestPath(manifestPath: string): SemanticLayer | null {
  try {
    return loadDbtModelInventoryFromManifest(
      JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>,
    );
  } catch {
    return null;
  }
}

function artifactHasTopLevelMetrics(manifestPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    return artifactCollection(manifest.metrics).some((metric) => {
      if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return false;
      return 'name' in metric;
    });
  } catch {
    return false;
  }
}

function loadDbtModelInventoryFromManifest(manifest: Record<string, unknown>): SemanticLayer | null {
  const nodes = Object.values(asRecord(manifest.nodes))
    .filter((node): node is DbtManifestModelNode => {
      return Boolean(
        node
        && typeof node === 'object'
        && !Array.isArray(node)
        && (node as DbtManifestModelNode).resource_type === 'model'
        && typeof (node as DbtManifestModelNode).name === 'string',
      );
    });
  if (nodes.length === 0) return null;

  const layer = new SemanticLayer();
  for (const node of nodes) {
    const tableName = resolveDbtModelTableName(node);
    const domain = deriveDbtManifestNodeDomain(node);
    const dimensions: DimensionDefinition[] = [];
    const timeDimensions: TimeDimensionDefinition[] = [];

    for (const [columnKey, columnValue] of Object.entries(asRecord(node.columns))) {
      const rawColumn = asRecord(columnValue);
      const columnName = firstString(rawColumn.name, columnKey);
      if (!columnName) continue;
      const columnType = inferDbtColumnType(rawColumn.data_type, columnName);
      const dimension: DimensionDefinition = {
        name: `${node.name}.${columnName}`,
        label: labelFromName(columnName),
        description: firstString(rawColumn.description) ?? '',
        domain,
        sql: columnName,
        type: columnType,
        table: tableName,
        cube: node.name,
        tags: Array.isArray(rawColumn.tags) ? rawColumn.tags.map(String) : undefined,
        source: dbtSource('dbt_column', `${node.unique_id ?? node.name}.${columnName}`, columnName, {
          ...rawColumn,
          unique_id: `${node.unique_id ?? node.name}.${columnName}`,
          package_name: node.package_name,
          original_file_path: node.original_file_path ?? node.path,
        }),
      };
      if (columnType === 'date') {
        timeDimensions.push({
          ...dimension,
          isTimeDimension: true,
          granularities: ['day', 'week', 'month', 'quarter', 'year'],
        });
      } else {
        dimensions.push(dimension);
      }
    }

    layer.addCube({
      name: node.name,
      label: labelFromName(node.name),
      description: node.description ?? '',
      sql: `SELECT * FROM ${tableName}`,
      table: tableName,
      domain,
      measures: [],
      dimensions,
      timeDimensions,
      joins: [],
      segments: [],
      preAggregations: [],
      source: dbtSource('dbt_model', node.unique_id ?? node.name, node.name, node as unknown as Record<string, unknown>),
    });
    layer.addSemanticModel({
      name: node.name,
      label: labelFromName(node.name),
      description: node.description ?? '',
      domain,
      model: node.name,
      table: tableName,
      entities: [],
      measures: [],
      dimensions: dimensions.map((dimension) => dimension.name),
      timeDimensions: timeDimensions.map((dimension) => dimension.name),
      tags: node.tags,
      source: dbtSource('dbt_model', node.unique_id ?? node.name, node.name, node as unknown as Record<string, unknown>),
    });
  }

  return layer;
}

/** Recursively collect all .yml/.yaml files in a directory. */
function collectYamlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...collectYamlFiles(fullPath));
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (ext === '.yml' || ext === '.yaml') {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip inaccessible entries
    }
  }
  return results;
}

/** Extract a table name from a dbt semantic model. */
function resolveDbtModelTableName(node: DbtManifestModelNode): string {
  if (node.relation_name) return node.relation_name;
  const relation = [node.database, node.schema, node.alias ?? node.name].filter(Boolean).join('.');
  return relation || node.name;
}

function inferDbtColumnType(dataType: unknown, columnName: string): DimensionDefinition['type'] {
  const value = `${typeof dataType === 'string' ? dataType : ''} ${columnName}`.toLowerCase();
  if (/\b(bool|boolean)\b/.test(value)) return 'boolean';
  if (/\b(date|time|timestamp|datetime)\b/.test(value)) return 'date';
  if (/\b(int|integer|number|numeric|decimal|double|float|real)\b/.test(value)) return 'number';
  return 'string';
}

function labelFromName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function deriveDbtManifestNodeDomain(node: DbtManifestModelNode): string {
  const meta = asRecord(node.meta);
  const config = asRecord(node.config);
  const configMeta = asRecord(config.meta);
  return firstString(
    meta?.domain,
    meta?.group,
    configMeta?.domain,
    configMeta?.group,
    config?.group,
    Array.isArray(node.fqn) && node.fqn.length > 1 ? node.fqn[1] : undefined,
    node.package_name,
  )?.replace(/[^a-z0-9/_-]+/gi, '-').toLowerCase() || 'uncategorized';
}

function resolveTableName(model: DbtSemanticModel): string {
  // Modern MetricFlow semantic_manifest.json artifacts resolve `model` into a
  // concrete node_relation. Preserve that resolved relation instead of falling
  // back to the semantic-model name (`order_item` is not `dev.order_items`).
  if (model.node_relation?.relation_name?.trim()) {
    return model.node_relation.relation_name.trim();
  }
  if (model.node_relation?.alias?.trim()) {
    return model.node_relation.schema_name?.trim()
      ? `${model.node_relation.schema_name.trim()}.${model.node_relation.alias.trim()}`
      : model.node_relation.alias.trim();
  }
  if (model.model) {
    // dbt model refs look like "ref('stg_orders')" - extract the model name
    const match = model.model.match(/ref\(['"](.+?)['"]\)/);
    if (match) return match[1];
    return model.model;
  }
  return model.name;
}

function dbtSource(
  objectType: string,
  objectId: string,
  objectName: string,
  raw?: Record<string, unknown>,
): MetricDefinition['source'] {
  return {
    provider: 'dbt',
    objectType,
    objectId,
    objectName,
    extra: raw
      ? {
          uniqueId: raw.unique_id,
          packageName: raw.package_name,
          path: raw.original_file_path ?? raw.path,
          meta: raw.meta,
          config: raw.config,
          raw,
        }
      : undefined,
  };
}

/**
 * Where a foreign entity joins TO. In dbt/MetricFlow, a foreign entity `location`
 * joins to the semantic model whose PRIMARY (or natural/unique) entity is also
 * named `location`. This index maps that entity name → the target cube and its
 * join key, so cross-model joins resolve to a real cube instead of the entity name.
 */
export type PrimaryEntityIndex = Map<string, { cube: string; key: string } | null>;

/** Build the primary-entity → {cube, key} index across all semantic models. */
export function buildPrimaryEntityIndex(models: DbtSemanticModel[]): PrimaryEntityIndex {
  const index: PrimaryEntityIndex = new Map();
  for (const model of models) {
    for (const entity of model.entities ?? []) {
      if (entity.type === 'primary' || entity.type === 'natural' || entity.type === 'unique') {
        const target = { cube: model.name, key: entity.expr ?? entity.name };
        const existing = index.get(entity.name);
        if (existing === undefined) index.set(entity.name, target);
        // A bare foreign entity cannot safely select between two primary model
        // targets. Retain the ambiguity explicitly so conversion emits no
        // model-authoritative join instead of depending on manifest order.
        else if (existing && existing.cube !== target.cube) index.set(entity.name, null);
      }
    }
  }
  return index;
}

function registerSemanticModel(
  layer: SemanticLayer,
  model: DbtSemanticModel,
  artifactKind: 'manifest' | 'semantic_manifest' | 'yaml' = 'yaml',
  entityIndex: PrimaryEntityIndex = new Map(),
): void {
  const cube = convertSemanticModel(model, artifactKind, entityIndex);
  layer.addCube(cube);
  layer.addSemanticModel(convertSemanticModelDetail(model, cube));
  for (const measure of model.measures ?? []) {
    layer.addMeasure(convertMeasure(model, measure, cube));
  }
  for (const entity of model.entities ?? []) {
    layer.addEntity(convertEntity(model, entity, cube));
  }
}

/** The five MetricFlow time grains, coarsest-last. A column stored at grain N
 * can be truncated to any grain ≥ N but never finer. */
/** MetricFlow's reserved name for the global aggregate time axis. */
export const METRIC_TIME = 'metric_time';

const GRAIN_ORDER = ['day', 'week', 'month', 'quarter', 'year'] as const;
type TimeGrain = typeof GRAIN_ORDER[number];

function isTimeGrain(value: unknown): value is TimeGrain {
  return typeof value === 'string' && (GRAIN_ORDER as readonly string[]).includes(value);
}

/** Grains available for a column whose base (finest) grain is `base`. Unknown
 * base ⇒ all five (backward-compatible). */
function grainsAtOrAbove(base: TimeGrain | undefined): TimeGrain[] {
  if (!base) return [...GRAIN_ORDER];
  return GRAIN_ORDER.slice(GRAIN_ORDER.indexOf(base));
}

/** The MetricFlow primary-entity name of a semantic model — the head used to
 * qualify its dimensions as `<primaryEntity>__<dim>`. First primary/natural/
 * unique entity wins (matches buildPrimaryEntityIndex). Falls back to the model
 * name so a qualifiedName is always producible. */
function primaryEntityNameOf(model: DbtSemanticModel): string {
  for (const entity of model.entities ?? []) {
    if (entity.type === 'primary' || entity.type === 'natural' || entity.type === 'unique') {
      return entity.name;
    }
  }
  return model.name;
}

/** Convert a dbt semantic model to a DQL CubeDefinition. */
function convertSemanticModel(
  model: DbtSemanticModel,
  artifactKind: 'manifest' | 'semantic_manifest' | 'yaml' = 'yaml',
  entityIndex: PrimaryEntityIndex = new Map(),
): CubeDefinition {
  const tableName = resolveTableName(model);
  const domain = deriveDbtDomain(model);
  const primaryEntity = primaryEntityNameOf(model);

  const measures: MetricDefinition[] = (model.measures ?? []).map((m) => ({
    name: m.name,
    label: m.label ?? m.name,
    description: m.description ?? '',
    domain,
    sql: buildAggSql(m.agg, m.expr ?? m.name),
    type: AGG_TYPE_MAP[m.agg] ?? 'custom',
    table: tableName,
    cube: model.name,
    aggregation: m.agg,
    filter: m.filter,
    aggTimeDimension: m.agg_time_dimension,
    typeParams: {
      agg: m.agg,
      expr: m.expr,
      agg_time_dimension: m.agg_time_dimension,
      create_metric: m.create_metric,
      non_additive_dimension: m.non_additive_dimension,
    },
    source: dbtSource('measure', `${model.name}.${m.name}`, m.name, {
      ...m,
      semantic_model: model.name,
      artifactKind,
    }),
  }));

  const dimensions: DimensionDefinition[] = [];
  const timeDimensions: TimeDimensionDefinition[] = [];

  for (const dim of model.dimensions ?? []) {
    const dqlType = DIM_TYPE_MAP[dim.type] ?? 'string';
    const sqlExpr = dim.expr ?? dim.name;

    // MetricFlow addresses group-bys by the owning model's PRIMARY entity, not
    // the model name: `<primaryEntity>__<dim>`. Stamp this canonical single-hop
    // identity so the compatibility service and query boundary can send the
    // runtime the name it expects. Multi-hop names (grouping across a join) are
    // computed per-request.
    const qualifiedName = `${primaryEntity}__${dim.name}`;

    if (dim.type === 'time') {
      // The declared base grain bounds how finely this column can be truncated.
      // Previously read then discarded (every time dim advertised all five
      // grains); now it narrows the offered set: a month-grain column offers
      // month/quarter/year, never day/week.
      const baseGranularity = isTimeGrain(dim.type_params?.time_granularity)
        ? dim.type_params.time_granularity
        : undefined;
      const isPrimary = model.defaults?.agg_time_dimension === dim.name;

          timeDimensions.push({
        name: dim.name,
        label: dim.label ?? dim.name,
        description: dim.description || model.columnDescriptions?.[dim.expr ?? dim.name] || '',
        sql: sqlExpr,
        type: 'date',
        table: tableName,
        cube: model.name,
        expr: dim.expr,
        isTimeDimension: true,
        qualifiedName,
        entityLink: primaryEntity,
        typeParams: dim.type_params,
        granularities: grainsAtOrAbove(baseGranularity),
        baseGranularity,
        primaryTime: isPrimary,
          domain,
          source: dbtSource('time_dimension', `${model.name}.${dim.name}`, dim.name, {
          ...dim,
          semantic_model: model.name,
          artifactKind,
        }),
      });
    } else {
        dimensions.push({
        name: dim.name,
        label: dim.label ?? dim.name,
        description: dim.description || model.columnDescriptions?.[dim.expr ?? dim.name] || '',
        sql: sqlExpr,
        type: dqlType,
        table: tableName,
        cube: model.name,
        expr: dim.expr,
        qualifiedName,
        entityLink: primaryEntity,
        typeParams: dim.type_params,
          domain,
          source: dbtSource('dimension', `${model.name}.${dim.name}`, dim.name, {
          ...dim,
          semantic_model: model.name,
          artifactKind,
        }),
      });
    }
  }

  // Convert foreign entities to joins. A foreign entity joins to the model whose
  // PRIMARY entity shares its name (MetricFlow semantics) — resolve that target via
  // the cross-model entity index so `join.right` is the real target CUBE and the SQL
  // uses the target's actual key. The old code used `entity.name` for both the
  // target and the right-hand column, so `orders.location_id = ${right}.location`
  // pointed at a non-existent column on a cube named `locations` — findJoinPath
  // (which matches `join.right === targetCube`) never resolved it, and EVERY
  // cross-table governed query silently fell through to generated SQL.
  const joins: JoinDefinition[] = [];
  for (const entity of model.entities ?? []) {
    if (entity.type !== 'foreign') continue;
    const leftKey = entity.expr ?? entity.name;
    const target = entityIndex.get(entity.name);
    joins.push({
      name: target?.cube ?? entity.name,
      left: model.name,
      right: target?.cube ?? entity.name,
      type: 'left',
      sql: `\${left}.${leftKey} = \${right}.${target?.key ?? entity.expr ?? entity.name}`,
      // The foreign-entity name this join traverses — the compatibility service
      // concatenates these to build MetricFlow multi-hop group-by names.
      entity: entity.name,
    });
  }

  // MetricFlow's global time axis.
  //
  // `metric_time` is not declared on any semantic model — MetricFlow synthesizes
  // it from each measure's aggregate time dimension, and it is the name every
  // MetricFlow query uses for a time breakdown (`metric_time__day`,
  // `metric_time__month`, ...). Because DQL only imported DECLARED dimensions it
  // never existed here, so the agent could not select it, compatibility rejected
  // it as unknown, and any question that needed the standard time axis failed
  // with "metric_time__day not found".
  //
  // Project it onto the model's own aggregate time column so the native compiler
  // can resolve it to real SQL while MetricFlow still receives the name it
  // expects. Grains come from the underlying column, so a month-grain fact never
  // advertises a day breakdown it cannot serve.
  const aggTimeName = model.defaults?.agg_time_dimension
    ?? (model.measures ?? []).map((measure) => measure.agg_time_dimension).find(Boolean);
  const aggTimeDim = aggTimeName
    ? (model.dimensions ?? []).find((dim) => dim.type === 'time' && dim.name === aggTimeName)
    : (model.dimensions ?? []).find((dim) => dim.type === 'time');
  if (aggTimeDim && !timeDimensions.some((dim) => dim.name === METRIC_TIME)) {
    const baseGranularity = isTimeGrain(aggTimeDim.type_params?.time_granularity)
      ? aggTimeDim.type_params.time_granularity
      : undefined;
    timeDimensions.push({
      name: METRIC_TIME,
      label: 'Metric time',
      description: `MetricFlow aggregate time axis for ${model.name} (${aggTimeDim.name}).`,
      sql: aggTimeDim.expr ?? aggTimeDim.name,
      type: 'date',
      table: tableName,
      cube: model.name,
      expr: aggTimeDim.expr,
      isTimeDimension: true,
      // Deliberately NOT entity-prefixed: MetricFlow addresses this axis
      // globally as `metric_time`, never `<entity>__metric_time`.
      qualifiedName: METRIC_TIME,
      entityLink: primaryEntity,
      typeParams: aggTimeDim.type_params,
      granularities: grainsAtOrAbove(baseGranularity),
      baseGranularity,
      primaryTime: true,
      domain,
      source: dbtSource('time_dimension', `${model.name}.${METRIC_TIME}`, METRIC_TIME, {
        semantic_model: model.name,
        agg_time_dimension: aggTimeDim.name,
        synthesized: true,
        artifactKind,
      }),
    });
  }

  return {
    name: model.name,
    label: model.label ?? model.name,
    description: model.description ?? '',
    sql: `SELECT * FROM ${tableName}`,
      table: tableName,
      domain,
    measures,
    dimensions,
    timeDimensions,
    joins,
    segments: [],
    preAggregations: [],
    defaultTimeDimension: model.defaults?.agg_time_dimension,
    source: dbtSource('semantic_model', model.unique_id ?? model.name, model.name, {
      ...model,
      artifactKind,
    }),
  };
}

function convertSemanticModelDetail(model: DbtSemanticModel, cube: CubeDefinition): SemanticModelDefinition {
  return {
    name: model.name,
    label: model.label ?? model.name,
    description: model.description ?? '',
    domain: cube.domain,
    model: model.model,
    table: cube.table,
    defaults: model.defaults,
    entities: (model.entities ?? []).map((entity) => entity.name),
    measures: (model.measures ?? []).map((measure) => measure.name),
    dimensions: cube.dimensions.map((dimension) => dimension.name),
    timeDimensions: cube.timeDimensions.map((dimension) => dimension.name),
    tags: cube.tags,
    owner: cube.owner,
    source: cube.source,
  };
}

function convertMeasure(
  model: DbtSemanticModel,
  measure: NonNullable<DbtSemanticModel['measures']>[number],
  cube: CubeDefinition,
): MeasureDefinition {
  return {
    name: measure.name,
    label: measure.label ?? measure.name,
    description: measure.description ?? '',
    domain: cube.domain,
    agg: measure.agg,
    expr: measure.expr,
    table: cube.table,
    cube: model.name,
    aggTimeDimension: measure.agg_time_dimension ?? model.defaults?.agg_time_dimension,
    displayFormat: parseSemanticDisplayFormat((measure as Record<string, unknown>).meta ?? (measure.config as Record<string, unknown> | undefined)?.meta),
    createMetric: measure.create_metric,
    nonAdditiveDimension: measure.non_additive_dimension,
    filter: measure.filter,
    owner: cube.owner,
    tags: cube.tags,
    source: dbtSource('measure', `${model.name}.${measure.name}`, measure.name, {
      ...measure,
      semantic_model: model.name,
    }),
  };
}

function convertEntity(
  model: DbtSemanticModel,
  entity: NonNullable<DbtSemanticModel['entities']>[number],
  cube: CubeDefinition,
): EntityDefinition {
  return {
    name: entity.name,
    label: entity.label ?? entity.name,
    description: entity.description ?? '',
    domain: cube.domain,
    type: entity.type,
    expr: entity.expr,
    table: cube.table,
    cube: model.name,
    role: entity.role,
    owner: cube.owner,
    tags: cube.tags,
    source: dbtSource('entity', `${model.name}.${entity.name}`, entity.name, {
      ...entity,
      semantic_model: model.name,
    }),
  };
}

/** Build an aggregate SQL expression from a dbt agg type and expression. */
function buildAggSql(agg: string, expr: string): string {
  switch (agg) {
    case 'sum': return `SUM(${expr})`;
    case 'count': return `COUNT(${expr})`;
    case 'count_distinct': return `COUNT(DISTINCT ${expr})`;
    case 'average':
    case 'avg': return `AVG(${expr})`;
    case 'min': return `MIN(${expr})`;
    case 'max': return `MAX(${expr})`;
    default: return expr;
  }
}

/** Convert a dbt metric definition to a DQL MetricDefinition. */
function convertDbtMetric(
  dbtMetric: DbtMetric,
  measureLookup: DbtMeasureLookup,
): MetricDefinition | null {
  const isSimple = dbtMetric.type.toLowerCase() === 'simple';
  const measureName = firstSemanticRefName(
    dbtMetric.type_params?.measure,
    dbtMetric.type_params?.measure_name,
    dbtMetric.type_params?.input_measures,
  );
  // Only a simple metric can be represented by one input measure. Selecting a
  // numerator/input from a derived, ratio, conversion, or cumulative metric
  // changes its meaning and previously produced plausible but incorrect SQL.
  const resolvedMeasure = isSimple && measureName ? measureLookup.get(measureName) : undefined;
  const nativeMetricType = resolvedMeasure ? AGG_TYPE_MAP[resolvedMeasure.agg] : undefined;
  const governedDerivedExpression = dbtMetric.type.toLowerCase() === 'ratio'
    ? governedRatioExpression(dbtMetric, measureLookup)
    : undefined;

  return {
    name: dbtMetric.name,
    label: dbtMetric.label ?? dbtMetric.name,
    description: dbtMetric.description ?? '',
    domain: deriveDbtMetricDomain(dbtMetric, resolvedMeasure?.modelName),
    sql: resolvedMeasure && nativeMetricType
      ? buildAggSql(resolvedMeasure.agg, resolvedMeasure.sql)
      : governedDerivedExpression ?? String(dbtMetric.type_params?.expr ?? dbtMetric.name),
    type: nativeMetricType ?? 'custom',
    table: nativeMetricType ? resolvedMeasure?.table ?? '' : '',
    cube: resolvedMeasure?.modelName,
    semanticModelIds: resolvedMeasure?.modelName ? [resolvedMeasure.modelName] : [],
    aggregation: dbtMetric.type,
    metricType: dbtMetric.type,
    // A real dbt metric node — always a metric, never a measure, even when it is
    // a derived/ratio/cumulative type that only runs through a full runtime.
    objectKind: 'metric',
    typeParams: dbtMetric.type_params,
    displayFormat: parseSemanticDisplayFormat(dbtMetric.meta ?? (dbtMetric.config as Record<string, unknown> | undefined)?.meta),
    ...(dbtMetricSynonyms(dbtMetric).length ? { synonyms: dbtMetricSynonyms(dbtMetric) } : {}),
    filter: dbtMetric.filter ?? dbtMetric.filters,
    aggTimeDimension: resolvedMeasure?.measure.agg_time_dimension,
    source: dbtSource('metric', dbtMetric.unique_id ?? dbtMetric.name, dbtMetric.name, dbtMetric as unknown as Record<string, unknown>),
  };
}

function governedRatioExpression(
  metric: DbtMetric,
  measureLookup: DbtMeasureLookup,
): string | undefined {
  const numeratorName = firstSemanticRefName(metric.type_params?.numerator);
  const denominatorName = firstSemanticRefName(metric.type_params?.denominator);
  if (!numeratorName || !denominatorName) return undefined;
  const numerator = measureLookup.get(numeratorName);
  const denominator = measureLookup.get(denominatorName);
  if (!numerator || !denominator
    || numerator.modelName !== denominator.modelName
    || numerator.table !== denominator.table) return undefined;
  const numeratorSql = buildAggSql(numerator.agg, numerator.sql);
  const denominatorSql = buildAggSql(denominator.agg, denominator.sql);
  return `(${numeratorSql}) / (${denominatorSql})`;
}

/**
 * ID-001 / CONTRACT-002: attach canonical semantic-model ownership after all
 * dbt metrics are known. dbt derived metrics frequently omit a direct measure
 * and reference other metrics instead, so converting them one at a time leaves
 * them incorrectly unowned and exposes the entire global dimension catalog.
 */
function convertDbtMetrics(
  dbtMetrics: DbtMetric[],
  measureLookup: DbtMeasureLookup,
): MetricDefinition[] {
  const rawByName = new Map(dbtMetrics.map((metric) => [metric.name, metric]));
  const converted = dbtMetrics
    .map((metric) => convertDbtMetric(metric, measureLookup))
    .filter((metric): metric is MetricDefinition => Boolean(metric));
  const convertedByName = new Map(converted.map((metric) => [metric.name, metric]));
  const ownershipCache = new Map<string, Set<string>>();

  const collectReferenceNames = (value: unknown, output: Set<string>): void => {
    if (typeof value === 'string') {
      if (value.trim()) output.add(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectReferenceNames(item, output);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const raw = value as Record<string, unknown>;
    for (const key of ['name', 'metric', 'metric_name', 'measure', 'measure_name']) {
      if (raw[key] !== undefined) collectReferenceNames(raw[key], output);
    }
  };

  const collectNamesForKeys = (value: unknown, keys: Set<string>, output: Set<string>): void => {
    if (Array.isArray(value)) {
      for (const item of value) collectNamesForKeys(item, keys, output);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(key)) collectReferenceNames(nested, output);
      collectNamesForKeys(nested, keys, output);
    }
  };

  const measureKeys = new Set([
    'measure',
    'measure_name',
    'input_measures',
    'base_measure',
    'conversion_measure',
  ]);
  const metricKeys = new Set([
    'metrics',
    'metric',
    'metric_name',
    'numerator',
    'denominator',
    'base_metric',
    'conversion_metric',
  ]);

  const inferOwnership = (metricName: string, visiting = new Set<string>()): Set<string> => {
    const cached = ownershipCache.get(metricName);
    if (cached) return new Set(cached);
    if (visiting.has(metricName)) return new Set();
    const nextVisiting = new Set(visiting).add(metricName);
    const raw = rawByName.get(metricName);
    const definition = convertedByName.get(metricName);
    const owners = new Set<string>(definition?.cube ? [definition.cube] : []);
    if (!raw) return owners;

    const measureNames = new Set<string>();
    collectNamesForKeys(raw.type_params, measureKeys, measureNames);
    for (const name of measureNames) {
      const modelName = measureLookup.get(name)?.modelName;
      if (modelName) owners.add(modelName);
    }

    const referencedMetrics = new Set<string>();
    collectNamesForKeys(raw.type_params, metricKeys, referencedMetrics);
    for (const referenced of referencedMetrics) {
      if (referenced === metricName || !convertedByName.has(referenced)) continue;
      for (const owner of inferOwnership(referenced, nextVisiting)) owners.add(owner);
    }

    ownershipCache.set(metricName, new Set(owners));
    return owners;
  };

  return converted.map((metric) => {
    const semanticModelIds = Array.from(inferOwnership(metric.name)).sort((a, b) => a.localeCompare(b));
    const cube = semanticModelIds.length === 1 ? semanticModelIds[0] : undefined;
    const raw = rawByName.get(metric.name);
    return {
      ...metric,
      cube,
      semanticModelIds,
      domain: raw ? deriveDbtMetricDomain(raw, cube) : metric.domain,
    };
  });
}

function firstSemanticRefName(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const nested = firstSemanticRefName(...value);
      if (nested) return nested;
      continue;
    }
    if (value && typeof value === 'object') {
      const raw = value as Record<string, unknown>;
      const nested = firstSemanticRefName(raw.name, raw.measure, raw.measure_name);
      if (nested) return nested;
    }
  }
  return undefined;
}

function deriveDbtDomain(model: DbtSemanticModel): string {
  const meta = asRecord(model.meta);
  const config = asRecord(model.config);
  const configMeta = asRecord(config.meta);
  return firstString(
    meta?.domain,
    meta?.group,
    configMeta?.domain,
    configMeta?.group,
    config?.group,
    model.package_name,
  )?.replace(/[^a-z0-9/_-]+/gi, '-').toLowerCase() || 'uncategorized';
}

/** Other names people use for a metric: `config.meta.synonyms` (or `meta.synonyms`) as a list of words. */
function dbtMetricSynonyms(metric: DbtMetric): string[] {
  const meta = asRecord(metric.meta);
  const configMeta = asRecord(asRecord(metric.config).meta);
  const out: string[] = [];
  for (const value of [configMeta.synonyms, meta.synonyms]) {
    for (const item of Array.isArray(value) ? value : []) {
      const word = typeof item === 'string' ? item.trim() : '';
      if (word && !out.some((seen) => seen.toLowerCase() === word.toLowerCase())) out.push(word);
    }
  }
  return out;
}

function deriveDbtMetricDomain(metric: DbtMetric, modelName?: string): string {
  const meta = asRecord(metric.meta);
  const config = asRecord(metric.config);
  const configMeta = asRecord(config.meta);
  return firstString(
    meta?.domain,
    meta?.group,
    configMeta?.domain,
    configMeta?.group,
    config?.group,
    metric.package_name,
    modelName,
  )?.replace(/[^a-z0-9/_-]+/gi, '-').toLowerCase() || 'uncategorized';
}

/** MetricFlow order_by entries are `name` or `-name` (descending). */
function parseSavedQueryOrderBy(orderBy: string[] | undefined): SavedQueryDefinition['orderBy'] {
  if (!Array.isArray(orderBy) || orderBy.length === 0) return undefined;
  const parsed = orderBy
    .map((raw) => String(raw).trim())
    .filter(Boolean)
    .map((raw) => raw.startsWith('-')
      ? { name: raw.slice(1), direction: 'desc' as const }
      : { name: raw, direction: 'asc' as const });
  return parsed.length > 0 ? parsed : undefined;
}

function convertSavedQuery(savedQuery: DbtSavedQuery): SavedQueryDefinition {
  const groupBy = savedQuery.query_params?.group_by ?? [];
  const timeRef = groupBy.find((value) => value.includes('__')) ?? groupBy.find((value) => value.toLowerCase().includes('metric_time'));
  const [timeDimension, granularity] = timeRef?.split('__') ?? [];
  const meta = asRecord(savedQuery.config?.meta);
  return {
    name: savedQuery.name,
    label: savedQuery.label ?? savedQuery.name,
    description: savedQuery.description ?? '',
    domain: firstString(meta.domain, meta.group) ?? 'uncategorized',
    metrics: savedQuery.query_params?.metrics ?? [],
    dimensions: groupBy.filter((value) => value !== timeRef),
    timeDimension: timeDimension || undefined,
    granularity,
    filters: savedQuery.query_params?.where,
    orderBy: parseSavedQueryOrderBy(savedQuery.query_params?.order_by),
    limit: typeof savedQuery.query_params?.limit === 'number' ? savedQuery.query_params.limit : undefined,
    exports: savedQuery.exports,
    tags: Array.isArray(savedQuery.config?.tags) ? savedQuery.config.tags.map(String) : undefined,
    source: dbtSource('saved_query', savedQuery.unique_id ?? savedQuery.name, savedQuery.name, savedQuery as unknown as Record<string, unknown>),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function collectMetricRefs(metric: DbtMetric): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value) return;
    if (typeof value === 'string') {
      refs.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      const raw = value as Record<string, unknown>;
      for (const key of ['name', 'metric', 'metric_name', 'measure', 'measure_name']) visit(raw[key]);
      for (const nested of Object.values(raw)) {
        if (typeof nested === 'object') visit(nested);
      }
    }
  };
  visit(metric.type_params?.metrics);
  visit(metric.type_params?.numerator);
  visit(metric.type_params?.denominator);
  return Array.from(refs);
}
