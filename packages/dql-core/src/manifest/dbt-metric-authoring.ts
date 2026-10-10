import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import {
  assertContainedPath,
  asRecord,
  dumpYaml,
  hash,
  loadDbtNodeAuthoringDetail,
  readJson,
  stringValue,
  type ModelingSourcePatch,
} from './dbt-first-authoring.js';

type UnknownRecord = Record<string, unknown>;

/** The aggregations DQL compiles natively from a MetricFlow measure (`dbt-provider.ts` AGG_TYPE_MAP). */
export const DBT_METRIC_AGGREGATIONS = ['sum', 'count', 'count_distinct', 'average', 'min', 'max'] as const;
export type DbtMetricAggregation = typeof DBT_METRIC_AGGREGATIONS[number];

export interface DbtMetricAuthoringInput {
  /** `add` refuses a name that exists anywhere in the dbt project; `edit` changes that metric in place. */
  mode: 'add' | 'edit';
  /** The MetricFlow semantic model that holds the measure. Created when it does not exist yet. */
  semanticModel: string;
  /** dbt model unique_id behind a semantic model that does not exist yet. */
  modelUniqueId?: string;
  /** Required with a new semantic model: its primary entity and aggregate time column. */
  primaryEntity?: { name: string; column: string };
  timeDimension?: { name: string; column: string; timeGranularity?: string };
  metric: {
    name: string;
    label?: string;
    description?: string;
    /** `avg` is accepted for `average`. */
    aggregation: string;
    column: string;
    /** Written as `config.meta.domain`, which DQL reads as the metric's domain. */
    domain?: string;
  };
  dimensions?: Array<{ name: string; column?: string; type?: 'categorical' | 'time'; timeGranularity?: string }>;
}

export interface DbtMetricPatchPreview {
  semanticModel: string;
  metric: string;
  patches: ModelingSourcePatch[];
  fingerprint: string;
  /** Things the check could not prove (for example, columns when no dbt manifest exists). */
  warnings: string[];
}

interface Loaded { path: string; before: string; document: UnknownRecord }

const NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];

function invalid(issues: string[]): never {
  throw Object.assign(new Error(issues.join(' ')), { code: 'DBT_METRIC_INVALID', issues });
}

function yamlFiles(root: string, modelPaths: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Symlinks are skipped so a link inside models/ cannot lead the scan or a write outside the project.
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/i.test(entry.name) && statSync(full).size < 2_000_000) out.push(full);
    }
  };
  for (const modelPath of modelPaths) walk(resolve(root, modelPath));
  return out.sort();
}

function modelPathsOf(root: string): string[] {
  try {
    const project = asRecord(yaml.load(readFileSync(join(root, 'dbt_project.yml'), 'utf8')));
    const paths = Array.isArray(project['model-paths']) ? project['model-paths'].map(String).filter(Boolean) : [];
    return paths.length ? paths : ['models'];
  } catch {
    return ['models'];
  }
}

function listOf(document: UnknownRecord, key: string): UnknownRecord[] {
  return Array.isArray(document[key]) ? (document[key] as unknown[]).map(asRecord) : [];
}

