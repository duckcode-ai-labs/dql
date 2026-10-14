import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import {
  CubejsProvider,
  DbtProvider,
  SnowflakeSemanticProvider,
  type CubeDefinition,
  type DimensionDefinition,
  type EntityDefinition,
  type HierarchyDefinition,
  type MeasureDefinition,
  type MetricDefinition,
  type PreAggregationDefinition,
  type SavedQueryDefinition,
  type SegmentDefinition,
  type SemanticLayer,
  type SemanticModelDefinition,
  type SemanticLayerProviderConfig,
  type SemanticSourceMetadata,
  type SnowflakeQueryExecutor,
  resolveRepoSource,
  semanticDimensionReference,
} from '@zlens/core';

export interface SemanticImportManifestObject {
  id: string;
  kind: 'cube' | 'metric' | 'measure' | 'dimension' | 'time_dimension' | 'entity' | 'hierarchy' | 'segment' | 'pre_aggregation' | 'semantic_model' | 'saved_query';
  name: string;
  label: string;
  domain: string;
  cube?: string;
  reference?: string;
  filePath: string;
  source?: SemanticSourceMetadata;
}

export interface SemanticImportManifest {
  version: 1;
  mode: 'imported';
  provider: 'dbt' | 'cubejs' | 'snowflake';
  importedAt: string;
  source: {
    projectPath?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    connection?: string;
  };
  warnings: string[];
  generatedFiles: string[];
  objects: SemanticImportManifestObject[];
}

export interface SemanticImportResult {
  manifest: SemanticImportManifest;
  counts: Record<SemanticImportManifestObject['kind'], number>;
}

export interface SemanticImportPreview {
  provider: 'dbt' | 'cubejs' | 'snowflake';
  counts: Record<SemanticImportManifestObject['kind'], number>;
  domains: string[];
  warnings: string[];
  objects: Array<{ kind: SemanticImportManifestObject['kind']; name: string; label: string; domain: string }>;
}

export interface SemanticSyncDiff {
  added: Array<{ kind: SemanticImportManifestObject['kind']; name: string; label: string; domain: string }>;
  removed: Array<{ kind: SemanticImportManifestObject['kind']; name: string; label: string; domain: string }>;
  changed: Array<{ kind: SemanticImportManifestObject['kind']; name: string; label: string; domain: string }>;
  unchanged: number;
}

export interface SemanticTreeNode {
  id: string;
  label: string;
  kind: 'provider' | 'domain' | 'cube' | 'group' | SemanticImportManifestObject['kind'];
  count?: number;
  meta?: Record<string, string | number | boolean | null | undefined>;
  children?: SemanticTreeNode[];
}

export interface SemanticObjectDetail {
  id: string;
  kind: SemanticImportManifestObject['kind'];
  name: string;
  label: string;
  description: string;
  domain: string;
  cube?: string;
  table?: string;
  sql?: string;
  type?: string;
  /** Provider-neutral model-scoped identity persisted in DQL artifacts. */
  reference?: string;
  /** Adapter-specific MetricFlow group-by spelling, diagnostic only. */
  qualifiedName?: string;
  entityLink?: string;
  tags: string[];
  owner: string | null;
  source: SemanticSourceMetadata | null;
  filePath: string | null;
  importedAt: string | null;
  joins?: CubeDefinition['joins'];
  levels?: HierarchyDefinition['levels'];
  measures?: string[];
  dimensions?: string[];
  timeDimension?: string;
  granularity?: string;
  refreshKey?: string;
  agg?: string;
  expr?: string;
  metricType?: string;
  typeParams?: Record<string, unknown>;
  filter?: unknown;
  entities?: string[];
  savedQueryMetrics?: string[];
  exports?: Array<Record<string, unknown>>;
}

const MANIFEST_RELATIVE_PATH = 'semantic-layer/imports/manifest.json';

export async function performSemanticImport(opts: {
  targetProjectRoot: string;
  provider: 'dbt' | 'cubejs' | 'snowflake';
  sourceConfig: SemanticLayerProviderConfig;
  executeQuery?: SnowflakeQueryExecutor;
}): Promise<SemanticImportResult> {
  const targetProjectRoot = resolve(opts.targetProjectRoot);
  const previousManifest = loadSemanticImportManifest(targetProjectRoot);
  const previousManaged = new Set(previousManifest?.generatedFiles ?? []);

  const source = resolveImportSource(opts.targetProjectRoot, opts.sourceConfig);
  const layer = await loadLayerForImport(opts.provider, source.localPath, source.config, opts.executeQuery);
  const warnings = [...source.warnings, ...collectImportWarnings(opts.provider, layer)];
  const objects = collectObjects(layer);

  const generatedFiles: string[] = [];
  const manifestObjects: SemanticImportManifestObject[] = [];

  for (const relPath of previousManaged) {
    const absPath = join(targetProjectRoot, relPath);
    if (existsSync(absPath)) {
      rmSync(absPath, { force: true });
    }
  }

  // dbt declares an entity in every semantic model that uses it (primary in
  // one, foreign in the others). A name declared more than once is written per
  // model; a name declared once keeps its plain file, as before.
  const entityNameCounts = new Map<string, number>();
  for (const object of objects) {
    if (object.kind === 'entity') entityNameCounts.set(object.name, (entityNameCounts.get(object.name) ?? 0) + 1);
  }
  for (const object of objects) {
    const normalizedDomain = normalizeDomain(object.domain);
    const registryReference = object.kind === 'dimension' || object.kind === 'time_dimension'
      ? semanticDimensionReference(object)
      : object.kind === 'entity' && (entityNameCounts.get(object.name) ?? 0) > 1 && object.cube
        ? `${object.cube}.${object.name}`
        : object.name;
    const filePath = buildSemanticFilePath(object.kind, normalizedDomain, registryReference);
    const absPath = join(targetProjectRoot, filePath);
    if (existsSync(absPath) && !previousManaged.has(filePath)) {
      throw new Error(`Import conflict: ${filePath} already exists and is not managed by semantic import.`);
    }
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, serializeSemanticObject(object), 'utf-8');
    generatedFiles.push(filePath);
    manifestObjects.push({
      id: objectId(object.kind, registryReference),
      kind: object.kind,
      name: object.name,
      label: object.label,
      domain: normalizedDomain,
      cube: 'cube' in object ? object.cube : undefined,
      reference: registryReference,
      filePath,
      source: object.source,
    });
  }

  const manifest: SemanticImportManifest = {
    version: 1,
    mode: 'imported',
    provider: opts.provider,
    importedAt: new Date().toISOString(),
    source: {
      projectPath: opts.sourceConfig.projectPath,
      repoUrl: opts.sourceConfig.repoUrl,
      branch: opts.sourceConfig.branch,
      subPath: opts.sourceConfig.subPath,
      connection: opts.sourceConfig.connection,
    },
    warnings,
    generatedFiles: [...generatedFiles, MANIFEST_RELATIVE_PATH],
    objects: manifestObjects,
  };

  const manifestPath = join(targetProjectRoot, MANIFEST_RELATIVE_PATH);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  applyCanonicalSemanticConfig(targetProjectRoot);

  return {
    manifest,
    counts: countObjects(manifestObjects),
  };
}

