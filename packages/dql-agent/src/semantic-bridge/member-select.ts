/**
 * Lane-2 fallback member selection (extracted from the answer loop).
 *
 * One LLM call that picks semantic members (metrics/dimensions/grain/filters) as
 * JSON — the `query_semantic_model` contract. The compiler still owns the SQL, so
 * this keeps paraphrased metric questions on the governed tier. Returns undefined
 * on any parse/shape failure so the caller falls through to metric-first /
 * generation.
 */
import { semanticDimensionReference, type SemanticLayer } from '@zlens/core';
import type { AgentMessage, AgentProvider } from '../providers/types.js';
import type { ReasoningEffort } from '../providers/reasoning-effort.js';
import type { SemanticBridgeFilter, SemanticMemberSelection } from './compose.js';

export async function selectSemanticMembersViaLlm(input: {
  provider: AgentProvider;
  semanticLayer: SemanticLayer;
  question: string;
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  /**
   * Dimensions the selection MUST include as group-bys (a retry after a
   * breakdown was dropped). The instruction is added to the prompt; the model
   * still picks only from the compatible cards.
   */
  requireDimensions?: string[];
}): Promise<SemanticMemberSelection | undefined> {
  const allMetrics = input.semanticLayer.listMetrics();
  // AGT-021 / UI-012: exact user-authored semantic names are a hard output
  // contract, including dbt measures projected into the metric catalog. The
  // former real-metrics-first card set hid those measures whenever even one
  // real metric was present, so a five-member request could only return the
  // single real metric after the deterministic filter-binding lane handed off.
  const explicitlyRequestedMetrics = exactNamedMembers(allMetrics, input.question);
  // Show REAL metrics, not dbt measures projected into the metrics map — the
  // model shouldn't pick a raw measure when a governed metric exists. If no real
  // metric matches, fall back to the full pool so measure-backed questions work.
  // Exact names are the exception: the user selected those identities directly,
  // so keep them at the front of the bounded cards regardless of object kind.
  const rankedRealMetrics = rankMembersForQuestion(input.semanticLayer.listMetrics(undefined, { includeMeasures: false }), input.question);
  const rankedMetrics = rankedRealMetrics.length > 0
    ? rankedRealMetrics
    : rankMembersForQuestion(allMetrics, input.question);
  const metrics = uniqueMembers([...explicitlyRequestedMetrics, ...rankedMetrics]);
  if (metrics.length === 0) return undefined;
  const dimensions = rankMembersForQuestion(
    input.semanticLayer.listDimensions(undefined, { includeVariants: true }),
    input.question,
  );
  const rawTimeDimensions = input.semanticLayer.listTimeDimensions?.(undefined, { includeVariants: true })
    ?? dimensions.filter((dimension) => dimension.isTimeDimension);
  const timeDimensions = rankMembersForQuestion(rawTimeDimensions, input.question);
  const visibleMetrics = metrics.slice(0, 60);

  // Only show dimensions the model can actually GROUP the candidate metrics by.
  // Showing the whole catalog let the model pick a dimension with no join path to
  // the metric, which the runtime then rejected ("does not match any group-by-
  // items") — so some questions worked and others didn't for the same metric.
  // Build the UNION of compatible dimensions across the top candidate metrics
  // (the model picks one metric, so a dim groupable by ANY candidate is valid),
  // and keep the qualified name to hand the runtime the exact group-by it wants.
  // Compatibility used to be computed for only the top FIVE of the sixty
  // visible metrics, so metrics 6-60 reached the model as a bare name and it had
  // to guess whether a dimension was groupable — the exact mistake the cards
  // exist to prevent. `explainCompatibleDimensions` is memoized per metric set,
  // which is what makes covering the whole visible set affordable.
  const candidateMetricNames = visibleMetrics.map((metric) => metric.name);
  const compatibleByName = new Map<string, string | undefined>();
  const compatibleByMetric = new Map<string, string[]>();
  // A metric-only catalog has no possible group-by card. Avoid calculating
  // compatibility for all 60 prompt candidates in that common large-catalog
  // case; the result is observably the same empty compatibility set.
  const hasDimensionCandidates = dimensions.length > 0 || timeDimensions.length > 0;
  if (hasDimensionCandidates) {
    for (const metricName of candidateMetricNames) {
      try {
        const references: string[] = [];
        for (const dim of input.semanticLayer.explainCompatibleDimensions([metricName]).compatible) {
          const reference = semanticDimensionReference(dim);
          if (!compatibleByName.has(reference)) compatibleByName.set(reference, dim.qualifiedName);
          references.push(reference);
        }
        compatibleByMetric.set(metricName, references);
      } catch {
        // No compatibility proof means no dimension card for this metric. Never
        // replace a failed governed check with the complete global catalog.
        compatibleByMetric.set(metricName, []);
      }
    }
  }
  const keepDimension = (name: string): boolean => compatibleByName.has(name);
  const visibleDimensions = dimensions.filter((dimension) => keepDimension(semanticDimensionReference(dimension))).slice(0, 80);
  const visibleTimeDimensions = timeDimensions.filter((dimension) => keepDimension(semanticDimensionReference(dimension))).slice(0, 20);
  // Real per-column grains so the model picks a grain the column actually
  // supports (a month-grain column cannot be sliced by day).
  const grainsFor = (dimension: typeof visibleTimeDimensions[number]): string[] =>
    input.semanticLayer.getTimeDimension?.(semanticDimensionReference(dimension))?.granularities ?? [];

  const catalog = [
    'METRICS:',
    ...visibleMetrics.map((metric) => {
      const compatible = compatibleByMetric.get(metric.name) ?? [];
      const compatibility = candidateMetricNames.includes(metric.name)
        ? ` [compatible dimensions: ${compatible.length > 0 ? compatible.slice(0, 25).join(', ') : 'none'}]`
        : '';
      return `- ${metric.name}${metric.label && metric.label !== metric.name ? ` (${metric.label})` : ''}${metric.description ? `: ${metric.description}` : ''}${compatibility}`;
    }),
    'DIMENSIONS (only those groupable by the metrics above; obey each metric card):',
    ...visibleDimensions.map((dimension) => {
      const reference = semanticDimensionReference(dimension);
      return `- ${reference}${dimension.label && dimension.label !== dimension.name ? ` (${dimension.label}; local: ${dimension.name})` : ` (local: ${dimension.name})`}`;
    }),
    ...(visibleTimeDimensions.length > 0 ? ['TIME DIMENSIONS (use for grain):', ...visibleTimeDimensions.map((dimension) => {
      const grains = grainsFor(dimension);
      return `- ${semanticDimensionReference(dimension)}${grains.length > 0 ? ` [grains: ${grains.join(', ')}]` : ''}`;
    })] : []),
  ].join('\n');

  const requiredDims = (input.requireDimensions ?? [])
    .map((name) => {
      const resolved = input.semanticLayer.resolveDimension(name, candidateMetricNames);
      return resolved ? semanticDimensionReference(resolved) : name;
    })
    .filter((name) => keepDimension(name));
  const messages: AgentMessage[] = [
    {
      role: 'system',
      content: [
        'You select governed semantic members to answer an analytics question. Choose ONLY from the metrics and dimensions listed — never invent names.',
        'Respond with a SINGLE json object, no prose, no code fences other than one ```json block:',
        '{"metrics": string[], "dimensions"?: string[], "timeDimension"?: {"name": string, "granularity": "day"|"week"|"month"|"quarter"|"year"}, "filters"?: [{"dimension": string, "operator": "equals"|"in", "values": string[]}], "limit"?: number}',
        'If no listed metric can answer the question, return {"metrics": []}.',
        ...(requiredDims.length > 0
          ? [`You MUST include these dimensions as group-bys (they are the requested breakdown): ${requiredDims.join(', ')}.`]
          : []),
      ].join('\n'),
    },
    { role: 'user', content: `Question: ${input.question}\n\nAvailable governed members:\n${catalog}\n\nReturn the member selection as JSON.` },
  ];

  let raw: string;
  try {
    raw = await input.provider.generate(messages, { signal: input.signal, reasoningEffort: input.reasoningEffort });
  } catch {
    return undefined;
  }
  const parsed = extractFirstJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  // Validate against the exact bounded cards shown to the provider, not the
  // complete catalog. A real-but-unseen member is still an invented selection
  // for this call and must be rejected at the resolver boundary.
  const metricNames = new Set(visibleMetrics.map((metric) => metric.name));
  const dimensionNames = new Set(visibleDimensions.map(semanticDimensionReference));
  const timeDimensionNames = new Set(visibleTimeDimensions.map(semanticDimensionReference));
  const modelSelectedMetrics = Array.isArray(record.metrics)
    ? record.metrics.filter((value): value is string => typeof value === 'string' && metricNames.has(value))
    : [];
  // The model may add a compatible semantic member, but it cannot delete an
  // exact metric/measure identity present in the user's question.
  const selectedMetrics = Array.from(new Set([
    ...explicitlyRequestedMetrics.map((metric) => metric.name),
    ...modelSelectedMetrics,
  ]));
  if (selectedMetrics.length === 0) return undefined;
  let compatibleForSelection = new Set<string>();
  if (hasDimensionCandidates) {
    try {
      compatibleForSelection = new Set(
        input.semanticLayer.explainCompatibleDimensions(selectedMetrics).compatible.map(semanticDimensionReference),
      );
    } catch {
      return undefined;
    }
  }
  const selection: SemanticMemberSelection = { metrics: selectedMetrics };
  if (Array.isArray(record.dimensions)) {
    const requested = record.dimensions.filter((value): value is string => typeof value === 'string');
    if (requested.some((value) => !dimensionNames.has(value) || !compatibleForSelection.has(value))) return undefined;
    selection.dimensions = requested;
  }
  const timeDim = record.timeDimension;
  if (timeDim && typeof timeDim === 'object') {
    const name = (timeDim as Record<string, unknown>).name;
    const granularity = (timeDim as Record<string, unknown>).granularity;
    if (typeof name !== 'string'
      || typeof granularity !== 'string'
      || !timeDimensionNames.has(name)
      || !compatibleForSelection.has(name)) return undefined;
    selection.timeDimension = { name, granularity };
  }
  if (Array.isArray(record.filters)) {
    const requestedFilters = record.filters.map((entry) => entry as Record<string, unknown>);
    if (requestedFilters.some((entry) =>
      !entry
      || typeof entry.dimension !== 'string'
      || !dimensionNames.has(entry.dimension)
      || !compatibleForSelection.has(entry.dimension)
      || !Array.isArray(entry.values))) return undefined;
    const filters = record.filters
      .map((entry) => entry as Record<string, unknown>)
      .map((entry) => ({
        dimension: entry.dimension as string,
        operator: (entry.operator === 'in' ? 'in' : 'equals') as SemanticBridgeFilter['operator'],
        values: (entry.values as unknown[]).filter((value): value is string => typeof value === 'string'),
      }))
      .filter((filter) => filter.values.length > 0);
    if (filters.length > 0) selection.filters = filters;
  }
  if (typeof record.limit === 'number' && Number.isFinite(record.limit) && record.limit > 0) {
    selection.limit = Math.floor(record.limit);
  }
  return selection;
}

