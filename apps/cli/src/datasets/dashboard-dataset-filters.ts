import {
  datasetPhysicalField,
  tileQueryOutputAliases,
  type DashboardDocument,
  type DashboardGridItem,
  type DatasetDescriptor,
  type DatasetPhysicalField,
  type TileQueryFilter,
} from '@zlens/core';

export interface DashboardDatasetCrossFilterInput {
  fromTileId: string;
  fromSourceId: string;
  fromSourceRevision: string;
  field: string;
  values: unknown[];
  /** Exclude these values instead of keeping only them (RFC 0009 step 6a). */
  exclude?: boolean;
}

export type DatasetFilterIssue = {
  filterId: string;
  code: 'DATASET_BINDING_MISSING' | 'FILTER_REQUIRED_VALUE_MISSING' | 'FILTER_MAPPING_MISSING' | 'DATASET_TILE_EXCLUDED' | 'FILTER_FIELD_UNAVAILABLE' | 'FILTER_VALUE_INVALID' | 'CROSS_FILTER_UNSUPPORTED' | 'CROSS_FILTER_SOURCE_INVALID';
  message: string;
};

export interface DatasetTileFilterResolution {
  filters: TileQueryFilter[];
  /** A visible badge can explain intentional partial filtering without hiding it. */
  unbound: DatasetFilterIssue[];
  /** Errors block only this tile; they never discard its saved query draft. */
  errors: DatasetFilterIssue[];
}

/**
 * Resolve field-bound dashboard filters for exactly one Dataset tile.  There
 * is no display-name fallback: a filter only travels across a source boundary
 * through `DashboardFilter.datasetBindings` or an authored cross-filter map.
 */
