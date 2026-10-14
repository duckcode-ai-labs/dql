import {
  datasetMeasureField,
  datasetPhysicalField,
  type AppAnalyticalContextV1,
  type DatasetDescriptor,
  type DatasetMeasureField,
  type DatasetPhysicalField,
  type TileQuery,
} from '@zlens/core';

/**
 * App Autopilot may receive a compact, server-derived analytical fact set for
 * one already-validated chart. This is deliberately stricter than a chart
 * renderer: it never serializes result rows, does not derive values from
 * arbitrary numeric columns, and declines shapes it cannot describe without
 * claiming more coverage than the saved preview proves.
 */
export const DATASET_CHART_FACT_MAX_GROUPS = 12;
export const DATASET_CHART_FACT_MAX_MEASURES = 3;
const MAX_GROUP_LABEL_LENGTH = 120;
const MAX_DECIMAL_DIGITS = 48;
const MAX_DECIMAL_SCALE = 12;

export type DatasetChartFactCoverage =
  | 'empty'
  | 'scalar'
  | 'complete_grouped'
  | 'incomplete'
  | 'too_large'
  | 'unsupported_shape'
  | 'unsafe_group'
  | 'unavailable';

export interface DatasetChartFactSummary {
  version: 1;
  coverage: DatasetChartFactCoverage;
  /** Provider-safe prose facts. It never contains a result-row object. */
  text: string;
  groupCount?: number;
  derivedRollupMeasures: string[];
}

interface SelectedMeasure {
  alias: string;
  measure: DatasetMeasureField;
}

interface BoundedDecimal {
  coefficient: bigint;
  scale: number;
  text: string;
}

/**
 * Describe a settled Dataset result with a small complete fact set. A grouped
 * subtotal is permitted only when the selected measure's declared aggregation
 * and declared additivity prove the rollup for this grouping axis. For a
 * limited chart it remains a subtotal of the displayed groups, never a claim
 * about all source rows.
 */
export function summarizeDatasetChartFacts(
  context: AppAnalyticalContextV1,
  descriptor: DatasetDescriptor | undefined,
): DatasetChartFactSummary {
  if (!descriptor) {
    return unavailable('Coverage unavailable: the current result no longer has a matching governed Dataset contract. No analytical values are supplied.');
  }
  const { rows, rowCount } = context.result;
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    return unavailable('Coverage unavailable: the settled chart does not report a bounded materialized group count. No analytical values are supplied.');
  }
  if (rowCount === 0) {
    return { version: 1, coverage: 'empty', text: 'The settled chart has no materialized groups for its current filter scope.', derivedRollupMeasures: [] };
  }
  if (rows.length !== rowCount) {
    return incomplete(`Coverage is incomplete: ${rows.length} of ${rowCount} materialized chart groups are retained. No grouped facts or rollups are supplied.`);
  }
  if (rowCount > DATASET_CHART_FACT_MAX_GROUPS) {
    return tooLarge(`Coverage is bounded to at most ${DATASET_CHART_FACT_MAX_GROUPS} chart groups; this result has ${rowCount}. No grouped facts or rollups are supplied.`);
  }
  if (context.interactionQueryFingerprint) {
    return unsupported('Coverage is limited: this is an interaction result whose effective grouping is not the saved Dataset query. No grouped facts or rollups are supplied.');
  }
  const query = context.authoredQuery;
  if (query.detail) {
    return unsupported('Coverage is limited: bounded detail results are not converted into App Autopilot analytical facts.');
  }
  if (query.comparison) {
    return unsupported('Coverage is limited: comparison outputs are not recomputed or rolled up by App Autopilot.');
  }
  const measures = selectedMeasures(descriptor, query);
  if (!measures || measures.length === 0 || measures.length > DATASET_CHART_FACT_MAX_MEASURES) {
    return unsupported(`Coverage is limited: this chart does not have between one and ${DATASET_CHART_FACT_MAX_MEASURES} current approved measures for a bounded fact summary.`);
  }
  if (query.dimensions.length === 0) return scalarFacts(rows[0]!, measures);
  if (query.dimensions.length !== 1) {
    return unsupported('Coverage is limited: App Autopilot only expands one approved grouping dimension at a time. No grouped facts or rollups are supplied.');
  }
  return groupedFacts({ context, descriptor, query, measures });
}

