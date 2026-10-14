import type { AnalyticalPeriodV2, AnalyticalQuestionFrameV2 } from '@zlens/core';

/** Snapshot-bound freshness observation supplied by an authorized runtime. */
export interface AnalyticalFreshnessObservationV1 {
  version: 1;
  snapshotId: string;
  metricId: string;
  timeDimensionId: string;
  /** Maximum governed event/reporting instant visible to the selected route. */
  observedThrough: string;
  observedAt?: string;
}

export interface AnalyticalFreshnessRequestV1 {
  version: 1;
  snapshotId: string;
  metricId: string;
  timeDimensionId: string;
  observedThroughFieldId?: string;
  /**
   * Exact adapter members resolved from the immutable plan and pinned registry.
   * The host may execute this bounded lookup, but must not search, rematch, or
   * change the selected metric/time route. Acceptance: AGT-019, SEC-004.
   */
  authorizedAdapterRequest?: {
    route: 'semantic';
    metric: string;
    timeDimension: string;
    granularity: string;
    outputField: string;
  };
}

export type ResolveAnalyticalPeriodsResult =
  | {
      status: 'resolved';
      frame: AnalyticalQuestionFrameV2;
      asOf: string;
      freshnessObservation?: AnalyticalFreshnessObservationV1;
    }
  | {
      status: 'blocked';
      code:
        | 'TIME_CONTEXT_REQUIRED'
        | 'TIME_POLICY_INCOMPLETE'
        | 'FRESHNESS_REQUIRED'
        | 'FRESHNESS_MISMATCH'
        | 'UNSUPPORTED_CALENDAR'
        | 'UNSUPPORTED_TIME_GRAIN'
        | 'EXPLICIT_PERIOD_BOUNDS_REQUIRED'
        | 'INVALID_TIME_INSTANT';
      reason: string;
    };

/**
 * Resolve relative analytical periods without interpreting prose or choosing a
 * time dimension. Meaning is already frozen in the frame; this function only
 * binds governed temporal policy to concrete start-inclusive/end-exclusive
 * instants. Acceptance: AGT-017, AGT-019, E2E-013.
 */
export function resolveAnalyticalPeriods(input: {
  frame: AnalyticalQuestionFrameV2;
  snapshotId: string;
  referenceInstant: string;
  freshnessObservation?: AnalyticalFreshnessObservationV1;
}): ResolveAnalyticalPeriodsResult {
  const time = input.frame.timeContext;
  if (!time) return { status: 'resolved', frame: structuredClone(input.frame), asOf: input.referenceInstant };
  if (!time.timeDimensionId || !time.timeRole || !time.calendarId || !time.timezone || !time.grain || !time.completenessPolicy) {
    return { status: 'blocked', code: 'TIME_POLICY_INCOMPLETE', reason: 'Relative periods require an exact time dimension, role, calendar, timezone, grain, and completeness policy.' };
  }
  if (!['calendar:gregorian', 'gregorian'].includes(time.calendarId.toLowerCase())) {
    return { status: 'blocked', code: 'UNSUPPORTED_CALENDAR', reason: `Calendar ${time.calendarId} requires a configured calendar adapter.` };
  }
  if (!['day', 'week', 'month', 'quarter', 'year'].includes(time.grain.toLowerCase())) {
    return { status: 'blocked', code: 'UNSUPPORTED_TIME_GRAIN', reason: `Time grain ${time.grain} is not supported by the Gregorian period resolver.` };
  }
  const reference = parseInstant(input.referenceInstant);
  if (!reference) return { status: 'blocked', code: 'INVALID_TIME_INSTANT', reason: 'The analytical reference instant is invalid.' };

  const needsFreshness = time.periods.some((period) => !period.start || !period.end)
    && time.completenessPolicy !== 'partial_current';
  const freshness = input.freshnessObservation;
  if (needsFreshness && !freshness) {
    return { status: 'blocked', code: 'FRESHNESS_REQUIRED', reason: 'Latest-complete and closed-period execution require a snapshot-bound freshness observation.' };
  }
  if (
    freshness
    && (freshness.version !== 1
      || freshness.snapshotId !== input.snapshotId
      || freshness.metricId !== input.frame.metricConceptIds[0]
      || freshness.timeDimensionId !== time.timeDimensionId)
  ) {
    return { status: 'blocked', code: 'FRESHNESS_MISMATCH', reason: 'The freshness observation does not match the selected snapshot, metric, and time dimension.' };
  }
  const observedThrough = freshness ? parseInstant(freshness.observedThrough) : undefined;
  if (freshness && !observedThrough) {
    return { status: 'blocked', code: 'INVALID_TIME_INSTANT', reason: 'The freshness observation instant is invalid.' };
  }

  const resolved = new Map<string, AnalyticalPeriodV2>();
  for (const period of time.periods) {
    if (period.start && period.end) {
      if (!parseInstant(period.start) || !parseInstant(period.end)) {
        return { status: 'blocked', code: 'INVALID_TIME_INSTANT', reason: `Period ${period.id} contains an invalid bound.` };
      }
      resolved.set(period.id, { ...period });
      continue;
    }
    if (period.kind === 'absolute') {
      return { status: 'blocked', code: 'EXPLICIT_PERIOD_BOUNDS_REQUIRED', reason: `Absolute period ${period.id} requires explicit bounds.` };
    }
    if (period.kind === 'previous_year' || period.kind === 'previous_period') continue;
    const bounds = currentBounds({
      reference,
      observedThrough,
      timezone: time.timezone,
      grain: time.grain,
      completenessPolicy: time.completenessPolicy,
    });
    resolved.set(period.id, { ...period, start: bounds.start.toISOString(), end: bounds.end.toISOString() });
  }

  for (const period of time.periods) {
    if (resolved.has(period.id)) continue;
    const alignedId = period.alignToPeriodId ?? input.frame.comparison?.basePeriodId;
    const aligned = alignedId ? resolved.get(alignedId) : undefined;
    if (!aligned?.start || !aligned.end) {
      return { status: 'blocked', code: 'EXPLICIT_PERIOD_BOUNDS_REQUIRED', reason: `Period ${period.id} has no resolved alignment period.` };
    }
    const start = parseInstant(aligned.start)!;
    const end = parseInstant(aligned.end)!;
    const shifted = period.kind === 'previous_year'
      ? shiftZonedYears(start, end, time.timezone, -1)
      : previousPeriod(start, end, time.timezone, time.grain);
    resolved.set(period.id, { ...period, start: shifted.start.toISOString(), end: shifted.end.toISOString() });
  }

  const frame = structuredClone(input.frame);
  frame.timeContext!.periods = time.periods.map((period) => resolved.get(period.id)!);
  const baseId = input.frame.comparison?.basePeriodId ?? time.periods[0]?.id;
  const base = baseId ? resolved.get(baseId) : undefined;
  return {
    status: 'resolved',
    frame,
    asOf: base?.end ?? input.referenceInstant,
    ...(freshness ? { freshnessObservation: { ...freshness } } : {}),
  };
}

