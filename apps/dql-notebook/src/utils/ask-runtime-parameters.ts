import type { DqlArtifactReference } from '@zlens/core/artifacts';
import type { BlockParameterDefinition } from '@zlens/core/blocks';
import type { QueryResult } from '../store/types';
import {
  inferVisualParameterType,
  parseVisualBlockParameters,
  setVisualBlockParameterBinding,
  upsertVisualBlockParameter,
} from './block-studio';

export interface AskResultFilterCandidate {
  column: string;
  field: string;
  values: Array<string | number | boolean>;
}

/**
 * React parents may rebuild an equivalent conversation artifact while the user
 * focuses, selects, or double-clicks an input. Use the executable contract—not
 * object identity—to decide whether local parameter edits should be reset.
 */
export function askArtifactStateKey(artifact: DqlArtifactReference): string {
  return JSON.stringify([
    artifact.kind,
    artifact.name ?? null,
    artifact.source,
    artifact.persistence ?? null,
    artifact.parameters ?? [],
    Object.entries(artifact.parameterValues ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    artifact.executionReceipt ?? null,
  ]);
}

/**
 * Ask may offer extra filters only for dimensions already present in a
 * transient semantic result. Metrics require governed HAVING semantics and
 * custom SQL requires an explicit placeholder, so neither is silently guessed.
 */
export function askResultFilterCandidates(
  artifact: DqlArtifactReference,
  result: QueryResult,
): AskResultFilterCandidate[] {
  // A GENERATED SQL answer gets its candidates from the server, which parsed the
  // executed statement and kept only plain source columns — an aggregate output
  // would need HAVING, whose post-aggregation meaning is not what picking a
  // column off the table implies. The browser deliberately does not re-derive
  // this; guessing it here is how a filter lands on the wrong query.
  if (artifact.kind === 'sql_block') {
    const columns = new Map(result.columns.map((column) => [column.toLowerCase(), column]));
    return (artifact.filterableColumns ?? []).flatMap((candidate) => {
      const column = columns.get(candidate.column.toLowerCase());
      if (!column) return [];
      return [{ column, field: candidate.predicateTarget, values: uniqueScalarValues(result.rows.map((row) => row[column])) }];
    });
  }
  if (artifact.kind !== 'semantic_block' || artifact.persistence !== 'transient') return [];
  const columns = new Map(result.columns.map((column) => [column.toLowerCase(), column]));
  const boundFields = new Set(
    (artifact.parameters ?? [])
      .flatMap((parameter) => parameter.binding?.kind === 'semantic_filter' ? [parameter.binding.field.toLowerCase()] : []),
  );
  return (artifact.dimensions ?? []).flatMap((field) => {
    if (boundFields.has(field.toLowerCase())) return [];
    const leaf = field.split('.').at(-1) ?? field;
    const column = columns.get(field.toLowerCase())
      ?? columns.get(leaf.toLowerCase())
      ?? columns.get(field.split('.').join('_').toLowerCase());
    if (!column) return [];
    const values = uniqueScalarValues(result.rows.map((row) => row[column]));
    return [{ column, field, values }];
  });
}

export function addAskResultFilter(
  artifact: DqlArtifactReference,
  result: QueryResult,
  column: string,
  value: unknown,
): { artifact: DqlArtifactReference; parameterName: string } {
  const candidate = askResultFilterCandidates(artifact, result).find((item) => item.column === column);
  if (!candidate) throw new Error(`"${column}" is not an available semantic result filter.`);
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error('Choose a default filter value before adding the input.');
  }
  const existingNames = new Set((artifact.parameters ?? []).map((parameter) => parameter.name));
  const baseName = normalizeParameterName(candidate.field.split('.').at(-1) ?? candidate.column);
  let parameterName = baseName;
  let suffix = 2;
  while (existingNames.has(parameterName)) parameterName = `${baseName}_${suffix++}`;
  const defaultText = Array.isArray(value) ? value.map(String).join(', ') : String(value);
  const type = inferVisualParameterType(defaultText, parameterName);
  let source = upsertVisualBlockParameter(artifact.source, {
    name: parameterName,
    type,
    required: false,
    defaultText,
    policy: 'dynamic',
  });
  source = setVisualBlockParameterBinding(source, parameterName, candidate.field);
  const parameters: BlockParameterDefinition[] = parseVisualBlockParameters(source).map((parameter) => ({
    ...parameter,
    ...(parameter.binding?.kind === 'semantic_filter' && parameter.binding.field
      ? {
          binding: {
            kind: 'semantic_filter' as const,
            field: parameter.binding.field,
            operator: parameter.binding.operator ?? 'equals',
          },
        }
      : parameter.binding?.kind === 'limit'
        ? { binding: { kind: 'limit' as const } }
        : parameter.binding?.kind === 'sql_value'
          ? { binding: { kind: 'sql_value' as const } }
          : { binding: undefined }),
  }));
  const { executionReceipt: _executionReceipt, compiledSql: _compiledSql, ...unexecutedArtifact } = artifact;
  return {
    artifact: {
      ...unexecutedArtifact,
      source,
      parameters,
      parameterValues: {
        ...(artifact.parameterValues ?? {}),
        [parameterName]: value,
      },
    },
    parameterName,
  };
}

function uniqueScalarValues(values: unknown[]): Array<string | number | boolean> {
  const seen = new Set<string>();
  const result: Array<string | number | boolean> = [];
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= 50) break;
  }
  return result;
}

function normalizeParameterName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z_][a-z0-9_]*$/.test(normalized) ? normalized : 'result_filter';
}
