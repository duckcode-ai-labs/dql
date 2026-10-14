import type { DatasetDescriptor, DatasetPhysicalField } from '@zlens/core/datasets/descriptor';
import type { TileQueryComparison } from '@zlens/core/apps/tile-query';

const SUPPORTED_GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year']);

/**
 * Browser-safe comparison authoring helpers.  They turn deliberately chosen
 * calendar dates into exact start-inclusive/end-exclusive instants; they do
 * not inspect result rows, infer a calendar, or authorize a Dataset route.
 */
export type DatasetComparisonDraft = {
  timeField: string;
  timeRole: string;
  calendarId: 'calendar:gregorian';
  timezone: string;
  grain: string;
  completenessPolicy: TileQueryComparison['completenessPolicy'];
  baseStart: string;
  baseEnd: string;
  comparisonStart: string;
  comparisonEnd: string;
};

export type DatasetComparisonBuildResult =
  | { status: 'ready'; comparison: TileQueryComparison; summary: string }
  | { status: 'blocked'; message: string };

export function datasetComparisonTimeFields(descriptor: DatasetDescriptor): DatasetPhysicalField[] {
  if (!descriptor.operations.includes('compare')) return [];
  return descriptor.fields.filter((field): field is DatasetPhysicalField => (
    field.kind === 'physical'
    && field.status === 'approved'
    && field.role === 'time'
    && Boolean(field.time?.grains.some((grain) => SUPPORTED_GRAINS.has(grain.toLowerCase())))
  ));
}

export function defaultDatasetComparisonDraft(descriptor: DatasetDescriptor): DatasetComparisonDraft {
  const field = datasetComparisonTimeFields(descriptor)[0];
  const grain = field?.time?.grains.find((candidate) => candidate.toLowerCase() === 'month')
    ?? field?.time?.grains.find((candidate) => SUPPORTED_GRAINS.has(candidate.toLowerCase()))
    ?? 'month';
  return {
    timeField: field?.name ?? '',
    timeRole: 'event_time',
    calendarId: 'calendar:gregorian',
    timezone: 'UTC',
    grain,
    completenessPolicy: 'closed_period',
    baseStart: '',
    baseEnd: '',
    comparisonStart: '',
    comparisonEnd: '',
  };
}

/**
 * Restore a persisted comparison into editable browser controls. The saved
 * TileQuery remains the authority; malformed or no-longer-approved fields are
 * intentionally left incomplete so the inspector can show an actionable
 * validation error instead of silently changing the App definition.
 */
export function datasetComparisonDraftFromQuery(
  descriptor: DatasetDescriptor,
  comparison: TileQueryComparison | undefined,
): DatasetComparisonDraft {
  const fallback = defaultDatasetComparisonDraft(descriptor);
  if (!comparison) return fallback;
  const base = comparison.periods.find((period) => period.id === comparison.basePeriodId);
  const prior = comparison.periods.find((period) => period.id === comparison.comparisonPeriodIds[0]);
  return {
    timeField: comparison.timeField,
    timeRole: comparison.timeRole,
    calendarId: comparison.calendarId === 'calendar:gregorian' ? 'calendar:gregorian' : fallback.calendarId,
    timezone: comparison.timezone,
    grain: comparison.grain,
    completenessPolicy: comparison.completenessPolicy,
    baseStart: comparisonDateInput(base?.start, comparison.timezone),
    baseEnd: comparisonDateInput(base?.end, comparison.timezone),
    comparisonStart: comparisonDateInput(prior?.start, comparison.timezone),
    comparisonEnd: comparisonDateInput(prior?.end, comparison.timezone),
  };
}

/** Human-readable persisted intent for Studio and the saved App viewer. */
export function datasetComparisonSummary(comparison: TileQueryComparison | undefined): string | undefined {
  if (!comparison) return undefined;
  const base = comparison.periods.find((period) => period.id === comparison.basePeriodId);
  const prior = comparison.periods.find((period) => period.id === comparison.comparisonPeriodIds[0]);
  const baseStart = comparisonDateInput(base?.start, comparison.timezone);
  const baseEnd = comparisonDateInput(base?.end, comparison.timezone);
  const priorStart = comparisonDateInput(prior?.start, comparison.timezone);
  const priorEnd = comparisonDateInput(prior?.end, comparison.timezone);
  if (!baseStart || !baseEnd || !priorStart || !priorEnd) {
    return `Configured ${comparison.grain} comparison on ${comparison.timeField} · ${comparison.timezone}`;
  }
  return `${baseStart} to before ${baseEnd} compared with ${priorStart} to before ${priorEnd} · ${comparison.timezone}`;
}