export function syncSemanticImport(opts: {
  targetProjectRoot: string;
  executeQuery?: SnowflakeQueryExecutor;
}): Promise<SemanticImportResult> {
  const manifest = loadSemanticImportManifest(opts.targetProjectRoot);
  if (!manifest) {
    throw new Error('No semantic import manifest found. Run `zlens semantic import <provider>` first.');
  }
  const sourceConfig: SemanticLayerProviderConfig = {
    provider: manifest.provider,
    projectPath: manifest.source.projectPath,
    repoUrl: manifest.source.repoUrl,
    branch: manifest.source.branch,
    subPath: manifest.source.subPath,
    connection: manifest.source.connection,
  };
  return performSemanticImport({
    targetProjectRoot: opts.targetProjectRoot,
    provider: manifest.provider,
    sourceConfig,
    executeQuery: opts.executeQuery,
  });
}

export function loadSemanticImportManifest(projectRoot: string): SemanticImportManifest | null {
  const manifestPath = join(resolve(projectRoot), MANIFEST_RELATIVE_PATH);
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as SemanticImportManifest;
  } catch {
    return null;
  }
}

function technicalMeasuresForCube(
  cube: CubeDefinition,
  measures: MeasureDefinition[],
): MeasureDefinition[] {
  const byName = new Map(
    measures
      .filter((measure) => measure.cube === cube.name)
      .map((measure) => [measure.name, measure]),
  );
  for (const projected of cube.measures) {
    if (byName.has(projected.name)) continue;
    byName.set(projected.name, {
      name: projected.name,
      label: projected.label,
      description: projected.description,
      domain: projected.domain,
      agg: projected.aggregation ?? projected.type,
      expr: projected.sql,
      table: projected.table,
      cube: projected.cube ?? cube.name,
      tags: projected.tags,
      owner: projected.owner,
      source: projected.source,
    });
  }
  return Array.from(byName.values());
}

