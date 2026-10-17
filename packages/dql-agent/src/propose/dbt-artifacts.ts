/**
 * Read-only readers for dbt build artifacts used by `zlens propose`.
 *
 * These parse the raw JSON shapes that dbt writes to `target/`:
 *   - `manifest.json`        — models, sources, depends_on, tags, schema, description
 *   - `catalog.json`         — column names + types (from the warehouse)
 *   - `semantic_manifest.json` (or manifest.json semantic nodes) — metrics/dimensions
 *   - `run_results.json`     — per-node execution records (used for run-frequency ranking)
 *
 * We deliberately do NOT reuse the manifest builder's `importDbtManifest`: that
 * function is private and tightly coupled to a full ZLens project scan (it walks
 * the DQL-referenced anchor set). `zlens propose` runs *before* a DQL layer
 * exists, so it reads the dbt artifacts directly. The field shapes mirror those
 * the builder consumes, so the two stay aligned.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WarehouseCatalogSnapshotV1 } from '@zlens/core';

export interface DbtColumn {
  name: string;
  type?: string;
  description?: string;
}

export interface DbtModelNode {
  uniqueId: string;
  name: string;
  resourceType: 'model';
  schema?: string;
  database?: string;
  /** dbt `alias` (the warehouse relation name), when it differs from `name`. */
  alias?: string;
  /**
   * Fully-qualified warehouse relation `database.schema.alias` (e.g.
   * `dev.order_items`), built from the existing manifest fields. This is the
   * REAL relation a `FROM` clause in an ad-hoc cell must reference — never the
   * bare model name. Falls back to the most-qualified form available.
   */
  qualifiedRelation: string;
  /** The dbt `{{ ref('<name>') }}` form for governed BLOCK SQL. */
  refForm: string;
  description?: string;
  materialized?: string;
  tags: string[];
  /** Folder segment after `models/`, e.g. `marts` or `staging`. */
  folder?: string;
  /** Domain hint from meta/group/fqn/package. */
  domainHint?: string;
  /** Upstream uniqueIds. */
  dependsOn: string[];
  /** Columns declared in the dbt model YAML (name + description; type may be empty). */
  columns: DbtColumn[];
  /** dbt model config + meta, kept for grain/primary-key inference. */
  meta: Record<string, unknown>;
  config: Record<string, unknown>;
  /** Path relative to the dbt project root. */
  path?: string;
}

export interface DbtSourceNode {
  uniqueId: string;
  name: string;
  resourceType: 'source';
  schema?: string;
  database?: string;
  /** Fully-qualified warehouse relation `database.schema.identifier`. */
  qualifiedRelation: string;
  /** The dbt `{{ source('<source>', '<table>') }}` form, when derivable. */
  refForm?: string;
  description?: string;
  tags: string[];
}

/**
 * Build the fully-qualified warehouse relation for a node from its
 * `database` / `schema` / relation-name fields. Returns the most-qualified
 * dotted form available (`db.schema.name` → `schema.name` → `name`) so a
 * `FROM` clause always references the REAL relation, never a bare model name.
 */
export function buildQualifiedRelation(parts: {
  database?: string;
  schema?: string;
  name: string;
}): string {
  return [parts.database, parts.schema, parts.name]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .join('.');
}

export interface DbtExposureNode {
  uniqueId: string;
  name: string;
  /** Downstream node uniqueIds this exposure depends on. */
  dependsOn: string[];
}

export interface DbtArtifacts {
  projectName?: string;
  models: DbtModelNode[];
  sources: DbtSourceNode[];
  exposures: DbtExposureNode[];
  /** model uniqueId -> column metadata from catalog.json (richer types). */
  catalogColumns: Map<string, DbtColumn[]>;
  /** node uniqueId -> number of recorded runs in run_results.json. */
  runCounts: Map<string, number>;
  /** Whether a semantic manifest with metrics/saved-queries was present. */
  hasSemantic: boolean;
  /** Semantic metric names keyed by the model they bind to (best-effort). */
  semanticMetrics: SemanticMetricRef[];
  /** Semantic models keyed by bound dbt model name (for entity/agg generation). */
  semanticModels: Map<string, SemanticModelRef>;
}

