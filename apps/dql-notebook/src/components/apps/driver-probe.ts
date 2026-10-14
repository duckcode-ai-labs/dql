import { tileQueryOutputAliases } from '@zlens/core/apps/tile-query';
import type { DashboardDocumentResponse, DashboardDriverDefinitionV1, DashboardRunResponse } from '../../api/client';

type LayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type RunTile = DashboardRunResponse['tiles'][number];

const GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year']);

/**
 * The driver definition behind "Why did it move?" for a trend tile: its
 * measure, explained at the latest period the tile shows, against the period
 * before. Only Dataset tiles grouped by a time grain qualify; the server
 * checks the fields again against the Dataset contract.
 */
export function driverProbeFor(
  item: LayoutItem,
  tile: RunTile | undefined,
  comparison: DashboardDriverDefinitionV1['comparison'] = 'previous_period',
  today: Date = new Date(),
): DashboardDriverDefinitionV1 | null {
  const query = item.query as Parameters<typeof tileQueryOutputAliases>[0] | undefined;
  if (!query || !item.sourceId || query.detail || tile?.status !== 'ok' || !tile.result?.rows?.length) return null;
  const measure = query.measures?.[0]?.measure;
  const timeIndex = query.dimensions.findIndex((dimension) => dimension.timeGrain && GRAINS.has(dimension.timeGrain.toLowerCase()));
  if (!measure || timeIndex < 0) return null;
  const timeDimension = query.dimensions[timeIndex]!;
  const alias = tileQueryOutputAliases(query)[timeIndex]?.alias;
  if (!alias) return null;
  const grain = timeDimension.timeGrain!.toLowerCase();
  const anchor = explainablePeriod(tile.result.rows.map((row) => row[alias]), grain, today);
  if (!anchor) return null;
  return {
    version: 1,
    measure,
    timeField: timeDimension.field,
    grain: grain as DashboardDriverDefinitionV1['grain'],
    anchor,
    comparison,
    dimensions: ['*'],
  };
}

/**
 * The period to explain: the latest one the tile shows, unless that period
 * is still running today, in which case the one before it. A half-finished
 * period compared with a full one would explain nothing.
 */
export function explainablePeriod(values: unknown[], grain: string, today: Date): string | null {
  const periods = Array.from(new Set(values.map(calendarDate).filter((date): date is string => Boolean(date)))).sort();
  const latest = periods.at(-1);
  if (!latest) return null;
  const current = periodStart(today.toISOString().slice(0, 10), grain);
  if (periodStart(latest, grain) === current && periods.length > 1) return periods.at(-2)!;
  return latest;
}

/** Start of the UTC calendar period containing a date. */
function periodStart(date: string, grain: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  if (grain === 'year') return `${year}-01-01`;
  if (grain === 'quarter') return `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  if (grain === 'month') return `${year}-${String(month).padStart(2, '0')}-01`;
  if (grain === 'week') {
    const value = new Date(Date.UTC(year, month - 1, day));
    const weekday = value.getUTCDay();
    value.setUTCDate(value.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
    return value.toISOString().slice(0, 10);
  }
  return date;
}

function calendarDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

/** "Mar 2026", "Q1 2026", "Week of Mar 2, 2026". Instants are read in UTC, as the server bounds them. */
export function driverPeriodLabel(value: string, grain: string): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return value;
  const utc = { timeZone: 'UTC' } as const;
  if (grain === 'year') return String(date.getUTCFullYear());
  if (grain === 'quarter') return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
  if (grain === 'month') return date.toLocaleDateString('en-US', { ...utc, month: 'short', year: 'numeric' });
  const day = date.toLocaleDateString('en-US', { ...utc, month: 'short', day: 'numeric', year: 'numeric' });
  return grain === 'week' ? `Week of ${day}` : day;
}

/** Exact decimal text to a readable number; signed shows + and − explicitly. */
export function formatDriverNumber(value: string | undefined, signed = false): string {
  if (value === undefined || value === null || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const text = new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(number) >= 100 ? 0 : 2 }).format(Math.abs(number));
  if (!signed) return number < 0 ? `−${text}` : text;
  return number > 0 ? `+${text}` : number < 0 ? `−${text}` : '0';
}

/** A member's signed share of the change as a whole percent. */
export function formatDriverShare(share: string | undefined): string {
  if (share === undefined) return '';
  const number = Number(share);
  if (!Number.isFinite(number)) return '';
  return `${Math.round(number * 100)}%`;
}

type PageFilter = NonNullable<DashboardDocumentResponse['dashboard']['filters']>[number];

/**
 * The page filters a new driver tile must join: every filter that lists the
 * tile it explains, in its scope or in a Dataset binding's tile list, gains
 * the driver tile, so "why did it move" answers for the same filtered data.
 * Filters that apply to all tiles are left as they are.
 */
export function filtersForNewDriverTile(filters: PageFilter[] | undefined, sourceTileId: string, driverTileId: string): PageFilter[] {
  const add = (ids: string[]) => (ids.includes(sourceTileId) && !ids.includes(driverTileId) ? [...ids, driverTileId] : ids);
  return (filters ?? []).flatMap((filter) => {
    const scopeIds = filter.scope && 'tileIds' in filter.scope ? filter.scope.tileIds : undefined;
    const bindings = filter.datasetBindings;
    const nextScope = scopeIds ? add(scopeIds) : undefined;
    const nextBindings = bindings
      ? Object.fromEntries(Object.entries(bindings).map(([id, binding]) => [id, binding.tileIds ? { ...binding, tileIds: add(binding.tileIds) } : binding]))
      : undefined;
    const changed = (nextScope && nextScope !== scopeIds)
      || (bindings && Object.entries(nextBindings!).some(([id, binding]) => binding.tileIds !== bindings[id]!.tileIds));
    if (!changed) return [];
    return [{
      ...filter,
      ...(nextScope ? { scope: { ...filter.scope, tileIds: nextScope } } : {}),
      ...(nextBindings ? { datasetBindings: nextBindings } : {}),
    } as PageFilter];
  });
}