export function buildSemanticTree(
  layer: SemanticLayer,
  manifest: SemanticImportManifest | null,
): SemanticTreeNode {
  const providerName = manifest?.provider ?? 'dql';
  const cubes = layer.listCubes();
  const metrics = layer.listMetrics(undefined, { includeMeasures: false });
  const measures = layer.listMeasures();
  const dimensions = layer.listDimensions(undefined, { includeVariants: true });
  const timeDimensions = layer.listTimeDimensions(undefined, { includeVariants: true });
  const entities = layer.listEntities();
  const hierarchies = layer.listHierarchies();
  const segments = layer.listSegments();
  const preAggregations = layer.listPreAggregations();
  const semanticModels = layer.listSemanticModels();
  const savedQueries = layer.listSavedQueries();
  const domains = Array.from(new Set([
    ...layer.listDomains().map((domain) => normalizeDomain(domain)),
    ...cubes.map((item) => normalizeDomain(item.domain)),
    ...metrics.map((item) => normalizeDomain(item.domain)),
    ...measures.map((item) => normalizeDomain(item.domain)),
    ...dimensions.map((item) => normalizeDomain(item.domain)),
    ...timeDimensions.map((item) => normalizeDomain(item.domain)),
    ...entities.map((item) => normalizeDomain(item.domain)),
    ...hierarchies.map((item) => normalizeDomain(item.domain)),
    ...segments.map((item) => normalizeDomain(item.domain)),
    ...preAggregations.map((item) => normalizeDomain(item.domain)),
    ...semanticModels.map((item) => normalizeDomain(item.domain)),
    ...savedQueries.map((item) => normalizeDomain(item.domain)),
  ])).sort((a, b) => a.localeCompare(b));

  const domainNodes = domains.map((domain) => {
    const domainCubes = cubes.filter((cube) => sameSemanticDomain(cube.domain, domain));
    const crossModelMetrics = metrics.filter((metric) =>
      sameSemanticDomain(metric.domain, domain)
      && !metric.cube
      && (metric.semanticModelIds?.length ?? 0) > 1);
    const looseMetrics = metrics.filter((metric) =>
      sameSemanticDomain(metric.domain, domain)
      && !metric.cube
      && (metric.semanticModelIds?.length ?? 0) <= 1);
    const looseDimensions = dimensions.filter((dimension) => sameSemanticDomain(dimension.domain, domain) && !dimension.cube);
    const looseMeasures = measures.filter((measure) => sameSemanticDomain(measure.domain, domain) && !measure.cube);
    const looseEntities = entities.filter((entity) => sameSemanticDomain(entity.domain, domain) && !entity.cube);
    const domainHierarchies = hierarchies.filter((hierarchy) => sameSemanticDomain(hierarchy.domain, domain));
    const domainCubeNames = new Set(domainCubes.map((cube) => cube.name));
    const domainSemanticModels = semanticModels.filter((model) =>
      sameSemanticDomain(model.domain, domain) && !domainCubeNames.has(model.name));
    const domainSavedQueries = savedQueries.filter((query) => sameSemanticDomain(query.domain, domain));

    const cubeNodes = domainCubes.map((cube) => ({
      id: objectId('cube', cube.name),
      label: cube.label,
      kind: 'cube' as const,
      count:
        metrics.filter((metric) => metric.cube === cube.name).length +
        cube.measures.length +
        cube.dimensions.length +
        cube.timeDimensions.length +
        cube.segments.length +
        cube.preAggregations.length,
      meta: {
        provider: cube.source?.provider ?? providerName,
        domain: normalizeDomain(cube.domain),
        cube: cube.name,
        owner: cube.owner ?? null,
        tags: (cube.tags ?? []).join(','),
        table: cube.table,
      },
      children: [
        buildGroupNode(`cube:${cube.name}`, 'metric', 'Metrics', metrics.filter((metric) => metric.cube === cube.name).map((metric) => toLeaf('metric', metric.name, metric.label, {
          provider: metric.source?.provider ?? providerName,
          domain: normalizeDomain(metric.domain),
          cube: metric.cube ?? cube.name,
          owner: metric.owner ?? cube.owner ?? null,
          tags: (metric.tags ?? []).join(','),
          table: metric.table,
          semanticModelIds: (metric.semanticModelIds ?? [cube.name]).join(','),
        }))),
        buildGroupNode(`cube:${cube.name}`, 'measure', 'Underlying measures', technicalMeasuresForCube(cube, measures).map((measure) => toLeaf('measure', measure.name, measure.label, {
          provider: measure.source?.provider ?? providerName,
          domain: normalizeDomain(measure.domain),
          cube: measure.cube ?? cube.name,
          owner: measure.owner ?? cube.owner ?? null,
          tags: (measure.tags ?? []).join(','),
          table: measure.table,
          agg: measure.agg,
        }))),
        buildGroupNode(`cube:${cube.name}`, 'dimension', 'Dimensions', cube.dimensions.map((dimension) => toLeaf('dimension', semanticDimensionReference(dimension), dimension.label, {
          provider: dimension.source?.provider ?? providerName,
          domain: normalizeDomain(dimension.domain),
          cube: dimension.cube ?? cube.name,
          reference: semanticDimensionReference(dimension),
          localName: dimension.name,
          qualifiedName: dimension.qualifiedName ?? null,
          entityLink: dimension.entityLink ?? null,
          owner: dimension.owner ?? cube.owner ?? null,
          tags: (dimension.tags ?? []).join(','),
          table: dimension.table,
        }))),
        buildGroupNode(`cube:${cube.name}`, 'time_dimension', 'Time Dimensions', cube.timeDimensions.map((dimension) => toLeaf('time_dimension', semanticDimensionReference(dimension), dimension.label, {
          provider: dimension.source?.provider ?? providerName,
          domain: normalizeDomain(dimension.domain),
          cube: dimension.cube ?? cube.name,
          reference: semanticDimensionReference(dimension),
          localName: dimension.name,
          qualifiedName: dimension.qualifiedName ?? null,
          entityLink: dimension.entityLink ?? null,
          owner: dimension.owner ?? cube.owner ?? null,
          tags: (dimension.tags ?? []).join(','),
          table: dimension.table,
        }))),
        buildGroupNode(`cube:${cube.name}`, 'entity', 'Entities', entities.filter((entity) => entity.cube === cube.name).map((entity) => toLeaf('entity', entity.name, entity.label, {
          provider: entity.source?.provider ?? providerName,
          domain: normalizeDomain(entity.domain),
          cube: entity.cube ?? cube.name,
          owner: entity.owner ?? cube.owner ?? null,
          tags: (entity.tags ?? []).join(','),
          table: entity.table,
          type: entity.type,
        }))),
        buildGroupNode(`cube:${cube.name}`, 'segment', 'Segments', cube.segments.map((segment) => toLeaf('segment', segment.name, segment.label, {
          provider: segment.source?.provider ?? providerName,
          domain: normalizeDomain(segment.domain),
          cube: segment.cube || cube.name,
          owner: segment.owner ?? cube.owner ?? null,
          tags: (segment.tags ?? []).join(','),
        }))),
        buildGroupNode(`cube:${cube.name}`, 'pre_aggregation', 'Pre-aggregations', cube.preAggregations.map((preAggregation) => toLeaf('pre_aggregation', preAggregation.name, preAggregation.label, {
          provider: preAggregation.source?.provider ?? providerName,
          domain: normalizeDomain(preAggregation.domain),
          cube: preAggregation.cube || cube.name,
          owner: preAggregation.owner ?? cube.owner ?? null,
          tags: (preAggregation.tags ?? []).join(','),
        }))),
      ].filter((node): node is SemanticTreeNode => Boolean(node)),
    }));

    const children: SemanticTreeNode[] = [...cubeNodes];
    const looseNodes = [
      buildGroupNode(`domain:${domain}`, 'metric', 'Cross-model metrics', crossModelMetrics.map((metric) => toLeaf('metric', metric.name, metric.label, {
        provider: metric.source?.provider ?? providerName,
        domain: normalizeDomain(metric.domain),
        cube: metric.cube ?? null,
        semanticModelIds: (metric.semanticModelIds ?? []).join(','),
        owner: metric.owner ?? null,
        tags: (metric.tags ?? []).join(','),
        table: metric.table,
      }))),
      buildGroupNode(`domain:${domain}`, 'metric', 'Unassigned metrics', looseMetrics.map((metric) => toLeaf('metric', metric.name, metric.label, {
        provider: metric.source?.provider ?? providerName,
        domain: normalizeDomain(metric.domain),
        cube: metric.cube ?? null,
        owner: metric.owner ?? null,
        tags: (metric.tags ?? []).join(','),
        table: metric.table,
      }))),
      buildGroupNode(`domain:${domain}`, 'measure', 'Underlying measures', looseMeasures.map((measure) => toLeaf('measure', measure.name, measure.label, {
        provider: measure.source?.provider ?? providerName,
        domain: normalizeDomain(measure.domain),
        cube: measure.cube ?? null,
        owner: measure.owner ?? null,
        tags: (measure.tags ?? []).join(','),
        table: measure.table,
      }))),
      buildGroupNode(`domain:${domain}`, 'dimension', 'Dimensions', looseDimensions.map((dimension) => toLeaf('dimension', semanticDimensionReference(dimension), dimension.label, {
        provider: dimension.source?.provider ?? providerName,
        domain: normalizeDomain(dimension.domain),
        cube: dimension.cube ?? null,
        reference: semanticDimensionReference(dimension),
        localName: dimension.name,
        qualifiedName: dimension.qualifiedName ?? null,
        entityLink: dimension.entityLink ?? null,
        owner: dimension.owner ?? null,
        tags: (dimension.tags ?? []).join(','),
        table: dimension.table,
      }))),
      buildGroupNode(`domain:${domain}`, 'time_dimension', 'Time Dimensions', timeDimensions.filter((dimension) => sameSemanticDomain(dimension.domain, domain) && !dimension.cube).map((dimension) => toLeaf('time_dimension', semanticDimensionReference(dimension), dimension.label, {
        provider: dimension.source?.provider ?? providerName,
        domain: normalizeDomain(dimension.domain),
        cube: dimension.cube ?? null,
        reference: semanticDimensionReference(dimension),
        localName: dimension.name,
        qualifiedName: dimension.qualifiedName ?? null,
        entityLink: dimension.entityLink ?? null,
        owner: dimension.owner ?? null,
        tags: (dimension.tags ?? []).join(','),
        table: dimension.table,
      }))),
      buildGroupNode(`domain:${domain}`, 'entity', 'Entities', looseEntities.map((entity) => toLeaf('entity', entity.name, entity.label, {
        provider: entity.source?.provider ?? providerName,
        domain: normalizeDomain(entity.domain),
        cube: entity.cube ?? null,
        owner: entity.owner ?? null,
        tags: (entity.tags ?? []).join(','),
        table: entity.table,
      }))),
      buildGroupNode(`domain:${domain}`, 'semantic_model', 'Semantic Models', domainSemanticModels.map((model) => toLeaf('semantic_model', model.name, model.label, {
        provider: model.source?.provider ?? providerName,
        domain: normalizeDomain(model.domain),
        owner: model.owner ?? null,
        tags: (model.tags ?? []).join(','),
        table: model.table,
      }))),
      buildGroupNode(`domain:${domain}`, 'saved_query', 'Saved Queries', domainSavedQueries.map((query) => toLeaf('saved_query', query.name, query.label, {
        provider: query.source?.provider ?? providerName,
        domain: normalizeDomain(query.domain),
        owner: query.owner ?? null,
        tags: (query.tags ?? []).join(','),
      }))),
      buildGroupNode(`domain:${domain}`, 'hierarchy', 'Hierarchies', domainHierarchies.map((hierarchy) => toLeaf('hierarchy', hierarchy.name, hierarchy.label, {
        provider: hierarchy.source?.provider ?? providerName,
        domain: normalizeDomain(hierarchy.domain),
        owner: hierarchy.owner ?? null,
        tags: (hierarchy.tags ?? []).join(','),
      }))),
      buildGroupNode(`domain:${domain}`, 'segment', 'Segments', segments.filter((segment) => sameSemanticDomain(segment.domain, domain) && !segment.cube).map((segment) => toLeaf('segment', segment.name, segment.label, {
        provider: segment.source?.provider ?? providerName,
        domain: normalizeDomain(segment.domain),
        cube: segment.cube || null,
        owner: segment.owner ?? null,
        tags: (segment.tags ?? []).join(','),
      }))),
      buildGroupNode(`domain:${domain}`, 'pre_aggregation', 'Pre-aggregations', preAggregations.filter((preAggregation) => sameSemanticDomain(preAggregation.domain, domain) && !preAggregation.cube).map((preAggregation) => toLeaf('pre_aggregation', preAggregation.name, preAggregation.label, {
        provider: preAggregation.source?.provider ?? providerName,
        domain: normalizeDomain(preAggregation.domain),
        cube: preAggregation.cube || null,
        owner: preAggregation.owner ?? null,
        tags: (preAggregation.tags ?? []).join(','),
      }))),
    ].filter((node): node is SemanticTreeNode => Boolean(node));
    children.push(...looseNodes);

    return {
      id: `domain:${domain}`,
      label: domain,
      kind: 'domain' as const,
      count: children.reduce((sum, node) => sum + (node.count ?? 0), 0),
      meta: {
        provider: providerName,
        domain,
      },
      children,
    };
  });

  return {
    id: `provider:${manifest?.provider ?? 'dql'}`,
    label: manifest?.provider ? `${manifest.provider} import` : 'semantic layer',
    kind: 'provider',
    count: domains.length,
    meta: {
      provider: providerName,
      importedAt: manifest?.importedAt ?? null,
      warnings: manifest?.warnings.length ?? 0,
    },
    children: domainNodes,
  };
}