export interface SemanticMetricRef {
  name: string;
  description?: string;
  /** Model name the metric's measure resolves to, when derivable. */
  model?: string;
  /** Underlying measure name (MetricFlow). */
  measure?: string;
  /** Aggregation type for the measure (sum, count_distinct, average, …). */
  agg?: string;
  /** The column/expr the measure aggregates over, when declared. */
  expr?: string;
  /** Metric type from the semantic manifest (simple, ratio, derived, …). */
  metricType?: string;
}

/** A semantic model's queryable shape (for entity/aggregation generation). */
export interface SemanticModelRef {
  /** Bound dbt model name (node_relation.alias, else the semantic model name). */
  model: string;
  /** Dimension column names declared on the semantic model. */
  dimensions: string[];
  /** Primary entity column name, when one is declared. */
  primaryEntity?: string;
  /** All entity column names. */
  entities: string[];
  /** Time dimension column names. */
  timeDimensions: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Derive the `models/<folder>/...` segment from a node path, e.g. `marts`. */
function folderFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)models\/([^/]+)\//);
  if (match) return match[1];
  // No `models/` prefix (e.g. already relative) — take the leading segment.
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : undefined;
}

/** Best-effort domain label from a dbt model node. */
function domainFromNode(node: Record<string, unknown>, folder?: string): string | undefined {
  const meta = asRecord(node.meta);
  const config = asRecord(node.config);
  const configMeta = asRecord(config.meta);
  const fqn = Array.isArray(node.fqn) ? (node.fqn as unknown[]) : [];
  return firstString(
    meta.domain,
    meta.group,
    configMeta.domain,
    configMeta.group,
    config.group,
    folder && folder !== 'marts' && folder !== 'staging' && folder !== 'intermediate' ? folder : undefined,
    fqn.length > 1 ? fqn[1] : undefined,
  );
}

function readColumns(node: Record<string, unknown>): DbtColumn[] {
  const columns = asRecord(node.columns);
  const out: DbtColumn[] = [];
  for (const [key, raw] of Object.entries(columns)) {
    const col = asRecord(raw);
    const name = firstString(col.name, key);
    if (!name) continue;
    out.push({
      name,
      type: firstString(col.data_type),
      description: firstString(col.description),
    });
  }
  return out;
}

/**
 * Load all dbt artifacts that live alongside `manifest.json` (same `target/`
 * directory). Only `manifest.json` is required; the rest are optional and the
 * loader degrades gracefully when they are missing.
 */
export function loadDbtArtifacts(manifestPath: string): DbtArtifacts {
  const manifest = readJson(manifestPath);
  if (!manifest) {
    throw new Error(`Could not read or parse dbt manifest at ${manifestPath}`);
  }

  const targetDir = manifestPath.replace(/[\\/][^\\/]+$/, '');
  const projectName = firstString(asRecord(manifest.metadata).project_name);

  const models: DbtModelNode[] = [];
  const sources: DbtSourceNode[] = [];
  const exposures: DbtExposureNode[] = [];

  for (const [uniqueId, raw] of Object.entries(asRecord(manifest.nodes))) {
    const node = asRecord(raw);
    if (node.resource_type !== 'model') continue;
    // `name` is the logical model name (used by `{{ ref() }}`); `alias` is the
    // warehouse relation name. They are usually equal, but when an `alias` is
    // declared the qualified relation must use it, not the model name.
    const modelName = firstString(node.name);
    const alias = firstString(node.alias);
    const name = alias ?? modelName;
    if (!name) continue;
    const refName = modelName ?? name;
    const schema = firstString(node.schema);
    const database = firstString(node.database);
    const path = firstString(node.original_file_path, node.path);
    const folder = folderFromPath(path);
    const dependsOn = Array.isArray(asRecord(node.depends_on).nodes)
      ? (asRecord(node.depends_on).nodes as unknown[]).filter((n): n is string => typeof n === 'string')
      : [];
    models.push({
      uniqueId,
      name,
      resourceType: 'model',
      schema,
      database,
      alias: alias && alias !== modelName ? alias : undefined,
      qualifiedRelation: buildQualifiedRelation({ database, schema, name }),
      refForm: `{{ ref('${refName}') }}`,
      description: firstString(node.description),
      materialized: firstString(asRecord(node.config).materialized),
      tags: Array.isArray(node.tags) ? (node.tags as unknown[]).map(String) : [],
      folder,
      domainHint: domainFromNode(node, folder),
      dependsOn,
      columns: readColumns(node),
      meta: asRecord(node.meta),
      config: asRecord(node.config),
      path,
    });
  }

  for (const [uniqueId, raw] of Object.entries(asRecord(manifest.sources))) {
    const node = asRecord(raw);
    const identifier = firstString(node.identifier, node.name);
    if (!identifier) continue;
    const schema = firstString(node.schema);
    const database = firstString(node.database);
    const sourceName = firstString(node.source_name);
    sources.push({
      uniqueId,
      name: identifier,
      resourceType: 'source',
      schema,
      database,
      qualifiedRelation: buildQualifiedRelation({ database, schema, name: identifier }),
      refForm: sourceName ? `{{ source('${sourceName}', '${firstString(node.name) ?? identifier}') }}` : undefined,
      description: firstString(node.description),
      tags: Array.isArray(node.tags) ? (node.tags as unknown[]).map(String) : [],
    });
  }

  for (const [uniqueId, raw] of Object.entries(asRecord(manifest.exposures))) {
    const node = asRecord(raw);
    const dependsOn = Array.isArray(asRecord(node.depends_on).nodes)
      ? (asRecord(node.depends_on).nodes as unknown[]).filter((n): n is string => typeof n === 'string')
      : [];
    exposures.push({
      uniqueId,
      name: firstString(node.name) ?? uniqueId,
      dependsOn,
    });
  }

  return {
    projectName,
    models,
    sources,
    exposures,
    catalogColumns: loadCatalog(join(targetDir, 'catalog.json')),
    runCounts: loadRunResults(join(targetDir, 'run_results.json')),
    ...loadSemantic(manifest, join(targetDir, 'semantic_manifest.json')),
  };
}

