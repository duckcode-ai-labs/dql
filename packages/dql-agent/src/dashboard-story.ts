import type {
  DashboardDisplayTrustState,
  DashboardStoryBrief,
  DashboardStoryClaim,
  DashboardStoryFact,
} from '@duckcodeailabs/dql-core';
import { computeResultStats } from './synthesize.js';

export interface DashboardStoryTileResult {
  tileId: string;
  title: string;
  status: string;
  trustState?: DashboardDisplayTrustState;
  grain?: string;
  result?: {
    columns?: unknown[];
    rows?: unknown[];
    rowCount?: number;
    columnsMeta?: Array<{ name?: unknown; kind?: unknown; unit?: unknown; decimals?: unknown }>;
  };
  /**
   * Dataset tiles declare whether their rows are a whole-scope scalar or
   * observations at a selected grain. This prevents the story generator from
   * reaggregating ratios, distinct counts, or a limited Top-N result.
   */
  datasetScope?: {
    kind: 'whole_scope' | 'grouped_observations';
    /**
     * The selected output aliases for grouped dimensions. These are a
     * presentation contract, so a time selection such as `order_date` at
     * month grain correctly resolves the returned `order_date_month` column.
     */
    outputDimensionAliases?: string[];
    dimensions: string[];
    limited?: boolean;
  };
  /** The actual dashboard controls that reached this tile's result. */
  filters?: Record<string, unknown>;
  citation?: { kind?: string; name?: string; path?: string };
}

export interface DashboardStoryBuildInput {
  goal: string;
  audience?: string;
  filters: Record<string, unknown>;
  tiles: DashboardStoryTileResult[];
  eligibleTileIds?: string[];
  driverTileIds?: string[];
}

export interface DashboardStoryBuildResult {
  facts: DashboardStoryFact[];
  story: DashboardStoryBrief;
}

const TRUST_ORDER: Record<DashboardDisplayTrustState, number> = {
  certified: 3,
  review_required: 2,
  draft_ready: 1,
};