export function buildSemanticObjectDetail(
  layer: SemanticLayer,
  manifest: SemanticImportManifest | null,
  id: string,
): SemanticObjectDetail | null {
  const [kind, ...rest] = id.split(':');
  const name = rest.join(':');
  const manifestObject = manifest?.objects.find((object) => object.id === id) ?? null;
  const importedAt = manifest?.importedAt ?? null;

  if (kind === 'cube') {
    const cube = layer.getCube(name);
    if (!cube) return null;
    return {
      id,
      kind: 'cube',
      name: cube.name,
      label: cube.label,
      description: cube.description,
      domain: cube.domain || normalizeDomain(undefined),
      table: cube.table,
      sql: cube.sql,
      tags: cube.tags ?? [],
      owner: cube.owner ?? null,
      source: cube.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
      joins: cube.joins,
    };
  }

  if (kind === 'metric') {
    const metric = layer.getMetric(name);
    if (!metric) return null;
    return {
      id,
      kind: 'metric',
      name: metric.name,
      label: metric.label,
      description: metric.description,
      domain: normalizeDomain(metric.domain),
      cube: metric.cube,
      table: metric.table,
      sql: metric.sql,
      type: metric.type,
      metricType: metric.metricType,
      typeParams: metric.typeParams,
      filter: metric.filter,
      tags: metric.tags ?? [],
      owner: metric.owner ?? null,
      source: metric.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
    };
  }

  if (kind === 'measure') {
    const measure = layer.getMeasure(name);
    if (!measure) return null;
    return {
      id,
      kind: 'measure',
      name: measure.name,
      label: measure.label,
      description: measure.description,
      domain: normalizeDomain(measure.domain),
      cube: measure.cube,
      table: measure.table,
      sql: measure.expr,
      type: measure.agg,
      agg: measure.agg,
      expr: measure.expr,
      filter: measure.filter,
      typeParams: {
        agg_time_dimension: measure.aggTimeDimension,
        create_metric: measure.createMetric,
        non_additive_dimension: measure.nonAdditiveDimension,
      },
      tags: measure.tags ?? [],
      owner: measure.owner ?? null,
      source: measure.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
    };
  }

  if (kind === 'dimension') {
    const dimension = layer.getDimension(name);
    if (!dimension) return null;
    return {
      id,
      kind: 'dimension',
      name: dimension.name,
      label: dimension.label,
      description: dimension.description,
      domain: normalizeDomain(dimension.domain),
      cube: dimension.cube,
      table: dimension.table,
      sql: dimension.sql,
      type: dimension.type,
      reference: semanticDimensionReference(dimension),
      qualifiedName: dimension.qualifiedName,
      entityLink: dimension.entityLink,
      tags: dimension.tags ?? [],
      owner: dimension.owner ?? null,
      source: dimension.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
    };
  }

  if (kind === 'time_dimension') {
    const dimension = layer.getDimension(name);
    if (!dimension) return null;
    return {
      id,
      kind: 'time_dimension',
      name: dimension.name,
      label: dimension.label,
      description: dimension.description,
      domain: normalizeDomain(dimension.domain),
      cube: dimension.cube,
      table: dimension.table,
      sql: dimension.sql,
      type: dimension.type,
      reference: semanticDimensionReference(dimension),
      qualifiedName: dimension.qualifiedName,
      entityLink: dimension.entityLink,
      typeParams: dimension.typeParams,
      tags: dimension.tags ?? [],
      owner: dimension.owner ?? null,
      source: dimension.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
    };
  }

  if (kind === 'entity') {
    const entity = layer.getEntity(name);
    if (!entity) return null;
    return {
      id,
      kind: 'entity',
      name: entity.name,
      label: entity.label,
      description: entity.description,
      domain: normalizeDomain(entity.domain),
      cube: entity.cube,
      table: entity.table,
      sql: entity.expr,
      type: entity.type,
      tags: entity.tags ?? [],
      owner: entity.owner ?? null,
      source: entity.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
    };
  }

  if (kind === 'semantic_model') {
    const model = layer.getSemanticModel(name);
    if (!model) return null;
    return {
      id,
      kind: 'semantic_model',
      name: model.name,
      label: model.label,
      description: model.description,
      domain: normalizeDomain(model.domain),
      table: model.table,
      sql: model.model,
      tags: model.tags ?? [],
      owner: model.owner ?? null,
      source: model.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
      entities: model.entities,
      measures: model.measures,
      dimensions: model.dimensions,
      timeDimension: model.timeDimensions.join(', '),
      typeParams: model.defaults,
    };
  }

  if (kind === 'saved_query') {
    const savedQuery = layer.getSavedQuery(name);
    if (!savedQuery) return null;
    return {
      id,
      kind: 'saved_query',
      name: savedQuery.name,
      label: savedQuery.label,
      description: savedQuery.description,
      domain: normalizeDomain(savedQuery.domain),
      tags: savedQuery.tags ?? [],
      owner: savedQuery.owner ?? null,
      source: savedQuery.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
      savedQueryMetrics: savedQuery.metrics,
      dimensions: savedQuery.dimensions,
      timeDimension: savedQuery.timeDimension,
      granularity: savedQuery.granularity,
      filter: savedQuery.filters,
      exports: savedQuery.exports,
    };
  }

  if (kind === 'hierarchy') {
    const hierarchy = layer.getHierarchy(name);
    if (!hierarchy) return null;
    return {
      id,
      kind: 'hierarchy',
      name: hierarchy.name,
      label: hierarchy.label,
      description: hierarchy.description,
      domain: normalizeDomain(hierarchy.domain),
      tags: hierarchy.tags ?? [],
      owner: hierarchy.owner ?? null,
      source: hierarchy.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
      levels: hierarchy.levels,
    };
  }

  if (kind === 'segment') {
    const segment = layer.getSegment(name);
    if (!segment) return null;
    return {
      id,
      kind: 'segment',
      name: segment.name,
      label: segment.label,
      description: segment.description,
      domain: normalizeDomain(segment.domain),
      cube: segment.cube,
      sql: segment.sql,
      tags: segment.tags ?? [],
      owner: segment.owner ?? null,
      source: segment.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
    };
  }

  if (kind === 'pre_aggregation') {
    const preAggregation = layer.getPreAggregation(name);
    if (!preAggregation) return null;
    return {
      id,
      kind: 'pre_aggregation',
      name: preAggregation.name,
      label: preAggregation.label,
      description: preAggregation.description,
      domain: normalizeDomain(preAggregation.domain),
      cube: preAggregation.cube,
      sql: preAggregation.sql,
      tags: preAggregation.tags ?? [],
      owner: preAggregation.owner ?? null,
      source: preAggregation.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
      measures: preAggregation.measures,
      dimensions: preAggregation.dimensions,
      timeDimension: preAggregation.timeDimension,
      granularity: preAggregation.granularity,
      refreshKey: preAggregation.refreshKey,
    };
  }

  return null;
}