/** catalog.json carries warehouse-resolved column types keyed by node uniqueId. */
function loadCatalog(catalogPath: string): Map<string, DbtColumn[]> {
  const out = new Map<string, DbtColumn[]>();
  if (!existsSync(catalogPath)) return out;
  const catalog = readJson(catalogPath);
  if (!catalog) return out;
  for (const [uniqueId, raw] of Object.entries(asRecord(catalog.nodes))) {
    const node = asRecord(raw);
    const columns = asRecord(node.columns);
    const cols: DbtColumn[] = [];
    for (const [key, colRaw] of Object.entries(columns)) {
      const col = asRecord(colRaw);
      const name = firstString(col.name, key);
      if (!name) continue;
      cols.push({ name, type: firstString(col.type), description: firstString(col.comment) });
    }
    if (cols.length > 0) out.set(uniqueId, cols);
  }
  return out;
}

/** run_results.json lists one result per executed node; count occurrences. */
function loadRunResults(runResultsPath: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(runResultsPath)) return out;
  const runResults = readJson(runResultsPath);
  if (!runResults) return out;
  const results = Array.isArray(runResults.results) ? runResults.results : [];
  for (const raw of results) {
    const result = asRecord(raw);
    const uniqueId = firstString(result.unique_id);
    if (!uniqueId) continue;
    out.set(uniqueId, (out.get(uniqueId) ?? 0) + 1);
  }
  return out;
}

/**
 * Load semantic metric references, preferring `semantic_manifest.json` and
 * falling back to semantic nodes embedded in `manifest.json`. Returns a flag so
 * the caller can decide whether to attempt metric-wrapper drafts.
 */