export function resolveDashboardDatasetFilters(input: {
  dashboard: DashboardDocument;
  item: DashboardGridItem;
  descriptor: DatasetDescriptor;
  values: Record<string, unknown>;
  crossFilters?: DashboardDatasetCrossFilterInput[];
  /** Reference instant for relative dates; the run's own clock by default. */
  now?: Date;
}): DatasetTileFilterResolution {
  const filters: TileQueryFilter[] = [];
  const unbound: DatasetFilterIssue[] = [];
  const errors: DatasetFilterIssue[] = [];
  if (!input.item.query || input.item.query.respectsGlobalFilters === false) return { filters, unbound, errors };
  const binding = input.dashboard.datasets?.find((candidate) => candidate.sourceId === input.item.sourceId
    && candidate.sourceRevision === input.item.sourceRevision);
  if (!binding) {
    errors.push({
      filterId: 'dataset',
      code: 'DATASET_BINDING_MISSING',
      message: 'This tile no longer has its exact Dataset binding. Refresh the selected dataset before running it.',
    });
    return { filters, unbound, errors };
  }
  for (const filter of input.dashboard.filters ?? []) {
    if (filter.scope?.page && filter.scope.page !== input.dashboard.id) continue;
    if (filter.scope?.tileIds && !filter.scope.tileIds.includes(input.item.i)) continue;
    const value = input.values[filter.id];
    if (isEmptyDashboardFilterValue(value)) {
      if (filter.required) {
        errors.push({
          filterId: filter.id,
          code: 'FILTER_REQUIRED_VALUE_MISSING',
          message: `${filter.label ?? filter.id} needs a value before this tile can run.`,
        });
      }
      continue;
    }
    const datasetBinding = filter.datasetBindings?.[binding.id];
    if (!datasetBinding) {
      unbound.push({
        filterId: filter.id,
        code: 'FILTER_MAPPING_MISSING',
        message: `${filter.label ?? filter.id} is not mapped to ${input.descriptor.label}.`,
      });
      continue;
    }
    if (datasetBinding.tileIds && !datasetBinding.tileIds.includes(input.item.i)) {
      unbound.push({
        filterId: filter.id,
        code: 'DATASET_TILE_EXCLUDED',
        message: `${filter.label ?? filter.id} is excluded from ${input.item.title ?? input.item.i} by this filter's linked-component selection.`,
      });
      continue;
    }
    const mapped = datasetBinding.field;
    const field = datasetPhysicalField(input.descriptor, mapped);
    if (!field) {
      errors.push({
        filterId: filter.id,
        code: 'FILTER_FIELD_UNAVAILABLE',
        message: `${filter.label ?? filter.id} maps to ${mapped}, which is no longer an approved physical field on ${input.descriptor.label}.`,
      });
      continue;
    }
    const compiled = dashboardFilterToTileFilter(filter.id, filter.type, filter.multiple === true, field, filter.timezone, value, input.now ?? new Date());
    if ('error' in compiled) {
      errors.push({ filterId: filter.id, code: 'FILTER_VALUE_INVALID', message: compiled.error });
      continue;
    }
    filters.push(...compiled.filters);
  }

  const crossFilterMappings = input.dashboard.interactions?.crossFilter;
  if (crossFilterMappings?.enabled !== false) {
    for (const crossFilter of input.crossFilters ?? []) {
      if (!crossFilter.values.length) continue;
      const sourceItem = input.dashboard.layout.items.find((candidate) => candidate.i === crossFilter.fromTileId);
      const sourceDataset = sourceItem?.sourceId && sourceItem.sourceRevision
        ? input.dashboard.datasets?.find((candidate) => candidate.sourceId === sourceItem.sourceId
          && candidate.sourceRevision === sourceItem.sourceRevision)
        : undefined;
      const sourceOutput = sourceItem?.query
        ? tileQueryOutputAliases(sourceItem.query).find((output) => output.alias === crossFilter.field)
        : undefined;
      if (!sourceItem || !sourceDataset || !sourceOutput
        || sourceItem.sourceId !== crossFilter.fromSourceId
        || sourceItem.sourceRevision !== crossFilter.fromSourceRevision) {
        errors.push({
          filterId: crossFilter.fromTileId,
          code: 'CROSS_FILTER_SOURCE_INVALID',
          message: `The cross-filter source ${crossFilter.fromTileId} no longer matches its declared Dataset field binding.`,
        });
        continue;
      }
      const mappings = (crossFilterMappings?.mappings ?? []).filter((mapping) =>
        mapping.toDataset === binding.id
        && mapping.fromField === crossFilter.field
        && mapping.fromTileId === crossFilter.fromTileId);
      // Keep only / Exclude on the tile's own Dataset needs no mapping: it is
      // the same Dataset and the same field, not a guess from a similar name.
      // A time grain's value names a period, not a date, so it never filters
      // this way.
      const ownDimension = sourceDataset.id === binding.id
        ? sourceItem.query?.dimensions.find((dimension) => !dimension.timeGrain
          && (dimension.alias ?? dimension.field) === crossFilter.field)
        : undefined;
      if (mappings.length === 0 && ownDimension) mappings.push({ fromTileId: crossFilter.fromTileId, fromField: crossFilter.field, toDataset: binding.id, toField: ownDimension.field });
      if (mappings.length === 0) {
        unbound.push({
          filterId: crossFilter.fromTileId,
          code: 'CROSS_FILTER_UNSUPPORTED',
          message: `The cross-filter from ${crossFilter.fromTileId} is not mapped to ${input.descriptor.label}.`,
        });
        continue;
      }
      for (const mapping of mappings) {
        const field = datasetPhysicalField(input.descriptor, mapping.toField);
        if (!field) {
          errors.push({
            filterId: crossFilter.fromTileId,
            code: 'FILTER_FIELD_UNAVAILABLE',
            message: `Cross-filter mapping ${mapping.toField} is not available on ${input.descriptor.label}.`,
          });
          continue;
        }
        filters.push({
          field: field.name,
          op: crossFilter.exclude
            ? (crossFilter.values.length > 1 ? 'not_in' : 'neq')
            : (crossFilter.values.length > 1 ? 'in' : 'eq'),
          values: [...crossFilter.values],
        });
      }
    }
  }
  return { filters: dedupeTileFilters(filters), unbound: dedupeIssues(unbound), errors: dedupeIssues(errors) };
}