function currentBounds(input: {
  reference: Date;
  observedThrough?: Date;
  timezone: string;
  grain: string;
  completenessPolicy: 'partial_current' | 'latest_complete' | 'closed_period';
}): { start: Date; end: Date } {
  if (input.completenessPolicy === 'partial_current') {
    const local = zonedDate(input.reference, input.timezone);
    return { start: startOfGrain(local, input.grain, input.timezone), end: input.reference };
  }

  const observed = input.observedThrough!;
  const completeDate = latestCompleteLocalDate(observed, input.timezone);
  if (input.completenessPolicy === 'latest_complete') {
    if (input.grain === 'day') {
      return {
        start: zonedStart(completeDate, input.timezone),
        end: zonedStart(addLocalDays(completeDate, 1), input.timezone),
      };
    }
    return {
      start: startOfGrain(completeDate, input.grain, input.timezone),
      end: zonedStart(addLocalDays(completeDate, 1), input.timezone),
    };
  }

  const currentStart = startOfGrain(completeDate, input.grain, input.timezone);
  const currentEnd = endOfGrain(completeDate, input.grain, input.timezone);
  if (currentEnd.getTime() <= observed.getTime()) return { start: currentStart, end: currentEnd };
  const previousDate = addLocalDays(zonedDate(currentStart, input.timezone), -1);
  return {
    start: startOfGrain(previousDate, input.grain, input.timezone),
    end: endOfGrain(previousDate, input.grain, input.timezone),
  };
}

interface LocalDate { year: number; month: number; day: number }

function latestCompleteLocalDate(observedThrough: Date, timezone: string): LocalDate {
  const local = zonedDate(observedThrough, timezone);
  const nextStart = zonedStart(addLocalDays(local, 1), timezone);
  return nextStart.getTime() <= observedThrough.getTime() ? local : addLocalDays(local, -1);
}

function startOfGrain(local: LocalDate, grain: string, timezone: string): Date {
  if (grain === 'day') return zonedStart(local, timezone);
  if (grain === 'week') {
    const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
    return zonedStart(addLocalDays(local, -(weekday === 0 ? 6 : weekday - 1)), timezone);
  }
  if (grain === 'month') return zonedStart({ ...local, day: 1 }, timezone);
  if (grain === 'quarter') return zonedStart({ year: local.year, month: Math.floor((local.month - 1) / 3) * 3 + 1, day: 1 }, timezone);
  return zonedStart({ year: local.year, month: 1, day: 1 }, timezone);
}