function loadSemantic(
  manifest: Record<string, unknown>,
  semanticManifestPath: string,
): {
  hasSemantic: boolean;
  semanticMetrics: SemanticMetricRef[];
  semanticModels: Map<string, SemanticModelRef>;
} {
  let source: Record<string, unknown> | null = null;
  if (existsSync(semanticManifestPath)) {
    source = readJson(semanticManifestPath);
  }
  // `semantic_manifest.json` carries metrics/semantic_models as ARRAYS, while
  // the inline `manifest.json` carries them as keyed RECORDS — normalize both to
  // a flat list of nodes so the loader works on either source.
  const metricsList = collectionValues(source?.metrics ?? manifest.metrics);
  const semanticModelsList = collectionValues(source?.semantic_models ?? manifest.semantic_models);

  // measure name -> model name, so a metric referencing a measure can resolve a
  // model. A semantic model's underlying dbt model is the alias in its
  // `node_relation` (MetricFlow shape), else its `name`. Also collect the
  // measure's agg + expr so a metric can build real aggregation SQL.
  const measureToModel = new Map<string, string>();
  const measureMeta = new Map<string, { agg?: string; expr?: string }>();
  const semanticModels = new Map<string, SemanticModelRef>();

  for (const raw of semanticModelsList) {
    const semanticModel = asRecord(raw);
    const modelName = firstString(asRecord(semanticModel.node_relation).alias, semanticModel.name);
    if (!modelName) continue;

    const entities = (Array.isArray(semanticModel.entities) ? semanticModel.entities : [])
      .map((e) => asRecord(e));
    const entityNames = entities
      .map((e) => firstString(e.expr, e.name))
      .filter((v): v is string => Boolean(v));
    const primaryEntity = firstString(
      ...entities.filter((e) => e.type === 'primary').map((e) => firstString(e.expr, e.name) ?? ''),
    );
    const dimensions = (Array.isArray(semanticModel.dimensions) ? semanticModel.dimensions : [])
      .map((d) => asRecord(d));
    const dimensionNames = dimensions
      .map((d) => firstString(d.name))
      .filter((v): v is string => Boolean(v));
    const timeDimensions = dimensions
      .filter((d) => d.type === 'time')
      .map((d) => firstString(d.name))
      .filter((v): v is string => Boolean(v));

    semanticModels.set(modelName, {
      model: modelName,
      dimensions: dimensionNames,
      primaryEntity: primaryEntity || undefined,
      entities: entityNames,
      timeDimensions,
    });

    for (const measureRaw of Array.isArray(semanticModel.measures) ? semanticModel.measures : []) {
      const measure = asRecord(measureRaw);
      const measureName = firstString(measure.name);
      if (!measureName) continue;
      measureToModel.set(measureName, modelName);
      measureMeta.set(measureName, {
        agg: firstString(measure.agg),
        expr: firstString(measure.expr),
      });
    }
  }

  const semanticMetrics: SemanticMetricRef[] = [];
  for (const raw of metricsList) {
    const metric = asRecord(raw);
    const name = firstString(metric.name);
    if (!name) continue;
    const typeParams = asRecord(metric.type_params);
    // `type_params.measure` is sometimes a string, sometimes an object { name }.
    const measure = firstString(typeParams.measure, asRecord(typeParams.measure).name);
    const meta = measure ? measureMeta.get(measure) : undefined;
    semanticMetrics.push({
      name,
      description: firstString(metric.description),
      model: measure ? measureToModel.get(measure) : undefined,
      measure,
      agg: meta?.agg,
      expr: meta?.expr,
      metricType: firstString(metric.type),
    });
  }

  return {
    hasSemantic: semanticMetrics.length > 0 || semanticModelsList.length > 0,
    semanticMetrics,
    semanticModels,
  };
}

/** Flatten a metrics/semantic_models collection that may be an array OR a record. */
function collectionValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
  return [];
}

/**
 * Present a warehouse catalog snapshot (`zlens sync warehouse`, a project
 * without dbt) in the shape the shared SQL grounding reads. A warehouse
 * relation is queried by its own name, so its "ref form" is the relation
 * itself; there is no dbt lineage, so join keys come only from shared key
 * columns (suggestions, never join authorization).
 */
export function artifactsFromWarehouseCatalog(snapshot: WarehouseCatalogSnapshotV1): DbtArtifacts {
  return {
    projectName: undefined,
    models: snapshot.relations.map((relation) => ({
      uniqueId: relation.id,
      name: relation.name,
      resourceType: 'model' as const,
      schema: relation.schema,
      database: relation.database,
      qualifiedRelation: relation.relation,
      refForm: relation.relation,
      description: relation.comment,
      materialized: relation.kind,
      tags: [],
      dependsOn: [],
      columns: relation.columns.map((column) => ({ name: column.name, type: column.type, description: column.comment })),
      meta: relation.primaryKey?.length ? { primary_key: relation.primaryKey } : {},
      config: {},
    })),
    sources: [],
    exposures: [],
    catalogColumns: new Map(),
    runCounts: new Map(),
    hasSemantic: false,
    semanticMetrics: [],
    semanticModels: new Map(),
  };
}