/**
 * Preview a semantic import without writing any files.
 * Returns counts, domains, warnings, and object summaries.
 */
export async function previewSemanticImport(opts: {
  targetProjectRoot: string;
  provider: 'dbt' | 'cubejs' | 'snowflake';
  sourceConfig: SemanticLayerProviderConfig;
  executeQuery?: SnowflakeQueryExecutor;
}): Promise<SemanticImportPreview> {
  const targetProjectRoot = resolve(opts.targetProjectRoot);
  const source = resolveImportSource(targetProjectRoot, opts.sourceConfig);
  const layer = await loadLayerForImport(opts.provider, source.localPath, source.config, opts.executeQuery);
  const warnings = [...source.warnings, ...collectImportWarnings(opts.provider, layer)];
  const objects = collectObjects(layer);

  const summaries = objects.map((obj) => ({
    kind: obj.kind,
    name: obj.name,
    label: obj.label,
    domain: normalizeDomain(obj.domain),
  }));

  const domains = [...new Set(summaries.map((o) => o.domain))].sort();

  return {
    provider: opts.provider,
    counts: countObjects(summaries.map((o) => ({ ...o, id: objectId(o.kind, o.name), filePath: '' }))),
    domains,
    warnings,
    objects: summaries,
  };
}

/**
 * Compute the diff between the current manifest and a fresh import, without applying changes.
 */
export async function computeSyncDiff(opts: {
  targetProjectRoot: string;
  executeQuery?: SnowflakeQueryExecutor;
}): Promise<SemanticSyncDiff> {
  const manifest = loadSemanticImportManifest(opts.targetProjectRoot);
  if (!manifest) {
    throw new Error('No semantic import manifest found. Run `zlens semantic import <provider>` first.');
  }

  const sourceConfig: SemanticLayerProviderConfig = {
    provider: manifest.provider,
    projectPath: manifest.source.projectPath,
    repoUrl: manifest.source.repoUrl,
    branch: manifest.source.branch,
    subPath: manifest.source.subPath,
    connection: manifest.source.connection,
  };

  const targetProjectRoot = resolve(opts.targetProjectRoot);
  const source = resolveImportSource(targetProjectRoot, sourceConfig);
  const layer = await loadLayerForImport(manifest.provider, source.localPath, source.config, opts.executeQuery);
  const newObjects = collectObjects(layer);

  const newById = new Map(
    newObjects.map((obj) => [objectId(obj.kind, semanticObjectRegistryReference(obj)), obj]),
  );
  const oldById = new Map(
    manifest.objects.map((obj) => [obj.id, obj]),
  );

  const added: SemanticSyncDiff['added'] = [];
  const removed: SemanticSyncDiff['removed'] = [];
  const changed: SemanticSyncDiff['changed'] = [];
  let unchanged = 0;

  for (const [id, obj] of newById) {
    const old = oldById.get(id);
    if (!old) {
      added.push({ kind: obj.kind, name: obj.name, label: obj.label, domain: normalizeDomain(obj.domain) });
    } else {
      // Compare domain and label to detect changes
      const oldDomain = old.domain;
      const newDomain = normalizeDomain(obj.domain);
      if (old.label !== obj.label || oldDomain !== newDomain) {
        changed.push({ kind: obj.kind, name: obj.name, label: obj.label, domain: newDomain });
      } else {
        unchanged++;
      }
    }
  }

  for (const [id, old] of oldById) {
    if (!newById.has(id)) {
      removed.push({ kind: old.kind, name: old.name, label: old.label, domain: old.domain });
    }
  }

  return { added, removed, changed, unchanged };
}