function endOfGrain(local: LocalDate, grain: string, timezone: string): Date {
  const start = zonedDate(startOfGrain(local, grain, timezone), timezone);
  if (grain === 'day') return zonedStart(addLocalDays(start, 1), timezone);
  if (grain === 'week') return zonedStart(addLocalDays(start, 7), timezone);
  if (grain === 'month') return zonedStart(addLocalMonths(start, 1), timezone);
  if (grain === 'quarter') return zonedStart(addLocalMonths(start, 3), timezone);
  return zonedStart({ year: start.year + 1, month: 1, day: 1 }, timezone);
}

function previousPeriod(start: Date, end: Date, timezone: string, grain: string): { start: Date; end: Date } {
  const localStart = zonedDate(start, timezone);
  if (grain === 'day') return { start: zonedStart(addLocalDays(localStart, -1), timezone), end: start };
  if (grain === 'week') return { start: zonedStart(addLocalDays(localStart, -7), timezone), end: start };
  if (grain === 'month') return { start: zonedStart(addLocalMonths(localStart, -1), timezone), end: start };
  if (grain === 'quarter') return { start: zonedStart(addLocalMonths(localStart, -3), timezone), end: start };
  return shiftZonedYears(start, end, timezone, -1);
}

function shiftZonedYears(start: Date, end: Date, timezone: string, years: number): { start: Date; end: Date } {
  const shift = (instant: Date): Date => {
    const local = zonedDate(instant, timezone);
    const targetYear = local.year + years;
    const day = Math.min(local.day, daysInMonth(targetYear, local.month));
    const time = zonedTime(instant, timezone);
    return zonedInstant({ year: targetYear, month: local.month, day }, time, timezone);
  };
  return { start: shift(start), end: shift(end) };
}

function zonedDate(value: Date, timezone: string): LocalDate {
  const parts = zonedParts(value, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function zonedTime(value: Date, timezone: string): { hour: number; minute: number; second: number; millisecond: number } {
  const parts = zonedParts(value, timezone);
  return { hour: parts.hour, minute: parts.minute, second: parts.second, millisecond: value.getUTCMilliseconds() };
}

function zonedParts(value: Date, timezone: string): LocalDate & { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const number = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)!.value);
  return { year: number('year'), month: number('month'), day: number('day'), hour: number('hour'), minute: number('minute'), second: number('second') };
}

function zonedStart(local: LocalDate, timezone: string): Date {
  return zonedInstant(local, { hour: 0, minute: 0, second: 0, millisecond: 0 }, timezone);
}

function zonedInstant(local: LocalDate, time: { hour: number; minute: number; second: number; millisecond: number }, timezone: string): Date {
  const target = Date.UTC(local.year, local.month - 1, local.day, time.hour, time.minute, time.second, time.millisecond);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = zonedParts(new Date(guess), timezone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second, time.millisecond);
    const adjustment = target - observedAsUtc;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(guess);
}

function addLocalDays(local: LocalDate, days: number): LocalDate {
  const value = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function addLocalMonths(local: LocalDate, months: number): LocalDate {
  const value = new Date(Date.UTC(local.year, local.month - 1 + months, 1));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: Math.min(local.day, daysInMonth(value.getUTCFullYear(), value.getUTCMonth() + 1)) };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseInstant(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

const CALENDAR_GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year']);

/**
 * Exact start-inclusive/end-exclusive instants for the period that contains
 * `anchor` (a local calendar date, YYYY-MM-DD) and the period it is compared
 * with, in `timezone`. Used where a person picked the period, such as the
 * last point on a trend chart (RFC 0008 step 7).
 */
export function calendarComparisonBounds(input: {
  anchor: string;
  grain: string;
  timezone: string;
  comparison: 'previous_period' | 'previous_year';
}): { current: { start: string; end: string }; prior: { start: string; end: string } } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.anchor.trim());
  const grain = input.grain.trim().toLowerCase();
  if (!match || !CALENDAR_GRAINS.has(grain)) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
  } catch {
    return undefined;
  }
  const local = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (local.month < 1 || local.month > 12 || local.day < 1 || local.day > daysInMonth(local.year, local.month)) return undefined;
  const start = startOfGrain(local, grain, input.timezone);
  const end = endOfGrain(local, grain, input.timezone);
  const prior = input.comparison === 'previous_year'
    ? shiftZonedYears(start, end, input.timezone, -1)
    : previousPeriod(start, end, input.timezone, grain);
  return {
    current: { start: start.toISOString(), end: end.toISOString() },
    prior: { start: prior.start.toISOString(), end: prior.end.toISOString() },
  };
}