/**
 * Build the exact persisted comparison contract for two author-selected
 * periods.  Date controls name local calendar boundaries; this helper records
 * their exact IANA-zone instants so a browser locale cannot silently change
 * the period on reload or server execution.
 */
export function buildDatasetComparison(
  descriptor: DatasetDescriptor,
  draft: DatasetComparisonDraft,
): DatasetComparisonBuildResult {
  const field = datasetComparisonTimeFields(descriptor).find((candidate) => candidate.name === draft.timeField);
  if (!field) return blocked('Choose an approved time field that supports period comparisons.');
  const grain = draft.grain.trim().toLowerCase();
  if (!SUPPORTED_GRAINS.has(grain) || !field.time?.grains.some((candidate) => candidate.toLowerCase() === grain)) {
    return blocked(`${field.name} does not support the selected comparison grain.`);
  }
  const timeRole = draft.timeRole.trim();
  if (!timeRole) return blocked('Choose the time role that this comparison uses.');
  if (!validTimeZone(draft.timezone)) return blocked('Choose a valid IANA time zone for the comparison boundaries.');
  const base = periodBounds(draft.baseStart, draft.baseEnd, draft.timezone, 'Current period');
  if (typeof base === 'string') return blocked(base);
  const comparison = periodBounds(draft.comparisonStart, draft.comparisonEnd, draft.timezone, 'Comparison period');
  if (typeof comparison === 'string') return blocked(comparison);
  return {
    status: 'ready',
    comparison: {
      version: 1,
      timeField: field.name,
      timeRole,
      calendarId: 'calendar:gregorian',
      timezone: draft.timezone,
      grain,
      completenessPolicy: draft.completenessPolicy,
      periods: [
        { id: 'current_period', kind: 'absolute', start: base.start, end: base.end },
        { id: 'comparison_period', kind: 'absolute', start: comparison.start, end: comparison.end },
      ],
      basePeriodId: 'current_period',
      comparisonPeriodIds: ['comparison_period'],
      alignment: 'calendar_period',
      outputs: ['value', 'absolute_delta', 'percent_delta'],
      zeroDenominatorPolicy: 'null',
    },
    summary: `${draft.baseStart} to before ${draft.baseEnd} compared with ${draft.comparisonStart} to before ${draft.comparisonEnd} · ${draft.timezone}`,
  };
}

/** Convert persisted exact instants back to controls in their declared zone. */
export function comparisonDateInput(value: string | undefined, timezone: string): string {
  if (!value || !validTimeZone(timezone)) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = zonedParts(date, timezone);
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

function periodBounds(start: string, end: string, timezone: string, label: string): { start: string; end: string } | string {
  const startDate = parseCalendarDate(start);
  const endDate = parseCalendarDate(end);
  if (!startDate || !endDate) return `${label} needs a start date and an exclusive end date.`;
  const startInstant = zonedStart(startDate, timezone);
  const endInstant = zonedStart(endDate, timezone);
  if (!startInstant || !endInstant || startInstant.getTime() >= endInstant.getTime()) {
    return `${label} must end after it starts.`;
  }
  return { start: startInstant.toISOString(), end: endInstant.toISOString() };
}

function parseCalendarDate(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const exact = new Date(Date.UTC(year, month - 1, day));
  if (exact.getUTCFullYear() !== year || exact.getUTCMonth() + 1 !== month || exact.getUTCDate() !== day) return undefined;
  return { year, month, day };
}

function validTimeZone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return Boolean(timezone.trim());
  } catch {
    return false;
  }
}

function zonedStart(local: { year: number; month: number; day: number }, timezone: string): Date | undefined {
  const target = Date.UTC(local.year, local.month - 1, local.day, 0, 0, 0, 0);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(new Date(guess), timezone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second, 0);
    const adjustment = target - observedAsUtc;
    guess += adjustment;
    if (adjustment === 0) {
      const exact = zonedParts(new Date(guess), timezone);
      return exact.year === local.year && exact.month === local.month && exact.day === local.day && exact.hour === 0 && exact.minute === 0 && exact.second === 0
        ? new Date(guess)
        : undefined;
    }
  }
  return undefined;
}

function zonedParts(value: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const number = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: number('year'), month: number('month'), day: number('day'),
    hour: number('hour'), minute: number('minute'), second: number('second'),
  };
}

function blocked(message: string): Extract<DatasetComparisonBuildResult, { status: 'blocked' }> {
  return { status: 'blocked', message };
}