export function buildDeterministicDashboardStory(input: DashboardStoryBuildInput): DashboardStoryBuildResult {
  const eligible = new Set(input.eligibleTileIds ?? input.tiles.map((tile) => tile.tileId));
  const drivers = new Set(input.driverTileIds ?? []);
  const facts: DashboardStoryFact[] = [];
  for (const tile of input.tiles) {
    if (!eligible.has(tile.tileId) || tile.status !== 'ok' || !tile.result) continue;
    const columns = (tile.result.columns ?? []).map((column) => typeof column === 'string' ? column : String((column as { name?: unknown })?.name ?? column));
    const rows = (tile.result.rows ?? []).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
    if (columns.length === 0 || rows.length === 0) continue;
    const stats = computeResultStats(columns, rows);
    const trustState = tile.trustState ?? 'review_required';
    const tileFilters = tile.filters ?? input.filters;
    const evidenceRef = tile.citation?.path ?? `${tile.citation?.kind ?? 'dashboard'}:${tile.citation?.name ?? tile.tileId}`;
    const first = rows[0] ?? {};
    const labelColumn = columns.find((column) => typeof first[column] === 'string');
    const numericStats = stats.filter((stat) => stat.kind === 'numeric');
    const columnMeta = new Map((tile.result.columnsMeta ?? [])
      .filter((meta): meta is { name: string; kind?: unknown; unit?: unknown; decimals?: unknown } => typeof meta?.name === 'string')
      .map((meta) => [meta.name, meta]));
    const observedGroups = tile.datasetScope?.kind === 'grouped_observations';
    if (observedGroups) {
      // A Dataset row at a declared dimension is evidence *at that dimension*.
      // Never turn rows such as monthly COUNT DISTINCT or ratio-of-sums into a
      // dashboard-wide total by summing display results. Keep the small set of
      // observations visibly group-qualified instead.
      const observationRows = rows.slice(0, 2);
      const declaredGroupColumn = resolveDeclaredGroupColumn(
        columns,
        tile.datasetScope?.outputDimensionAliases ?? tile.datasetScope?.dimensions ?? [],
      );
      for (const stat of numericStats.slice(0, 2)) {
        const unit = storyFormatUnit(columnMeta.get(stat.column));
        for (let index = 0; index < observationRows.length; index += 1) {
          const row = observationRows[index]!;
          const value = numericValue(row[stat.column]);
          if (value === undefined) continue;
          const groupColumn = declaredGroupColumn ?? labelColumn;
          const group = groupColumn && row[groupColumn] !== undefined
            ? formatGroupValue(row[groupColumn])
            : `returned group ${index + 1}`;
          facts.push({
            id: `${tile.tileId}:observation:${stat.column}:${index + 1}`,
            tileId: tile.tileId,
            kind: drivers.has(tile.tileId) ? 'driver' : 'value',
            label: `${tile.title} — ${humanize(stat.column)} for ${group}`,
            value,
            unit,
            grain: tile.grain ?? `grouped by ${tile.datasetScope?.dimensions.map(humanize).join(', ') || 'Dataset dimension'}${tile.datasetScope?.limited ? ' (limited result)' : ''}`,
            filters: tileFilters,
            evidenceRef,
            trustState,
          });
        }
      }
      continue;
    }
    for (const stat of numericStats.slice(0, 2)) {
      const singleValue = rows.length === 1 && typeof first[stat.column] === 'number' ? first[stat.column] as number : undefined;
      facts.push({
        id: `${tile.tileId}:value:${stat.column}`,
        tileId: tile.tileId,
        kind: drivers.has(tile.tileId) ? 'driver' : 'value',
        label: `${tile.title} — ${humanize(stat.column)}`,
        value: singleValue ?? stat.sum ?? null,
        unit: storyFormatUnit(columnMeta.get(stat.column)),
        grain: tile.grain,
        filters: tileFilters,
        evidenceRef,
        trustState,
      });
    }
    const numericColumn = numericStats[0]?.column;
    if (labelColumn && numericColumn && first[labelColumn] !== undefined && first[numericColumn] !== undefined) {
      facts.push({
        id: `${tile.tileId}:rank:1`,
        tileId: tile.tileId,
        kind: 'rank',
        label: `${tile.title} leader`,
        value: `${String(first[labelColumn])}: ${formatValue(first[numericColumn], storyFormatUnit(columnMeta.get(numericColumn)))}`,
        grain: tile.grain,
        filters: tileFilters,
        evidenceRef,
        trustState,
      });
    }
  }
  // A selected page control can intentionally exclude a component. Preserve
  // that tile's complete-source fact, but never narrate it as if it carried
  // the global filter values used by other components.
  const scopedFacts = facts.filter((fact) => sameDashboardFilterScope(fact.filters ?? {}, input.filters));
  const hasScopeExclusions = scopedFacts.length !== facts.length;
  const trustState = scopedFacts.reduce<DashboardDisplayTrustState>(
    (least, fact) => TRUST_ORDER[fact.trustState] < TRUST_ORDER[least] ? fact.trustState : least,
    'certified',
  );
  const scope = filterScope(input.filters);
  const primary = scopedFacts.slice(0, 3);
  const supporting = scopedFacts.slice(3, 6);
  const headline = primary.length
    ? `${humanize(input.goal).replace(/[?.!]+$/, '')}: the current picture`
    : `No result is available yet for ${humanize(input.goal).replace(/[?.!]+$/, '')}`;
  const firstParagraph = primary.length
    ? `For ${scope}, the clearest signals are ${joinFacts(primary)}. These figures come from tiles with this exact filter scope, so the summary and visible results stay aligned when filters change.`
    : `The dashboard did not return enough governed evidence to summarize ${scope}. Apply a different filter range or review the unavailable sections before using this view for a decision.`;
  const driverFacts = scopedFacts.filter((fact) => fact.kind === 'driver');
  const secondParagraph = supporting.length
    ? `${joinFacts(supporting)} add context across the rest of the view. ${driverFacts.length ? `The supported driver evidence points to ${joinFacts(driverFacts.slice(0, 2))}.` : 'The current view shows association and ranking, but it does not prove why the pattern occurred.'}`
    : `The available evidence is concentrated in ${primary.length === 1 ? 'one business signal' : 'a small set of signals'}. Use Research deeper for a validated baseline or driver breakdown before describing the pattern as a cause.`;
  const claims: DashboardStoryClaim[] = [];
  if (primary.length) claims.push({ text: firstParagraph, factIds: primary.map((fact) => fact.id), kind: 'observation' });
  if (supporting.length) claims.push({
    text: secondParagraph,
    factIds: Array.from(new Set([...supporting, ...(driverFacts.length ? driverFacts.slice(0, 2) : [])].map((fact) => fact.id))),
    kind: driverFacts.length ? 'driver' : 'observation',
  });
  return {
    facts,
    story: {
      headline,
      paragraphs: [firstParagraph, secondParagraph],
      implication: scopedFacts.length ? 'Use this view to focus the next decision on the strongest verified signal, then open the supporting evidence before acting.' : undefined,
      caveat: [
        driverFacts.length === 0 && scopedFacts.length > 0 ? 'This view does not contain validated causal evidence.' : undefined,
        hasScopeExclusions ? 'Some visible tiles are outside the current filter scope and are not included in this summary.' : undefined,
      ].filter((value): value is string => Boolean(value)).join(' ') || undefined,
      claims,
      evidenceRefs: Array.from(new Set(scopedFacts.map((fact) => fact.evidenceRef))),
      trustState: scopedFacts.length ? trustState : 'draft_ready',
      generatedBy: 'deterministic',
    },
  };
}