function exactNamedMembers<T extends { name: string; label?: string }>(
  members: T[],
  question: string,
): T[] {
  const normalizedQuestion = ` ${normalizeMemberPhrase(question)} `;
  const byPhrase = new Map<string, T[]>();
  for (const member of members) {
    const phrases = new Set([
      normalizeMemberPhrase(member.name),
      normalizeMemberPhrase(member.name.split('.').at(-1) ?? member.name),
      normalizeMemberPhrase(member.label ?? ''),
    ].filter(Boolean));
    for (const phrase of phrases) {
      if (!normalizedQuestion.includes(` ${phrase} `)) continue;
      byPhrase.set(phrase, [...(byPhrase.get(phrase) ?? []), member]);
    }
  }
  return [...byPhrase.entries()]
    .filter(([, matches]) => new Set(matches.map((member) => member.name)).size === 1)
    .sort(([left], [right]) =>
      normalizedQuestion.indexOf(` ${left} `) - normalizedQuestion.indexOf(` ${right} `)
      || right.length - left.length)
    .map(([, matches]) => matches[0]!)
    .filter((member, index, all) => all.findIndex((candidate) => candidate.name === member.name) === index);
}

function normalizeMemberPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_./-]+/g, ' ')
    .replace(/[^a-z0-9% ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueMembers<T extends { name: string }>(members: T[]): T[] {
  // The semantic selection lane deliberately considers thousands of metrics
  // before bounding its prompt. `findIndex` made this de-duplication O(n²),
  // so a 7k-member catalog could consume the whole selection budget under a
  // concurrent Node 20 test run. Preserve first-member-wins semantics in O(n).
  const seen = new Set<string>();
  return members.filter((member) => {
    if (seen.has(member.name)) return false;
    seen.add(member.name);
    return true;
  });
}

function rankMembersForQuestion<T extends { name: string; label?: string; description?: string }>(
  members: T[],
  question: string,
): T[] {
  const terms = Array.from(new Set((question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length > 1 && !SEMANTIC_SELECTION_STOPWORDS.has(term))));
  if (terms.length === 0) return [...members].sort((left, right) => left.name.localeCompare(right.name));
  return members
    .map((member) => {
      const normalizedName = member.name.toLowerCase().replace(/[_.-]+/g, ' ');
      const label = member.label?.toLowerCase() ?? '';
      const description = member.description?.toLowerCase() ?? '';
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        if (normalizedName === term || label === term) {
          score += 12;
          matched += 1;
        } else if (normalizedName.includes(term) || label.includes(term)) {
          score += 5;
          matched += 1;
        } else if (description.includes(term)) {
          score += 1;
          matched += 1;
        }
      }
      return { member, score: score + matched / Math.max(terms.length, 1) };
    })
    .sort((left, right) => right.score - left.score || left.member.name.localeCompare(right.member.name))
    .map((entry) => entry.member);
}

const SEMANTIC_SELECTION_STOPWORDS = new Set([
  'what', 'which', 'who', 'show', 'give', 'tell', 'find', 'the', 'a', 'an', 'our', 'my',
  'is', 'are', 'was', 'were', 'of', 'for', 'in', 'on', 'to', 'by', 'and', 'or',
  'top', 'bottom', 'highest', 'lowest', 'total', 'value', 'values', 'amount',
]);

/** Extract the first balanced JSON object from model text (tolerant of fences/prose). */
export function extractFirstJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = trimmed.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