function scalarFacts(row: Record<string, unknown>, measures: SelectedMeasure[]): DatasetChartFactSummary {
  const facts = measures.flatMap(({ alias, measure }) => {
    const value = boundedMeasureValue(row[alias]);
    return value === undefined ? [] : [`${measure.name} = ${value.text}`];
  });
  if (facts.length !== measures.length) {
    return unavailable('Coverage unavailable: one or more selected aggregate values are missing or not a bounded numeric value. No analytical values are supplied.');
  }
  return {
    version: 1,
    coverage: 'scalar',
    text: `Exact settled aggregate fact${facts.length === 1 ? '' : 's'}: ${facts.join(', ')}. These are reported chart values, not a recomputation.`,
    derivedRollupMeasures: [],
  };
}

function groupedFacts(input: {
  context: AppAnalyticalContextV1;
  descriptor: DatasetDescriptor;
  query: TileQuery;
  measures: SelectedMeasure[];
}): DatasetChartFactSummary {
  const selection = input.query.dimensions[0]!;
  const field = datasetPhysicalField(input.descriptor, selection.field);
  if (!isSafeFactGroup(field)) {
    return unsafeGroup('Coverage withheld: the selected grouping is not one approved time or dimension field. Key, attribute, and unrecognized group labels are not supplied to App Autopilot.');
  }
  const groupAlias = selection.alias ?? (selection.timeGrain ? `${field.name}_${selection.timeGrain}` : field.name);
  const expectedColumns = new Set([groupAlias, ...input.measures.map(({ alias }) => alias)]);
  if (![...expectedColumns].every((column) => input.context.result.columns.includes(column))) {
    return unavailable('Coverage unavailable: the saved Dataset query outputs no longer match the settled chart schema. No grouped facts or rollups are supplied.');
  }

  const facts: Array<{ group: string; values: Array<{ selected: SelectedMeasure; value: BoundedDecimal | null }> }> = [];
  for (const row of input.context.result.rows) {
    const group = boundedGroupValue(row[groupAlias]);
    if (group === undefined) {
      return unsafeGroup('Coverage withheld: at least one selected group label is not a bounded scalar value. No grouped facts or rollups are supplied.');
    }
    const values: Array<{ selected: SelectedMeasure; value: BoundedDecimal | null }> = [];
    for (const selected of input.measures) {
      const raw = row[selected.alias];
      if (raw === undefined) {
        return unavailable('Coverage unavailable: at least one selected measure is missing from a materialized chart group. No grouped facts or rollups are supplied.');
      }
      const value = boundedMeasureValue(raw);
      if (raw !== null && !value) {
        return unavailable('Coverage unavailable: at least one selected measure is not a bounded numeric value. No grouped facts or rollups are supplied.');
      }
      values.push({ selected, value: value ?? null });
    }
    facts.push({ group, values });
  }

  const groupFacts = facts.map(({ group, values }) => `${groupAlias} = ${group}: ${values
    .map(({ selected, value }) => `${selected.measure.name} = ${value?.text ?? 'unavailable'}`)
    .join(', ')}`);
  const totalLength = groupFacts.reduce((length, fact) => length + fact.length, 0);
  if (totalLength > 2_400) {
    return tooLarge('Coverage is bounded: the approved group labels or values exceed the App Autopilot fact-size limit. No grouped facts or rollups are supplied.');
  }

  const rollups = input.measures.flatMap((selected) => {
    if (!mayRollUpSelectedMeasure(selected.measure, field, selection, input.descriptor)) return [];
    const values = facts.map(({ values }) => values.find((entry) => entry.selected.alias === selected.alias)?.value);
    if (values.some((value) => !value)) return [];
    const total = sumBoundedDecimals(values as BoundedDecimal[]);
    return total ? [{ measure: selected.measure.name, value: total }] : [];
  });
  const boundedNotice = input.query.limit === undefined
    ? 'The facts cover every materialized chart group in this settled preview.'
    : 'The saved query bounds the displayed group set; facts and any subtotal cover only those displayed groups, not an unbounded Dataset total.';
  const rollupText = rollups.length > 0
    ? ` Safe additive subtotal across these displayed groups: ${rollups.map((rollup) => `${rollup.measure} = ${rollup.value}`).join(', ')}.`
    : '';
  return {
    version: 1,
    coverage: 'complete_grouped',
    text: `Complete bounded grouped facts (${facts.length} groups): ${groupFacts.join('; ')}. ${boundedNotice}${rollupText}`,
    groupCount: facts.length,
    derivedRollupMeasures: rollups.map((rollup) => rollup.measure),
  };
}