function sameDashboardFilterScope(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const stable = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([first], [second]) => first.localeCompare(second)),
  ));
  return stable(left) === stable(right);
}

export function validateDashboardStoryBrief(
  story: DashboardStoryBrief,
  facts: DashboardStoryFact[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const allowedNumbers = new Set(facts.flatMap((fact) => [fact.value, fact.comparison?.baseline, fact.comparison?.delta, formatValue(fact.value, fact.unit)])
    .filter((value) => value !== undefined && value !== null)
    .flatMap((value) => String(value).match(/-?\d+(?:\.\d+)?/g) ?? []));
  // Group-qualified Dataset observations may carry dates or identifiers in
  // their evidence-backed labels. Those tokens originate in the result row,
  // not generated prose, so permit them when the story repeats the label.
  for (const fact of facts) {
    for (const number of fact.label.match(/-?\d+(?:\.\d+)?/g) ?? []) allowedNumbers.add(number);
  }
  for (const value of facts.flatMap((fact) => Object.values(fact.filters ?? {}))) {
    for (const number of String(Array.isArray(value) ? value.join(' ') : value).match(/-?\d+(?:\.\d+)?/g) ?? []) allowedNumbers.add(number);
  }
  const prose = [story.headline, ...story.paragraphs, story.implication ?? '', story.caveat ?? ''].join(' ');
  for (const number of prose.match(/-?\d+(?:\.\d+)?/g) ?? []) {
    if (!allowedNumbers.has(number)) errors.push(`unsupported number: ${number}`);
  }
  for (const claim of story.claims) {
    const evidence = claim.factIds.map((id) => byId.get(id)).filter((fact): fact is DashboardStoryFact => Boolean(fact));
    if (evidence.length !== claim.factIds.length || evidence.length === 0) errors.push(`claim has missing evidence: ${claim.text}`);
    if (claim.kind === 'comparison' && !evidence.some((fact) => fact.comparison)) errors.push(`comparison has no baseline: ${claim.text}`);
    if ((claim.kind === 'driver' || /\bcaused|driven by|because of|led to\b/i.test(claim.text)) && !evidence.some((fact) => fact.kind === 'driver')) {
      errors.push(`causal claim has no driver evidence: ${claim.text}`);
    }
    const grains = new Set(evidence.map((fact) => fact.grain).filter(Boolean));
    if (grains.size > 1) errors.push(`claim mixes incompatible grains: ${claim.text}`);
    const filterFingerprints = new Set(evidence.map((fact) => JSON.stringify(fact.filters ?? {})));
    if (filterFingerprints.size > 1) errors.push(`claim mixes incompatible filters: ${claim.text}`);
  }
  return { ok: errors.length === 0, errors };
}

function joinFacts(facts: DashboardStoryFact[]): string {
  return facts.map((fact) => `${fact.label} is **${formatValue(fact.value, fact.unit)}**`).join(facts.length > 2 ? '; ' : ' and ');
}

function filterScope(filters: Record<string, unknown>): string {
  // An empty multi-select is "All", not a filter.
  const active = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0));
  if (active.length === 0) return 'the current scope';
  return active.map(([key, value]) => `${humanize(key)} ${Array.isArray(value) ? value.join(' to ') : String(value)}`).join(', ');
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