function resolveImportSource(
  targetProjectRoot: string,
  sourceConfig: SemanticLayerProviderConfig,
): { localPath: string; config: SemanticLayerProviderConfig; warnings: string[] } {
  const projectRoot = resolve(targetProjectRoot);
  if (sourceConfig.provider === 'snowflake') {
    return {
      localPath: projectRoot,
      config: sourceConfig,
      warnings: [],
    };
  }

  if (sourceConfig.projectPath && !sourceConfig.repoUrl && sourceConfig.source !== 'github' && sourceConfig.source !== 'gitlab') {
    return {
      localPath: resolve(projectRoot, sourceConfig.projectPath),
      config: { ...sourceConfig, projectPath: undefined },
      warnings: [],
    };
  }

  const resolved = resolveRepoSource(sourceConfig, projectRoot);
  return {
    localPath: resolved.localPath,
    config: { ...sourceConfig, projectPath: undefined, source: 'local' },
    warnings: resolved.warnings,
  };
}

async function loadLayerForImport(
  provider: 'dbt' | 'cubejs' | 'snowflake',
  sourceRoot: string,
  config: SemanticLayerProviderConfig,
  executeQuery?: SnowflakeQueryExecutor,
): Promise<SemanticLayer> {
  if (provider === 'dbt') {
    return new DbtProvider().load({ ...config, provider }, sourceRoot);
  }
  if (provider === 'cubejs') {
    return new CubejsProvider().load({ ...config, provider }, sourceRoot);
  }
  if (!executeQuery) {
    throw new Error('Snowflake semantic import requires an active query executor.');
  }
  return new SnowflakeSemanticProvider(executeQuery).loadAsync({ ...config, provider }, sourceRoot);
}

function collectObjects(layer: SemanticLayer): Array<
  | (CubeDefinition & { kind: 'cube' })
  | (MetricDefinition & { kind: 'metric' })
  | (MeasureDefinition & { kind: 'measure' })
  | (DimensionDefinition & { kind: 'dimension' })
  | (DimensionDefinition & { kind: 'time_dimension' })
  | (EntityDefinition & { kind: 'entity' })
  | (HierarchyDefinition & { kind: 'hierarchy' })
  | (SegmentDefinition & { kind: 'segment' })
  | (PreAggregationDefinition & { kind: 'pre_aggregation' })
  | (SemanticModelDefinition & { kind: 'semantic_model' })
  | (SavedQueryDefinition & { kind: 'saved_query' })
> {
  const timeDimensionRefs = new Set(
    layer.listTimeDimensions(undefined, { includeVariants: true }).map(semanticDimensionReference),
  );
  const dimensions = layer.listDimensions(undefined, { includeVariants: true });
  return [
    ...layer.listCubes().map((cube) => ({ ...cube, kind: 'cube' as const })),
    ...layer.listMetrics().map((metric) => ({ ...metric, kind: 'metric' as const })),
    ...layer.listMeasures().map((measure) => ({ ...measure, kind: 'measure' as const })),
    ...dimensions.filter((dimension) => !timeDimensionRefs.has(semanticDimensionReference(dimension))).map((dimension) => ({ ...dimension, kind: 'dimension' as const })),
    ...layer.listTimeDimensions(undefined, { includeVariants: true }).map((dimension) => ({ ...dimension, kind: 'time_dimension' as const })),
    ...layer.listEntities().map((entity) => ({ ...entity, kind: 'entity' as const })),
    ...layer.listHierarchies().map((hierarchy) => ({ ...hierarchy, kind: 'hierarchy' as const })),
    ...layer.listSegments().map((segment) => ({ ...segment, kind: 'segment' as const })),
    ...layer.listPreAggregations().map((preAggregation) => ({ ...preAggregation, kind: 'pre_aggregation' as const })),
    ...layer.listSemanticModels().map((model) => ({ ...model, kind: 'semantic_model' as const })),
    ...layer.listSavedQueries().map((query) => ({ ...query, kind: 'saved_query' as const })),
  ];
}

function buildSemanticFilePath(
  kind: SemanticImportManifestObject['kind'],
  domain: string,
  name: string,
): string {
  const folder = kind === 'pre_aggregation'
    ? 'pre_aggregations'
    : kind === 'time_dimension'
      ? 'time_dimensions'
      : kind === 'semantic_model'
        ? 'semantic_models'
        : kind === 'saved_query'
          ? 'saved_queries'
          : `${kind}s`.replace('hierarchys', 'hierarchies');
  return join('semantic-layer', folder, slugifyPathSegment(domain), `${slugifyPathSegment(name)}.yaml`);
}

/** A top-level `key: value` for a nested value, serialized rather than stringified. */
function yamlField(key: string, value: unknown): string {
  return dumpYaml({ [key]: value }, { lineWidth: -1 }).trimEnd();
}

