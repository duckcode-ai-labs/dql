/**
 * A viewer's own App page filter ("Filter by… → Product Name → Apply").
 *
 * A reader narrows a page to understand it; nothing is written to the App. The
 * filter is not one of the page's declared `filters`, so the declared-filter
 * path never saw it and the value was silently dropped: no tile narrowed, the
 * story stayed whole, and Ask read the unfiltered page.
 *
 * The browser sends `viewerFilters` on the page run: a column, its value(s) and
 * the tiles whose previous server run reported that column as filterable. The
 * server does not take the browser's word for the tile list — each named block
 * tile must still prove, from its own SQL, that the column is a safe
 * dimension (never an aggregate input or an ambiguous join column) before a
 * predicate is added. The predicate itself goes through the same parameterised
 * wrapper as a declared filter, so a value never becomes SQL text.
 */
import type { DashboardDocument, DashboardGridItem } from '@zlens/core';
import { dashboardFilterableResultColumns } from './sql-result-filter.js';

type DashboardFilter = NonNullable<DashboardDocument['filters']>[number];
type DashboardTileFilterBinding = NonNullable<DashboardGridItem['filterBindings']>[number];
type ViewerFilterValue = string | number | boolean;

export interface DashboardViewerFilter {
  /** The result column, exactly as a tile's `filterableColumns` named it. */
  column: string;
  /** One value (equality) or several (IN). Never empty. */
  values: ViewerFilterValue[];
  /** The tiles the viewer was told this filter narrows. */
  tileIds: string[];
}

export const MAX_VIEWER_FILTERS = 8;
const MAX_VIEWER_FILTER_VALUES = 50;
const MAX_VIEWER_FILTER_VALUE_LENGTH = 500;
const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type ParsedDashboardViewerFilters =
  | { ok: true; filters: DashboardViewerFilter[] }
  | { ok: false; error: string };

/**
 * Validate the request's `viewerFilters`. A column that the page already
 * declares as a filter or parameter is refused: the declared control owns that
 * name, and two values for one name would make the page's scope ambiguous.
 */
export function parseDashboardViewerFilters(
  value: unknown,
  dashboard: Pick<DashboardDocument, 'filters' | 'params' | 'layout'>,
): ParsedDashboardViewerFilters {
  if (value === undefined || value === null) return { ok: true, filters: [] };
  if (!Array.isArray(value) || value.length > MAX_VIEWER_FILTERS) {
    return { ok: false, error: `viewerFilters must be an array of at most ${MAX_VIEWER_FILTERS} column filters.` };
  }
  const authoredTileIds = new Set(dashboard.layout.items.map((item) => item.i));
  const declared = new Set([
    ...(dashboard.filters ?? []).map((filter) => filter.id.toLowerCase()),
    ...(dashboard.params ?? []).map((param) => param.id.toLowerCase()),
  ]);
  const seen = new Set<string>();
  const filters: DashboardViewerFilter[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { ok: false, error: 'Each viewer filter must name a column, its value and the tiles it narrows.' };
    }
    const record = candidate as Record<string, unknown>;
    const column = typeof record.column === 'string' ? record.column.trim() : '';
    if (!SAFE_COLUMN.test(column)) {
      return { ok: false, error: 'A viewer filter column must be a plain result column name.' };
    }
    const key = column.toLowerCase();
    if (declared.has(key)) {
      return { ok: false, error: `"${column}" is already a filter on this page; set it there instead.` };
    }
    if (seen.has(key)) {
      return { ok: false, error: `"${column}" is filtered twice; send one viewer filter per column.` };
    }
    seen.add(key);
    const rawValues = Array.isArray(record.values) ? record.values : record.value === undefined ? [] : [record.value];
    if (rawValues.length === 0 || rawValues.length > MAX_VIEWER_FILTER_VALUES) {
      return { ok: false, error: `The "${column}" filter needs between 1 and ${MAX_VIEWER_FILTER_VALUES} values.` };
    }
    const values: ViewerFilterValue[] = [];
    for (const item of rawValues) {
      if (typeof item === 'number' && Number.isFinite(item)) values.push(item);
      else if (typeof item === 'boolean') values.push(item);
      else if (typeof item === 'string' && item.trim() && item.length <= MAX_VIEWER_FILTER_VALUE_LENGTH) values.push(item);
      else return { ok: false, error: `The "${column}" filter has a value that is empty, too long, or not a plain value.` };
    }
    if (!Array.isArray(record.tileIds) || record.tileIds.length > 200) {
      return { ok: false, error: `The "${column}" filter must list the tiles it narrows.` };
    }
    const tileIds = Array.from(new Set(record.tileIds.map((tileId) => (typeof tileId === 'string' ? tileId.trim() : ''))));
    if (tileIds.some((tileId) => !tileId || !authoredTileIds.has(tileId))) {
      return { ok: false, error: `The "${column}" filter names a tile that is not on this page.` };
    }
    filters.push({ column, values, tileIds });
  }
  return { ok: true, filters };
}

/** The request variables a viewer filter contributes, so story, Ask and fingerprints see it. */
export function viewerFilterVariables(filters: DashboardViewerFilter[]): Record<string, unknown> {
  return Object.fromEntries(filters.map((filter) => [
    filter.column,
    filter.values.length === 1 ? filter.values[0] : [...filter.values],
  ]));
}

/** Ephemeral filter declarations for one run. Never persisted to the page. */
export function viewerFilterDeclarations(filters: DashboardViewerFilter[]): DashboardFilter[] {
  return filters.map((filter) => ({
    id: filter.column,
    label: filter.column,
    type: filter.values.length === 1 ? 'select' : 'multiselect',
    bindsTo: filter.column,
  }));
}

/**
 * The tile filter bindings a viewer filter earns on one block tile: only when
 * the viewer was told this tile narrows AND the tile's own SQL proves the
 * column is a filterable dimension. A tile that fails either check keeps its
 * full scope and reports the filter as skipped.
 */
export function viewerFilterBindingsForBlockTile(input: {
  tileId: string;
  sql: string;
  declaredDimensions?: string[];
  filters: DashboardViewerFilter[];
  dialect?: string;
}): DashboardTileFilterBinding[] {
  const bindings: DashboardTileFilterBinding[] = [];
  for (const filter of input.filters) {
    if (!filter.tileIds.includes(input.tileId)) continue;
    let proven: Array<{ column: string; predicateTarget: string }> = [];
    try {
      proven = dashboardFilterableResultColumns(input.sql, [filter.column], input.declaredDimensions ?? [], input.dialect);
    } catch {
      proven = [];
    }
    const match = proven.find((candidate) => candidate.column.toLowerCase() === filter.column.toLowerCase());
    if (!match) continue;
    bindings.push({ filter: filter.column, binding: match.predicateTarget, mode: 'predicate' });
  }
  return bindings;
}

/** The page's applied filters as reader-facing label/value pairs, viewer filters included. */
export function viewerFilterPageFilters(filters: DashboardViewerFilter[]): Array<{ id: string; label: string; value: string }> {
  return filters.map((filter) => ({
    id: filter.column,
    label: filter.column,
    value: filter.values.map(String).join(', ').slice(0, 200),
  }));
}
