/**
 * "WHY DID IT MOVE?" FOR DATASET TILES (RFC 0008 step 7).
 *
 * A driver tile explains one period's change in a Dataset measure against
 * the period it is compared with. The runtime runs one governed Dataset
 * period comparison for the whole measure and one per candidate dimension;
 * this module plans those queries and folds their rows into a driver
 * analysis with the same exact-decimal contribution arithmetic the Research
 * investigation uses. No AI takes part, so every number is a governed query
 * result or plain arithmetic on one.
 */
import type { DashboardDriverDefinition, DatasetDescriptor, TileQuery, TileQueryComparison } from '@zlens/core';
import { datasetMeasureField, datasetPhysicalField, DRIVER_ALL_DIMENSIONS, MAX_DRIVER_DIMENSIONS } from '@zlens/core';
import type { DatasetPhysicalField } from '@zlens/core';
import { calendarComparisonBounds } from '../analytical-period-resolution.js';
import { absDecimal, compareDecimal, divideDecimal, formatDecimal, parseExactDecimal, percentChange, subtractDecimal, sumDecimals, type ExactDecimal } from '../analytical-execution-graph.js';
import { contributionTable, memberKey, memberLabel, type ContributionMemberInput } from '../research/investigation/contribution.js';
import type { MetricAdditivity } from '../research/investigation/types.js';

export const DRIVER_MEASURE_ALIAS = 'value';
export const DRIVER_MEMBER_ALIAS = 'member';
export const DRIVER_CURRENT_PERIOD = 'current_period';
export const DRIVER_PRIOR_PERIOD = 'comparison_period';
/** Members listed per dimension; the rest are summed into one "Other" row. */
export const DRIVER_MEMBERS_SHOWN = 6;

export interface DriverQueryPlan {
  periods: { current: { start: string; end: string }; prior: { start: string; end: string } };
  comparison: TileQueryComparison;
  total: TileQuery;
  dimensions: Array<{ field: string; label: string; query: TileQuery }>;
  /** Dimensions the Dataset cannot break this measure down by, with why. */
  skipped: Array<{ field: string; reason: string }>;
  additivity: MetricAdditivity;
  measureLabel: string;
}

export type DriverQueryPlanResult =
  | { status: 'ready'; plan: DriverQueryPlan }
  | { status: 'blocked'; reason: string };

const humanLabel = (field: string) => field.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (first) => first.toUpperCase());