/** Build the YAML patches for adding or editing one MetricFlow simple metric, without writing anything. */
export function previewDbtMetricPatch(
  dbtProjectRoot: string,
  manifestPath: string,
  input: DbtMetricAuthoringInput,
): DbtMetricPatchPreview {
  const root = resolve(dbtProjectRoot);
  const issues: string[] = [];
  const warnings: string[] = [];
  const metricInput = input.metric ?? ({} as DbtMetricAuthoringInput['metric']);
  const metricName = String(metricInput.name ?? '').trim();
  const semanticModelName = String(input.semanticModel ?? '').trim();
  if (input.mode !== 'add' && input.mode !== 'edit') issues.push('mode must be "add" or "edit".');
  if (!NAME.test(metricName)) issues.push(`Metric name "${metricName}" must be lowercase letters, digits and single underscores, starting with a letter (for example average_claimed_amount).`);
  if (!NAME.test(semanticModelName)) issues.push(`Semantic model name "${semanticModelName}" must be lowercase letters, digits and single underscores.`);
  const aggregationRaw = String(metricInput.aggregation ?? '').trim().toLowerCase();
  const aggregation = (aggregationRaw === 'avg' ? 'average' : aggregationRaw) as DbtMetricAggregation;
  if (!DBT_METRIC_AGGREGATIONS.includes(aggregation)) issues.push(`Unsupported aggregation "${metricInput.aggregation ?? ''}". Use one of: ${DBT_METRIC_AGGREGATIONS.join(', ')}.`);
  const column = String(metricInput.column ?? '').trim();
  if (!COLUMN.test(column)) issues.push(`Column "${column}" must be a single column name; expressions are not supported here.`);
  if (issues.length) invalid(issues);

  // Everything the project already defines, so a duplicate is refused before anything is written.
  const loaded = new Map<string, Loaded>();
  for (const file of yamlFiles(root, modelPathsOf(root))) {
    const path = relative(root, file).replace(/\\/g, '/');
    const before = readFileSync(file, 'utf8');
    let document: UnknownRecord;
    try {
      document = asRecord(yaml.load(before));
    } catch (error) {
      // A file that is not parsable cannot be shown to hold the name, so it is named rather than skipped silently.
      warnings.push(`${path} could not be parsed as YAML and was not checked for duplicates: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      continue;
    }
    loaded.set(path, { path, before, document });
  }
  const all = [...loaded.values()];
  const manifest = existsSync(manifestPath) ? readJson(assertContainedPath(root, manifestPath, 'dbt manifest')) : undefined;
  const manifestMetricNames = Object.values(asRecord(manifest?.metrics)).map((node) => stringValue(asRecord(node).name));
  const metricOwner = all.find((file) => listOf(file.document, 'metrics').some((metric) => metric.name === metricName));
  const measureOwner = all.find((file) => listOf(file.document, 'semantic_models').some((model) => listOf(model, 'measures').some((measure) => measure.name === metricName)));
  const semanticOwner = all.find((file) => listOf(file.document, 'semantic_models').some((model) => model.name === semanticModelName));

  if (input.mode === 'add') {
    if (metricOwner || manifestMetricNames.includes(metricName)) issues.push(`A metric named "${metricName}" already exists${metricOwner ? ` in ${metricOwner.path}` : ' in the dbt manifest'}. Pick another name, or edit that metric.`);
    if (measureOwner) issues.push(`A measure named "${metricName}" already exists in ${measureOwner.path}; MetricFlow measure names are unique across the project.`);
  } else if (!metricOwner) {
    issues.push(`There is no metric named "${metricName}" in the dbt project YAML to edit.`);
  }

  // The semantic model: an existing one is extended; otherwise one is created beside its dbt model.
  let target: { file: Loaded; model: UnknownRecord } | undefined;
  let created: { path: string; modelName: string; dir: string } | undefined;
  const knownColumns = new Map<string, string>();
  let modelNode: string | undefined;
  if (semanticOwner) {
    const model = listOf(semanticOwner.document, 'semantic_models').find((candidate) => candidate.name === semanticModelName)!;
    target = { file: semanticOwner, model };
    modelNode = /ref\(\s*['"]([^'"]+)['"]/.exec(String(model.model ?? ''))?.[1];
  } else if (input.mode === 'edit') {
    issues.push(`Semantic model "${semanticModelName}" is not defined in the dbt project YAML.`);
  } else {
    const node = input.modelUniqueId && manifest ? asRecord(asRecord(manifest.nodes)[input.modelUniqueId]) : undefined;
    if (!input.modelUniqueId) issues.push(`Semantic model "${semanticModelName}" does not exist. Say which dbt model it is built on to create it.`);
    else if (!manifest) issues.push('No dbt manifest was found, so the dbt model cannot be looked up. Run dbt parse and try again.');
    else if (node?.resource_type !== 'model') issues.push(`dbt model not found: ${input.modelUniqueId}.`);
    else {
      modelNode = stringValue(node.name);
      const original = stringValue(node.original_file_path) ?? `models/${modelNode}.sql`;
      const dir = dirname(original).replace(/\\/g, '/');
      created = { modelName: modelNode ?? semanticModelName, dir, path: `${dir === '.' ? '' : `${dir}/`}${semanticModelName}_semantic.yml` };
      // A file at that path that the scan did not load (unparsable, over 2 MB, or outside model-paths) may hold
      // the semantic model or other content. Writing a new file over it would destroy it, so refuse.
      if (!loaded.has(created.path) && existsSync(resolve(root, created.path))) {
        issues.push(`${created.path} already exists but could not be read as dbt YAML (see warnings), so DQL will not overwrite it. Fix or move that file, or add the semantic model there by hand.`);
      }
    }
    if (!input.primaryEntity?.name || !input.primaryEntity.column) issues.push('A new semantic model needs a primary entity (name and key column).');
    if (!input.timeDimension?.name || !input.timeDimension.column) issues.push('A new semantic model needs a time column for MetricFlow to aggregate over time.');
  }

  // Columns are checked against the dbt model when its columns are known; an undocumented model is unproven, not wrong.
  if (modelNode && manifest) {
    const uniqueId = Object.entries(asRecord(manifest.nodes)).find(([, node]) => asRecord(node).resource_type === 'model' && asRecord(node).name === modelNode)?.[0];
    for (const item of (uniqueId ? loadDbtNodeAuthoringDetail(manifestPath, uniqueId)?.columns : undefined) ?? []) knownColumns.set(item.name.toLowerCase(), item.name);
  }
  const checkColumn = (value: string, what: string): string => {
    if (!COLUMN.test(value)) { issues.push(`${what} column "${value}" must be a single column name.`); return value; }
    if (knownColumns.size === 0) return value;
    const known = knownColumns.get(value.toLowerCase());
    if (!known) issues.push(`Unknown column "${value}" for ${what} on dbt model "${modelNode}". Columns: ${[...knownColumns.values()].sort().join(', ')}.`);
    return known ?? value;
  };
  if (knownColumns.size === 0) warnings.push(`The columns of ${modelNode ? `dbt model "${modelNode}"` : 'the dbt model'} are not documented in the manifest, so column names were not checked.`);
  const measureColumn = checkColumn(column, 'the metric');

  const model = target?.model ?? {
    name: semanticModelName,
    model: `ref('${created?.modelName ?? semanticModelName}')`,
    defaults: { agg_time_dimension: input.timeDimension?.name },
    entities: input.primaryEntity ? [{ name: input.primaryEntity.name, type: 'primary', expr: checkColumn(input.primaryEntity.column, 'the primary entity') }] : [],
    dimensions: [] as UnknownRecord[],
    measures: [] as UnknownRecord[],
  };
  const dimensions = Array.isArray(model.dimensions) ? [...model.dimensions as unknown[]].map(asRecord) : [];
  const wanted = [
    ...(created && input.timeDimension ? [{ name: input.timeDimension.name, column: input.timeDimension.column, type: 'time' as const, timeGranularity: input.timeDimension.timeGranularity ?? 'day' }] : []),
    ...(input.dimensions ?? []),
  ];
  for (const requested of wanted) {
    const name = String(requested.name ?? '').trim();
    const dimensionColumn = String(requested.column ?? name).trim();
    if (!NAME.test(name)) { issues.push(`Dimension name "${name}" must be lowercase letters, digits and single underscores.`); continue; }
    if (requested.timeGranularity && !GRAINS.includes(requested.timeGranularity)) issues.push(`Dimension "${name}" has an unknown time granularity "${requested.timeGranularity}". Use one of: ${GRAINS.join(', ')}.`);
    const expr = checkColumn(dimensionColumn, `dimension "${name}"`);
    const existing = dimensions.find((dimension) => dimension.name === name);
    if (existing) {
      if (String(existing.expr ?? existing.name) !== expr) issues.push(`Dimension "${name}" already exists on "${semanticModelName}" with column "${String(existing.expr ?? existing.name)}".`);
      continue;
    }
    dimensions.push({
      name,
      type: requested.type === 'time' ? 'time' : 'categorical',
      ...(expr !== name ? { expr } : {}),
      ...(requested.type === 'time' ? { type_params: { time_granularity: requested.timeGranularity ?? 'day' } } : {}),
    });
  }
  const hasTime = dimensions.some((dimension) => dimension.type === 'time') && Boolean(asRecord(model.defaults).agg_time_dimension ?? input.timeDimension?.name);
  if (!hasTime) issues.push(`Semantic model "${semanticModelName}" has no aggregate time dimension (defaults.agg_time_dimension), which MetricFlow needs for a metric.`);
  if (issues.length) invalid(issues);

  const measures = Array.isArray(model.measures) ? [...model.measures as unknown[]].map(asRecord) : [];
  const measureIndex = measures.findIndex((measure) => measure.name === metricName);
  if (input.mode === 'edit' && measureIndex < 0) invalid([`Metric "${metricName}" does not use a measure of the same name on "${semanticModelName}"; edit it in dbt directly.`]);
  const measure: UnknownRecord = {
    ...(measureIndex >= 0 ? measures[measureIndex] : {}),
    name: metricName,
    ...(metricInput.description?.trim() ? { description: metricInput.description.trim() } : {}),
    agg: aggregation,
    expr: measureColumn,
  };
  if (measureIndex >= 0) measures[measureIndex] = measure; else measures.push(measure);
  const nextModel: UnknownRecord = { ...model, dimensions, measures };

  // Place the semantic model and the metric; each touched file is written once.
  const edits = new Map<string, Loaded>();
  const touch = (file: Loaded): UnknownRecord => {
    const entry = edits.get(file.path) ?? { ...file, document: { ...file.document } };
    edits.set(file.path, entry);
    return entry.document;
  };
  if (target) {
    const document = touch(target.file);
    document.semantic_models = listOf(target.file.document, 'semantic_models').map((candidate) => (candidate.name === semanticModelName ? nextModel : candidate));
  } else if (created) {
    const existingFile = loaded.get(created.path);
    const document = touch(existingFile ?? { path: created.path, before: '', document: { version: 2 } });
    document.semantic_models = [...(existingFile ? listOf(existingFile.document, 'semantic_models') : []), nextModel];
  }
  const metricHome = metricOwner ?? target?.file ?? loaded.get(created?.path ?? '') ?? { path: created?.path ?? '', before: '', document: { version: 2 } };
  const metricDocument = touch(metricHome);
  const metrics = listOf(metricHome.document, 'metrics');
  const metricIndex = metrics.findIndex((metric) => metric.name === metricName);
  const existingMetric = metricIndex >= 0 ? metrics[metricIndex] : {};
  const domain = metricInput.domain?.trim();
  const nextMetric: UnknownRecord = {
    ...existingMetric,
    name: metricName,
    label: metricInput.label?.trim() || metricName.split('_').map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' '),
    ...(metricInput.description?.trim() ? { description: metricInput.description.trim() } : {}),
    type: 'simple',
    type_params: { ...asRecord(existingMetric.type_params), measure: metricName },
    ...(domain ? { config: { ...asRecord(existingMetric.config), meta: { ...asRecord(asRecord(existingMetric.config).meta), domain } } } : {}),
  };
  if (metricIndex >= 0) metrics[metricIndex] = nextMetric; else metrics.push(nextMetric);
  metricDocument.metrics = metrics;

  const patches: ModelingSourcePatch[] = [...edits.values()].map((entry) => {
    entry.document.version = typeof entry.document.version === 'number' ? entry.document.version : 2;
    const after = dumpYaml(entry.document);
    return { path: entry.path, before: entry.before, after, changed: entry.before !== after };
  });
  return { semanticModel: semanticModelName, metric: metricName, patches, fingerprint: hash({ input, patches }), warnings };
}

export function applyDbtMetricPatch(
  dbtProjectRoot: string,
  manifestPath: string,
  input: DbtMetricAuthoringInput,
  expectedFingerprint: string,
): DbtMetricPatchPreview {
  const preview = previewDbtMetricPatch(dbtProjectRoot, manifestPath, input);
  if (!expectedFingerprint || preview.fingerprint !== expectedFingerprint) {
    throw new Error('dbt source changed after the preview. Refresh the source patch before applying.');
  }
  for (const patch of preview.patches.filter((item) => item.changed)) {
    const absolute = assertContainedPath(dbtProjectRoot, patch.path, 'dbt source patch');
    mkdirSync(dirname(absolute), { recursive: true });
    // Re-check after mkdir so a concurrently-created symlink cannot redirect the write outside the dbt project.
    assertContainedPath(dbtProjectRoot, patch.path, 'dbt source patch');
    writeFileSync(absolute, patch.after, 'utf8');
  }
  return preview;
}