function dashboardFilterToTileFilter(
  filterId: string,
  type: string,
  multiple: boolean,
  field: DatasetPhysicalField,
  timezone: string | undefined,
  value: unknown,
  now: Date,
): { filters: TileQueryFilter[] } | { error: string } {
  let values = Array.isArray(value) ? value : [value];
  if (type === 'relative_date') {
    if (values.length !== 1 || typeof values[0] !== 'string') return { error: `${filterId} requires one relative date such as last_30_days.` };
    if (field.type !== 'date' && field.type !== 'timestamp') {
      return { error: `${filterId} is a relative date, but ${field.name} is not a date or timestamp field.` };
    }
    if (field.type === 'timestamp' && !timezone) {
      return { error: `${filterId} requires a declared IANA timezone before it can bound timestamp values.` };
    }
    const range = resolveRelativeDateRange(values[0], calendarDateInTimezone(now, timezone ?? 'UTC'));
    if (!range) return { error: `${filterId} uses an unknown relative date ${values[0]}. Use last_N_days, today, yesterday, month_to_date, quarter_to_date, or year_to_date.` };
    // A relative date is an inclusive calendar range ending today in the
    // filter's timezone; from here it is exactly a date range.
    type = 'daterange';
    values = [range.start, range.end];
  }
  if (type === 'daterange') {
    if (values.length !== 2) return { error: `${filterId} requires exactly two values for a range.` };
    if (!values.every((candidate) => typeof candidate === 'string')) return { error: `${filterId} requires ISO date values.` };
    const [start, end] = values as string[];
    if (isCalendarDate(start) && isCalendarDate(end)) {
      if (field.type === 'timestamp' && !timezone) {
        return { error: `${filterId} requires a declared IANA timezone before it can bound timestamp values.` };
      }
      const exclusiveEnd = field.type === 'timestamp'
        ? calendarDateBoundaryInTimezone(nextCalendarDate(end), timezone!)
        : nextCalendarDate(end);
      const inclusiveStart = field.type === 'timestamp'
        ? calendarDateBoundaryInTimezone(start, timezone!)
        : start;
      return { filters: [
        { field: field.name, op: 'gte', values: [inclusiveStart] },
        { field: field.name, op: 'lt', values: [exclusiveEnd] },
      ] };
    }
    // Explicit timestamp boundaries are already precise. Preserve their
    // caller-declared semantics rather than guessing an extra calendar day.
    return { filters: [{ field: field.name, op: 'between', values }] };
  }
  if (type === 'number_range') {
    if (values.length !== 2) return { error: `${filterId} requires exactly two values for a range.` };
    return { filters: [{ field: field.name, op: 'between', values }] };
  }
  if (type === 'search') {
    if (values.length !== 1) return { error: `${filterId} requires one search value.` };
    return { filters: [{ field: field.name, op: 'contains', values }] };
  }
  if (type === 'multiselect' || multiple || Array.isArray(value)) {
    if (values.length === 0) return { error: `${filterId} requires at least one selected value.` };
    return { filters: [{ field: field.name, op: 'in', values }] };
  }
  if (values.length !== 1) return { error: `${filterId} requires one value.` };
  return { filters: [{ field: field.name, op: 'eq', values }] };
}

/**
 * Resolve a relative-date preset to an inclusive calendar range. `today` is
 * the calendar date in the filter's timezone (UTC when none is declared, which
 * only a date field allows). `last_N_days` includes today: last_7_days is
 * today and the six days before it.
 */
export function resolveRelativeDateRange(preset: string, today: string): { start: string; end: string } | undefined {
  const [year, month, day] = today.split('-').map(Number);
  const shift = (days: number) => new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  const lastDays = /^last_(\d{1,4})_days$/.exec(preset);
  if (lastDays) {
    const count = Number(lastDays[1]);
    if (count < 1 || count > 3660) return undefined;
    return { start: shift(-(count - 1)), end: today };
  }
  if (preset === 'today') return { start: today, end: today };
  if (preset === 'yesterday') return { start: shift(-1), end: shift(-1) };
  if (preset === 'month_to_date') return { start: `${today.slice(0, 7)}-01`, end: today };
  if (preset === 'quarter_to_date') {
    const quarterMonth = String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0');
    return { start: `${today.slice(0, 4)}-${quarterMonth}-01`, end: today };
  }
  if (preset === 'year_to_date') return { start: `${today.slice(0, 4)}-01-01`, end: today };
  return undefined;
}

function calendarDateInTimezone(instant: Date, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function nextCalendarDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

/** Convert a declared local calendar boundary to a UTC timestamp without
 * treating a daylight-saving day as a fixed 24-hour duration. */
function calendarDateBoundaryInTimezone(date: string, timezone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const requested = Date.UTC(year, month - 1, day, 0, 0, 0);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let instant = requested;
  // One correction resolves ordinary offsets; a second resolves a DST
  // transition at local midnight without assuming a 24-hour calendar day.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]));
    const observed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    instant += requested - observed;
  }
  return new Date(instant).toISOString();
}

function isEmptyDashboardFilterValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function dedupeTileFilters(filters: TileQueryFilter[]): TileQueryFilter[] {
  const seen = new Set<string>();
  return filters.filter((filter) => {
    const key = JSON.stringify([filter.field, filter.op, filter.values]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeIssues(issues: DatasetFilterIssue[]): DatasetFilterIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.filterId}\u0000${issue.code}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