/** Plan the governed queries behind a driver definition, checked against the Dataset contract. */
export function planDriverQueries(definition: DashboardDriverDefinition, descriptor: DatasetDescriptor): DriverQueryPlanResult {
  const measure = datasetMeasureField(descriptor, definition.measure);
  if (!measure || measure.status !== 'approved') return { status: 'blocked', reason: `${definition.measure} is not an approved measure of ${descriptor.label}.` };
  const time = datasetPhysicalField(descriptor, definition.timeField);
  if (!time || time.role !== 'time' || time.status !== 'approved') return { status: 'blocked', reason: `${definition.timeField} is not an approved time field of ${descriptor.label}.` };
  if (time.time?.grains?.length && !time.time.grains.some((grain) => grain.toLowerCase() === definition.grain)) {
    return { status: 'blocked', reason: `${time.name} does not support ${definition.grain} periods.` };
  }
  if (!descriptor.operations.includes('compare')) return { status: 'blocked', reason: `${descriptor.label} does not allow period comparisons.` };
  const timezone = definition.timezone ?? 'UTC';
  const bounds = calendarComparisonBounds({ anchor: definition.anchor, grain: definition.grain, timezone, comparison: definition.comparison });
  if (!bounds) return { status: 'blocked', reason: 'The period to explain is not a valid date for this grain and time zone.' };

  const comparison: TileQueryComparison = {
    version: 1,
    timeField: time.name,
    timeRole: 'event_time',
    calendarId: 'calendar:gregorian',
    timezone,
    grain: definition.grain,
    completenessPolicy: 'closed_period',
    periods: [
      { id: DRIVER_CURRENT_PERIOD, kind: 'absolute', start: bounds.current.start, end: bounds.current.end },
      { id: DRIVER_PRIOR_PERIOD, kind: 'absolute', start: bounds.prior.start, end: bounds.prior.end },
    ],
    basePeriodId: DRIVER_CURRENT_PERIOD,
    comparisonPeriodIds: [DRIVER_PRIOR_PERIOD],
    alignment: 'calendar_period',
    outputs: ['value', 'absolute_delta', 'percent_delta'],
    zeroDenominatorPolicy: 'null',
  };
  const measures = [{ measure: measure.name, alias: DRIVER_MEASURE_ALIAS }];
  const nonAdditive = new Set(measure.additivity.nonAdditiveDimensionIds ?? []);
  const dimensions: DriverQueryPlan['dimensions'] = [];
  const skipped: DriverQueryPlan['skipped'] = [];
  // "*" means the Dataset's own approved dimensions, hierarchy roots first.
  const requested = definition.dimensions.length === 1 && definition.dimensions[0] === DRIVER_ALL_DIMENSIONS
    ? descriptor.fields
      .filter((field): field is DatasetPhysicalField => field.kind === 'physical' && field.role === 'dimension' && field.status === 'approved')
      .sort((left, right) => (left.hierarchy?.level ?? 0) - (right.hierarchy?.level ?? 0))
      .slice(0, MAX_DRIVER_DIMENSIONS)
      .map((field) => field.name)
    : definition.dimensions;
  for (const fieldName of requested) {
    const field = datasetPhysicalField(descriptor, fieldName);
    if (!field || field.status !== 'approved') {
      skipped.push({ field: fieldName, reason: 'not an approved field of this Dataset' });
      continue;
    }
    if (field.role === 'time') {
      skipped.push({ field: field.name, reason: 'a time field; the periods already cover time' });
      continue;
    }
    if (nonAdditive.has(field.qualifiedId) || nonAdditive.has(field.name)) {
      skipped.push({ field: field.name, reason: `${measure.name} does not add up across it` });
      continue;
    }
    dimensions.push({
      field: field.name,
      label: humanLabel(field.name),
      query: { dimensions: [{ field: field.name, alias: DRIVER_MEMBER_ALIAS }], measures, comparison },
    });
  }
  if (dimensions.length === 0) {
    return { status: 'blocked', reason: `None of the chosen dimensions can break ${measure.name} down: ${skipped.map((entry) => `${entry.field} (${entry.reason})`).join(', ')}.` };
  }
  const additivity: MetricAdditivity = measure.aggregation === 'ratio' || (measure.numerator && measure.denominator)
    ? 'ratio'
    : measure.additivity.entities === 'additive' ? 'additive' : 'non_additive';
  return {
    status: 'ready',
    plan: {
      periods: bounds,
      comparison,
      total: { dimensions: [], measures, comparison },
      dimensions,
      skipped,
      additivity,
      measureLabel: humanLabel(measure.name),
    },
  };
}

export interface DriverMemberV1 {
  label: string;
  /** The member's own value, so a reader can drill into it exactly (absent for "Other"). */
  value?: string | number | boolean;
  /** Exact decimals as text; absent when the member has no value in the period. */
  current?: string;
  prior?: string;
  delta?: string;
  /** Signed share of the whole change (additive measures only). */
  share?: string;
  role: 'driver' | 'offset' | 'flat';
  status: 'both' | 'new' | 'gone';
  /** True for the row that sums every member not listed. */
  other?: boolean;
}

export interface DriverDimensionV1 {
  field: string;
  label: string;
  members: DriverMemberV1[];
  memberCount: number;
  /** Members add up to the headline change within tolerance. */
  reconciles: boolean;
  residual?: string;
  /** Largest member movement over all members' movement, 0..1, used to rank dimensions. */
  concentration: number;
}

export interface DriverAnalysisV1 {
  version: 1;
  measure: { field: string; label: string; additivity: MetricAdditivity };
  grain: string;
  periods: DriverQueryPlan['periods'];
  headline: { current?: string; prior?: string; delta?: string; percentDelta?: string };
  /** Ranked: the dimension whose members explain the change most sharply first. */
  dimensions: DriverDimensionV1[];
  unavailable: Array<{ field: string; reason: string; detail?: string }>;
  /** A period with no rows at all, so there is nothing to split. */
  missingPeriod?: 'current' | 'prior';
  /** One plain sentence built only from the numbers above. */
  summary: string;
}

type Rows = Array<Record<string, unknown>>;