function selectedMeasures(descriptor: DatasetDescriptor, query: TileQuery): SelectedMeasure[] | undefined {
  const aliases = new Set<string>();
  const selected: SelectedMeasure[] = [];
  for (const selection of query.measures) {
    const measure = datasetMeasureField(descriptor, selection.measure);
    const alias = selection.alias ?? measure?.name;
    if (!measure || !alias || aliases.has(alias.toLowerCase())) return undefined;
    aliases.add(alias.toLowerCase());
    selected.push({ alias, measure });
  }
  return selected;
}

function isSafeFactGroup(field: DatasetPhysicalField | undefined): field is DatasetPhysicalField {
  return Boolean(field && field.status === 'approved' && (field.role === 'time' || field.role === 'dimension'));
}

function boundedGroupValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return 'unavailable';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_GROUP_LABEL_LENGTH && !/[\u0000-\u001F\u007F]/.test(normalized)
    ? normalized
    : undefined;
}

function boundedMeasureValue(value: unknown): BoundedDecimal | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = typeof value === 'number'
    ? Number.isFinite(value) ? String(value) : ''
    : typeof value === 'bigint'
      ? value.toString()
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (!raw || raw.length > MAX_DECIMAL_DIGITS || !/^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/.test(raw)) return undefined;
  const negative = raw.startsWith('-');
  const unsigned = raw.replace(/^[+-]/, '');
  const [integerPart, fractionalPart = ''] = unsigned.split('.');
  if (fractionalPart.length > MAX_DECIMAL_SCALE) return undefined;
  const integer = (integerPart || '0').replace(/^0+(?=\d)/, '') || '0';
  const fractional = fractionalPart.replace(/0+$/, '');
  const scale = fractional.length;
  const digits = `${integer}${fractional || ''}`.replace(/^0+(?=\d)/, '') || '0';
  const coefficient = BigInt(`${negative ? '-' : ''}${digits}`);
  const text = decimalText(coefficient, scale);
  return { coefficient, scale, text };
}

function sumBoundedDecimals(values: BoundedDecimal[]): string | undefined {
  if (values.length === 0) return undefined;
  const scale = Math.max(...values.map((value) => value.scale));
  const coefficient = values.reduce((total, value) => total + value.coefficient * (10n ** BigInt(scale - value.scale)), 0n);
  return decimalText(coefficient, scale);
}

function decimalText(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  const integer = digits.slice(0, -scale) || '0';
  const fractional = digits.slice(-scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fractional ? `.${fractional}` : ''}`;
}

function mayRollUpSelectedMeasure(
  measure: DatasetMeasureField,
  field: DatasetPhysicalField,
  selection: TileQuery['dimensions'][number],
  descriptor: DatasetDescriptor,
): boolean {
  if (measure.aggregation !== 'sum' && measure.aggregation !== 'count') return false;
  // Resolve each contract identity through the canonical Dataset lookup so a
  // declaration may use either the stable qualified ID or its display name.
  // A per-dimension non-additivity declaration is stricter than the broad
  // entity/time axis flag and must always prevent a local subtotal.
  if ((measure.additivity.nonAdditiveDimensionIds ?? []).some((dimensionId) => (
    datasetPhysicalField(descriptor, dimensionId)?.qualifiedId === field.qualifiedId
  ))) return false;
  const timeAxis = Boolean(selection.timeGrain) || field.role === 'time';
  const declaredAdditivity = timeAxis ? measure.additivity.time : measure.additivity.entities;
  if (declaredAdditivity !== 'additive') return false;
  // An aggregate Dataset needs the same declared axis proof before a local
  // chart subtotal is stated. The compiler already validates the saved query;
  // this second check keeps the narrative path fail-closed if contracts drift.
  if (descriptor.grain.aggregate && timeAxis && descriptor.grain.timeGrain && measure.additivity.time !== 'additive') return false;
  return true;
}

function unavailable(text: string): DatasetChartFactSummary {
  return { version: 1, coverage: 'unavailable', text, derivedRollupMeasures: [] };
}

function incomplete(text: string): DatasetChartFactSummary {
  return { version: 1, coverage: 'incomplete', text, derivedRollupMeasures: [] };
}

function tooLarge(text: string): DatasetChartFactSummary {
  return { version: 1, coverage: 'too_large', text, derivedRollupMeasures: [] };
}

function unsupported(text: string): DatasetChartFactSummary {
  return { version: 1, coverage: 'unsupported_shape', text, derivedRollupMeasures: [] };
}

function unsafeGroup(text: string): DatasetChartFactSummary {
  return { version: 1, coverage: 'unsafe_group', text, derivedRollupMeasures: [] };
}