function resolveDeclaredGroupColumn(columns: string[], aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const normalizedAlias = normalizeOutputAlias(alias);
    const column = columns.find((candidate) => normalizeOutputAlias(candidate) === normalizedAlias);
    if (column) return column;
  }
  return undefined;
}

function normalizeOutputAlias(value: string): string {
  return value.trim().toLowerCase();
}

function formatGroupValue(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // A time-grain result represents a calendar bucket. Use the unambiguous
    // date portion rather than the process-local rendering of a Date object.
    return value.toISOString().slice(0, 10);
  }
  return String(value);
}

function storyFormatUnit(meta: { kind?: unknown; unit?: unknown; decimals?: unknown } | undefined): string | undefined {
  if (!meta || typeof meta.kind !== 'string') return undefined;
  const decimals = typeof meta.decimals === 'number' && Number.isInteger(meta.decimals) && meta.decimals >= 0 && meta.decimals <= 12
    ? meta.decimals
    : undefined;
  if (meta.kind === 'percent') return `percent${decimals === undefined ? '' : `:${decimals}`}`;
  if (meta.kind === 'currency') {
    const currency = typeof meta.unit === 'string' && /^[A-Z]{3}$/.test(meta.unit) ? meta.unit : 'USD';
    return `currency:${currency}${decimals === undefined ? '' : `:${decimals}`}`;
  }
  return decimals === undefined ? undefined : `number:${decimals}`;
}

function formatValue(value: unknown, unit?: string): string {
  if (typeof value === 'number') {
    const [kind, configuredUnit, configuredDecimals] = (unit ?? '').split(':');
    const parsedDecimals = configuredDecimals === undefined ? undefined : Number(configuredDecimals);
    const fractionDigits = typeof parsedDecimals === 'number'
      && Number.isInteger(parsedDecimals)
      && parsedDecimals >= 0
      && parsedDecimals <= 12
      ? parsedDecimals
      : undefined;
    if (kind === 'percent') {
      const percentDigits = Number.isInteger(Number(configuredUnit)) ? Number(configuredUnit) : fractionDigits;
      return new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: percentDigits ?? 0, maximumFractionDigits: percentDigits ?? 2 }).format(value);
    }
    if (kind === 'currency' && configuredUnit && /^[A-Z]{3}$/.test(configuredUnit)) {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: configuredUnit, minimumFractionDigits: fractionDigits ?? 2, maximumFractionDigits: fractionDigits ?? 2 }).format(value);
    }
    if (kind === 'number') {
      const numberDigits = Number.isInteger(Number(configuredUnit)) ? Number(configuredUnit) : fractionDigits;
      if (numberDigits !== undefined) {
        return new Intl.NumberFormat('en-US', { minimumFractionDigits: numberDigits, maximumFractionDigits: numberDigits }).format(value);
      }
    }
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  }
  return String(value ?? 'not available');
}