const column = (rows: Rows, suffix: string): string | undefined => {
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  return keys.find((key) => key === `${DRIVER_MEASURE_ALIAS}${suffix}`) ?? keys.find((key) => key.endsWith(suffix));
};
const exact = (value: unknown): ExactDecimal | undefined => (value === null || value === undefined || value === '' ? undefined : parseExactDecimal(typeof value === 'number' ? String(value) : value));
const text = (value: ExactDecimal | undefined) => (value === undefined ? undefined : formatDecimal(value));

/** Fold governed comparison rows into a driver analysis. */
export function foldDriverAnalysis(input: {
  definition: DashboardDriverDefinition;
  plan: DriverQueryPlan;
  totalRows: Rows;
  dimensionResults: Array<{ field: string; rows?: Rows; error?: string }>;
}): DriverAnalysisV1 {
  const { plan } = input;
  const currentKey = column(input.totalRows, `__${DRIVER_CURRENT_PERIOD}`);
  const priorKey = column(input.totalRows, `__${DRIVER_PRIOR_PERIOD}`);
  const totalRow = input.totalRows[0] ?? {};
  const totalCurrent = currentKey ? exact(totalRow[currentKey]) : undefined;
  const totalPrior = priorKey ? exact(totalRow[priorKey]) : undefined;
  const zero = parseExactDecimal('0')!;
  const headlineDelta = totalCurrent !== undefined && totalPrior !== undefined ? subtractDecimal(totalCurrent, totalPrior) : undefined;
  const headline = {
    ...(totalCurrent !== undefined ? { current: text(totalCurrent) } : {}),
    ...(totalPrior !== undefined ? { prior: text(totalPrior) } : {}),
    ...(headlineDelta !== undefined ? { delta: text(headlineDelta) } : {}),
    ...(headlineDelta !== undefined && totalPrior !== undefined && totalPrior.coefficient !== 0n ? { percentDelta: percentChange(headlineDelta, absDecimal(totalPrior), 4) } : {}),
  };

  const unavailable: DriverAnalysisV1['unavailable'] = [...plan.skipped];
  const dimensions: DriverDimensionV1[] = [];
  // A period with no rows has no members to compare, and the breakdowns
  // fail for that reason alone. Say that once instead of per dimension.
  const missingPeriod = totalCurrent === undefined ? 'current' as const : totalPrior === undefined ? 'prior' as const : undefined;
  for (const result of missingPeriod ? [] : input.dimensionResults) {
    const planned = plan.dimensions.find((entry) => entry.field === result.field);
    if (!planned) continue;
    if (result.error || !result.rows) {
      unavailable.push({ field: result.field, reason: 'its breakdown query did not run', ...(result.error ? { detail: result.error } : {}) });
      continue;
    }
    const rows = result.rows;
    const memberCurrent = column(rows, `__${DRIVER_CURRENT_PERIOD}`);
    const memberPrior = column(rows, `__${DRIVER_PRIOR_PERIOD}`);
    const members: ContributionMemberInput[] = rows.map((row) => ({
      key: memberKey(row[DRIVER_MEMBER_ALIAS]),
      value: row[DRIVER_MEMBER_ALIAS],
      label: memberLabel(row[DRIVER_MEMBER_ALIAS]),
      ...(memberCurrent && exact(row[memberCurrent]) !== undefined ? { current: exact(row[memberCurrent]) } : {}),
      ...(memberPrior && exact(row[memberPrior]) !== undefined ? { prior: exact(row[memberPrior]) } : {}),
    }));
    const table = contributionTable({
      additivity: plan.additivity,
      members,
      totalCurrent: totalCurrent ?? zero,
      totalPrior: totalPrior ?? zero,
    });
    const shown = table.rows.slice(0, DRIVER_MEMBERS_SHOWN);
    const rest = table.rows.slice(DRIVER_MEMBERS_SHOWN);
    const listed: DriverMemberV1[] = shown.map((row) => ({
      label: row.label,
      ...(typeof row.value === 'string' || typeof row.value === 'number' || typeof row.value === 'boolean' ? { value: row.value } : {}),
      ...(row.current !== undefined ? { current: text(row.current) } : {}),
      ...(row.prior !== undefined ? { prior: text(row.prior) } : {}),
      ...(row.delta !== undefined ? { delta: text(row.delta) } : {}),
      ...(row.share !== undefined ? { share: text(row.share) } : {}),
      role: row.role,
      status: row.status,
    }));
    if (rest.length > 0 && table.additive) {
      const sum = (pick: (row: typeof rest[number]) => ExactDecimal | undefined) => sumDecimals(rest.map((row) => pick(row) ?? zero));
      const delta = sum((row) => row.delta);
      const share = headlineDelta && headlineDelta.coefficient !== 0n ? parseExactDecimal(divideDecimal(delta, headlineDelta, 12) ?? '') : undefined;
      listed.push({
        label: `Other (${rest.length})`,
        current: text(sum((row) => row.current)),
        prior: text(sum((row) => row.prior)),
        delta: text(delta),
        ...(share ? { share: text(share) } : {}),
        role: delta.coefficient === 0n ? 'flat' : headlineDelta && Math.sign(Number(delta.coefficient)) === Math.sign(Number(headlineDelta.coefficient)) ? 'driver' : 'offset',
        status: 'both',
        other: true,
      });
    }
    // How sharply one member explains the movement: the largest member
    // movement over all members' movement together. One member doing all
    // of it scores 1; many offsetting moves score low.
    const movements = table.rows.map((row) => (row.delta === undefined ? zero : absDecimal(row.delta)));
    const gross = sumDecimals(movements);
    const largest = movements.reduce((best, value) => (compareDecimal(value, best) > 0 ? value : best), zero);
    const concentration = gross.coefficient === 0n ? 0 : Number(divideDecimal(largest, gross, 6) ?? '0');
    dimensions.push({
      field: planned.field,
      label: planned.label,
      members: listed,
      memberCount: table.rows.length,
      reconciles: table.reconciles,
      ...(table.residual !== undefined && table.residual.coefficient !== 0n ? { residual: text(table.residual) } : {}),
      concentration: Number.isFinite(concentration) ? Math.min(1, concentration) : 0,
    });
  }
  dimensions.sort((left, right) => right.concentration - left.concentration || left.label.localeCompare(right.label));

  return {
    version: 1,
    measure: { field: input.definition.measure, label: plan.measureLabel, additivity: plan.additivity },
    grain: input.definition.grain,
    periods: plan.periods,
    headline,
    dimensions,
    unavailable,
    ...(missingPeriod ? { missingPeriod } : {}),
    summary: missingPeriod
      ? `There is no ${plan.measureLabel.toLowerCase()} in the ${missingPeriod === 'prior' ? 'comparison' : 'explained'} period, so there is no change to split.`
      : driverSummary(plan.measureLabel, headline, dimensions[0]),
  };
}