function serializeSemanticObject(
  object:
    | (CubeDefinition & { kind: 'cube' })
    | (MetricDefinition & { kind: 'metric' })
    | (MeasureDefinition & { kind: 'measure' })
    | (DimensionDefinition & { kind: 'dimension' })
    | (DimensionDefinition & { kind: 'time_dimension' })
    | (EntityDefinition & { kind: 'entity' })
    | (HierarchyDefinition & { kind: 'hierarchy' })
    | (SegmentDefinition & { kind: 'segment' })
    | (PreAggregationDefinition & { kind: 'pre_aggregation' })
    | (SemanticModelDefinition & { kind: 'semantic_model' })
    | (SavedQueryDefinition & { kind: 'saved_query' }),
): string {
  const lines: string[] = [
    `name: ${yamlScalar(object.name)}`,
    `label: ${yamlScalar(object.label)}`,
    `description: ${yamlScalar(object.description)}`,
    `domain: ${yamlScalar(object.domain || normalizeDomain(undefined))}`,
  ];

  if ('table' in object && object.table) lines.push(`table: ${yamlScalar(object.table)}`);
  if ('cube' in object && object.cube) lines.push(`cube: ${yamlScalar(object.cube)}`);
  if ('sql' in object && typeof object.sql === 'string') lines.push(`sql: ${yamlBlockScalar(object.sql)}`);
  if ('type' in object && typeof object.type === 'string') lines.push(`type: ${yamlScalar(object.type)}`);
  if ('aggregation' in object && object.aggregation) lines.push(`aggregation: ${yamlScalar(object.aggregation)}`);
  if ('agg' in object && object.agg) lines.push(`agg: ${yamlScalar(object.agg)}`);
  if ('expr' in object && object.expr) lines.push(`expr: ${yamlScalar(object.expr)}`);
  if ('metricType' in object && object.metricType) lines.push(`metricType: ${yamlScalar(object.metricType)}`);
  if ('aggTimeDimension' in object && object.aggTimeDimension) lines.push(`aggTimeDimension: ${yamlScalar(object.aggTimeDimension)}`);
  // What scopes a metric, and what a derived metric is built from. Leaving
  // these out made a filtered metric (loss payments only) sum every row, and
  // left a derived metric with nothing to compose; the native engine applies a
  // filter it can render and refuses a metric whose filter it cannot.
  if (object.kind === 'metric') {
    if (object.filter !== undefined && object.filter !== null && object.filter !== '') lines.push(yamlField('filter', object.filter));
    if (object.filters && Object.keys(object.filters).length > 0) lines.push(yamlField('filters', object.filters));
    if (object.typeParams && Object.keys(object.typeParams).length > 0) lines.push(yamlField('typeParams', object.typeParams));
  }
  if ('owner' in object && object.owner) lines.push(`owner: ${yamlScalar(object.owner)}`);
  if ('tags' in object && object.tags && object.tags.length > 0) {
    lines.push('tags:');
    for (const tag of object.tags) lines.push(`  - ${yamlScalar(tag)}`);
  }
  if (object.source) {
    lines.push('source:');
    lines.push(`  provider: ${yamlScalar(object.source.provider)}`);
    lines.push(`  objectType: ${yamlScalar(object.source.objectType)}`);
    lines.push(`  objectId: ${yamlScalar(object.source.objectId)}`);
    if (object.source.objectName) lines.push(`  objectName: ${yamlScalar(object.source.objectName)}`);
    if (object.source.importedAt) lines.push(`  importedAt: ${yamlScalar(object.source.importedAt)}`);
    if (object.source.extra && Object.keys(object.source.extra).length > 0) {
      lines.push('  extra:');
      for (const [key, value] of Object.entries(object.source.extra)) {
        if (value === undefined) continue;
        lines.push(`    ${key}: ${yamlScalar(typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value))}`);
      }
    }
  }

  if (object.kind === 'hierarchy') {
    lines.push('levels:');
    for (const level of object.levels) {
      lines.push(`  - name: ${yamlScalar(level.name)}`);
      lines.push(`    label: ${yamlScalar(level.label)}`);
      lines.push(`    description: ${yamlScalar(level.description)}`);
      lines.push(`    dimension: ${yamlScalar(level.dimension)}`);
      lines.push(`    order: ${level.order}`);
    }
  }

  if (object.kind === 'cube') {
    lines.push('measures:');
    for (const measure of object.measures) {
      lines.push(`  - name: ${yamlScalar(measure.name)}`);
      lines.push(`    label: ${yamlScalar(measure.label)}`);
      lines.push(`    description: ${yamlScalar(measure.description)}`);
      lines.push(`    sql: ${yamlBlockScalar(measure.sql, 4)}`);
      lines.push(`    type: ${yamlScalar(measure.type)}`);
      if (measure.aggregation) lines.push(`    aggregation: ${yamlScalar(measure.aggregation)}`);
    }
    lines.push('dimensions:');
    for (const dimension of object.dimensions) {
      lines.push(`  - name: ${yamlScalar(dimension.name)}`);
      lines.push(`    label: ${yamlScalar(dimension.label)}`);
      lines.push(`    description: ${yamlScalar(dimension.description)}`);
      lines.push(`    sql: ${yamlBlockScalar(dimension.sql, 4)}`);
      lines.push(`    type: ${yamlScalar(dimension.type)}`);
    }
    if (object.timeDimensions.length > 0) {
      lines.push('time_dimensions:');
      for (const dimension of object.timeDimensions) {
        lines.push(`  - name: ${yamlScalar(dimension.name)}`);
        lines.push(`    label: ${yamlScalar(dimension.label)}`);
        lines.push(`    description: ${yamlScalar(dimension.description)}`);
        lines.push(`    sql: ${yamlBlockScalar(dimension.sql, 4)}`);
        lines.push('    granularities:');
        for (const granularity of dimension.granularities) {
          lines.push(`      - ${yamlScalar(granularity)}`);
        }
        if (dimension.primaryTime) lines.push('    primary_time: true');
      }
    }
    if (object.joins.length > 0) {
      lines.push('joins:');
      for (const joinDef of object.joins) {
        lines.push(`  - name: ${yamlScalar(joinDef.name)}`);
        lines.push(`    right: ${yamlScalar(joinDef.right)}`);
        lines.push(`    type: ${yamlScalar(joinDef.type)}`);
        lines.push(`    sql: ${yamlBlockScalar(joinDef.sql, 4)}`);
        // The dbt entity a join follows fixes its direction (many-to-one).
        if (joinDef.entity) lines.push(`    entity: ${yamlScalar(joinDef.entity)}`);
      }
    }
    if (object.segments.length > 0) {
      lines.push('segments:');
      for (const segment of object.segments) {
        lines.push(`  - name: ${yamlScalar(segment.name)}`);
        lines.push(`    label: ${yamlScalar(segment.label)}`);
        lines.push(`    description: ${yamlScalar(segment.description)}`);
        lines.push(`    sql: ${yamlBlockScalar(segment.sql, 4)}`);
      }
    }
    if (object.preAggregations.length > 0) {
      lines.push('pre_aggregations:');
      for (const preAggregation of object.preAggregations) {
        lines.push(`  - name: ${yamlScalar(preAggregation.name)}`);
        lines.push(`    label: ${yamlScalar(preAggregation.label)}`);
        lines.push(`    description: ${yamlScalar(preAggregation.description)}`);
        if (preAggregation.measures?.length) {
          lines.push('    measures:');
          for (const measure of preAggregation.measures) lines.push(`      - ${yamlScalar(measure)}`);
        }
        if (preAggregation.dimensions?.length) {
          lines.push('    dimensions:');
          for (const dimension of preAggregation.dimensions) lines.push(`      - ${yamlScalar(dimension)}`);
        }
        if (preAggregation.timeDimension) lines.push(`    timeDimension: ${yamlScalar(preAggregation.timeDimension)}`);
        if (preAggregation.granularity) lines.push(`    granularity: ${yamlScalar(preAggregation.granularity)}`);
        if (preAggregation.refreshKey) lines.push(`    refreshKey: ${yamlScalar(preAggregation.refreshKey)}`);
      }
    }
  }

  if (object.kind === 'pre_aggregation') {
    if (object.measures?.length) {
      lines.push('measures:');
      for (const measure of object.measures) lines.push(`  - ${yamlScalar(measure)}`);
    }
    if (object.dimensions?.length) {
      lines.push('dimensions:');
      for (const dimension of object.dimensions) lines.push(`  - ${yamlScalar(dimension)}`);
    }
    if (object.timeDimension) lines.push(`timeDimension: ${yamlScalar(object.timeDimension)}`);
    if (object.granularity) lines.push(`granularity: ${yamlScalar(object.granularity)}`);
    if (object.refreshKey) lines.push(`refreshKey: ${yamlScalar(object.refreshKey)}`);
  }

  if (object.kind === 'semantic_model') {
    if (object.model) lines.push(`model: ${yamlScalar(object.model)}`);
    if (object.entities.length > 0) {
      lines.push('entities:');
      for (const entity of object.entities) lines.push(`  - ${yamlScalar(entity)}`);
    }
    if (object.measures.length > 0) {
      lines.push('measures:');
      for (const measure of object.measures) lines.push(`  - ${yamlScalar(measure)}`);
    }
    if (object.dimensions.length > 0) {
      lines.push('dimensions:');
      for (const dimension of object.dimensions) lines.push(`  - ${yamlScalar(dimension)}`);
    }
    if (object.timeDimensions.length > 0) {
      lines.push('timeDimensions:');
      for (const dimension of object.timeDimensions) lines.push(`  - ${yamlScalar(dimension)}`);
    }
  }

  if (object.kind === 'saved_query') {
    if (object.metrics.length > 0) {
      lines.push('metrics:');
      for (const metric of object.metrics) lines.push(`  - ${yamlScalar(metric)}`);
    }
    if (object.dimensions.length > 0) {
      lines.push('dimensions:');
      for (const dimension of object.dimensions) lines.push(`  - ${yamlScalar(dimension)}`);
    }
    if (object.timeDimension) lines.push(`timeDimension: ${yamlScalar(object.timeDimension)}`);
    if (object.granularity) lines.push(`granularity: ${yamlScalar(object.granularity)}`);
  }

  return lines.join('\n') + '\n';
}

