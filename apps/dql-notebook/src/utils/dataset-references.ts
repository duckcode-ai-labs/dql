import type { Cell, DatasetReference, SchemaTable } from '../store/types';

export interface JoinPairSuggestion {
  warehouseKey: string;
  localKey: string;
  score: number;
  reason: string;
}

export type JoinCardinality = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many' | 'unknown';

export function findDatasetReferences(sql: string, tables: SchemaTable[]): DatasetReference[] {
  return tables
    .filter((table) => table.datasetId && (table.objectType === 'dataset' || table.objectType === 'staged_dataset'))
    .filter((table) => relationPattern(table.name).test(sql))
    .map((table) => ({
      id: table.datasetId!,
      alias: table.name,
      role: table.objectType === 'staged_dataset' ? 'staged' : 'source',
      fingerprint: table.fileFingerprint,
    }));
}

export function findWarehouseReferences(sql: string, tables: SchemaTable[]): string[] {
  return tables
    .filter((table) => table.source === 'database')
    .filter((table) => relationPattern(table.name).test(sql))
    .map((table) => table.name);
}

export function suggestJoinPairs(
  warehouseColumns: string[],
  localColumns: Array<{ name: string; flags?: string[] }>,
): JoinPairSuggestion[] {
  const pairs: JoinPairSuggestion[] = [];
  for (const warehouseKey of warehouseColumns) {
    for (const localColumn of localColumns) {
      const score = joinKeyScore(warehouseKey, localColumn.name, localColumn.flags ?? []);
      if (score.score > 0) pairs.push({ warehouseKey, localKey: localColumn.name, ...score });
    }
  }
  return pairs.sort((a, b) => b.score - a.score || a.warehouseKey.localeCompare(b.warehouseKey)).slice(0, 12);
}

export function estimateJoinCardinality(input: {
  warehouseRows: Array<Record<string, unknown>>;
  warehouseKey: string;
  localDistinctCount?: number;
  localSampledRows?: number;
}): JoinCardinality {
  const warehouseValues = input.warehouseRows
    .map((row) => row[input.warehouseKey])
    .filter((value) => value !== null && value !== undefined);
  if (warehouseValues.length === 0 || !input.localSampledRows || input.localDistinctCount === undefined) return 'unknown';
  const warehouseUnique = new Set(warehouseValues.map(stableValue)).size === warehouseValues.length;
  const localUnique = input.localDistinctCount >= input.localSampledRows;
  if (warehouseUnique && localUnique) return 'one_to_one';
  if (warehouseUnique) return 'one_to_many';
  if (localUnique) return 'many_to_one';
  return 'many_to_many';
}

export function buildCombinedDatasetCell(input: {
  staged: { id: string; alias: string; fileFingerprint: string; refreshedAt: string; columns?: string[] };
  local: { id: string; alias: string; fileFingerprint: string; refreshedAt: string; columns?: string[] };
  warehouseKey: string;
  localKey: string;
  joinType: 'left' | 'inner';
  sourceCell: Cell;
}): Cell {
  const stagedColumns = new Set(input.staged.columns ?? []);
  const localSelections = (input.local.columns ?? [])
    .filter((column) => column !== input.localKey)
    .map((column) => {
      const output = stagedColumns.has(column) ? `local_${column}` : column;
      return `  local_data.${quoteIdentifier(column)} AS ${quoteIdentifier(output)}`;
    });
  const selections = ['  warehouse.*', ...localSelections];
  const cell: Cell = {
    id: `cell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'sql',
    name: `${input.local.alias}_${input.staged.alias}_analysis`,
    content: [
      '-- Local research join: governed warehouse snapshot plus local dataset',
      '-- Review required: verify join cardinality and freshness before sharing',
      'SELECT',
      selections.join(',\n'),
      `FROM ${quoteIdentifier(input.staged.alias)} AS warehouse`,
      `${input.joinType.toUpperCase()} JOIN ${quoteIdentifier(input.local.alias)} AS local_data`,
      `  ON warehouse.${quoteIdentifier(input.warehouseKey)} = local_data.${quoteIdentifier(input.localKey)}`,
      'LIMIT 1000',
    ].join('\n'),
    status: 'idle',
    executionTarget: { target: 'local' },
    datasetRefs: [
      { id: input.staged.id, alias: input.staged.alias, role: 'staged', fingerprint: input.staged.fileFingerprint },
      { id: input.local.id, alias: input.local.alias, role: 'source', fingerprint: input.local.fileFingerprint },
    ],
    dependencies: [{ cellId: input.sourceCell.id }],
    annotations: [{
      id: `note_${Date.now()}_join`,
      body: `Combined ${input.staged.alias} (${input.staged.refreshedAt}) with ${input.local.alias} (${input.local.refreshedAt}) using ${input.warehouseKey} = ${input.localKey}. Review required.`,
      createdAt: new Date().toISOString(),
      author: 'ZLens',
    }],
  };
  return cell;
}

function joinKeyScore(left: string, right: string, flags: string[]): { score: number; reason: string } {
  const leftLower = left.toLowerCase();
  const rightLower = right.toLowerCase();
  if (leftLower === rightLower) return { score: 100, reason: 'Same column name' };
  const leftCanonical = canonicalKey(leftLower);
  const rightCanonical = canonicalKey(rightLower);
  if (leftCanonical === rightCanonical) return { score: 90, reason: 'Same normalized name' };
  if ((leftCanonical.endsWith(rightCanonical) || rightCanonical.endsWith(leftCanonical))
    && (leftCanonical.endsWith('id') || rightCanonical.endsWith('id'))) {
    return { score: flags.includes('identifier') ? 78 : 70, reason: 'Related identifier names' };
  }
  const shared = tokens(leftLower).filter((token) => tokens(rightLower).includes(token));
  if (shared.length > 0 && (leftLower.includes('id') || rightLower.includes('id'))) {
    return { score: flags.includes('identifier') ? 62 : 55, reason: 'Shared entity identifier' };
  }
  return { score: 0, reason: '' };
}

function canonicalKey(value: string): string {
  return value.replace(/[^a-z0-9]/g, '').replace(/identifier$/, 'id');
}

function tokens(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter((token) => token.length > 1);
}

function relationPattern(alias: string): RegExp {
  return new RegExp(`(?:^|[^a-zA-Z0-9_])(?:["\x60])?${escapeRegExp(alias)}(?:["\x60])?(?=$|[^a-zA-Z0-9_])`, 'i');
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stableValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