function driverSummary(measure: string, headline: DriverAnalysisV1['headline'], top: DriverDimensionV1 | undefined): string {
  const delta = parseExactDecimal(headline.delta ?? '');
  if (!delta) return `${measure} could not be compared across the two periods.`;
  if (delta.coefficient === 0n) return `${measure} did not change between the two periods.`;
  const direction = delta.coefficient > 0n ? 'rose' : 'fell';
  const lead = top?.members.find((member) => member.role === 'driver' && !member.other);
  if (!top || !lead?.delta) return `${measure} ${direction} by ${formatDecimal(absDecimal(delta))}.`;
  const share = lead.share !== undefined ? Math.round(Math.abs(Number(lead.share)) * 100) : undefined;
  const leadDelta = parseExactDecimal(lead.delta);
  const signed = leadDelta ? `${compareDecimal(leadDelta, parseExactDecimal('0')!) >= 0 ? '+' : '−'}${formatDecimal(absDecimal(leadDelta))}` : lead.delta;
  return `${measure} ${direction} by ${formatDecimal(absDecimal(delta))}. The largest move was ${lead.label} (${top.label.toLowerCase()}): ${signed}${share !== undefined ? `, ${share}% of the change` : ''}.`;
}

/** Synthetic tile ids the runtime uses for a driver tile's governed queries. */
export const driverTotalTileId = (tileId: string) => `${tileId}::driver::total`;
export const driverDimensionTileId = (tileId: string, field: string) => `${tileId}::driver::${field}`;
export const isDriverExecutionTileId = (tileId: string) => tileId.includes('::driver::');