function applyCanonicalSemanticConfig(projectRoot: string): void {
  const configPath = join(projectRoot, 'dql.config.json');
  const raw = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    : {};
  raw.semanticLayer = {
    provider: 'dql',
    path: './semantic-layer',
  };
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}

function collectImportWarnings(provider: 'dbt' | 'cubejs' | 'snowflake', layer: SemanticLayer): string[] {
  const warnings: string[] = [];
  if (provider === 'dbt') {
    if (layer.listHierarchies().length === 0) {
      warnings.push('No dbt hierarchies were imported; dbt semantic models were normalized into cubes, measures, dimensions, and joins.');
    }
  }
  if (provider === 'snowflake' && layer.listCubes().length === 0) {
    warnings.push('Snowflake semantic import returned no semantic views.');
  }
  return warnings;
}

function countObjects(objects: SemanticImportManifestObject[]): Record<SemanticImportManifestObject['kind'], number> {
  return {
    cube: objects.filter((object) => object.kind === 'cube').length,
    metric: objects.filter((object) => object.kind === 'metric').length,
    measure: objects.filter((object) => object.kind === 'measure').length,
    dimension: objects.filter((object) => object.kind === 'dimension').length,
    time_dimension: objects.filter((object) => object.kind === 'time_dimension').length,
    entity: objects.filter((object) => object.kind === 'entity').length,
    hierarchy: objects.filter((object) => object.kind === 'hierarchy').length,
    segment: objects.filter((object) => object.kind === 'segment').length,
    pre_aggregation: objects.filter((object) => object.kind === 'pre_aggregation').length,
    semantic_model: objects.filter((object) => object.kind === 'semantic_model').length,
    saved_query: objects.filter((object) => object.kind === 'saved_query').length,
  };
}

function normalizeDomain(domain: string | undefined): string {
  return domain && domain.trim().length > 0 ? domain.trim() : 'uncategorized';
}

function sameSemanticDomain(value: string | undefined, domain: string): boolean {
  return normalizeDomain(value) === normalizeDomain(domain);
}

function slugifyPathSegment(value: string): string {
  return normalizeDomain(value)
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '');
}

function objectId(kind: SemanticImportManifestObject['kind'], name: string): string {
  return `${kind}:${name}`;
}

function semanticObjectRegistryReference(object: {
  kind: SemanticImportManifestObject['kind'];
  name: string;
  cube?: string;
  source?: SemanticSourceMetadata;
}): string {
  return object.kind === 'dimension' || object.kind === 'time_dimension'
    ? semanticDimensionReference(object)
    : object.name;
}

function yamlScalar(value: string): string {
  if (/^[a-zA-Z0-9_.:/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlBlockScalar(value: string, indent: number = 2): string {
  const indentText = ' '.repeat(indent);
  if (!value.includes('\n')) return yamlScalar(value);
  return `|\n${value.split('\n').map((line) => `${indentText}${line}`).join('\n')}`;
}

function buildGroupNode(
  scope: string,
  kind: SemanticImportManifestObject['kind'],
  label: string,
  children: SemanticTreeNode[],
): SemanticTreeNode | null {
  if (children.length === 0) return null;
  return {
    id: `group:${scope}:${kind}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    label,
    kind: 'group',
    count: children.length,
    meta: {
      objectKind: kind,
    },
    children,
  };
}

function toLeaf(
  kind: SemanticImportManifestObject['kind'],
  name: string,
  label: string,
  meta?: SemanticTreeNode['meta'],
): SemanticTreeNode {
  return {
    id: objectId(kind, name),
    label,
    kind,
    meta,
  };
}
