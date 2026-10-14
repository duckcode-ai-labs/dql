/**
 * Classify a governed-metric question by whether the SEMANTIC COMPILER can build
 * it — so the answer loop can route it correctly and, crucially, decide whether
 * a compose failure is a MODELING gap (refuse with an actionable reason) or a
 * genuine compiler gap (free SQL is the legitimate path).
 *
 * The native compiler builds — with columns always qualified across joins, so no
 * ambiguous columns and no wrong joins by construction:
 *   {one+ simple/additive metrics} × {categorical dims} × {one time dim + grain}
 *   × {AND-combined pre-aggregation filters} × {global order/limit}, cross-fact
 *   via aggregate-islands, provided the members are join-graph-connected.
 * Derived/ratio/cumulative/non-additive metrics must go to the runtime compiler
 * (MetricFlow / dbt Cloud). A handful of shapes neither can express — those are
 * the only ones that legitimately need free SQL.
 */
import type { AnalysisQuestionPlan } from '../metadata/analysis-planner.js';
import type { SemanticLayer } from '@zlens/core';

export type GovernedQueryShape = 'compiler_expressible' | 'runtime_required' | 'genuine_gap';

/**
 * Shapes that neither the native compiler nor the runtime can express
 * deterministically, so free SQL is the correct path. Kept CONSERVATIVE and
 * biased toward `genuine_gap` — a false "genuine_gap" merely keeps the existing
 * free-SQL behavior, whereas a false "compiler_expressible" could refuse a
 * question that should have generated SQL.
 */
const GENUINE_GAP_RE = new RegExp(
  [
    'running\\s+total',
    'cumulative',
    'moving\\s+average',
    'month[-\\s]?over[-\\s]?month',
    'year[-\\s]?over[-\\s]?year',
    'week[-\\s]?over[-\\s]?week',
    'rolling\\s+\\d',
    '\\bhaving\\b',
    'multiplied\\s+by',
    'divided\\s+by',
    'ratio\\s+of',
    'percent(?:age)?\\s+change',
    'growth\\s+rate',
    'per[-\\s]?unit',
  ].join('|'),
  'i',
);

/**
 * @param questionPlan the parsed question plan (shape, terms).
 * @param metricNames  the governed metric(s) that matched. A multi-metric
 *                     question ("revenue and refunds by month") is composable
 *                     only if EVERY selected metric is — one runtime-only metric
 *                     pulls the whole query to the runtime compiler.
 * @param semanticLayer the catalog (for `canComposeMetric`).
 */
export function classifyGovernedQueryShape(
  questionPlan: AnalysisQuestionPlan,
  metricNames: string | string[] | undefined,
  semanticLayer: Pick<SemanticLayer, 'canComposeMetric'>,
): GovernedQueryShape {
  const selectedMetrics = (typeof metricNames === 'string' ? [metricNames] : metricNames ?? [])
    .filter((name): name is string => Boolean(name));
  // Genuine gaps first — a shape neither compiler nor runtime expresses.
  // Per-group top-N ("top 3 products PER region") is the clearest structural one.
  if (questionPlan.requestedShape.topN?.scope === 'per_group') return 'genuine_gap';
  if (GENUINE_GAP_RE.test(questionPlan.question) || GENUINE_GAP_RE.test(questionPlan.normalizedQuestion)) {
    return 'genuine_gap';
  }

  // A derived/ratio/cumulative/non-additive metric is not natively composable and
  // must run through the runtime compiler (MetricFlow / dbt Cloud).
  if (selectedMetrics.some((name) => !semanticLayer.canComposeMetric(name))) return 'runtime_required';

  // A simple/additive metric × dims × grain × AND-filters × global order/limit —
  // exactly the compiler's wheelhouse. If it matched a governed metric and still
  // couldn't compose, that is a MODELING gap (an unconnected dimension), not a
  // reason to guess SQL.
  return 'compiler_expressible';
}
