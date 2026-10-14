/**
 * Shared contracts for the conversational analytical orchestrator.
 *
 * The existing DQL engine remains the authority for compilation, execution,
 * trust, and the immutable resolved analytical plan.  This module is the thin
 * outer contract used by the conversational layer to describe what it
 * understood, what it searched, and why it could or could not continue.
 *
 * The contract is intentionally content-only: it never carries model
 * chain-of-thought, credentials, raw provider payloads, or authorization.
 *
 * Acceptance: AGT-027..033, CTX-007, PERF-003, E2E-022.
 */

import { unboundMeasureQualifierTerms } from './metadata/analysis-planner.js';
export { unboundMeasureQualifierTerms } from './metadata/analysis-planner.js';
import { createHash } from 'node:crypto';
import { parseAnalyticalTimeWindow } from './requirement-clauses.js';
import type { AgentRunTelemetryV1, DqlArtifactExecutionReceipt } from '@zlens/core';

export const ANALYTICAL_ORCHESTRATION_CONTRACT_VERSION = 1 as const;

export type AnalyticalTurnKind =
  | 'conversation'
  | 'definition'
  | 'lookup'
  | 'ranking'
  | 'breakdown'
  | 'comparison'
  | 'drilldown'
  | 'diagnosis'
  | 'research'
  | 'compound'
  | 'clarification'
  // Basic value/measure requests that are not a glossary definition.
  // Kept separate from `definition` so narration can explain the result.
  // (The union member is intentionally last for stable serialized values.)
  | 'aggregation';

export type AnalyticalTaskKind =
  | 'definition'
  | 'aggregation'
  | 'ranking'
  | 'attribute_lookup'
  | 'breakdown'
  | 'comparison'
  | 'drilldown'
  | 'diagnosis'
  | 'research_branch';

export type AnalyticalTaskStatus = 'planned' | 'running' | 'completed' | 'partial' | 'gap' | 'blocked';

export interface AnalyticalTaskOutputContractV1 {
  metrics: string[];
  dimensions: string[];
  filters: Array<{ field: string; value: string }>;
  grain?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  requestedColumns?: string[];
}

/** A bounded, server-computed dependency between two compound tasks. */
export interface AnalyticalTaskDependencyV1 {
  version: 1;
  kind: 'top_ranked_region';
  sourceTaskId: string;
  targetDimension: 'region';
}

/**
 * The only parent-result material a dependent child may receive. It carries
 * one selected canonical value and its row/result proofs, never parent prose,
 * SQL, or arbitrary rows.
 */
export interface AnalyticalTaskDependencyBindingV1 {
  version: 1;
  sourceTaskId: string;
  sourceResultFingerprint: string;
  canonicalColumn: string;
  value: string;
  rowFingerprint: string;
}

export type AnalyticalTaskDependencyResolution =
  | { ok: true; binding: AnalyticalTaskDependencyBindingV1 }
  | { ok: false; code: 'RESULT_CONTRACT_MISMATCH'; message: string };

export interface AnalyticalTaskV1 {
  version: 1;
  id: string;
  kind: AnalyticalTaskKind;
  question: string;
  dependencies: string[];
  dependency?: AnalyticalTaskDependencyV1;
  output: AnalyticalTaskOutputContractV1;
  status: AnalyticalTaskStatus;
  /** Only qualified catalog IDs may be placed in this list. */
  candidateIds: string[];
  /** Shared prior-result bindings, e.g. region = Philadelphia. */
  inheritedBindings: Array<{ id: string; value: string; source: 'conversation' | 'result' | 'user' }>;
}

/**
 * Trust projected for one task outcome.  This is intentionally the same
 * local-first vocabulary used by the canonical answer, but it is declared
 * independently so task receipts remain readable without importing the run
 * engine (and old JSON records remain valid).
 */
export type AnalyticalTaskOutcomeTrustStateV1 =
  | 'certified'
  | 'governed'
  | 'review_required'
  | 'blocked'
  | 'not_applicable';

/** Finalized state for one bounded Ask clause or Research branch. */
export type AnalyticalTaskOutcomeStatusV1 =
  | 'completed'
  | 'partial'
  | 'gap'
  | 'blocked'
  /** A child was deliberately not executed because its required parent failed. */
  | 'dependency_blocked';

/** Typed, content-safe failure retained per task rather than collapsed into the root. */
export interface AnalyticalTaskFailureV1 {
  version: 1;
  code: string;
  message: string;
  phase: 'planning' | 'execution' | 'dependency';
}

/** Durable, content-only outcome for one independent clause/branch. */
export interface AnalyticalTaskOutcomeV1 {
  version: 1;
  taskId: string;
  status: AnalyticalTaskOutcomeStatusV1;
  /** Present once a compiler or executor established task-local provenance. */
  trustState?: AnalyticalTaskOutcomeTrustStateV1;
  summary?: string;
  resultFingerprint?: string;
  gap?: AnalyticalCoverageGapV1;
  /** Typed cause when the task did not produce an independent result. */
  failure?: AnalyticalTaskFailureV1;
  /** Parent task IDs that prevented this child from executing. */
  dependencyTaskIds?: string[];
}

/**
 * Additive turn-level task receipt for ordinary Ask.  The run's historical
 * terminal status stays wire-compatible; this summary distinguishes a
 * completed, partial, or fully blocked multi-task answer without hiding any
 * independently validated sibling result.
 */
export interface AnalyticalTaskOutcomeSummaryV1 {
  version: 1;
  status: 'completed' | 'partial' | 'blocked';
  trustState: AnalyticalTaskOutcomeTrustStateV1;
  taskCount: number;
  successfulTaskIds: string[];
  failedTaskIds: string[];
  dependencyBlockedTaskIds: string[];
}

export interface AnalyticalCoverageGapV1 {
  version: 1;
  code:
    | 'MISSING_MEASURE'
    | 'MISSING_DIMENSION'
    | 'MISSING_ATTRIBUTE'
    | 'MISSING_RELATIONSHIP'
    | 'MISSING_RUNTIME_CAPABILITY'
    | 'RESULT_CONTRACT_MISMATCH'
    | 'PROVIDER_UNAVAILABLE'
    | 'EXECUTION_FAILED'
    | 'AMBIGUOUS_MEANING'
    | 'POLICY_BLOCKED';
  phase: 'retrieval' | 'meaning' | 'planning' | 'compilation' | 'execution' | 'presentation';
  message: string;
  searchedSources: string[];
  attemptedRoutes: Array<'certified' | 'semantic' | 'governed_relational' | 'generated' | 'research'>;
  missing: string[];
  recoverable: boolean;
  planFrozen: boolean;
  nextActions: string[];
}

/**
 * Roles are deliberately independent of a source's trust tier.  A semantic
 * dimension can be an entity label, a categorical breakdown, or a time axis;
 * treating all members as interchangeable is what made an Account question
 * offer owner e-mail and sentiment as substitutes for the account itself.
 *
 * Acceptance: CTX-005, CTX-007, AGT-009, AGT-010.
 */
export type EvidenceCandidateRoleV1 =
  | 'metric'
  | 'entity_key'
  | 'entity_label'
  | 'categorical_dimension'
  | 'time_dimension'
  | 'member'
  | 'relationship'
  /**
   * A physical relation whose OWN columns cover part of what was asked.
   *
   * Relations could previously only play `context`, which satisfies no role
   * quota, so a wide mart carrying both the measure and the entity label lost
   * its place to whichever narrow column fragment happened to score higher —
   * and the one table that could answer the question was never shown. A
   * relation earns this role only by evidence: a documented column of its own
   * matching a requested term.
   */
  | 'relation'
  | 'context';

/**
 * Content-safe statement of what the bounded planner package established for
 * one requested role. `alternatives` deliberately means that qualified cards
 * were retained for a user choice; it never claims the business meaning was
 * proven merely because retrieval found related fields.
 */
export type EvidenceRoleCoverageStateV1 = 'proven' | 'alternatives';

/**
 * A typed, content-safe reading of the analytical requirements in a question.
 * It is advisory for retrieval/ranking only: the compatibility solver and the
 * immutable resolved plan still own authorization and execution.
 */
export interface AnalyticalRequirementSetV1 {
  version: 1;
  measures: string[];
  dimensions: string[];
  entityTerms: string[];
  entityDisplayTerms: string[];
  memberTerms: string[];
  /**
   * A host-validated predicate reconstructed from one stable prior result
   * selection. This is execution context, not an LLM-selected meaning: the
   * runtime keeps it through retrieval/planning so a deictic follow-up cannot
   * widen back to the full warehouse after reload.
   */
  priorResultMemberBinding?: AnalyticalPriorResultMemberBindingV1;
  /** Explicit projection fields are requirements, not optional prompt hints. */
  outputTerms?: string[];
  /**
   * Words the reader put in FRONT of a measure that no requirement kept.
   *
   * "beverage revenue" reduces to the measure `revenue`, and the qualifier is
   * gone before anything downstream can see it — so the host bound plain
   * revenue, executed, and reported total revenue as beverage revenue. A
   * dropped qualifier is not a harmless simplification; it is a different
   * question. Recording it lets the deterministic path refuse to answer one
   * question as though it were another.
   */
  unboundMeasureQualifiers?: string[];
  /** `individual` requests a row-level relation rather than an aggregate. */
  grain?: 'individual' | 'aggregate';
  ranking?: {
    metricTerms: string[];
    entityTerms: string[];
    direction: 'top' | 'bottom';
    limit: number;
    /** True means the reader did not specify a count and DQL assumed 10. */
    defaultedLimit: boolean;
    /** Per-group top-N ("top 2 per month") vs one overall ranking. */
    scope?: 'overall' | 'per_group';
  };
  time?: {
    role: 'time_axis' | 'time_filter';
    grain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
    /**
     * A bounded period the answer must be restricted to. This clause was
     * previously UNREPRESENTABLE: "last two months" had no slot anywhere in
     * the requirement layer, so it degraded into a grouping dimension while
     * its count was misread as a row limit. A window is a restriction on
     * WHEN, independent of whether the answer also groups by a grain.
     */
    window?: AnalyticalTimeWindowV1;
    fiscalPeriod?: string;
    /** A fiscal token is not executable until a declared calendar binds it. */
    requiresDeclaredFiscalCalendar: boolean;
  };
  /**
   * Where each clause came from, so runtime re-derivation can refresh a
   * clause read from the current question without silently deleting one the
   * user established earlier in the conversation or via a clarification.
   */
  clauseMeta?: {
    time?: RequirementClauseMetaV1;
    ranking?: RequirementClauseMetaV1;
  };
}

/** A typed time restriction; `expression` is the canonical resolver input. */
export interface AnalyticalTimeWindowV1 {
  version: 1;
  kind: 'relative' | 'absolute' | 'named_period';
  /** Canonical digits form accepted by `resolvePlanTimeRange`, e.g. "last 2 months". */
  expression: string;
  relative?: {
    count: number;
    unit: 'day' | 'week' | 'month' | 'quarter' | 'year';
    /** True = complete calendar periods; false = trailing from now. */
    complete: boolean;
  };
  absolute?: { startInclusive: string; endExclusive: string };
  namedPeriod?: string;
}

export type RequirementClauseProvenance = 'question' | 'inherited' | 'clarification' | 'defaulted';

export interface RequirementClauseMetaV1 {
  provenance: RequirementClauseProvenance;
  required: boolean;
  sourceTurnId?: string;
}

/**
 * Additive, host-owned representation of a selected value from a prior
 * canonical result. It intentionally mirrors the engine boundary without
 * importing that module, so analytical framing remains cycle-free.
 */
export interface AnalyticalPriorResultMemberBindingV1 {
  version: 1;
  displayDimension: string;
  values: string[];
  sourceTurnId?: string;
  resultFingerprint?: string;
}

/**
 * Preserve a validated prior-result predicate as typed analytical context.
 * The selected display key supplies the entity/display requirements needed to
 * retrieve relationship closure; the literal values remain an immutable host
 * filter and are never treated as a provider-selected member meaning.
 */
export function withAnalyticalPriorResultMemberBinding(
  requirements: AnalyticalRequirementSetV1,
  binding: AnalyticalPriorResultMemberBindingV1 | undefined,
): AnalyticalRequirementSetV1 {
  const displayDimension = binding?.displayDimension?.trim();
  const seenValues = new Set<string>();
  const values = (binding?.values ?? []).flatMap((value) => {
    const trimmed = value.trim();
    const normalized = normalizeRequirementTerm(trimmed);
    if (!trimmed || !normalized || seenValues.has(normalized)) return [];
    seenValues.add(normalized);
    return [trimmed];
  });
  if (!displayDimension || values.length === 0) return requirements;
  const normalizedDisplay = normalizeRequirementTerm(displayDimension);
  const entityTerm = normalizedDisplay
    .replace(/\b(?:name|id|key|label|email)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    ...requirements,
    entityTerms: uniqueRequirementTerms([
      ...requirements.entityTerms,
      ...(entityTerm ? [entityTerm] : []),
    ]),
    entityDisplayTerms: uniqueRequirementTerms([
      ...requirements.entityDisplayTerms,
      normalizedDisplay,
    ]),
    // These values are retained for local compiler/filter construction. The
    // planner request redacts this host-only binding and does not require a
    // member card when it is present.
    memberTerms: uniqueRequirementTerms([...requirements.memberTerms, ...values]),
    priorResultMemberBinding: {
      version: 1,
      // Preserve the canonical host field spelling for the immutable filter;
      // normalized text above is only for role matching/admission.
      displayDimension,
      values,
      ...(binding?.sourceTurnId ? { sourceTurnId: binding.sourceTurnId } : {}),
      ...(binding?.resultFingerprint ? { resultFingerprint: binding.resultFingerprint } : {}),
    },
  };
}

/**
 * Host-owned analytical input to the one bounded meaning call.  The seed is
 * built before any provider response and is the only source of explicit user
 * requirements downstream.  The model may bind supplied candidate IDs and
 * explain ambiguity; it may not erase, add, or replace the request tuple.
 *
 * This is deliberately not an execution plan. It contains business terms and
 * parsed filters only; the compatibility solver and immutable resolved plan
 * still own qualified identifiers, joins, SQL, trust, and route selection.
 */
export interface AnalyticalRequirementSeedV1 {
  version: 1;
  sourceQuestion: string;
  requirements: AnalyticalRequirementSetV1;
  queryIntent: {
    measures: string[];
    dimensions: string[];
    filters: Array<{ field: string; value: string }>;
    timeRange?: string;
    timeGrain?: string;
    order?: 'asc' | 'desc';
    limit?: number;
    fiscalCalendarId?: string;
    fiscalDateRoleId?: string;
  };
}

/** Build the immutable host request tuple before a meaning model can respond. */
export function buildAnalyticalRequirementSeedV1(input: {
  question: string;
  parsedIntent?: Partial<{
    measures: string[];
    dimensions: string[];
    filters: Array<{ field: string; value: string }>;
    timeRange: string;
    timeGrain: string;
    order: 'asc' | 'desc';
    limit: number;
    fiscalCalendarId: string;
    fiscalDateRoleId: string;
  }>;
  requirements?: AnalyticalRequirementSetV1;
  priorResultMemberBinding?: AnalyticalPriorResultMemberBindingV1;
  fiscalCalendar?: { id: string; dateRoleId?: string; fiscalPeriodFieldId?: string };
}): AnalyticalRequirementSeedV1 {
  // Retrieval/parser output is intentionally broad: it may contain useful
  // context from a prior turn, vector hit, or search expansion.  It is not an
  // authority for a new free-text request.  Keep only refinements that the
  // source question itself demonstrates before they can contribute to the
  // frozen host tuple. Structured clarification selections are merged by the
  // router into `requirements` before this function is called.
  const parsed = currentQuestionGroundedParsedIntent(input.question, input.parsedIntent);
  const baseRequirements = input.requirements ?? buildAnalyticalRequirementSet({
    question: input.question,
    parsedIntent: parsed,
  });
  const requirements = withAnalyticalPriorResultMemberBinding(
    baseRequirements,
    input.priorResultMemberBinding ?? baseRequirements.priorResultMemberBinding,
  );
  // Order and limit are lexical requirements, not parser defaults. In
  // particular, a prior ranking must not turn a complete new question into a
  // top-N query just because retrieval retained an old `limit` or `order`.
  const order = requirements.ranking
    ? requirements.ranking.direction === 'bottom' ? 'asc' as const : 'desc' as const
    : undefined;
  const limit = requirements.ranking?.limit;
  const filters = [...(parsed?.filters ?? [])].map((filter) => ({ field: filter.field, value: filter.value }));
  for (const value of requirements.priorResultMemberBinding?.values ?? []) {
    const field = requirements.priorResultMemberBinding?.displayDimension;
    if (!field || filters.some((filter) =>
      normalizeRequirementTerm(filter.field) === normalizeRequirementTerm(field)
      && normalizeRequirementTerm(filter.value) === normalizeRequirementTerm(value))) continue;
    filters.push({ field, value });
  }
  if (requirements.time?.fiscalPeriod && input.fiscalCalendar?.fiscalPeriodFieldId
    && !filters.some((filter) => filter.field === input.fiscalCalendar!.fiscalPeriodFieldId)) {
    filters.push({ field: input.fiscalCalendar.fiscalPeriodFieldId, value: requirements.time.fiscalPeriod });
  }
  return {
    version: 1,
    sourceQuestion: input.question,
    requirements,
    queryIntent: {
      measures: [...requirements.measures],
      // A ranking's entity display key is an execution requirement, not a
      // prompt nicety. Keep it in the host-owned query tuple, but do not put
      // the broad entity noun (for example `customer`) in the categorical
      // dimension lane. A metric can legitimately expose customer type and
      // customer order number as groupings; neither is interchangeable with
      // the requested customer display/rank key. The frame resolves the
      // display term against the selected metric's native display/rank role.
      dimensions: [...new Set([
        ...categoricalDimensionRequirementTerms(requirements),
        ...requirements.entityDisplayTerms,
      ])],
      filters,
      // The typed window is the host's own reading of the question and wins
      // over a retrieval refinement. Its canonical expression is exactly the
      // input `resolvePlanTimeRange` accepts, so populating it is what makes
      // that (previously never-called) resolver finally produce timeBounds.
      ...(requirements.time?.window
        ? { timeRange: requirements.time.window.expression }
        : parsed?.timeRange ? { timeRange: parsed.timeRange } : {}),
      ...(requirements.time?.grain
        ? { timeGrain: requirements.time.grain }
        : parsed?.timeGrain ? { timeGrain: parsed.timeGrain } : {}),
      ...(order ? { order } : {}),
      ...(limit !== undefined ? { limit } : {}),
      // A calendar/date role is declared snapshot metadata, never an ID
      // copied from retrieval/parser evidence.
      ...(input.fiscalCalendar?.id ? { fiscalCalendarId: input.fiscalCalendar.id } : {}),
      ...(input.fiscalCalendar?.dateRoleId ? { fiscalDateRoleId: input.fiscalCalendar.dateRoleId } : {}),
    },
  };
}

type RetrievalParsedIntentRefinement = Partial<{
  measures: string[];
  dimensions: string[];
  filters: Array<{ field: string; value: string }>;
  timeRange: string;
  timeGrain: string;
  order: 'asc' | 'desc';
  limit: number;
  fiscalCalendarId: string;
  fiscalDateRoleId: string;
}>;

/**
 * Return only parser refinements whose business words occur in the current
 * source question. This deliberately does not try to recover previous turn
 * context: continuation is represented by a server-issued structured choice
 * and merged separately by the host. The helper is exported for regression
 * tests and for router paths that construct a requirement set before a seed.
 */
export function currentQuestionGroundedParsedIntent(
  question: string,
  parsedIntent: RetrievalParsedIntentRefinement | undefined,
): RetrievalParsedIntentRefinement | undefined {
  if (!parsedIntent) return undefined;
  // These are intentionally tiny, product-wide vocabulary aliases rather
  // than semantic guessing. They let a retrieval parser retain the same
  // current-turn business phrase (`drink revenue` for `beverage revenue`, or
  // `sales` for `revenue`) while still rejecting an unrelated prior-turn
  // phrase such as `rollover balance`. Do not add customer/model-specific
  // synonyms here: those require a qualified selected candidate and an
  // override receipt at the meaning boundary.
  const canonicalGroundingToken = (term: string): string => {
    if (term === 'sale' || term === 'sales') return 'revenue';
    if (term === 'drink' || term === 'drinks') return 'beverage';
    return term;
  };
  const questionTerms = new Set(normalizeRequirementTerm(question)
    .split(' ')
    .filter((term) => term.length > 1)
    .map(canonicalGroundingToken));
  const groundedTerm = (value: string | undefined): boolean => {
    const terms = normalizeRequirementTerm(value ?? '')
      .split(' ')
      .filter((term) => term.length > 1 && !/^(?:the|a|an|by|for|with|and|or|of|to|in|on|at)$/.test(term))
      .map(canonicalGroundingToken);
    return terms.length > 0 && terms.every((term) => {
      if (questionTerms.has(term)) return true;
      // Preserve only a trivial singular/plural normalization. Anything more
      // permissive would let a stale retrieved phrase become a new request.
      return term.endsWith('s')
        ? questionTerms.has(term.slice(0, -1))
        : questionTerms.has(`${term}s`);
    });
  };
  const timeRangeGrounded = (value: string | undefined): boolean => {
    const normalized = normalizeRequirementTerm(value ?? '');
    if (!normalized) return false;
    if (groundedTerm(normalized)) return true;
    if (!/^(?:last|previous|past) (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve) (?:day|days|week|weeks|month|months|quarter|quarters|year|years)$/.test(normalized)) return false;
    // The question may spell the count ("last two months") while the parsed
    // range uses digits ("last 2 months"). Both spell the same window; ground
    // on the digit-normalized forms so the wording difference cannot unground
    // a range the question itself established.
    const digits = (value2: string): string => value2
      .replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2').replace(/\bthree\b/g, '3')
      .replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5').replace(/\bsix\b/g, '6')
      .replace(/\bseven\b/g, '7').replace(/\beight\b/g, '8').replace(/\bnine\b/g, '9')
      .replace(/\btwelve\b/g, '12').replace(/\bten\b/g, '10');
    return digits(normalizeRequirementTerm(question)).includes(digits(normalized));
  };
  const measures = (parsedIntent.measures ?? []).filter(groundedTerm);
  const dimensions = (parsedIntent.dimensions ?? []).filter(groundedTerm);
  // A parser may contribute the column that a reader's explicitly named value
  // belongs to, but the value itself must appear in this request. This drops
  // stale rollover-balance/member filters while retaining a current named
  // member that the host can bind to a qualified field.
  const filters = (parsedIntent.filters ?? []).filter((filter) => groundedTerm(filter.value));
  const timeRange = timeRangeGrounded(parsedIntent.timeRange)
    ? parsedIntent.timeRange
    : undefined;
  return {
    ...(measures.length > 0 ? { measures } : {}),
    ...(dimensions.length > 0 ? { dimensions } : {}),
    ...(filters.length > 0 ? { filters } : {}),
    ...(timeRange ? { timeRange } : {}),
    // Grain/ranking/limit are derived deterministically from the source
    // question below. Never promote parser values by themselves.
  };
}

/**
 * Preserve a small set of explicit current-question literals even when a
 * retriever did not emit a parser filter. This is deliberately not a value
 * search or synonym engine: it records only quoted values, capitalized proper
 * names, and values introduced by an explicit predicate phrase. The planner
 * must still bind each term to an admitted, qualified member/dimension card
 * before it can become an executable filter.
 *
 * Without this host-owned atom, "customers in Philadelphia" could reach a
 * broad certified fit after retrieval silently omitted the parser filter.
 */
export function currentQuestionLiteralMemberTerms(question: string): string[] {
  const literals: string[] = [];
  const append = (
    value: string | undefined,
    source: 'quoted' | 'predicate' | 'proper_name' = 'predicate',
  ): void => {
    const trimmed = (value ?? '').trim()
      .replace(/^(?:the\s+)/i, '')
      .replace(/[?.!,;:]+$/g, '')
      .trim();
    const normalized = normalizeRequirementTerm(trimmed);
    if (!normalized || isTemporalTerm(normalized)) return;
    // Do not mistake grammatical/analytical words for a member literal.
    if (/^(?:by|with|and|or|for|where|that|which|who|having|have)\b/i.test(normalized)) return;
    if (/^(?:show|who|what|which|where|when|why|how|top|bottom|highest|lowest|revenue|sales|customers?|accounts?|products?|orders?|regions?|categories?|category|region|customer|account|product|order)$/i.test(normalized)) return;
    // A two-word title-cased fragment is not automatically a proper name.
    // Sentence-leading analytical phrases such as `Show Revenue` and `Top
    // Customers` otherwise become fake member atoms, then falsely demand a
    // member field before the compiler can reach a safe physical fallback.
    // Quoted text remains an explicit reader literal; only heuristic proper
    // name extraction applies this conservative vocabulary guard.
    if (source === 'proper_name') {
      const words = normalized.split(/\s+/);
      if (words.some((word) => /^(?:show|list|give|find|get|top|bottom|highest|lowest|revenue|sales|customer|customers|account|accounts|product|products|order|orders|region|regions|category|categories|metric|metrics|amount|count|total|average|avg|monthly|daily|yearly)$/i.test(word))) return;
    }
    literals.push(trimmed);
  };

  // A reader can make a value unambiguous with quotes regardless of casing.
  for (const match of question.matchAll(/["“]([^"”]{2,96})["”]/g)) append(match[1], 'quoted');

  // Keep a literal only when the question itself supplies a predicate-like
  // construction. The bounded lookahead avoids swallowing "by revenue" or a
  // second clause into the value.
  const predicate = /\b(?:in|from|at|named|called)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9'/-]*(?:\s+[A-Za-z][A-Za-z0-9'/-]*){0,3})(?=\s*(?:\b(?:by|with|and|or|for|where|that|which|who|having|have)\b|[?.!,;]|$))/gi;
  for (const match of question.matchAll(predicate)) append(match[1], 'predicate');

  // Proper names such as "Brittany Barrera" are a member requirement even
  // when the reader phrases an attribute lookup rather than a SQL-style
  // predicate. Single capitalized words are intentionally handled only by the
  // predicate branch above so sentence-leading generic words do not become
  // fake filters.
  for (const match of question.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)) append(match[1], 'proper_name');

  return uniqueRequirementTerms(literals);
}

export type ContextSourceCoverageStatusV1 = 'available' | 'empty' | 'stale' | 'unavailable' | 'errored' | 'skipped';

/** Source coverage is distinct from a missing capability.  A bounded package
 * may omit a relevant candidate; that is not proof that the source lacks it. */
export interface ContextSourceCoverageV1 {
  version: 1;
  source: 'certified' | 'semantic' | 'governed_relational' | 'exploratory' | 'dbt_manifest' | 'runtime_schema' | 'vector' | 'conversation';
  status: ContextSourceCoverageStatusV1;
  candidateIds: string[];
  reason?: string;
}

export type AnalyticalCascadeTierV1 = 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql' | 'clarify_or_gap';
export type AnalyticalCascadeTierOutcomeV1 = 'executable' | 'ineligible' | 'unavailable' | 'ambiguous' | 'denied';

/** One immutable, inspectable decision per ordered authority tier. */
export interface CascadeTierAttemptV1 {
  version: 1;
  tier: AnalyticalCascadeTierV1;
  outcome: AnalyticalCascadeTierOutcomeV1;
  candidateIds: string[];
  reason: string;
  /** A denied or frozen tier must never silently fall through to another one. */
  planFrozen: boolean;
}

/**
 * A server-owned freeze made after a generated exploratory proposal has passed
 * the selected snapshot's SQL/context checks and has been bound to one live
 * execution target. It intentionally contains fingerprints and qualified
 * candidate identities only: the opaque execution capability and SQL text
 * never leave the in-memory host boundary.
 */
export interface ExploratoryExecutionFreezeV1 {
  version: 1;
  selectedTier: 'exploratory_sql';
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  targetFingerprint: string;
  sqlFingerprint: string;
  candidateIds: string[];
  /** The host minted one single-use capability before connector execution. */
  authorization: 'capability_minted';
  /**
   * Per-output proof emitted by the host SQL validator.  When a frozen plan
   * names explicit projected identifiers, a result is displayable only if the
   * authorization receipt carries one exact physical source binding for each
   * of them.  Optional for pre-V4 persisted receipts; required for new
   * exploratory execution with required outputs.
   */
  requiredOutputBindings?: ExploratoryRequiredOutputBindingProofV1[];
  /**
   * SQL authorization is distinct from the router plan freeze.  Index zero is
   * the first exact SQL handoff; index one is the only permitted same-plan
   * correction after a retryable warehouse execution failure.  Older receipts
   * omit this additive field and are interpreted as the original handoff.
   */
  authorizationAttempt?: ExploratoryExecutionAuthorizationAttemptV1;
}

/**
 * Host-owned proof that one output alias in the authorized SQL came from the
 * exact physical source selected in the frozen analytical plan.  The SQL text
 * remains in the local execution boundary; this portable receipt carries only
 * qualified identifiers and normalized relation/column names.
 */
export interface ExploratoryRequiredOutputBindingProofV1 {
  version: 1;
  outputName: string;
  qualifiedId: string;
  relation: string;
  column: string;
}

/**
 * Server-owned lifecycle marker for an exploratory SQL capability.  A repair
 * does not reopen routing or meaning: it may only replace the SQL bytes while
 * preserving the frozen plan, snapshot, target, candidate closure, and
 * read-only validation proof.
 */
export type ExploratoryExecutionAuthorizationAttemptV1 =
  | { version: 1; index: 0; parentSqlFingerprint?: never }
  | { version: 1; index: 1; parentSqlFingerprint: string };

/**
 * A host authorization attaches to a plan the router has already frozen.  The
 * plan freeze establishes the meaning, candidate closure, and source snapshot;
 * this receipt establishes only the exact read-only SQL and live target.  It
 * is intentionally an alias of the existing wire shape so persisted V1/V3
 * runs remain readable while callers stop treating authorization as the point
 * at which a plan becomes frozen.
 *
 * Acceptance: AGT-029, AGT-031, AGT-034.
 */
export type ExploratoryExecutionAuthorizationReceiptV1 = ExploratoryExecutionFreezeV1;

/** A content-safe, server-produced terminal incident for Ask observability. */
export interface AskTerminalIncidentV1 {
  version: 1;
  code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH'
    | 'CONNECTION_NOT_CONFIGURED'
    /** A frozen plan failed before any statement reached the warehouse. */
    | 'COMPILATION_FAILED'
    /** The executed rows did not satisfy the immutable frozen result contract. */
    | 'RESULT_CONTRACT_MISMATCH'
    | 'ANALYTICAL_EXECUTION_FAILED'
    | 'ANALYTICAL_COVERAGE_GAP'
    /** The run's own deadline ended it; the phase says how far it got. */
    | 'RUN_TIMEOUT'
    | 'PROVIDER_FAILURE'
    /** Every admitted Research branch used its bounded window without a finding. */
    | 'RESEARCH_BRANCH_TIMEOUT'
    /** Explicit Research exhausted its root deadline before finalization. */
    | 'RESEARCH_RUN_DEADLINE'
    | 'CANCELLED';
  boundary: 'plan.compile' | 'semantic.compile' | 'sql.authorize' | 'sql.execute' | 'result.validate' | 'provider' | 'cascade' | 'run';
  origin: 'internal_invariant' | 'governance_gate' | 'semantic_compiler' | 'plan_compiler' | 'result_validator' | 'provider' | 'warehouse' | 'unknown';
  impact: 'execution_not_attempted' | 'execution_failed' | 'answer_not_produced' | 'run_cancelled';
  safeAction:
    | 'export_redacted_trace'
    | 'configure_connection'
    | 'change_authorized_connection'
    | 'inspect_failure'
    | 'retry_same_plan'
    | 'refresh_snapshot'
    | 'edit_dql'
    | 'open_sql_notebook'
    | 'request_access'
    | 'reapply_semantic_runtime'
    | 'review_analytical_failure'
    | 'inspect_research_failures'
    | 'none';
}

/**
 * A compact, producer-owned account of a completed-but-limited Research run.
 *
 * This is deliberately distinct from `AskTerminalIncidentV1`: the root Ask
 * can retain a receipt-backed finding and its selected trust state while one
 * or more independently bounded Research children failed, timed out, or were
 * skipped.  The summary carries only typed counts, reason codes, and frozen
 * child-plan evidence; it never retains branch prompts, result rows, SQL, or
 * provider content.
 */
export interface AskResearchBranchSummaryV1 {
  version: 1;
  totalBranches: number;
  /** Children that completed their bounded lifecycle. */
  completedBranches: number;
  /** Completed children with a persisted execution receipt in the V2 ledger. */
  receiptBackedBranches: number;
  failedBranches: number;
  timedOutBranches: number;
  skippedBranches: number;
  /** True only when a receipt-backed finding survived alongside a limited child. */
  partialSuccess: boolean;
  failureReasons: Array<{
    code: 'execution_failed' | 'research_branch_timeout' | 'budget_exhausted' | 'run_deadline' | 'cancelled';
    branchCount: number;
  }>;
  /** Frozen child plans actually persisted by the Research root. */
  availableChildPlans: Array<{
    tier: Exclude<AnalyticalCascadeTierV1, 'clarify_or_gap'>;
    frozenPlanCount: number;
    branchCount: number;
    reviewRequired: boolean;
  }>;
  /** Distinct child run IDs carried by durable branch receipts. */
  linkedChildRunCount: number;
  safeAction: 'inspect_research_failures';
}

/** One compact canonical story used by both the inspector and full trace. */
export interface AskDecisionSummaryV1 {
  version: 1;
  summaryFingerprint: string;
  understoodRequest: {
    measures: number;
    dimensions: number;
    entityRequested: boolean;
    outputCount: number;
    ranking?: { direction: 'top' | 'bottom'; limit: number; defaultedLimit: boolean };
    conversationBinding: 'none' | 'structured_clarification' | 'prior_result' | 'task_dependency';
  };
  evidenceByRole: Array<{ role: EvidenceCandidateRoleV1; candidateCount: number }>;
  tierDecisions: Array<{ tier: AnalyticalCascadeTierV1; outcome: AnalyticalCascadeTierOutcomeV1; planFrozen: boolean }>;
  selectedPlan?: { tier: Exclude<AnalyticalCascadeTierV1, 'clarify_or_gap'>; planFrozen: boolean; reviewRequired: boolean };
  terminalIncident?: AskTerminalIncidentV1;
  /** Present for persisted Research branch evidence; does not change root status. */
  researchBranchSummary?: AskResearchBranchSummaryV1;
  safeNextAction: AskTerminalIncidentV1['safeAction'] | 'none';
}

/**
 * A narrow, producer-owned terminal relationship witness carried with the
 * authoritative cascade.  It is deliberately enumerated rather than a copy
 * of router prose: durable Ask receipts must explain an allocation/relationship
 * block without persisting a question, candidate label, or inferred join.
 */
export interface AnalyticalCascadeTerminalGapV1 {
  version: 1;
  code: 'MISSING_RELATIONSHIP';
  requirement: 'certified_relationship_or_allocation_proof';
  /** Qualified evidence IDs only; presentation never infers new paths. */
  witnessCandidateIds: string[];
}

/**
 * The shared cascade receipt.  This does not itself compile SQL; it prevents
 * downstream presentation/execution layers from silently reinterpreting a
 * question after route selection.
 */
export interface AnalyticalCascadeDecisionV1 {
  version: 1;
  requirements: AnalyticalRequirementSetV1;
  sourceCoverage: ContextSourceCoverageV1[];
  attempts: CascadeTierAttemptV1[];
  selectedTier?: Exclude<AnalyticalCascadeTierV1, 'clarify_or_gap'>;
  planFrozen: boolean;
  /** Present only after a selected exploratory proposal is host-authorized. */
  exploratoryExecutionFreeze?: ExploratoryExecutionFreezeV1;
  /**
   * Present only when one retryable warehouse failure received the sole
   * permitted same-plan exploratory SQL repair authorization.  The original
   * receipt remains above so persisted evidence proves parent-before-repair.
   */
  exploratoryRepairExecutionFreeze?: ExploratoryExecutionFreezeV1;
  /** Present only when the router supplied a typed, relationship-safe gap. */
  terminalGap?: AnalyticalCascadeTerminalGapV1;
  stopReason: 'selected' | 'ambiguous' | 'coverage_gap' | 'denied' | 'post_freeze_failure';
}

export type ProviderFailureCauseV1 =
  | 'authentication'
  | 'model_not_found'
  | 'rate_limited'
  | 'gateway'
  | 'network'
  | 'provider_timeout'
  | 'run_deadline'
  | 'admission_denied'
  | 'dispatch_budget'
  | 'cancelled'
  | 'unknown';

/** Content-free, redacted provider diagnostics safe to persist in a run. */
export interface ProviderFailureDiagnosticV1 {
  version: 1;
  cause: ProviderFailureCauseV1;
  phase: 'preflight' | 'classification' | 'meaning_resolution' | 'planning' | 'generation' | 'repair' | 'narration' | 'agent_control' | 'tool_followup' | 'unknown';
  retryable: boolean;
  safeAction: 'retry_same_provider' | 'fix_provider_configuration' | 'wait_and_retry' | 'inspect_run' | 'none';
  httpStatusClass?: '4xx' | '5xx';
  providerFingerprint?: string;
  modelFingerprint?: string;
  baseOriginFingerprint?: string;
}

/**
 * Additive durable diagnostics. V1 and V2 intentionally remain the compact
 * compatibility envelopes used by older persisted runs.
 */
export interface AgentRunDiagnosticReceiptV3 {
  version: 3;
  runId: string;
  sourceCoverage: ContextSourceCoverageV1[];
  cascade?: AnalyticalCascadeDecisionV1;
  /** Direct projection for run-detail consumers that do not traverse cascade. */
  terminalGap?: AnalyticalCascadeTerminalGapV1;
  planFrozen: boolean;
  orchestrationMode?: 'legacy' | 'shadow' | 'agentic';
  provider?: ProviderFailureDiagnosticV1;
  finalStopReason: string;
}

/**
 * Additive canonical Ask story. V1/V2/V3 remain readable; this receipt is
 * deliberately JSON-only so no metadata/index migration is needed.
 */
export interface AgentRunDiagnosticReceiptV4 {
  version: 4;
  runId: string;
  summary: AskDecisionSummaryV1;
  terminalIncident?: AskTerminalIncidentV1;
  finalStopReason: string;
}

/**
 * Ask Analyst Runtime V1 contracts.
 *
 * These records deliberately separate an agent's business interpretation from
 * the deterministic compiler/execution authority.  They contain typed intent,
 * stable candidate identities, and receipts — never prompts, provider
 * responses, SQL text, result rows, credentials, or hidden reasoning.
 *
 * Acceptance: AGT-035..040, API-015, OBS-015, E2E-023.
 */
export type AskAnalystRuntimeModeV1 = 'legacy' | 'shadow' | 'authoritative';

export interface BusinessQuestionFrameV3 {
  version: 3;
  /** Stable only within the persisted run; raw question text stays on AgentRun. */
  questionFingerprint: string;
  kind: AnalyticalTurnKind;
  requirements: AnalyticalRequirementSetV1;
  /** A source question supplied a top-N default; presentation must disclose it. */
  defaultedTop?: { limit: number };
  conversation: {
    binding: 'none' | 'structured_clarification' | 'prior_result' | 'task_dependency';
    sourceTurnId?: string;
    selectedStableId?: string;
  };
}

export type AnalyticalHypothesisKindV1 =
  | 'direct_answer'
  | 'trend'
  | 'comparison'
  | 'contributor'
  | 'anomaly'
  | 'freshness'
  | 'counter_evidence';

/** Agent-proposed question to test; deterministic execution validates it. */
export interface AnalyticalHypothesisV1 {
  version: 1;
  id: string;
  kind: AnalyticalHypothesisKindV1;
  taskId: string;
  status: 'planned' | 'supported' | 'contradicted' | 'inconclusive' | 'failed' | 'skipped';
  requiredRoles: EvidenceCandidateRoleV1[];
}

/** Bounded mission owned by the Ask runtime before a compiler is selected. */
export interface AnalyticalMissionV1 {
  version: 1;
  mode: 'ask' | 'research';
  taskLimit: number;
  planningContinuationLimit: number;
  /**
   * The ingress task graph exceeded this mission's bounded capacity. This is
   * separate from `deferredTasks`: ordinary Ask must present a scope outcome
   * before planning/execution rather than silently dropping clauses.
   */
  scopeOverflow?: boolean;
  tasks: AnalyticalTaskV1[];
  /**
   * Ordinary Ask currently freezes one route-neutral executable program per
   * turn. When ingress splits a compound request, retain the unexecuted
   * clauses explicitly instead of silently running task-1 and losing the
   * rest. Research owns the multi-branch execution contract.
   */
  deferredTasks?: Array<Pick<AnalyticalTaskV1, 'id' | 'kind'>>;
  hypotheses: AnalyticalHypothesisV1[];
}

export interface EvidenceWorkspaceToolReceiptV1 {
  version: 1;
  id: string;
  kind: 'retrieve_snapshot' | 'candidate_extension' | 'compiler_broker' | 'provider_meaning' | 'execute' | 'repair';
  status: 'completed' | 'skipped' | 'failed';
  candidateIds: string[];
  reasonCode: string;
}

/** Same-snapshot evidence admission; excluded is never interpreted as absent. */
export interface EvidenceWorkspaceV1 {
  version: 1;
  snapshotId?: string;
  sourceFingerprint?: string;
  sourceCoverage: ContextSourceCoverageV1[];
  /**
   * Additive V2 admission projection.  Legacy readers use
   * `admittedCandidateIds`; new Ask runs retain the qualified 32-card
   * execution workspace separately from the 16 cards released to the
   * planner.  Both are stable IDs from one immutable snapshot.
   */
  workspaceCandidateIds?: string[];
  plannerCandidateIds?: string[];
  admittedCandidateIds: string[];
  excludedCandidates: Array<{ id: string; reasonCode: 'role_cap' | 'incompatible' | 'ranking_conflict' | 'duplicate' | 'not_admitted' }>;
  tools: EvidenceWorkspaceToolReceiptV1[];
}

/**
 * Route-neutral analytical intent.  Certified, MetricFlow, governed
 * relational, and exploratory SQL are all compilers of this one program.
 */
export interface AnalyticalProgramV1 {
  version: 1;
  id: string;
  frameFingerprint: string;
  taskIds: string[];
  /** Immutable selected evidence identities. Compilers may only consume these. */
  candidateIds: string[];
  /**
   * Same-snapshot compiler context. This is deliberately separate from the
   * bounded meaning cards: a physical relation/column closure may be needed
   * for a pre-freeze fallback even when it was not sent to the meaning model.
   * It is still immutable, target-scoped by the compiler, and never a license
   * to retrieve or nominate a new business meaning.
   */
  executionCandidateIds?: string[];
  requiredRoles: EvidenceCandidateRoleV1[];
  /** Route-neutral predicate/member contract; never inferred by a compiler. */
  filters: Array<{
    fieldTerms: string[];
    memberIds: string[];
    /** Literal/member binding owned by the program, never guessed by a compiler. */
    value: string;
    operator: 'equals' | 'in' | 'between' | 'contains' | 'unknown';
  }>;
  ranking?: {
    metricTerms: string[];
    direction: 'asc' | 'desc';
    limit: number;
    defaultedLimit?: boolean;
  };
  time?: {
    roleTerms: string[];
    calendarId?: string;
    fiscalPeriodTerms: string[];
    grain?: NonNullable<AnalyticalRequirementSetV1['time']>['grain'];
  };
  comparison?: {
    kind: 'none' | 'period_over_period' | 'segment' | 'baseline';
    terms: string[];
  };
  /** Stable relationship evidence IDs required to combine selected objects. */
  relationshipRequirements: string[];
  outputs: {
    measures: string[];
    dimensions: string[];
    entityDisplayTerms: string[];
    timeGrain?: NonNullable<AnalyticalRequirementSetV1['time']>['grain'];
    limit?: number;
    assertions: Array<'all_requested_measures' | 'all_requested_dimensions' | 'safe_relationship_closure' | 'result_contract'>;
  };
}

/** Runtime-owned selection receipt around the existing immutable RAP. */
export interface ResolvedAnalyticalPlanV2 {
  version: 2;
  programId: string;
  compiler: 'certified' | 'metricflow' | 'governed_relational' | 'exploratory_sql' | 'none';
  selectedTier?: Exclude<AnalyticalCascadeTierV1, 'clarify_or_gap'>;
  planFrozen: boolean;
  reviewRequired: boolean;
  planFingerprint?: string;
}

/** Typed continuation material that survives reload without reparsing prose. */
export interface AskAnalystConversationDeltaV1 {
  version: 1;
  sourceQuestionFingerprint: string;
  selectedStableId?: string;
  selectedResultBindingId?: string;
  partialFrame: Pick<BusinessQuestionFrameV3, 'kind' | 'requirements'>;
}

export interface AskAnalystStateV1 {
  version: 1;
  mode: AskAnalystRuntimeModeV1;
  phase: 'framed' | 'evidence_ready' | 'program_ready' | 'compiled' | 'executed' | 'clarify' | 'blocked';
  frame: BusinessQuestionFrameV3;
  mission: AnalyticalMissionV1;
  workspace: EvidenceWorkspaceV1;
  program: AnalyticalProgramV1;
  resolvedPlan?: ResolvedAnalyticalPlanV2;
  conversationDelta: AskAnalystConversationDeltaV1;
  planningContinuations: number;
  toolCalls: number;
  executionAttempts: number;
  repairAttempts: number;
}

/** A fact-bound answer envelope. Narrative can only summarize these receipts. */
export interface BusinessAnswerV1 {
  version: 1;
  mode: 'facts_only' | 'deterministic_fallback';
  trustState: 'certified' | 'governed' | 'review_required' | 'blocked' | 'not_applicable';
  factIds: string[];
  resultFingerprint?: string;
  /** The accepted answer text, already visible in the corresponding artifact. */
  answer?: string;
  limitations: string[];
  /** Additive per-task aggregate; omitted by legacy/single-task records. */
  taskOutcomeSummary?: AnalyticalTaskOutcomeSummaryV1;
}

/**
 * Content-free runtime projection for diagnostics/trace export. The durable
 * local run retains typed continuation state; this projection intentionally
 * omits raw question, requirement/member values, answer text, SQL, and rows.
 */
export interface AskAnalystDiagnosticStateV1 {
  version: 1;
  mode: AskAnalystRuntimeModeV1;
  phase: AskAnalystStateV1['phase'];
  questionFingerprint: string;
  kind: AnalyticalTurnKind;
  requirementCounts: {
    measures: number;
    dimensions: number;
    entityTerms: number;
    members: number;
    filters: number;
  };
  mission: { mode: AnalyticalMissionV1['mode']; taskCount: number; deferredTaskCount: number; hypothesisCount: number };
  workspace: {
    snapshotId?: string;
    sourceFingerprint?: string;
    admittedCandidateCount: number;
    excludedCandidateCount: number;
    sourceCoverage: Array<{ source: ContextSourceCoverageV1['source']; status: ContextSourceCoverageV1['status']; candidateCount: number }>;
    tools: Array<Pick<EvidenceWorkspaceToolReceiptV1, 'id' | 'kind' | 'status' | 'reasonCode'>>;
  };
  program: {
    id: string;
    taskCount: number;
    candidateCount: number;
    requiredRoles: EvidenceCandidateRoleV1[];
    outputAssertionCount: number;
  };
  resolvedPlan?: ResolvedAnalyticalPlanV2;
  counters: { planningContinuations: number; toolCalls: number; executionAttempts: number; repairAttempts: number };
}

export interface BusinessAnswerDiagnosticProjectionV1 {
  version: 1;
  mode: BusinessAnswerV1['mode'];
  trustState: BusinessAnswerV1['trustState'];
  factIds: string[];
  resultFingerprint?: string;
  limitationCount: number;
}

/** Compact default trace story; advanced spans remain in local observability. */
export interface AskDecisionSummaryV2 {
  version: 2;
  summaryFingerprint: string;
  runtimeMode: AskAnalystRuntimeModeV1;
  whatHappened: string;
  why: string;
  impact: string;
  nextAction: AskTerminalIncidentV1['safeAction'] | 'none';
  selectedCompiler?: ResolvedAnalyticalPlanV2['compiler'];
  programTaskCount: number;
  admittedCandidateCount: number;
  toolCallCount: number;
  executionAttempts: number;
}

/** Additive V5 receipt; V1-V4 remain readable JSON records. */
export interface AgentRunDiagnosticReceiptV5 {
  version: 5;
  runId: string;
  state: AskAnalystDiagnosticStateV1;
  summary: AskDecisionSummaryV2;
  businessAnswer?: BusinessAnswerDiagnosticProjectionV1;
  /** Typed terminal provider evidence from the physical provider boundary. */
  provider?: ProviderFailureDiagnosticV1;
  finalStopReason: string;
}

/**
 * Additive retrieval-first Ask contracts.  V1 records remain the persisted
 * compatibility shape; V2 is the authoritative runtime shape for new turns.
 * The planner gets qualified cards only and cannot turn a raw retrieval term
 * into an execution identity.
 */
export type AskPlanningModeV1 = 'exact_fast_path' | 'initial_planner' | 'targeted_revision' | 'deterministic_binding';

export interface AnalyticalPlannerCandidateCardV1 {
  version: 1;
  id: string;
  qualifiedId?: string;
  /** Compact retrieval label/aliases; never a raw definition dump or row data. */
  label?: string;
  aliases?: string[];
  roles: EvidenceCandidateRoleV1[];
  source: ContextSourceCoverageV1['source'];
  trustTier: 'certified' | 'semantic' | 'governed' | 'exploratory';
  exactMatch: boolean;
  /**
   * The card was retained so the planner can resolve one otherwise-unmet
   * business role. This is admission context only: it is not a declared
   * alias, selected meaning, or execution authorization. The verifier must
   * still prove an exact declaration or one unique inferred substitution.
   */
  admissionReasonCode?: 'candidate_for_unresolved_role';
  unresolvedRoles?: EvidenceCandidateRoleV1[];
  relationHints?: string[];
  /** Present only for a host-authored relationship-path card; exploratory never implies governed authority. */
  relationshipProofClass?: 'governed' | 'exploratory';
}

export interface AnalyticalPlannerRequestV1 {
  version: 1;
  planningMode: AskPlanningModeV1;
  /** Raw business question is intentionally available only at the bounded planner boundary. */
  question: string;
  questionFingerprint: string;
  /**
   * Advisory frame for the planner. It is deliberately not an immutable
   * execution tuple: parser-derived metric/entity/dimension guesses can be
   * corrected only by selecting locally-qualified cards. Explicit user
   * predicates, time, ranking and output constraints remain host verified.
   */
  frame: Pick<BusinessQuestionFrameV4, 'kind' | 'requirements' | 'conversation' | 'planningMode'>;
  /** Host-owned, content-safe hints; they are advisory and never execution authority. */
  advisoryHints: string[];
  sourceCoverage: Array<Pick<ContextSourceCoverageV1, 'source' | 'status'>>;
  /**
   * Bounded server-derived task options. They are not an execution plan: the
   * planner may select one compatible option or two/three independent options,
   * and the verifier later requires every selected ID to freeze and execute.
   */
  taskOptions: Array<{ id: string; kind: AnalyticalTaskV1['kind']; question: string }>;
  /**
   * Present only for the one verifier-directed revision. Prior selected
   * bindings are immutable context; only a card in `targetedCandidates` may
   * fill the verifier-proven missing role.
   */
  priorProposal?: Pick<AnalyticalPlannerProposalV1, 'version' | 'selectedConceptIds' | 'tasks'>;
  priorSelectedConceptIds?: string[];
  verificationFeedback?: ProgramVerificationFeedbackV1;
  /** At most four verifier-admitted cards released for a targeted revision. */
  targetedCandidates?: AnalyticalPlannerCandidateCardV1[];
  candidates: AnalyticalPlannerCandidateCardV1[];
  deadlineMs: number;
}

export type AnalyticalPlannerOperationV1 =
  | 'aggregate'
  | 'rank'
  | 'group'
  | 'filter'
  | 'trend'
  | 'compare'
  | 'project';

export interface AnalyticalPlannerTaskProposalV1 {
  version: 1;
  taskId: string;
  /**
   * Server task options this one program deliberately covers. Omitted means
   * only `taskId`. The verifier must prove complete coverage before a
   * compatible multi-clause Ask may collapse to one execution.
   */
  coveredTaskIds?: string[];
  selectedConceptIds: string[];
  /** Candidate-ID role bindings only; the verifier owns role compatibility. */
  roleBindings: Partial<Record<EvidenceCandidateRoleV1, string[]>>;
  /** Typed analytical intent, never SQL/DQL or a compiler authorization. */
  operations: AnalyticalPlannerOperationV1[];
  preferredCompiler?: 'certified' | 'metricflow' | 'governed_relational' | 'exploratory_sql';
  assumptions?: string[];
}

export interface TargetedContextRequestV1 {
  version: 1;
  /** Exactly one verifier-proven role may be recovered per Ask turn. */
  missingRoles: EvidenceCandidateRoleV1[];
  /**
   * Normalized business terms used to search the existing immutable 32-card
   * workspace. The planner never receives or mints hidden workspace IDs.
   */
  searchTerms?: string[];
  /** Optional references to cards already in the supplied 16-card package. */
  relatedCandidateIds?: string[];
  /**
   * Legacy compatibility carrier. New planner JSON must not use this to name
   * an unadmitted card; the verifier rejects anything outside the planner
   * package before it can be treated as a recovery hint.
   */
  candidateIds?: string[];
  /** Existing same-snapshot relationship paths, bounded to three. */
  relationshipPathIds?: string[];
}

export interface TargetedContextResultV1 {
  version: 1;
  status: 'admitted' | 'unavailable' | 'denied';
  candidateIds: string[];
  relationshipPathIds: string[];
  reasonCode: string;
}

export interface AnalyticalPlannerProposalV1 {
  version: 1;
  tasks: AnalyticalPlannerTaskProposalV1[];
  selectedConceptIds: string[];
  confidence?: 'high' | 'medium' | 'low';
  missingInformation?: string[];
  recovery?: TargetedContextRequestV1;
}

export interface ProgramVerificationFeedbackV1 {
  version: 1;
  status: 'valid' | 'needs_targeted_context' | 'ambiguous' | 'denied' | 'invalid';
  missingRoles: EvidenceCandidateRoleV1[];
  candidateIds: string[];
  reasonCode: string;
}

export interface EvidenceWorkspaceV2 extends Omit<EvidenceWorkspaceV1, 'version' | 'admittedCandidateIds'> {
  version: 2;
  /** The qualified immutable closure; never exceeds 32 candidates. */
  workspaceCandidateIds: string[];
  /** Cards released to the one planner call; never exceeds 16. */
  plannerCandidateIds: string[];
  /** V1 consumers read this as the planner admission. */
  admittedCandidateIds: string[];
  /**
   * Content-safe role admission counters. These are captured at the runtime
   * boundary, rather than reconstructed later from raw retrieval cards, so a
   * V7 trace can distinguish a missing requested role from a role-cap
   * exclusion after reload without retaining business labels or values.
   */
  roleCoverage?: Array<{
    role: EvidenceCandidateRoleV1;
    candidateCount: number;
    state?: EvidenceRoleCoverageStateV1;
  }>;
  targetedContext?: TargetedContextResultV1;
}

export interface BusinessQuestionFrameV4 extends Omit<BusinessQuestionFrameV3, 'version'> {
  version: 4;
  planningMode: AskPlanningModeV1;
}

export interface AnalyticalProgramV2 extends Omit<AnalyticalProgramV1, 'version' | 'candidateIds' | 'executionCandidateIds'> {
  version: 2;
  /** Validated meaning cards selected by the planner. */
  candidateIds: string[];
  /** Full immutable qualified workspace consumed by compilers. */
  executionCandidateIds: string[];
  plannerCandidateIds: string[];
  workspaceCandidateIds: string[];
  /**
   * Provider-neutral business interpretation accepted by the deterministic
   * verifier. IDs remain canonicalized below; the planner never gains join,
   * grain, additivity, trust, or compiler authority.
   */
  planner: {
    version: 1;
    tasks: Array<{
      taskId: string;
      coveredTaskIds?: string[];
      selectedConceptIds: string[];
      roleBindings: Partial<Record<EvidenceCandidateRoleV1, string[]>>;
      operations: AnalyticalPlannerOperationV1[];
      preferredCompiler?: AnalyticalPlannerTaskProposalV1['preferredCompiler'];
      assumptions: string[];
    }>;
    confidence?: AnalyticalPlannerProposalV1['confidence'];
    missingInformation: string[];
  };
}

/**
 * Planner V2 is the post-verification business interpretation.  The provider
 * V1 wire format remains readable during rollout, but a frozen program does
 * not preserve a provider-selected relationship/join binding: relationship
 * closure is compiler-owned evidence, not business meaning.
 */
export type AnalyticalPlannerBusinessRoleV2 = Exclude<EvidenceCandidateRoleV1, 'relationship'>;

export interface AnalyticalPlannerTaskV2 {
  taskId: string;
  coveredTaskIds?: string[];
  selectedConceptIds: string[];
  roleBindings: Partial<Record<AnalyticalPlannerBusinessRoleV2, string[]>>;
  operations: AnalyticalPlannerOperationV1[];
  preferredCompiler?: AnalyticalPlannerTaskProposalV1['preferredCompiler'];
  assumptions: string[];
}

export interface AnalyticalPlannerInterpretationV2 {
  version: 2;
  /** The source is diagnostic only; it cannot change authority after verify. */
  source: 'provider' | 'deterministic' | 'legacy_adapter';
  tasks: AnalyticalPlannerTaskV2[];
  confidence?: AnalyticalPlannerProposalV1['confidence'];
  missingInformation: string[];
}

/**
 * One host-derived safe relationship closure.  `candidateId` refers to the
 * compact same-snapshot path card; `relationshipEvidence` contains only its
 * canonical proof IDs.  A planner never selects either value.
 */
export interface CanonicalRelationshipPathReceiptV1 {
  version: 1;
  candidateId: string;
  proofClass: 'governed' | 'exploratory';
  relationshipEvidence: string[];
}

/**
 * Lossless typed inputs that survive planner/legacy adapter conversions. The
 * words remain local program data; diagnostic projections expose counts only.
 */
export interface AnalyticalInputAtomV1 {
  version: 1;
  source: 'current_question' | 'trusted_successful_task';
  role: Exclude<EvidenceCandidateRoleV1, 'relationship' | 'context'> | 'filter';
  term: string;
  required: true;
}

/** A host-validated anchor from a successful prior task/result. */
export interface TrustedAnalyticalTaskAnchorV1 {
  version: 1;
  /**
   * `member_binding` retains a validated selected result value.
   * `analytical_shape` retains only a successful task's metric/projection
   * shape for an explicit additive follow-up such as "add region here".
   * Neither form is provider supplied.
   */
  kind?: 'member_binding' | 'analytical_shape';
  displayDimension?: string;
  values: string[];
  /** Existing successful-task shape; no rows or free-form prior answer. */
  measures?: string[];
  dimensions?: string[];
  sourceTurnId?: string;
  resultFingerprint?: string;
}

/**
 * The authoritative frozen Ask contract. V1/V2 remain valid persisted JSON
 * readers; all new authoritative turns construct V3 before compiler entry.
 */
export interface AnalyticalProgramV3 extends Omit<AnalyticalProgramV2, 'version' | 'planner'> {
  version: 3;
  planner: AnalyticalPlannerInterpretationV2;
  /** Compiler-owned path receipts; never provider-selected join instructions. */
  relationshipPaths: CanonicalRelationshipPathReceiptV1[];
  /** Current-turn atoms cannot be erased by a compatibility MeaningResolution. */
  inputAtoms: AnalyticalInputAtomV1[];
  /** Validated prior-result anchors are distinct from free-text member guesses. */
  trustedTaskAnchors: TrustedAnalyticalTaskAnchorV1[];
}

export interface AskAnalystConversationDeltaV2 extends Omit<AskAnalystConversationDeltaV1, 'version' | 'partialFrame'> {
  version: 2;
  partialFrame: Pick<BusinessQuestionFrameV4, 'kind' | 'requirements' | 'planningMode'>;
  programId?: string;
}

export interface AskAnalystStateV2 extends Omit<AskAnalystStateV1, 'version' | 'frame' | 'workspace' | 'program' | 'conversationDelta'> {
  version: 2;
  frame: BusinessQuestionFrameV4;
  workspace: EvidenceWorkspaceV2;
  program: AnalyticalProgramV2;
  conversationDelta: AskAnalystConversationDeltaV2;
  planningMode: AskPlanningModeV1;
  plannerRevisionCount: number;
  planningReceipt?: AskAnalystPlanningReceiptV1;
}

/** New authoritative state; V2 remains readable for interrupted old runs. */
export interface AskAnalystStateV3 extends Omit<AskAnalystStateV2, 'version' | 'program'> {
  version: 3;
  program: AnalyticalProgramV3;
}

export interface AskAnalystPlanningReceiptV1 {
  version: 1;
  mode: AskPlanningModeV1;
  plannerCalls: number;
  revisionCalls: number;
  verification: ProgramVerificationFeedbackV1;
}

export interface BusinessAnswerV2 extends Omit<BusinessAnswerV1, 'version'> {
  version: 2;
  /** Facts and result fingerprint are the only authoritative narrative source. */
  factBinding: 'validated_result_facts' | 'deterministic_fallback';
}

export interface AgentRunDiagnosticReceiptV6 extends Omit<AgentRunDiagnosticReceiptV5, 'version'> {
  version: 6;
  planning?: AskAnalystPlanningReceiptV1;
  /** Role coverage is count-only: raw terms and candidate labels stay Advanced-only. */
  roleCoverage: Array<{
    role: EvidenceCandidateRoleV1;
    candidateCount: number;
    /** `alternatives` is a clarification state, not a proof of business meaning. */
    state?: EvidenceRoleCoverageStateV1;
  }>;
  /** The exact pre-execution cascade record behind the selected compiler. */
  cascade: {
    attempts: Array<Pick<CascadeTierAttemptV1, 'tier' | 'outcome' | 'planFrozen'>>;
    selectedTier?: AnalyticalCascadeDecisionV1['selectedTier'];
    stopReason?: string;
    planFrozen: boolean;
  };
  /** Present only for a typed terminal incident; never inferred from prose. */
  origin?: Pick<AskTerminalIncidentV1, 'boundary' | 'origin' | 'impact'>;
  connection: { attempted: boolean };
  execution: { attempts: number };
  /**
   * Content-safe physical counters. Research roots aggregate server-owned
   * child execution counters (with durable receipt fallback for older child
   * records); the root dispatch ledger remains the authority for provider
   * egress so child spans are never double-counted.
   */
  telemetry?: AgentRunTelemetryV1;
  facts: { factCount: number; resultFingerprint?: string };
  safeNextAction: AskDecisionSummaryV2['nextAction'];
  /** Compact default story; raw spans and candidate lifecycle remain Advanced-only. */
  story: Array<{
    stage: 'retrieval' | 'role_coverage' | 'planner' | 'verification' | 'targeted_recovery' | 'cascade' | 'freeze' | 'connection' | 'execution' | 'facts';
    status: 'completed' | 'skipped' | 'blocked' | 'unavailable';
    reasonCode: string;
  }>;
}


/** New runtime values are V2; V1 values remain readable from old JSON runs. */
export type AskAnalystState = AskAnalystStateV1 | AskAnalystStateV2 | AskAnalystStateV3;
export type AnalyticalProgram = AnalyticalProgramV1 | AnalyticalProgramV2 | AnalyticalProgramV3;
export type BusinessQuestionFrame = BusinessQuestionFrameV3 | BusinessQuestionFrameV4;
export type BusinessAnswer = BusinessAnswerV1 | BusinessAnswerV2;

export interface AnalyticalTurnPlanV1 {
  version: 1;
  turnId?: string;
  question: string;
  kind: AnalyticalTurnKind;
  /** Natural-language turns use one bounded interpretation call by default. */
  meaningCallBudget: 0 | 1;
  meaningCallReason: 'explicit_binding' | 'conversation_only' | 'candidate_interpretation' | 'frozen_research_child';
  snapshotId?: string;
  sourceFingerprint?: string;
  taskIds: string[];
  tasks: AnalyticalTaskV1[];
  authorityOrder: Array<'certified' | 'semantic' | 'governed_relational' | 'generated'>;
  /** This is set only after compatibility and authorization have passed. */
  frozen: boolean;
  conversationTurnId?: string;
  parentRunId?: string;
}

export interface AnalyticalAnswerSectionV1 {
  version: 1;
  id: string;
  taskId: string;
  status: 'answered' | 'partial' | 'gap' | 'blocked';
  answer?: string;
  result?: CanonicalQueryResultV1;
  gap?: AnalyticalCoverageGapV1;
  factIds: string[];
  trustState: 'certified' | 'governed' | 'review_required' | 'not_applicable' | 'blocked';
}

export interface AnalyticalTurnAnswerV1 {
  version: 1;
  answer: string;
  sections: AnalyticalAnswerSectionV1[];
  followUps: string[];
  facts: string[];
}

/**
 * Small, explainable intent vocabulary used before the physical plan exists.
 * It is deliberately not a second semantic matcher: candidate identity still
 * comes from retrieval plus the bounded meaning call. These helpers only turn
 * a request into a task graph and output contract, so a compound question can
 * report partial success instead of collapsing the whole turn to one error.
 */
export function inferAnalyticalTurnKind(question: string): AnalyticalTurnKind {
  const text = question.toLowerCase();
  if (/\b(hello|hi|hey|thanks|thank you|good morning|good afternoon)\b/.test(text)) return 'conversation';
  if (/\b(why|root cause|driver|diagnos|anomal|changed)\b/.test(text)) return 'diagnosis';
  if (/\b(research|investigate|deep dive|tell a story|surrounding context)\b/.test(text)) return 'research';
  if (/\b(compare|versus|vs\.?|difference)\b/.test(text)) return 'comparison';
  if (/\b(top|bottom|highest|lowest|rank)\b/.test(text)) return 'ranking';
  if (/\b(by|per|over time|trend|monthly|daily|weekly)\b/.test(text)) return 'breakdown';
  if (/\b(what is|what are|define|definition|meaning)\b/.test(text) && !/\b(total|revenue|count|sales|amount)\b/.test(text)) return 'definition';
  if (/\b(region|country|state|city|name|label|email|category|product|customer)\b/.test(text)
    && /\b(where|which|what|who)\b/.test(text)) return 'lookup';
  return 'aggregation';
}

export type RoleBalancedEvidenceCandidate = {
  id: string;
  qualifiedId?: string;
  kind?: string;
  semanticObjectType?: string;
  name?: string;
  aliases?: string[];
  /** Source-authored semantic or physical value type when the snapshot has it. */
  dataType?: string;
  dimensions?: string[];
  /** Documented physical columns; the evidence behind the `relation` role. */
  columns?: Array<{ name: string; type?: string; description?: string }>;
  timeGrains?: string[];
  relationshipEvidence?: string[];
  /**
   * Host-only runtime-value proof attached to one qualified physical column.
   * It is intentionally structural here so the retrieval selector can reserve
   * the field for a current literal without exposing values to a provider.
   */
  safeValueEvidence?: Array<{ normalizedValue?: string; value?: string }>;
  relevanceScore?: number;
  exactMatch?: boolean;
  compatibility?: string;
  /**
   * Snapshot-authored compatibility declarations. These are deliberately not
   * folded into general lexical identity: only the categorical-dimension lane
   * may use the narrowly typed declarations below.
   */
  compatibilityFacts?: string[];
  /**
   * A narrowly-scoped host extension derived from the same immutable semantic
   * capability snapshot.  It is not a lexical synonym or model assertion:
   * the retriever may mint it only when one MetricFlow-capable grouping field
   * is uniquely available for the requested business role.  Keeping the
   * source metric and exact dimension identity here lets routing record the
   * assumption while the frozen capability still owns execution safety.
   */
  sameSnapshotRoleExtension?: SameSnapshotRoleExtensionV1;
  analyticalCapability?: {
    dimensions?: Array<{ dimensionId?: string }>;
    timeDimensions?: Array<{ dimensionId?: string }>;
  };
};

export interface SameSnapshotRoleExtensionV1 {
  version: 1;
  role: 'categorical_dimension';
  requestedTerm: string;
  metricId: string;
  dimensionId: string;
  /**
   * `sole_metricflow_grouping_dimension` is the deliberately narrow
   * geography recovery path. `exact_metricflow_grouping_dimension` is an
   * equally snapshot-bound extension for a current-question categorical
   * phrase whose exact, qualified dimension is declared by the admitted
   * metric capability. Neither value permits lexical joins or a model-owned
   * field identity.
   */
  basis: 'sole_metricflow_grouping_dimension' | 'exact_metricflow_grouping_dimension';
}

function normalizeRequirementTerm(value: string): string {
  return value.toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueRequirementTerms(values: Array<string | undefined>): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeRequirementTerm)
    .filter(Boolean))];
}

/**
 * Entity/display terms are represented in the historical `dimensions` seed
 * so ranking plans can retain their requested grain. They must not consume
 * the separate categorical-dimension admission lane. For example, in "top
 * customers by product category", `customer` is the entity/rank role while
 * `product category` is the required categorical grouping role.
 */
export function categoricalDimensionRequirementTerms(
  requirements: Pick<AnalyticalRequirementSetV1, 'dimensions' | 'entityTerms' | 'entityDisplayTerms'>,
): string[] {
  const entityTerms = new Set(uniqueRequirementTerms([
    ...requirements.entityTerms,
    ...requirements.entityDisplayTerms,
  ]));
  return uniqueRequirementTerms(requirements.dimensions)
    .filter((term) => !entityTerms.has(term));
}

/**
 * A small, typed vocabulary bridge for categorical field identities. It is
 * intentionally not a general synonym engine: only the field-kind suffix is
 * canonicalized, while the scoped business noun must still match. Thus
 * `product category` can bind the snapshot-declared `product_type`, whereas
 * `customer_type` cannot satisfy it. A bare `category` remains potentially
 * ambiguous when more than one qualified `*_type` field exists.
 */
export function categoricalDimensionTermsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeRequirementTerm(left);
  const normalizedRight = normalizeRequirementTerm(right);
  if (!normalizedLeft || !normalizedRight) return false;
  const phraseMatch = (a: string, b: string): boolean => a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`);
  if (phraseMatch(normalizedLeft, normalizedRight)) return true;
  const canonicalizeKind = (value: string): string => value
    .replace(/\bcategories\b/g, 'type')
    .replace(/\bcategory\b/g, 'type');
  return phraseMatch(canonicalizeKind(normalizedLeft), canonicalizeKind(normalizedRight));
}

function isTemporalTerm(term: string): boolean {
  return /^(?:date|day|week|month|quarter|year|fy\d{2,4}|fiscal year|fiscal quarter)$/.test(term);
}

/**
 * Parser output occasionally retains the grammatical wrapper around an
 * aggregation (for example "count for each customer") as though it were a
 * second metric.  The stable requirement is `count`; the rest describes the
 * requested grain and is already represented by the entity/dimension roles.
 * Keeping the wrapper makes a physically complete customer table look
 * incomplete and prematurely terminates the pre-freeze cascade.
 */
function isStructuralMeasurePhrase(value: string): boolean {
  const term = normalizeRequirementTerm(value);
  return /^(?:count|sum|total|average|avg)?\s*for\s+(?:each|every)\s+(?:account|customer|client|company|product|order|item|row)s?$/.test(term)
    || /^for\s+(?:each|every)\s+(?:account|customer|client|company|product|order|item|row)s?$/.test(term);
}

const AGGREGATION_REQUIREMENT_OPERATORS = new Set([
  'total', 'sum', 'average', 'avg', 'minimum', 'min', 'maximum', 'max',
]);

/**
 * A parsed intent may preserve every grammatical fragment of an aggregate
 * request ("total", "total supply cost", "supply", and "product").  Those
 * fragments are useful while retrieving, but they are not independent
 * physical requirements. Normalize only the explicit aggregation + grouping
 * construction so ordinary named metrics such as `total_revenue` keep their
 * authored identity.
 */
function typedAggregationRequirementRoles(question: string): {
  measure: string;
  dimension: string;
} | undefined {
  const match = /\b(?:total|sum|average|avg|minimum|min|maximum|max)\s+([a-z][a-z0-9_ -]{1,60}?)\s+(?:per|by|for\s+each)\s+([a-z][a-z0-9_-]*)\b/i.exec(question);
  const measure = match?.[1] ? normalizeRequirementTerm(match[1]) : '';
  const dimension = match?.[2] ? normalizeRequirementTerm(match[2]) : '';
  return measure && dimension ? { measure, dimension } : undefined;
}

function normalizedTypedAggregationRequirements(input: {
  question: string;
  measures: string[];
  dimensions: string[];
}): { measures: string[]; dimensions: string[] } {
  const typed = typedAggregationRequirementRoles(input.question);
  if (!typed) return input;
  const measureParts = new Set(typed.measure.split(' ').filter(Boolean));
  const measures = uniqueRequirementTerms([
    typed.measure,
    ...input.measures.filter((value) => {
      const normalized = normalizeRequirementTerm(value);
      return normalized !== typed.measure
        && !AGGREGATION_REQUIREMENT_OPERATORS.has(normalized)
        && normalized !== `total ${typed.measure}`
        && !(normalized.split(' ').length === 1 && measureParts.has(normalized));
    }),
  ]);
  const dimensions = uniqueRequirementTerms([
    typed.dimension,
    ...input.dimensions.filter((value) => {
      const normalized = normalizeRequirementTerm(value);
      return normalized !== typed.dimension
        && !(normalized.split(' ').length === 1 && measureParts.has(normalized));
    }),
  ]);
  return { measures, dimensions };
}

/**
 * Keep grammatical wrappers out of the physical tuple. In particular, a
 * parser can return `sales based on the region` as a dimension for a simple
 * revenue-by-region request. That is neither a business dimension nor an
 * object ZLens may report as absent.
 */
function normalizeAnalyticalDimensionTerms(question: string, values: readonly string[]): string[] {
  const hasRegion = /\b(?:by|based\s+on(?:\s+the)?|across|per)\s+(?:the\s+)?region\b/i.test(question);
  const hasProductCategory = /\bproduct\s+categor(?:y|ies)\b/i.test(question);
  // A planner can surface the noun from a projected field as a grouping
  // dimension (for example `product` from “with product ID and product
  // price”).  An output is not a `by product` group. Keep the noun only when
  // the reader actually supplied a grouping construction; otherwise the
  // host-owned row-level/output tuple would acquire a fake dimension and
  // make an otherwise single-table exploratory plan ambiguous.
  const outputRoots = new Set(explicitOutputTerms(question)
    .map((term) => term.replace(/\s+(?:id|name|price)$/i, '').trim())
    .filter(Boolean));
  const isExplicitGroupingRoot = (term: string): boolean => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b(?:by|per|across|for\\s+each)\\s+(?:the\\s+)?${escaped}(?:s)?\\b`, 'i').test(question);
  };
  const normalized = uniqueRequirementTerms([...values])
    .filter((value) => !/\b(?:revenue|sales)\b.*\b(?:based\s+on|by)\b.*\bregion\b/.test(value))
    .filter((value) => !(hasProductCategory && /^(?:product|category)$/.test(value)))
    .filter((value) => !outputRoots.has(value) || isExplicitGroupingRoot(value));
  return uniqueRequirementTerms([
    ...normalized,
    ...(hasRegion ? ['region'] : []),
    ...(hasProductCategory ? ['product category'] : []),
  ]);
}

function explicitOutputTerms(question: string): string[] {
  const terms = [...question.matchAll(/\b(?:order|product|customer|account)\s+(?:id|name|price)\b/gi)]
    .map((match) => match[0] ?? '');
  return uniqueRequirementTerms(terms);
}

/**
 * Normalize grammatical aggregation wrappers before they become a plan
 * requirement.  Retrieval/parser output is allowed to retain useful search
 * phrases, but an immutable plan must never treat "count for each customer"
 * or "for each customer" as separate physical measures.  The grouping entity
 * is represented by the dimension/entity roles instead.
 *
 * `order count for each customer` is the common prose form for the authored
 * `order_count` semantic measure at customer grain.  Keep that compound
 * identity intact: reducing it to the generic aggregation `count` makes the
 * unfiltered `Orders` MetricFlow metric indistinguishable from scoped metrics
 * such as `Drink Orders` and `Food Orders`.  The grouping entity is still
 * represented by the dimension/entity roles rather than becoming another
 * measure.
 */
export function normalizeAnalyticalMeasureTerms(
  question: string,
  values: readonly string[],
  options: { preserveIdentity?: boolean } = {},
): string[] {
  // A parser often singularizes the business alias `sales` into `sale`.  That
  // is not a second measure beside revenue: it is the same current-question
  // request.  Canonicalize only that standalone vocabulary alias here; named
  // measures such as `sales_tax` or `sales_pipeline` keep their identity.
  const canonicalMeasureAlias = (value: string): string => {
    const normalized = normalizeRequirementTerm(value);
    return normalized === 'sale' || normalized === 'sales' ? 'revenue' : value;
  };
  const terms = values
    .map(canonicalMeasureAlias)
    .filter((value) => !isStructuralMeasurePhrase(value));
  // An inherited measure can already be a stable semantic/dbt identity. Keep
  // that identity intact for the planner/meaning handoff; matching and display
  // have their own normalizers. Rewriting `total_consumption_units` to prose
  // here lost the only sticky reference a measure-less refinement carried.
  if (options.preserveIdentity) {
    const seen = new Set<string>();
    return terms.flatMap((value) => {
      const exact = value.replace(/\s+/g, ' ').trim();
      const normalized = normalizeRequirementTerm(exact);
      if (!exact || !normalized || seen.has(normalized)) return [];
      seen.add(normalized);
      return [exact];
    });
  }
  return uniqueRequirementTerms(terms);
}

/**
 * Parsed measure phrases are the most specific typed evidence available before
 * meaning resolution. A lexical root is useful only when the parser found no
 * phrase that already owns it: adding both `beverage revenue` and `revenue`
 * turns one requested metric into two and incorrectly rejects a block whose
 * own declared output is `beverage_revenue`. The same holds for `order count`
 * and its generic `count` root; the authored compound is retained and owns
 * that generic aggregation vocabulary for this question.
 */
function nonRedundantLexicalMeasureTerms(
  parsedMeasures: readonly string[],
  question: string,
): string[] {
  const compoundTerms = explicitQuestionCompoundMeasureTerms(question);
  const lexical = [
    ...compoundTerms,
    ...['revenue', 'refund', 'refunds', 'bcm', 'run rate', 'count'],
  ]
    // `BCM run rate` is one named business measure, not the independent
    // lexical roots `bcm` and `run rate`.
    .filter((term) => !compoundTerms.some((compound) => compound !== term && compound.includes(term)))
    .filter((term) => new RegExp(`\\b${term.replace(' ', '\\s+')}\\b`, 'i').test(question));
  return lexical.filter((term) => {
    // A multi-word lexical root such as `run rate` must be considered owned
    // by `BCM run rate`. The old word-by-word comparison only worked for a
    // one-word root and added both phrases as independent measures, which
    // prevented an otherwise exact semantic metric from binding without a
    // provider. Treat the lexical phrase as redundant when all of its tokens
    // are already present in one parsed measure. Keep the narrow refund
    // singular/plural equivalence so existing vocabulary remains stable.
    const lexicalTokens = normalizeRequirementTerm(term)
      .split(' ')
      .filter(Boolean)
      .map((token) => token === 'refunds' ? 'refund' : token);
    return !parsedMeasures.some((measure) => {
      const measureTokens = new Set(
        normalizeRequirementTerm(measure)
          .split(' ')
          .filter(Boolean)
          .map((token) => token === 'refunds' ? 'refund' : token),
      );
      return lexicalTokens.every((token) => measureTokens.has(token));
    });
  });
}

/**
 * Preserve explicit multi-word business measures when a retrieval parser
 * emits only a suffix such as `rate`. This is intentionally a compact,
 * vocabulary-backed list rather than a speculative phrase synthesizer: it
 * upgrades only a phrase the user actually wrote and whose complete meaning
 * is common in the governed analytics catalog.
 */
function explicitQuestionCompoundMeasureTerms(question: string): string[] {
  return [
    ...(/\borders?\s+count\b/i.test(question) ? ['order count'] : []),
    ...(/\bbcm\s+run\s+rate\b/i.test(question) ? ['bcm run rate'] : []),
  ];
}

/**
 * A parser fragment must not become a second measure when the source question
 * contains an explicit compound business measure that subsumes it. For
 * example, `rate` plus `BCM run rate` is one requested metric. We only remove
 * strict token subsets of a phrase explicitly present in the user question;
 * independent named measures remain separate requirements.
 */
function preferExplicitQuestionCompoundMeasures(terms: readonly string[], question: string): string[] {
  const compounds = explicitQuestionCompoundMeasureTerms(question)
    .map((term) => ({ term, tokens: normalizeRequirementTerm(term).split(' ').filter(Boolean) }));
  if (compounds.length === 0) return uniqueRequirementTerms([...terms]);
  return uniqueRequirementTerms([...terms]).filter((term) => {
    const normalized = normalizeRequirementTerm(term);
    const tokens = normalized.split(' ').filter(Boolean);
    return !compounds.some((compound) => normalized !== compound.term
      && tokens.length > 0
      && tokens.length < compound.tokens.length
      && tokens.every((token) => compound.tokens.includes(token)));
  });
}

/**
 * A ranking question can contain a business qualifier immediately before the
 * ranked entity (for example, "BCM customers") as well as the measure that
 * actually orders the result ("highest revenue").  The retrieval parser keeps
 * both phrases because both are useful for recall, but they are not equivalent
 * plan requirements.  Prefer a direct ranking clause over the broad parser
 * hint before any candidate is admitted as a metric.
 *
 * This deliberately remains narrow.  It only disambiguates when the parser
 * supplied competing measures and the user also wrote an explicit comparator;
 * parser-absent and already-unambiguous ranking requests retain their existing
 * normal meaning-resolution path.
 */
function explicitRankingMeasureTerms(
  question: string,
  parsedMeasures: readonly string[],
): string[] {
  const parsed = uniqueRequirementTerms([...parsedMeasures]);
  if (parsed.length < 2) return [];
  const phrases: string[] = [];
  const endOfMeasure = String.raw`(?=\s+(?:across|among|for|per|in|where|during|over|with|that|which|who|and|or)\b|[?.!,;]|$)`;
  for (const pattern of [
    new RegExp(String.raw`\b(?:highest|lowest|most|least)\s+(?:the\s+)?([a-z][a-z0-9_. -]{0,80}?)${endOfMeasure}`, 'gi'),
  ]) {
    for (const match of question.matchAll(pattern)) {
      const phrase = normalizeRequirementTerm(match[1] ?? '');
      if (phrase && !isTemporalTerm(phrase)) phrases.push(phrase);
    }
  }
  const direct = uniqueRequirementTerms(phrases);
  if (direct.length === 0) return [];

  // Preserve the parser's more stable authored phrase when it is the same
  // measure.  This avoids replacing `net revenue` with a looser lexical root,
  // while still removing an entity modifier such as `BCM` in `BCM customers`.
  const matchedParsed = parsed.filter((measure) => direct.some((phrase) =>
    measure === phrase || measure.includes(phrase) || phrase.includes(measure)));
  return matchedParsed.length > 0 ? matchedParsed : direct;
}

/**
 * Parse only stable analytical roles. This is purposefully narrower than an
 * LLM interpretation: unknown business phrases remain available to the normal
 * bounded meaning resolver instead of being guessed here.
 */
export function buildAnalyticalRequirementSet(input: {
  question: string;
  parsedIntent?: Partial<{
    measures: string[];
    dimensions: string[];
    filters: Array<{ field: string; value: string }>;
    timeGrain: string;
    limit: number;
  }>;
}): AnalyticalRequirementSetV1 {
  const question = input.question;
  const lower = question.toLowerCase();
  // Parser/retrieval evidence may be broad or stale. A requirement set is
  // host authority, so only source-question-grounded refinements may enter it.
  const parsed = currentQuestionGroundedParsedIntent(question, input.parsedIntent);
  const grainMatch = lower.match(/\b(?:by|per|each)\s+(day|week|month|quarter|year)\b|\b(monthly|weekly|quarterly|yearly|daily)\b/i);
  const grainWord = (grainMatch?.[1] ?? grainMatch?.[0]?.replace(/ly\b/i, '') ?? '').toLowerCase();
  const grain = grainWord === 'daily' ? 'day'
    : grainWord === 'weekly' ? 'week'
      : grainWord === 'monthly' ? 'month'
        : grainWord === 'quarterly' ? 'quarter'
          : grainWord === 'yearly' ? 'year'
            : /^(day|week|month|quarter|year)$/.test(grainWord) ? grainWord as AnalyticalRequirementSetV1['time'] extends { grain?: infer G } ? G : never
              : undefined;
  const fiscal = lower.match(/\bfy\s?(\d{2,4})\b|\bfiscal\s+year\s+(\d{2,4})\b/i);
  const fiscalPeriod = fiscal ? `FY${fiscal[1] ?? fiscal[2]}`.toUpperCase() : undefined;
  const ranking = lower.match(/\b(top|bottom|highest|lowest|most|least|expensive|cheapest)\s*(\d+)?\b/i);
  const leadingOrdinalRanking = lower.match(/\b(\d+)\s+(?:most|least|expensive|cheapest)\b/i);
  const requestedDimensions = normalizeAnalyticalDimensionTerms(question, parsed?.dimensions ?? []);
  const entityTerms = uniqueRequirementTerms([
    ...((lower.match(/\b(?:account|accounts|customer|customers|client|clients|company|companies)\b/g) ?? [])),
  ]).map((term) => term.replace(/s$/, ''));
  // A ranking result needs a human-readable entity output even when the
  // wording starts with "what" rather than "who" or "which".  Treat the
  // entity's display key as a required role for `top accounts` / `top
  // customers`; an entity key, owner field, or sentiment attribute is not a
  // substitute for the result label.
  const entityDisplayTerms = (/\b(?:who|which)\b/i.test(question) || Boolean(ranking && entityTerms.length > 0))
    ? uniqueRequirementTerms(entityTerms.map((term) => `${term} name`))
    : [];
  // "this amount" is a deictic reference to a prior result, not a request to
  // choose an `amount` metric. Treating it as a new explicit measure made a
  // compositional follow-up reject every otherwise-valid display/predicate
  // option. Concrete metric words remain typed requirements, including the
  // common revenue/refunds pair used by multi-metric requests.
  const deicticAmount = /\b(?:this|that|the|such)\s+amount\b/i.test(question);
  // `sales` is a common business synonym for revenue. Do not add the broad
  // revenue root merely because a named metric contains it (`beverage revenue`)
  // or an exact certified block would suddenly look multi-metric.
  const salesIsRevenueAlias = /\bsales\b/i.test(question);
  const parsedMeasures = normalizeAnalyticalMeasureTerms(question, parsed?.measures ?? [])
    .filter((measure) => !/\bsales\s+based\s+on\b/.test(normalizeRequirementTerm(measure)));
  const parsedMeasuresWithLexicalTerms = preferExplicitQuestionCompoundMeasures(
    uniqueRequirementTerms([
      ...parsedMeasures,
      ...nonRedundantLexicalMeasureTerms(parsedMeasures, question),
      ...(salesIsRevenueAlias ? ['revenue'] : []),
      ...(/\b(?:most|highest|expensive)\b.*\bproduct\s+price\b|\bproduct\s+price\b.*\b(?:most|highest|expensive)\b/i.test(question)
        ? ['product price']
        : []),
      ...(!deicticAmount
        && /\bamount\b/i.test(question)
        && !parsedMeasures.some((measure) => normalizeRequirementTerm(measure).split(' ').includes('amount'))
        ? ['amount']
        : []),
    ]),
    question,
  );
  const typedRequirements = normalizedTypedAggregationRequirements({
    question,
    measures: parsedMeasuresWithLexicalTerms,
    dimensions: requestedDimensions.filter((term) => !isTemporalTerm(term)),
  });
  const explicitRankingMeasures = ranking
    ? explicitRankingMeasureTerms(question, typedRequirements.measures)
    : [];
  // A direct ranking clause is the explicit analytical measure.  Keep broad
  // parser/retrieval phrases out of the execution tuple so a contextual term
  // cannot become a second ranking metric or force a false clarification.
  const measures = explicitRankingMeasures.length > 0
    ? explicitRankingMeasures
    : typedRequirements.measures;
  // Retrieval/parser hints sometimes repeat an explicit measure as a
  // dimension (for example `revenue` in "show revenue by region").  Keep
  // the user-authored measure authoritative and remove only an exact
  // normalized duplicate.  A broader substring rule would incorrectly drop
  // legitimate dimensions such as `product revenue category`.
  const measureTerms = new Set(measures.map((measure) => normalizeRequirementTerm(measure)));
  const dimensions = typedRequirements.dimensions.filter((dimension) =>
    !measureTerms.has(normalizeRequirementTerm(dimension)));
  const rankingMetricTerms = ranking ? measures : [];
  // A context planner supplies its own safety default (`topN: 10`) for bare
  // rankings. It is a useful execution bound, but it is not user intent. Read
  // an explicit count only from the actual question so the cascade/answer
  // receipt can disclose that a bare “top” used DQL's default rather than
  // misleadingly presenting it as a requested limit.
  const wordRankingLimit = lower.match(/\b(?:top|bottom|highest|lowest|most|least|expensive|cheapest)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:most|least|expensive|cheapest)\b/i)?.slice(1).find(Boolean)?.toLowerCase();
  const explicitWordLimit: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const explicitLimit = ranking?.[2]
    ? Number(ranking[2])
    : leadingOrdinalRanking?.[1] ? Number(leadingOrdinalRanking[1])
    : wordRankingLimit ? explicitWordLimit[wordRankingLimit] : undefined;
  // A bounded window is a restriction on WHEN, distinct from grouping grain.
  // It gets its own typed clause; without one, "last two months" had nowhere
  // to live and silently vanished between the question and the query.
  const window = parseAnalyticalTimeWindow(question);
  const time = grain || fiscalPeriod || window
    ? {
        role: grain ? 'time_axis' as const : 'time_filter' as const,
        ...(grain ? { grain: grain as NonNullable<AnalyticalRequirementSetV1['time']>['grain'] } : {}),
        ...(window ? { window } : {}),
        ...(fiscalPeriod ? { fiscalPeriod } : {}),
        requiresDeclaredFiscalCalendar: Boolean(fiscalPeriod),
      }
    : undefined;
  return {
    version: 1,
    measures,
    dimensions,
    entityTerms,
    entityDisplayTerms,
    // A parser filter is useful but not the sole authority for an explicit
    // current-turn member. Preserve bounded literal atoms too; downstream
    // planning must still bind them to qualified snapshot evidence before a
    // field/value predicate can be frozen.
    memberTerms: uniqueRequirementTerms([
      ...(parsed?.filters ?? []).map((filter) => filter.value),
      ...currentQuestionLiteralMemberTerms(question),
    ]),
    ...(explicitOutputTerms(question).length > 0 ? { outputTerms: explicitOutputTerms(question) } : {}),
    ...(unboundMeasureQualifierTerms(question, measures).length > 0
      ? { unboundMeasureQualifiers: unboundMeasureQualifierTerms(question, measures) }
      : {}),
    ...(/\bindividual\b/i.test(question) ? { grain: 'individual' as const } : {}),
    ...(ranking
      ? {
          ranking: {
            metricTerms: rankingMetricTerms,
            entityTerms,
            direction: /bottom|lowest|least|cheapest/i.test(ranking[1] ?? '') ? 'bottom' : 'top',
            limit: explicitLimit ?? 10,
            defaultedLimit: explicitLimit === undefined,
          },
        }
      : {}),
    ...(time ? { time } : {}),
  };
}

const DECLARED_CANDIDATE_ROLE_ALIASES: ReadonlyArray<readonly [EvidenceCandidateRoleV1, readonly string[]]> = [
  ['metric', ['metric']],
  ['entity_key', ['entity key', 'entity id']],
  ['entity_label', ['entity label', 'display key', 'display label']],
  ['categorical_dimension', ['categorical dimension', 'category dimension']],
  ['time_dimension', ['time dimension', 'date dimension']],
  ['member', ['member']],
  ['relationship', ['relationship']],
  ['context', ['context']],
];

/**
 * Only an authored declaration may let an object fill an additional role.  A
 * metric's capability lists dimensions, time grains, and relationship paths it
 * *uses*; that does not make the metric itself a display key, time column, or
 * relationship candidate.  Compatibility facts are snapshot-authored metadata
 * and therefore the only additive role declaration accepted here.
 */
function explicitlyDeclaredCandidateRoles(candidate: RoleBalancedEvidenceCandidate): Set<EvidenceCandidateRoleV1> {
  const declared = new Set<EvidenceCandidateRoleV1>();
  for (const fact of candidate.compatibilityFacts ?? []) {
    const normalized = normalizeRequirementTerm(fact);
    if (!/^(?:(?:candidate|evidence|intrinsic|supported) )?roles?\b/.test(normalized)) continue;
    const suffix = normalized.replace(/^(?:(?:candidate|evidence|intrinsic|supported) )?roles?\s*/, '');
    for (const [role, aliases] of DECLARED_CANDIDATE_ROLE_ALIASES) {
      if (aliases.some((alias) => new RegExp(`(?:^| )${alias}(?:$| )`).test(suffix))) declared.add(role);
    }
  }
  return declared;
}

function intrinsicCandidateIdentity(candidate: RoleBalancedEvidenceCandidate): string {
  return uniqueRequirementTerms([
    candidate.id,
    candidate.qualifiedId,
    candidate.name,
  ]).join(' ');
}

/**
 * Keep account display-key selection separate from common account attributes.
 * Candidate names originate in dbt/semantic identifiers, so underscores and
 * dots must be normalized before testing (`account_sentiment_rating` is just
 * as much an attribute as "Account Sentiment Rating").
 */
export function hasEntityAttributeTerm(value: string): boolean {
  return /\b(?:owner|sentiment|email)\b/i.test(normalizeRequirementTerm(value));
}

export function isEntityAttributeCandidate(candidate: RoleBalancedEvidenceCandidate): boolean {
  return hasEntityAttributeTerm(intrinsicCandidateIdentity(candidate));
}

/**
 * Time is a type-level role, not a lexical synonym. Semantic indexes from
 * dbt/MetricFlow commonly retain all members as `dimension`, so a typed
 * `opened_date` must not also enter the ordinary categorical/geographic
 * fallback lane. A card-level semantic-time class or physical/semantic type
 * is authoritative. `timeGrains` alone is deliberately not: older retrieval
 * adapters can inherit a model/metric's supported grains onto unrelated
 * entity and display cards. Names are used only for legacy cards with no
 * source type.
 */
function candidateHasDeclaredTimeRole(candidate: RoleBalancedEvidenceCandidate): boolean {
  if (candidate.semanticObjectType === 'time_dimension') return true;
  const dataType = normalizeRequirementTerm(candidate.dataType ?? '');
  return /(?:^| )(?:date|datetime|timestamp|timestamptz|timestampntz|time)(?:$| )/.test(dataType);
}

function candidateUsesLegacyTimeNameFallback(candidate: RoleBalancedEvidenceCandidate): boolean {
  // A supplied type is authoritative even when a legacy name happens to
  // contain `date` (for example a text display label). A missing/empty
  // time-grain list is not a positive type declaration, so old untyped cards
  // retain this safe fallback.
  if (normalizeRequirementTerm(candidate.dataType ?? '')) return false;
  return /(?:\bdate\b|\btime\b|\bmonth\b|\bquarter\b|\byear\b|\bfiscal\b|\bperiod\b)/
    .test(intrinsicCandidateIdentity(candidate));
}

/** Classify the role an already-qualified candidate may fill. */
export function evidenceCandidateRoles(candidate: RoleBalancedEvidenceCandidate): EvidenceCandidateRoleV1[] {
  const identity = intrinsicCandidateIdentity(candidate);
  const roles = new Set<EvidenceCandidateRoleV1>();
  const physicalColumn = candidate.kind === 'sql_column';
  // An explicit semantic metric remains a metric even if an old index also
  // carries an imprecise type. Conversely, a typed semantic time dimension
  // such as `metric_time` must not become a metric merely because its local
  // compiler name contains the word "metric". The latter was causing V2 to
  // admit the time card as a metric and discard its declared grains before
  // semantic validation.
  const explicitMetricCandidate = candidate.kind === 'semantic_metric'
    || candidate.semanticObjectType === 'metric'
    || candidate.semanticObjectType === 'measure';
  const sourceDeclaredTimeRole = !explicitMetricCandidate && candidateHasDeclaredTimeRole(candidate);
  const metricCandidate = explicitMetricCandidate
    || (!sourceDeclaredTimeRole && (
      /\bmetric\b/.test(identity)
      || (physicalColumn && /\b(?:revenue|amount|count|rate|bcm|spend|cost|margin|total)\b/.test(identity))
    ));
  // A temporal type/grain is stronger than an authored compatibility-role
  // label. Index migrations can leave an old `roles categorical dimension`
  // fact on a date field, but allowing that contradictory fact back into the
  // ordinary inference lane turns time fields into false geography choices.
  // Metrics retain their explicit compatibility roles because capability
  // metadata is not the metric object's own temporal identity.
  const declaredTimeRole = !metricCandidate && sourceDeclaredTimeRole;
  const legacyTimeName = !metricCandidate
    && !declaredTimeRole
    && candidateUsesLegacyTimeNameFallback(candidate);
  const temporalCandidate = declaredTimeRole || legacyTimeName;
  if (metricCandidate) roles.add('metric');

  // Capability metadata belongs to the metric's execution contract.  It must
  // not be treated as the metric object's own entity, display, time, or join
  // identity.  Explicit snapshot metadata is the only exception.
  if (!metricCandidate) {
    if (candidate.semanticObjectType === 'entity'
      || /(?:^| )(?:account|customer|client|company) (?:id|key)\b/.test(identity)
      || /\bentity\b/.test(identity)) roles.add('entity_key');
    // Entity identity (for example `semantic:entity:account`) proves an
    // entity key/grain but not the field a person can read in a ranking
    // result.  Require an intrinsic display-name declaration instead of
    // allowing every identifier that merely contains "account" or
    // "customer" to fill the entity-label role.  Explicit authored role
    // facts below remain the only additive exception.
    if (/\b(?:account|customer|client|company)\b/.test(identity)
      && /\b(?:name|label|display)\b/.test(identity)
      && !hasEntityAttributeTerm(identity)) roles.add('entity_label');
    if (temporalCandidate) roles.add('time_dimension');
    if ((candidate.kind === 'dql_modeling' && (candidate.relationshipEvidence?.length ?? 0) > 0)
      || /\b(?:relationship|join|bridge)\b/.test(identity)) roles.add('relationship');
    // `semantic_member` intentionally collapses dimensions, entities, models,
    // and saved queries in older local indexes. Only a real (or legacy
    // unclassified) dimension can be a categorical field. A semantic model or
    // entity is execution context, never a user-visible grouping dimension.
    const semanticDimension = candidate.semanticObjectType === 'dimension'
      || (candidate.kind === 'semantic_member' && candidate.semanticObjectType === undefined);
    // A time dimension can be grouped at a time grain, but it is not an
    // ordinary categorical/geographic alternative for a business term such
    // as `region`. Keep the role sets mutually exclusive here; the semantic
    // compiler still receives the same qualified identity when time is asked.
    if (!temporalCandidate
      && (semanticDimension
        || (physicalColumn && /\b(?:competitor|region|category|segment|status|type|owner|sentiment|active|product|description)\b/.test(identity)))) {
      roles.add('categorical_dimension');
    }
    if (candidate.kind === 'semantic_member' && candidate.semanticObjectType === 'member') roles.add('member');
  }
  for (const role of explicitlyDeclaredCandidateRoles(candidate)) {
    // Do not let a stale/contradictory authored compatibility declaration
    // reverse a source-authored temporal type or legacy temporal identity.
    // The temporal role remains visible; only the conflicting ordinary
    // categorical role is rejected.
    if (temporalCandidate && role === 'categorical_dimension') continue;
    roles.add(role);
  }
  // A relation with documented columns is a queryable thing in its own right,
  // not merely ambient context. The role is unconditional here; the selector
  // decides whether THIS relation's columns match THIS request.
  if ((candidate.kind === 'dbt_model' || candidate.kind === 'sql_table' || candidate.kind === 'dbt_source')
    && (candidate.columns?.length ?? 0) > 0) roles.add('relation');
  if (candidate.kind === 'sql_column' || candidate.kind === 'dbt_model' || candidate.kind === 'sql_table') roles.add('context');
  if (roles.size === 0) roles.add('context');
  return [...roles];
}

/**
 * Does this relation's OWN column vocabulary cover one of the requested terms?
 *
 * "net arr by customer account" is answered by a table that has a net-ARR
 * column and an account-name column. Judging that table by its name and
 * description alone — which is all the selector could see — is why the one
 * relation that could answer the question ranked below a support report whose
 * title happened to contain the same word.
 */
function relationColumnsMatchTerms(
  candidate: RoleBalancedEvidenceCandidate,
  terms: string[],
): boolean {
  const columns = candidate.columns;
  if (!columns?.length || terms.length === 0) return false;
  const normalizedColumns = uniqueRequirementTerms(columns.map((column) => column.name));
  return terms.some((term) => {
    const needle = term.trim();
    if (needle.length < 3) return false;
    return normalizedColumns.some((column) => column === needle
      || column.includes(needle)
      || needle.includes(column));
  });
}

function candidateMatchesTerms(
  candidate: RoleBalancedEvidenceCandidate,
  terms: string[],
  options: { categoricalDimension?: boolean; relationColumns?: boolean } = {},
): boolean {
  if (terms.length === 0) return false;
  const identity = uniqueRequirementTerms([
    candidate.id,
    candidate.qualifiedId,
    candidate.name,
    ...(candidate.aliases ?? []),
    ...(candidate.dimensions ?? []),
  ]).join(' ');
  if (terms.some((term) => identity.includes(term) || term.includes(identity))) return true;
  if (options.relationColumns === true && relationColumnsMatchTerms(candidate, terms)) return true;
  if (options.categoricalDimension === true
    && terms.some((term) => categoricalDimensionTermsMatch(term, identity))) return true;
  return options.categoricalDimension === true
    && candidateMatchesCategoricalDimensionRequirement(candidate, terms);
}

/**
 * A metric's attached dimensions, source model, and relationship path are
 * execution context.  They are deliberately useful for binding a complete
 * plan, but must never make one metric match the name of another.  In
 * particular, `bcm_run_rate` from an `account_revenue` model is not the
 * `revenue` ranking measure merely because its source-model identity contains
 * that word.
 */
function metricCandidateIdentityTerms(candidate: RoleBalancedEvidenceCandidate): string[] {
  const terminalMetricIdentity = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const namespaceLeaf = value.split(':').filter(Boolean).at(-1) ?? value;
    const metricLeaf = namespaceLeaf.split(/[./]/).filter(Boolean).at(-1) ?? namespaceLeaf;
    return normalizeRequirementTerm(metricLeaf);
  };
  return uniqueRequirementTerms([
    // Metadata cards sometimes use their source-qualified identifier as the
    // display label (for example `account_revenue.bcm_run_rate`). Treat that
    // exactly like an ID: its terminal metric leaf is intrinsic identity and
    // its model prefix is execution context. A human label such as `Total
    // Revenue` has no namespace separator and is retained intact.
    terminalMetricIdentity(candidate.name),
    ...(candidate.aliases ?? []).map(terminalMetricIdentity),
    terminalMetricIdentity(candidate.id),
    terminalMetricIdentity(candidate.qualifiedId),
  ]);
}

function metricCandidateMatchesTerms(
  candidate: RoleBalancedEvidenceCandidate,
  terms: readonly string[],
): boolean {
  const identities = metricCandidateIdentityTerms(candidate);
  return terms.some((term) => {
    const normalizedTerm = normalizeRequirementTerm(term);
    if (!normalizedTerm) return false;
    return identities.some((identity) => identity === normalizedTerm
      || identity.endsWith(` ${normalizedTerm}`)
      || normalizedTerm.endsWith(` ${identity}`));
  });
}

/**
 * A direct ranking measure is authoritative for metric admission.  Other
 * retrieved metrics remain visible in the lifecycle receipt, but they cannot
 * become a second metric choice merely because they are correlated with the
 * entity phrase in the question.
 */
export function candidateConflictsWithExplicitRankingMeasure(
  candidate: RoleBalancedEvidenceCandidate,
  requirements: AnalyticalRequirementSetV1,
): boolean {
  const metricTerms = requirements.ranking?.metricTerms ?? [];
  return metricTerms.length > 0
    && evidenceCandidateRoles(candidate).includes('metric')
    && !metricCandidateMatchesTerms(candidate, metricTerms);
}

/**
 * A categorical dimension may satisfy a requested business role only through
 * its own snapshot-authored declaration. In particular, `location_name` is
 * not a synonym for `region`: it can fill a region lane only when metadata
 * explicitly says `alternative-for:region`, or when the dimension itself is
 * declared with the semantic geography role. This protects admission from
 * broad lexical geography expansion while retaining role-balanced recall.
 */
export function candidateMatchesCategoricalDimensionRequirement(
  candidate: Pick<RoleBalancedEvidenceCandidate, 'compatibilityFacts' | 'sameSnapshotRoleExtension'>,
  terms: readonly string[],
): boolean {
  const extension = candidate.sameSnapshotRoleExtension;
  if (extension?.role === 'categorical_dimension'
    && (extension.basis === 'sole_metricflow_grouping_dimension'
      || extension.basis === 'exact_metricflow_grouping_dimension')) {
    const requested = new Set(terms.map(normalizeRequirementTerm).filter(Boolean));
    if (requested.has(normalizeRequirementTerm(extension.requestedTerm))) return true;
  }
  const facts = new Set((candidate.compatibilityFacts ?? [])
    .map(normalizeRequirementTerm)
    .filter(Boolean));
  if (facts.size === 0) return false;

  const requestedRoles = [...new Set(terms.flatMap((term) => {
    const normalized = normalizeRequirementTerm(term);
    const terminal = normalized.split(' ').at(-1) ?? '';
    return [normalized, terminal].filter(Boolean);
  }))];
  const hasDeclaredAlternative = requestedRoles.some((role) =>
    facts.has(`alternative for ${role}`)
    || facts.has(`dimension alternative for ${role}`));
  if (hasDeclaredAlternative) return true;

  const declaredGeography = facts.has('semantic role geography')
    || facts.has('semantic geography role');
  return declaredGeography && requestedRoles.some((role) =>
    role === 'region' || role === 'geography' || role === 'geographic');
}

/**
 * Keep an internal retrieval result broad while making the provider package
 * role-balanced. Exact/alias matches stay pinned; each requested role gets up
 * to two candidates before relevance fills remaining cards.
 */
export function selectRoleBalancedMeaningCandidates<T extends RoleBalancedEvidenceCandidate>(input: {
  candidates: T[];
  requirements: AnalyticalRequirementSetV1;
  maxCandidates?: number;
  /** Use before any kind cap to reserve exact/required-role cards. */
  pinOnly?: boolean;
}): T[] {
  // This selector is used twice by Ask Analyst Runtime: once to make the
  // immutable 32-item execution workspace and again to make the compact
  // 16-card planner package.  Keep the ceiling here rather than allowing a
  // caller to accidentally turn a retrieval result into an unbounded prompt
  // or compiler closure.
  const max = Math.max(1, Math.min(32, Math.floor(input.maxCandidates ?? 16)));
  const ranked = [...new Map(input.candidates
    .filter((candidate) => candidate.id.trim() && candidate.compatibility !== 'incompatible')
    .map((candidate) => [candidate.id, candidate] as const)).values()]
    .sort((left, right) => Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
      || (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0)
      || left.id.localeCompare(right.id));
  const selected: T[] = [];
  const add = (candidate: T | undefined): void => {
    if (!candidate || candidateConflictsWithExplicitRankingMeasure(candidate, input.requirements)) return;
    if (selected.length < max && !selected.some((item) => item.id === candidate.id)) selected.push(candidate);
  };
  const categoricalTerms = categoricalDimensionRequirementTerms(input.requirements);
  // A relation is judged against everything the question asked for, because a
  // single table often supplies the measure AND the label AND the breakdown.
  const relationTerms = uniqueRequirementTerms([
    ...(input.requirements.ranking?.metricTerms ?? []),
    ...input.requirements.measures,
    ...input.requirements.entityTerms,
    ...input.requirements.entityDisplayTerms,
    ...categoricalTerms,
  ]);
  const servesRequestedRole = (candidate: T): boolean => {
    const roles = evidenceCandidateRoles(candidate);
    const metricTerms = input.requirements.ranking?.metricTerms.length
      ? input.requirements.ranking.metricTerms
      : input.requirements.measures;
    if (roles.includes('metric') && candidateMatchesTerms(candidate, metricTerms)) return true;
    // An entity term such as "account" is deliberately insufficient for an
    // attribute (Account Owner Email) to displace the requested display key.
    // Only an actual entity-label candidate may satisfy this binding.
    if (roles.includes('entity_key') && candidateMatchesTerms(candidate, input.requirements.entityTerms)) return true;
    if (roles.includes('entity_label') && candidateMatchesTerms(candidate, [
      ...input.requirements.entityTerms,
      ...input.requirements.entityDisplayTerms,
    ])) return true;
    if (roles.includes('time_dimension') && Boolean(input.requirements.time)) return true;
    if (roles.includes('categorical_dimension')
      && categoricalTerms.length > 0
      && candidateMatchesTerms(candidate, categoricalTerms, { categoricalDimension: true })) return true;
    if (roles.includes('member') && input.requirements.memberTerms.length > 0
      && candidateMatchesTerms(candidate, input.requirements.memberTerms)) return true;
    if (roles.includes('categorical_dimension') && input.requirements.memberTerms.length > 0
      && candidateHasSafeValueForMemberTerms(candidate, input.requirements.memberTerms)) return true;
    if (roles.includes('relationship')
      && (input.requirements.dimensions.length > 1 || input.requirements.entityTerms.length > 0)) return true;
    if (roles.includes('relation') && relationColumnsMatchTerms(candidate, relationTerms)) return true;
    return false;
  };
  for (const candidate of ranked.filter((candidate) => candidate.exactMatch)) {
    // In a pin-only prepass, an exact match is only a pin when it serves a
    // requested analytical role. Otherwise a pile of exact members consumes
    // the whole package before the requested metric/entity can be reserved.
    if (input.pinOnly && !servesRequestedRole(candidate)) continue;
    add(candidate);
  }
  const required: Array<{
    role: EvidenceCandidateRoleV1;
    terms: string[];
    limit: number;
    categorical?: boolean;
    relationColumns?: boolean;
  }> = [
    // An explicit ranking measure is never displaced by correlated metric
    // variants. Two cards leave room for a compatible canonical/alias pair.
    { role: 'metric', terms: input.requirements.ranking?.metricTerms.length ? input.requirements.ranking.metricTerms : input.requirements.measures, limit: 2 },
    { role: 'entity_key', terms: input.requirements.entityTerms, limit: 1 },
    { role: 'entity_label', terms: [...input.requirements.entityTerms, ...input.requirements.entityDisplayTerms], limit: 2 },
    // Each requested breakdown gets two candidates, bounded to four total so
    // a product/category request cannot be crowded out by customer variants.
    ...categoricalTerms.slice(0, 2).map((term) => ({ role: 'categorical_dimension' as const, terms: [term], limit: 2, categorical: true })),
    { role: 'time_dimension', terms: input.requirements.time ? [input.requirements.time.grain ?? 'time'] : [], limit: 2 },
    { role: 'member', terms: input.requirements.memberTerms, limit: 2 },
    { role: 'relationship', terms: input.requirements.dimensions.length > 1 || input.requirements.entityTerms.length > 0 ? ['relationship'] : [], limit: 2 },
    // A physical relation whose own columns cover the requested measure or
    // entity is the shortest path to a governed-relational or exploratory
    // answer, and it is the card a planner most needs when no metric exists.
    // Three slots: enough for a fact table, a dimension table and one rival.
    {
      role: 'relation',
      terms: relationTerms,
      limit: 3,
      relationColumns: true,
    },
  ];
  for (const { role, terms, limit, categorical, relationColumns } of required) {
    // No requested categorical dimension means that high-scoring arbitrary
    // members are noise, not a role reservation. This is the subtle path that
    // used to admit Account Owner and Sentiment immediately after Account Name.
    if (terms.length === 0) continue;
    let admitted = 0;
    for (const candidate of ranked) {
      if (admitted >= limit || selected.length >= max) break;
      const roles = evidenceCandidateRoles(candidate);
      const safePhysicalMember = role === 'member'
        && roles.includes('categorical_dimension')
        && candidateHasSafeValueForMemberTerms(candidate, terms);
      if (!roles.includes(role) && !safePhysicalMember) continue;
      // "top accounts" needs the account display key, not any field whose
      // label happens to contain account. Once a display candidate is
      // available, owner/e-mail/sentiment attributes are neither the entity
      // role nor a useful categorical reservation unless the user explicitly
      // named that attribute. This runs during the pre-cap pin pass so noisy
      // same-kind cards cannot enter through the categorical role.
      const explicitlyRequestsAttribute = hasEntityAttributeTerm([
        ...input.requirements.dimensions,
        ...input.requirements.entityTerms,
        ...input.requirements.entityDisplayTerms,
      ].join(' '));
      const hasRequestedEntityLabel = ranked.some((item) =>
        evidenceCandidateRoles(item).includes('entity_label')
        && candidateMatchesTerms(item, [
          ...input.requirements.entityTerms,
          ...input.requirements.entityDisplayTerms,
        ]));
      if (role === 'categorical_dimension'
        && hasRequestedEntityLabel
        && !explicitlyRequestsAttribute
        && isEntityAttributeCandidate(candidate)) continue;
      // For entity labels, role is more important than a lexical owner/email
      // hit. For all other roles, prefer an identity matching the requested
      // business term but retain a role candidate when the request is terse.
      if (terms.length > 0 && !safePhysicalMember
        && !candidateMatchesTerms(candidate, terms, {
          categoricalDimension: categorical === true,
          relationColumns: relationColumns === true,
        })
        && role !== 'time_dimension' && role !== 'relationship' && role !== 'entity_label') continue;
      add(candidate);
      admitted += 1;
    }
  }
  if (!input.pinOnly) {
    for (const candidate of ranked) add(candidate);
  }
  return selected;
}

/** Exact snapshot-value equality only; no lexical/synonym member matching. */
function candidateHasSafeValueForMemberTerms(
  candidate: RoleBalancedEvidenceCandidate,
  terms: readonly string[],
): boolean {
  const values = candidate.safeValueEvidence ?? [];
  return terms.some((term) => {
    const normalized = normalizeRequirementTerm(term);
    return Boolean(normalized) && values.some((value) =>
      normalizeRequirementTerm(value.normalizedValue ?? value.value ?? '') === normalized);
  });
}

/**
 * Build the Ask execution workspace before planner admission.  It is the
 * only helper that may create the 32-card closure; all later compiler paths
 * must intersect with this immutable result rather than reaching back into a
 * broad snapshot.
 */
export function selectRoleBalancedWorkspaceCandidates<T extends RoleBalancedEvidenceCandidate>(input: {
  candidates: T[];
  requirements: AnalyticalRequirementSetV1;
}): T[] {
  return selectRoleBalancedMeaningCandidates({
    candidates: input.candidates,
    requirements: input.requirements,
    maxCandidates: 32,
  });
}

export function classifyProviderFailure(input: {
  message?: string;
  code?: string;
  phase?: ProviderFailureDiagnosticV1['phase'];
  providerFingerprint?: string;
  modelFingerprint?: string;
  baseOriginFingerprint?: string;
}): ProviderFailureDiagnosticV1 {
  const text = `${input.code ?? ''} ${input.message ?? ''}`.toLowerCase();
  const cause: ProviderFailureCauseV1 = /cancel/.test(text) ? 'cancelled'
    : /dispatch.?budget|provider_dispatch_budget/.test(text) ? 'dispatch_budget'
      : /deadline.?insufficient|admission|soft.?target|provider_result_rows_(?:blocked|limit_exceeded)/.test(text) ? 'admission_denied'
        : /run.?deadline|time limit/.test(text) ? 'run_deadline'
          : /timeout|timed out/.test(text) ? 'provider_timeout'
            : /401|403|api key|unauthori[sz]ed|auth(?:entication)?/.test(text) ? 'authentication'
              : /model(?:[ _-]+|\s+).*not[ _-]?found|unknown model|model_not_found|404/.test(text) ? 'model_not_found'
                : /429|rate[ _-]?limit|too many requests/.test(text) ? 'rate_limited'
                  : /\b5\d{2}\b|gateway/.test(text) ? 'gateway'
                    : /econn|network|fetch failed|not reachable|connection refused/.test(text) ? 'network'
                      : 'unknown';
  const retryable = cause === 'rate_limited' || cause === 'gateway' || cause === 'network' || cause === 'provider_timeout';
  const safeAction: ProviderFailureDiagnosticV1['safeAction'] = retryable ? (cause === 'rate_limited' ? 'wait_and_retry' : 'retry_same_provider')
    : cause === 'authentication' || cause === 'model_not_found' ? 'fix_provider_configuration'
      : cause === 'cancelled' ? 'none'
        : 'inspect_run';
  const httpStatusClass = /\b(?:401|403|404|429)\b/.test(text) ? '4xx' as const
    : /\b5\d{2}\b/.test(text) ? '5xx' as const
      : undefined;
  return {
    version: 1,
    cause,
    phase: input.phase ?? 'unknown',
    retryable,
    safeAction,
    ...(httpStatusClass ? { httpStatusClass } : {}),
    ...(input.providerFingerprint ? { providerFingerprint: input.providerFingerprint } : {}),
    ...(input.modelFingerprint ? { modelFingerprint: input.modelFingerprint } : {}),
    ...(input.baseOriginFingerprint ? { baseOriginFingerprint: input.baseOriginFingerprint } : {}),
  };
}

export function buildAnalyticalCascadeDecision(input: Omit<AnalyticalCascadeDecisionV1, 'version'>): AnalyticalCascadeDecisionV1 {
  // A frozen tier is the end of the authoritative cascade.  Later tiers are
  // neither evaluated nor eligible as a fallback, even when the selected
  // compiler, adapter, or execution target subsequently fails.  Retaining
  // pre-built later attempts in the receipt makes a truthful post-freeze
  // failure look like a silent downgrade and invalidates portable replay.
  // Normalize at the shared construction boundary so every router path and
  // every emitted trace receives the same immutable attempt prefix.
  const attempts: CascadeTierAttemptV1[] = [];
  for (const inputAttempt of input.attempts) {
    const attempt: CascadeTierAttemptV1 = {
      ...inputAttempt,
      version: 1,
      candidateIds: [...new Set(inputAttempt.candidateIds)].slice(0, 32),
      // Decision-level `planFrozen` is the server-owned source of truth. A
      // legacy caller may have stamped it only on the decision; keep the
      // selected attempt coherent before enforcing the immutable prefix.
      planFrozen: inputAttempt.planFrozen
        || (input.planFrozen === true && input.selectedTier === inputAttempt.tier),
    };
    attempts.push(attempt);
    if (attempt.planFrozen) break;
  }
  return {
    version: 1,
    ...input,
    sourceCoverage: input.sourceCoverage.map((coverage) => ({
      ...coverage,
      version: 1,
      candidateIds: [...new Set(coverage.candidateIds)].slice(0, 32),
    })),
    attempts,
    ...(input.terminalGap ? {
      terminalGap: {
        version: 1,
        code: 'MISSING_RELATIONSHIP',
        requirement: 'certified_relationship_or_allocation_proof',
        witnessCandidateIds: [...new Set(input.terminalGap.witnessCandidateIds)].sort().slice(0, 32),
      },
    } : {}),
  };
}

/**
 * `Regarding: "Mr. Matthew Meyer"` and friends — a short label, a colon, and a
 * quoted value, with nothing else in the clause. Deliberately narrow: it must
 * be the WHOLE clause and the value must be quoted, so an ordinary question
 * that happens to contain a colon is untouched.
 */
const ANNOTATION_CLAUSE = /^\s*[A-Za-z][A-Za-z ]{0,24}:\s*["“'‘][^"”'’]*["”'’]\s*$/;

export function splitAnalyticalTasks(question: string): string[] {
  // The separator belongs to the SPLIT, not to the clause. Carrying it through
  // produced a child task whose question was literally
  // `" then "What customer type is Wesley Jenkins` — quote, connector and all —
  // which then failed to resolve and surfaced that punctuation to the reader as
  // the task title.
  const leadingJunk = /^(?:[\s"'“”‘’,:;.\-]+|\b(?:then|and|also)\b)+/i;
  const trailingJunk = /[\s"'“”‘’,:;.\-]+$/;
  const raw = question
    .split(/\s*(?:\?|;|\band then\b|\balso\b)\s*/i)
    .flatMap((part) => part.split(/\s+\band\s+(?=(?:what|who|which|show|list|tell|give|how|why)\b)/i));
  // A `Label: "value"` clause is an ANNOTATION, not a question. The composer
  // appends `Regarding: "<selected row>"` when the reader follows up on
  // something they clicked, and splitting on the `?` before it turned that
  // referent into a task of its own — titled `Regarding: "Mr. Matthew Meyer`,
  // which then "answered" by computing an unrelated maximum over the rows still
  // on screen. Context says WHO the real task is about; it is never a task.
  // Filtered before the junk strip, which would unbalance the quotes.
  const asked = raw.filter((part) => !ANNOTATION_CLAUSE.test(part));
  const parts = (asked.length > 0 ? asked : raw)
    .map((part) => part.replace(leadingJunk, '').replace(trailingJunk, '').trim())
    .filter(Boolean);
  // "… and give me top 5 rows" is a RANKING CLAUSE of the request before it,
  // not an independent question — it names no measure, no entity, nothing to
  // ask about on its own. Splitting it minted a task titled "give me top 5
  // rows" that could never resolve, and the phantom task then spent the
  // dispatch budget the real question needed. A fragment that is nothing but
  // shape vocabulary folds back into its predecessor.
  const merged: string[] = [];
  for (const part of parts) {
    if (merged.length > 0 && isPureShapeClause(part)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} and ${part}`;
      continue;
    }
    merged.push(part);
  }
  return merged.length > 0 ? merged : [question.trim()];
}

/**
 * Does this fragment carry ONLY result-shape vocabulary (ranking, limit,
 * projection), with no subject of its own? Checked by removal: strip the
 * shape words, counts and connectives; a real question leaves a residue.
 */
function isPureShapeClause(fragment: string): boolean {
  const lower = fragment.toLowerCase();
  if (!/\b(?:top|bottom|first|last|highest|lowest|limit|rows?|results?)\b/.test(lower)) return false;
  const residue = lower
    .replace(/\b(?:and|then|please|give|me|show|list|just|only|the|a|an|top|bottom|first|last|highest|lowest|best|worst|limit|it|to|of|them|rows?|results?|records?|entries|items?|values?)\b/g, ' ')
    .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();
  return residue.length === 0;
}

export function buildAnalyticalTaskGraph(input: {
  question: string;
  /**
   * Explicit user-selected mode. Research is a root workflow, not merely a
   * higher reasoning effort: its evidence ledger and synthesis must retain the
   * whole question rather than treating story clauses as independent asks.
   */
  mode?: 'ask' | 'research';
  candidateIds?: string[];
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ field: string; value: string }>;
  inheritedBindings?: Array<{ id: string; value: string; source: 'conversation' | 'result' | 'user' }>;
  maxTasks?: number;
}): { kind: AnalyticalTurnKind; tasks: AnalyticalTaskV1[]; partial: boolean } {
  // Research is an explicit mode boundary. Investigative wording in an
  // ordinary Ask can influence its operations but must not silently switch it
  // to the multi-branch Research budget/execution contract.
  const inferredKind = inferAnalyticalTurnKind(input.question);
  const rootKind = input.mode === 'research'
    ? 'research'
    : inferredKind === 'research'
      ? 'diagnosis'
      : inferredKind;
  // A research turn may later create bounded evidence branches, but that is a
  // research planner's job. Splitting at ingress loses the surrounding story
  // before it has an opportunity to reason about it.
  const sourceClauses = rootKind === 'research'
    ? [input.question.trim()]
    : splitAnalyticalTasks(input.question);
  const taskCap = Math.max(1, Math.min(6, input.maxTasks ?? 6));
  // Keep the overflow visible to the runtime.  The prior `slice()` silently
  // accepted the first three ordinary-Ask clauses and returned `partial:
  // false`, which could make a four-question request look successfully
  // answered after only three frozen programs.  Ordinary Ask must stop before
  // planning/execution in that case; explicit Research owns broader branching.
  const partial = sourceClauses.length > taskCap;
  const clauses = sourceClauses.slice(0, taskCap);
  const candidateIds = [...new Set((input.candidateIds ?? []).filter((id) => id.trim()))];
  const metrics = [...new Set((input.metrics ?? []).filter((metric) => metric.trim()))];
  const dimensions = [...new Set((input.dimensions ?? []).filter((dimension) => dimension.trim()))];
  const filters = input.filters ?? [];
  const inheritedBindings = input.inheritedBindings ?? [];
  const unboundTasks = clauses.map((clause, index): AnalyticalTaskV1 => {
    const inferredClauseKind = rootKind === 'research' ? 'research' : inferAnalyticalTurnKind(clause);
    const kind = rootKind === 'research'
      ? 'research'
      : inferredClauseKind === 'research'
        ? 'diagnosis'
        : inferredClauseKind;
    const research = rootKind === 'research';
    const taskKind: AnalyticalTaskKind = research
      ? 'research_branch'
      : kind === 'lookup'
        ? 'attribute_lookup'
        : kind === 'breakdown'
          ? 'breakdown'
          : kind === 'comparison'
            ? 'comparison'
            : kind === 'ranking'
              ? 'ranking'
              : kind === 'definition'
                ? 'definition'
                : 'aggregation';
    return {
      version: 1,
      id: `task-${index + 1}`,
      kind: taskKind,
      question: clause,
      dependencies: index === 0 ? [] : [],
      output: {
        metrics,
        dimensions,
        filters,
        ...(kind === 'ranking' ? { order: 'desc' as const } : {}),
      },
      status: 'planned',
      candidateIds,
      inheritedBindings,
    };
  });
  const tasks = bindTopRankedRegionDependencies(unboundTasks);
  return {
    kind: rootKind === 'research' ? 'research' : tasks.length > 1 ? 'compound' : rootKind,
    tasks,
    partial,
  };
}

const TOP_RANKED_REGION_RE = /(?:\b(?:top|highest|most)\b[^?.!]{0,72}\bregions?\b|\bregions?\b[^?.!]{0,72}\b(?:top|highest|most)\b)/i;
const DEPENDENT_REGION_CUSTOMERS_RE = /\b(?:that|this|same)\s+region\b/i;

/**
 * Recognise only the demonstrated two-step dependency. Broader pronoun
 * resolution belongs to the normal conversation layer; turning every compound
 * question into a dependency would serialise unrelated work and invent filters.
 */
function bindTopRankedRegionDependencies(tasks: AnalyticalTaskV1[]): AnalyticalTaskV1[] {
  return tasks.map((task, index) => {
    if (!DEPENDENT_REGION_CUSTOMERS_RE.test(task.question) || !/\bcustomers?\b/i.test(task.question)) return task;
    const parent = tasks.slice(0, index).reverse().find((candidate) => TOP_RANKED_REGION_RE.test(candidate.question));
    if (!parent) return task;
    const dependency: AnalyticalTaskDependencyV1 = {
      version: 1,
      kind: 'top_ranked_region',
      sourceTaskId: parent.id,
      targetDimension: 'region',
    };
    return { ...task, dependencies: [parent.id], dependency };
  });
}

export function buildAnalyticalTurnPlan(input: {
  question: string;
  mode?: 'ask' | 'research';
  turnId?: string;
  candidateIds?: string[];
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ field: string; value: string }>;
  inheritedBindings?: Array<{ id: string; value: string; source: 'conversation' | 'result' | 'user' }>;
  zeroCallReason?: AnalyticalTurnPlanV1['meaningCallReason'];
  frozen?: boolean;
  snapshotId?: string;
  sourceFingerprint?: string;
}): AnalyticalTurnPlanV1 {
  const graph = buildAnalyticalTaskGraph(input);
  const zeroCall = input.zeroCallReason === 'explicit_binding'
    || input.zeroCallReason === 'conversation_only'
    || input.zeroCallReason === 'frozen_research_child';
  return {
    version: 1,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    question: input.question,
    kind: graph.kind,
    meaningCallBudget: zeroCall ? 0 : 1,
    meaningCallReason: input.zeroCallReason ?? 'candidate_interpretation',
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    ...(input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {}),
    taskIds: graph.tasks.map((task) => task.id),
    tasks: graph.tasks,
    authorityOrder: ['certified', 'semantic', 'governed_relational', 'generated'],
    frozen: input.frozen === true,
  };
}

export function summarizeTaskOutcomes(tasks: AnalyticalTaskV1[]): {
  status: 'completed' | 'partial' | 'gap' | 'blocked';
  completed: string[];
  gaps: string[];
} {
  const completed = tasks.filter((task) => task.status === 'completed').map((task) => task.id);
  const gaps = tasks.filter((task) => task.status === 'gap' || task.status === 'blocked').map((task) => task.id);
  const status = completed.length === tasks.length && tasks.length > 0
    ? 'completed'
    : completed.length > 0
      ? 'partial'
      : gaps.some((id) => tasks.find((task) => task.id === id)?.status === 'blocked')
        ? 'blocked'
        : 'gap';
  return { status, completed, gaps };
}

export interface CanonicalQueryResultV1 {
  version: 1;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  executionTime?: number;
  truncated?: boolean;
  /** The exact execution proof is carried through every transport boundary. */
  executionReceipt?: DqlArtifactExecutionReceipt;
  /** Trust/tier are descriptive identity, never inferred by a renderer. */
  trustState?: 'certified' | 'governed' | 'review_required' | 'not_applicable' | 'blocked';
  answerTier?: string;
  resultFingerprint: string;
}

/**
 * A reader-selected value from a previously rendered canonical result.
 *
 * This is intentionally a reference, not copied conversational prose. The
 * host must resolve `sourceRunId` from its durable run store and validate every
 * field against the persisted result before the binding may influence routing,
 * value lookup, or SQL planning.
 */
export interface AgentSelectedResultBindingV1 {
  version: 1;
  sourceRunId: string;
  sourceArtifactId: string;
  canonicalColumn: string;
  value: string;
  rowFingerprint: string;
  resultFingerprint: string;
}

export type AgentSelectedResultBindingValidation =
  | { ok: true; binding: AgentSelectedResultBindingV1 }
  | {
      ok: false;
      code: 'RESULT_BINDING_INVALID' | 'RESULT_BINDING_RESULT_MISMATCH' | 'RESULT_BINDING_ROW_MISMATCH';
      message: string;
    };

/** Stable scalar transport for a selected canonical result cell. */
export function canonicalResultBindingValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** A row proof includes all canonical columns, not just the selected cell. */
export function canonicalResultRowFingerprint(result: Pick<CanonicalQueryResultV1, 'columns'>, row: Record<string, unknown>): string {
  return stableFingerprint({
    columns: result.columns,
    row: Object.fromEntries(result.columns.map((column) => [column, row[column]])),
  });
}

/**
 * Validate an untrusted selected-result reference against a persisted
 * canonical result. The source run/artifact identities are checked by the
 * host before calling this pure result-level validator.
 */
export function validateSelectedResultBinding(
  binding: AgentSelectedResultBindingV1 | undefined,
  result: CanonicalQueryResultV1 | undefined,
): AgentSelectedResultBindingValidation {
  if (!binding
    || binding.version !== 1
    || !binding.sourceRunId.trim()
    || !binding.sourceArtifactId.trim()
    || !binding.canonicalColumn.trim()
    || !binding.value.trim()
    || !normalizeAnalyticalExecutionFingerprint(binding.rowFingerprint)
    || !normalizeAnalyticalExecutionFingerprint(binding.resultFingerprint)) {
    return {
      ok: false,
      code: 'RESULT_BINDING_INVALID',
      message: 'The selected result reference is incomplete or malformed.',
    };
  }
  if (!result || binding.resultFingerprint !== result.resultFingerprint) {
    return {
      ok: false,
      code: 'RESULT_BINDING_RESULT_MISMATCH',
      message: 'The selected result is no longer the persisted result for this run.',
    };
  }
  if (!result.columns.includes(binding.canonicalColumn)) {
    return {
      ok: false,
      code: 'RESULT_BINDING_ROW_MISMATCH',
      message: `The selected column ${binding.canonicalColumn} is not present in the persisted result.`,
    };
  }
  const matched = result.rows.some((row) =>
    canonicalResultRowFingerprint(result, row) === binding.rowFingerprint
    && canonicalResultBindingValue(row[binding.canonicalColumn]) === binding.value);
  if (!matched) {
    return {
      ok: false,
      code: 'RESULT_BINDING_ROW_MISMATCH',
      message: 'The selected row/value does not match the persisted result.',
    };
  }
  return { ok: true, binding: { ...binding, resultFingerprint: result.resultFingerprint } };
}

/**
 * Derive the one value a `top region -> customers in that region` child may
 * consume. A first row alone is never proof. The parent must either return an
 * explicit rank, or be the server-computed descending ranking task and return
 * at least two rows with one strictly-leading numeric measure. `rowCount` is
 * the returned-row contract, not proof that a singleton is the complete group
 * set. Ties and ambiguous result shapes remain a typed child gap.
 */
export function resolveTopRankedRegionDependency(
  sourceTaskId: string,
  result: CanonicalQueryResultV1 | undefined,
  parentTask?: Pick<AnalyticalTaskV1, 'kind' | 'output'>,
): AnalyticalTaskDependencyResolution {
  if (!result || result.rows.length === 0) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The top-region task did not produce a canonical result that can bind the dependent customer task.',
    };
  }
  const canonicalResultFingerprint = normalizeAnalyticalExecutionFingerprint(result.resultFingerprint);
  const executionReceipt = normalizeAnalyticalExecutionReceipt(result.executionReceipt);
  if (!executionReceipt) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The top-region result did not retain a complete normalized execution receipt, so the dependent customer task was not run.',
    };
  }
  if (!canonicalResultFingerprint
    || result.resultFingerprint !== canonicalResultFingerprint
    || executionReceipt.resultFingerprint !== canonicalResultFingerprint) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The top-region execution receipt does not match the canonical result, so the dependent customer task was not run.',
    };
  }
  const regionColumns = result.columns.filter((column) => /(?:^|_)region(?:_name)?$/i.test(column));
  if (regionColumns.length !== 1) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The top-region result did not contain exactly one canonical region column.',
    };
  }
  const canonicalColumn = regionColumns[0]!;
  const first = result.rows[0]!;
  const value = canonicalResultBindingValue(first[canonicalColumn]);
  if (!value) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The leading top-region row did not contain a usable region value.',
    };
  }
  if (!hasUnambiguousTopRow(result, parentTask)) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The top-region result did not prove a single leading region, so the dependent customer task was not run.',
    };
  }
  return {
    ok: true,
    binding: {
      version: 1,
      sourceTaskId,
      sourceResultFingerprint: canonicalResultFingerprint,
      canonicalColumn,
      value,
      rowFingerprint: canonicalResultRowFingerprint(result, first),
    },
  };
}

function hasUnambiguousTopRow(
  result: CanonicalQueryResultV1,
  parentTask?: Pick<AnalyticalTaskV1, 'kind' | 'output'>,
): boolean {
  const rankColumn = result.columns.find((column) => /(?:^|_)(?:rank|row_number)$/i.test(column));
  if (rankColumn) {
    const ranks = result.rows.map((row) => numericCell(row[rankColumn]));
    if (ranks[0] === 1 && ranks.slice(1).every((rank) => rank === undefined || rank > 1)) return true;
  }
  // A plain numerical result column does not say that its first row was ranked.
  // It becomes a ranking proof only when the server's own parent task explicitly
  // asked for a descending ranking AND the returned rows demonstrate a strictly
  // leading value. A singleton needs an explicit rank = 1: it cannot establish
  // that unreturned groups are lower.
  if (parentTask?.kind !== 'ranking' || parentTask.output.order !== 'desc') return false;
  if (result.rows.length < 2) return false;
  const measures = result.columns.filter((column) => {
    if (column === rankColumn) return false;
    const values = result.rows.map((row) => numericCell(row[column]));
    return values.every((value) => value !== undefined);
  });
  if (measures.length !== 1) return false;
  const values = result.rows.map((row) => numericCell(row[measures[0]!])!);
  return values.slice(1).every((value) => values[0]! > value);
}

function numericCell(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Normalize connector, MetricFlow, and provider result shapes at one boundary.
 * Connectors may return `ColumnMeta[]` and rows as arrays; UI surfaces should
 * never need to guess how to index those rows.
 */
export function normalizeCanonicalQueryResult(input: {
  columns?: unknown;
  rows?: unknown;
  rowCount?: unknown;
  executionTime?: unknown;
  executionTimeMs?: unknown;
  truncated?: unknown;
  resultFingerprint?: unknown;
  executionReceipt?: unknown;
  trustState?: unknown;
  answerTier?: unknown;
}): CanonicalQueryResultV1 {
  const columns = Array.isArray(input.columns)
    ? input.columns.map(columnName)
    : [];
  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  const inferredColumns = columns.length > 0
    ? columns
    : objectRowColumns(rawRows).length > 0
      ? objectRowColumns(rawRows)
      : firstArrayRow(rawRows)
        ? firstArrayRow(rawRows)!.map((_, index) => `column_${index + 1}`)
        : [];
  const rows = rawRows.map((row) => normalizeRow(row, inferredColumns));
  const rowCount = typeof input.rowCount === 'number' && Number.isFinite(input.rowCount)
    ? Math.max(0, Math.trunc(input.rowCount))
    : rows.length;
  const executionTime = typeof input.executionTimeMs === 'number'
    ? input.executionTimeMs
    : typeof input.executionTime === 'number'
      ? input.executionTime
      : undefined;
  const canonical = {
    version: 1 as const,
    columns: inferredColumns,
    rows,
    rowCount,
    ...(executionTime !== undefined ? { executionTime } : {}),
    ...(input.truncated === true ? { truncated: true } : {}),
  };
  const receipt = input.executionReceipt && typeof input.executionReceipt === 'object'
    ? input.executionReceipt as DqlArtifactExecutionReceipt
    : undefined;
  const receiptFingerprint = typeof receipt?.resultFingerprint === 'string' ? receipt.resultFingerprint : undefined;
  const suppliedFingerprint = typeof input.resultFingerprint === 'string' && input.resultFingerprint.trim()
    ? input.resultFingerprint.trim()
    : receiptFingerprint;
  const trustState = input.trustState === 'certified'
    || input.trustState === 'governed'
    || input.trustState === 'review_required'
    || input.trustState === 'not_applicable'
    || input.trustState === 'blocked'
    ? input.trustState
    : undefined;
  return {
    ...canonical,
    ...(receipt ? { executionReceipt: receipt } : {}),
    ...(trustState ? { trustState } : {}),
    ...(typeof input.answerTier === 'string' && input.answerTier.trim()
      ? { answerTier: input.answerTier.trim() }
      : {}),
    // A connector/execution receipt is authoritative. The local digest is only
    // a backwards-compatible fallback for legacy unreceipted rows.
    resultFingerprint: suppliedFingerprint ?? stableFingerprint(canonical),
  };
}

export function canonicalResultRows(result: CanonicalQueryResultV1): unknown[][] {
  return result.rows.map((row) => result.columns.map((column) => row[column]));
}

export function assertCanonicalResult(result: CanonicalQueryResultV1): void {
  if (result.version !== 1) throw new Error('Unsupported analytical result contract version.');
  if (result.rowCount < result.rows.length) throw new Error('Result rowCount cannot be smaller than the returned rows.');
  if (new Set(result.columns).size !== result.columns.length) throw new Error('Result columns must be unique.');
  for (const row of result.rows) {
    for (const column of result.columns) {
      if (!Object.prototype.hasOwnProperty.call(row, column)) {
        throw new Error(`Result row is missing the declared column ${column}.`);
      }
    }
  }
}

export interface ContextCandidateCardV1 {
  id: string;
  lane: 'exact' | 'lexical' | 'vector' | 'graph' | 'runtime_value' | 'domain' | 'skill' | 'conversation'
    | 'certified' | 'semantic' | 'relational' | 'business';
  relevance: number;
  trust?: 'certified' | 'semantic' | 'governed_sql' | 'exploratory';
  compatible?: boolean;
  summary?: string;
}

export interface ContextFusionDiagnosticsV1 {
  lanes: Record<string, {
    returned: number;
    durationMs?: number;
    status?: 'ok' | 'empty' | 'error' | 'skipped';
    error?: string;
    skippedReason?: string;
  }>;
  selectedIds: string[];
  truncated: boolean;
}

export interface ContextFusionResultV1 {
  candidates: ContextCandidateCardV1[];
  diagnostics: ContextFusionDiagnosticsV1;
}

/** Reciprocal-rank fusion keeps recall across lexical, vector, and graph lanes. */
export function fuseContextCandidates(
  lanes: Record<string, ContextCandidateCardV1[]>,
  limit = 32,
): ContextFusionResultV1 {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const byId = new Map<string, ContextCandidateCardV1 & { score: number; lanes: Set<string> }>();
  const diagnostics: ContextFusionDiagnosticsV1 = { lanes: {}, selectedIds: [], truncated: false };
  for (const [lane, cards] of Object.entries(lanes)) {
    diagnostics.lanes[lane] = { returned: cards.length };
    cards.forEach((card, index) => {
      if (!card.id.trim()) return;
      const score = 1 / (60 + index + 1) + Math.max(0, Math.min(1, card.relevance)) * 0.25;
      const existing = byId.get(card.id);
      if (existing) {
        existing.score += score;
        existing.lanes.add(lane);
        if ((card.relevance ?? 0) > existing.relevance) existing.relevance = card.relevance;
        if (card.compatible === true) existing.compatible = true;
        if (!existing.summary && card.summary) existing.summary = card.summary;
      } else {
        byId.set(card.id, { ...card, score, lanes: new Set([lane]) });
      }
    });
  }
  const selected = [...byId.values()]
    .sort((left, right) => right.score - left.score || right.relevance - left.relevance || left.id.localeCompare(right.id))
    .slice(0, safeLimit)
    .map(({ score: _score, lanes: _lanes, ...card }) => card);
  diagnostics.selectedIds = selected.map((card) => card.id);
  diagnostics.truncated = byId.size > selected.length;
  return { candidates: selected, diagnostics };
}

export async function retrieveContextLanes(
  lanes: Record<string, () => Promise<ContextCandidateCardV1[]>>,
  limit = 32,
  maxConcurrent = 4,
): Promise<ContextFusionResultV1> {
  const entries = Object.entries(lanes);
  const concurrency = Math.max(1, Math.min(8, Math.trunc(maxConcurrent) || 1));
  const settled: Array<readonly [string, ContextCandidateCardV1[] | { error: string }, number]> = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      if (!entry) return;
      const [name, retrieve] = entry;
      const startedAt = Date.now();
      try {
        const cards = await retrieve();
        settled[index] = [name, cards, Date.now() - startedAt];
      } catch (error) {
        settled[index] = [name, { error: error instanceof Error ? error.message : String(error) }, Date.now() - startedAt];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));
  const successful: Record<string, ContextCandidateCardV1[]> = {};
  const errors: Record<string, string> = {};
  const durations: Record<string, number> = {};
  for (const [name, result, durationMs] of settled) {
    durations[name] = durationMs;
    if (Array.isArray(result)) successful[name] = result;
    else errors[name] = result.error;
  }
  const fused = fuseContextCandidates(successful, limit);
  for (const [name, cards] of Object.entries(successful)) {
    fused.diagnostics.lanes[name] = {
      returned: cards.length,
      durationMs: durations[name],
      status: cards.length > 0 ? 'ok' : 'empty',
    };
  }
  for (const [name, error] of Object.entries(errors)) {
    fused.diagnostics.lanes[name] = {
      returned: 0,
      durationMs: durations[name],
      status: 'error',
      error,
    };
  }
  return fused;
}

export interface ResearchLedgerEntryV1 {
  id: string;
  branchId: string;
  question: string;
  status: 'observed' | 'failed' | 'skipped';
  /** Optional complete execution proof; arbitrary IDs are never accepted. */
  executionReceipt?: DqlArtifactExecutionReceipt;
  resultFingerprint?: string;
  rowCount?: number;
  facts: string[];
  receipts: string[];
  error?: string;
}

export interface ResearchEvidenceLedgerV1 {
  version: 1;
  rootQuestion: string;
  planId?: string;
  snapshotId?: string;
  entries: ResearchLedgerEntryV1[];
  factIds: string[];
  stoppingReason: 'completed' | 'budget' | 'insufficient_evidence' | 'blocked' | 'not_started';
}

export type ResearchEvidenceVerdictV2 = 'supported' | 'contradicted' | 'inconclusive' | 'failed' | 'skipped';

/** Deterministic observation classes; none infer causality from returned rows. */
export type ResearchEvidenceValidatorKindV2 = 'trend' | 'comparison' | 'contributor' | 'anomaly' | 'freshness' | 'counter_evidence';

export interface ResearchEvidenceValidatorV2 {
  version: 1;
  kind: ResearchEvidenceValidatorKindV2;
  /** True only when a deterministic, receipt-bound predicate was evaluated. */
  evaluated: boolean;
  /** Optional non-causal observation result. Absent means inconclusive. */
  outcome?: 'supports_observation' | 'contradicts_observation';
  receiptFingerprints: string[];
}

export interface ResearchHypothesisPlanEntryV2 {
  id: string;
  statement: string;
  expectation: string;
  targetId: string;
  validatorKind: ResearchEvidenceValidatorKindV2;
}

export interface ResearchHypothesisPlanV2 {
  version: 2;
  hypotheses: ResearchHypothesisPlanEntryV2[];
  limitedScope: boolean;
}

/**
 * V2 makes the difference between a returned row and an evaluated hypothesis
 * explicit. A branch may be observed yet inconclusive; it is never promoted to
 * a causal claim merely because it executed.
 */
export interface ResearchEvidenceLedgerEntryV2 extends ResearchLedgerEntryV1 {
  verdict: ResearchEvidenceVerdictV2;
  hypothesis?: string;
  validator?: ResearchEvidenceValidatorV2;
  counterEvidenceFactIds: string[];
}

export interface ResearchEvidenceLedgerV2 {
  version: 2;
  rootQuestion: string;
  planId?: string;
  snapshotId?: string;
  entries: ResearchEvidenceLedgerEntryV2[];
  factIds: string[];
  groundableBranchCount: number;
  limitedScope: boolean;
  stoppingReason: ResearchEvidenceLedgerV1['stoppingReason'];
}

/**
 * A local structural lineage observation is not a query result.  This receipt
 * deliberately carries only bounded counts, opaque fingerprints, and
 * allowlisted status values: it must never become a place where prompts, SQL,
 * rows, graph labels, paths, or provider output are persisted.
 */
export type ResearchLineageEvidenceStatusV1 = 'completed' | 'missing' | 'ambiguous' | 'stale' | 'truncated' | 'unavailable';

export type ResearchLineageResolutionV1 =
  | 'exact_id'
  | 'exact_name'
  | 'canonical_alias'
  | 'missing'
  | 'ambiguous'
  | 'stale'
  | 'unavailable';

export type ResearchLineageNodeTypeV1 =
  | 'source_table'
  | 'dbt_model'
  | 'dbt_source'
  | 'term'
  | 'block'
  | 'business_view'
  | 'metric'
  | 'dimension'
  | 'domain'
  | 'chart'
  | 'notebook'
  | 'dashboard'
  | 'app';

export interface ResearchLineageEvidenceReceiptV1 {
  version: 1;
  evidenceKind: 'lineage_graph';
  /** Opaque local identity only; no source path or graph content is retained. */
  snapshotId?: string;
  snapshotFingerprint?: string;
  graphFingerprint: string;
  targetFingerprint: string;
  status: ResearchLineageEvidenceStatusV1;
  resolution: ResearchLineageResolutionV1;
  candidateCount: number;
  targetType?: ResearchLineageNodeTypeV1;
  upstreamNodeCount: number;
  downstreamNodeCount: number;
  upstreamPathCount: number;
  downstreamPathCount: number;
  traversedNodeCount: number;
  traversedEdgeCount: number;
  maxDepth: number;
  maxPaths: number;
  maxNodes: number;
  maxEdges: number;
  truncated: boolean;
  /** One-way digest of the bounded structural program, never a result digest. */
  structuralFingerprint?: string;
  validator: {
    version: 1;
    kind: 'structural_dependency';
    evaluated: boolean;
    outcome: 'dependency_observed' | 'inconclusive';
    /** A lineage edge is structural evidence only, never a causal conclusion. */
    nonCausal: true;
  };
  /** This program must not dispatch AI, SQL, warehouse, or repair work. */
  zeroCallCounters: {
    providerCalls: 0;
    sqlExecutions: 0;
    warehouseExecutions: 0;
    repairAttempts: 0;
  };
}

export type ResearchEvidenceKindV3 = 'analytical_result' | 'lineage_graph';

/**
 * V3 is additive and content-safe.  V1/V2 remain available to old readers,
 * while V3 distinguishes a receipt-bound analytical result from a bounded
 * structural lineage observation.  In particular, the lineage variant has no
 * result fingerprint, execution receipt, row count, SQL, or provider payload.
 */
export interface ResearchEvidenceLedgerAnalyticalEntryV3 {
  version: 3;
  id: string;
  branchId: string;
  evidenceKind: 'analytical_result';
  status: ResearchLedgerEntryV1['status'];
  verdict: ResearchEvidenceVerdictV2;
  hypothesisFingerprint?: string;
  factIds: string[];
  counterEvidenceFactIds: string[];
  receiptFingerprints: string[];
  resultFingerprint?: string;
}

export interface ResearchEvidenceLedgerLineageEntryV3 {
  version: 3;
  id: string;
  branchId: string;
  evidenceKind: 'lineage_graph';
  /** The structural program completed even when a target is missing/stale. */
  status: 'observed' | 'failed' | 'skipped';
  verdict: ResearchEvidenceVerdictV2;
  hypothesisFingerprint?: string;
  factIds: string[];
  counterEvidenceFactIds: string[];
  receiptFingerprints: string[];
  lineageReceipt: ResearchLineageEvidenceReceiptV1;
}

export type ResearchEvidenceLedgerEntryV3 =
  | ResearchEvidenceLedgerAnalyticalEntryV3
  | ResearchEvidenceLedgerLineageEntryV3;

export interface ResearchEvidenceLedgerV3 {
  version: 3;
  /** One-way root-question identity; V3 does not retain research prose. */
  rootQuestionFingerprint: string;
  planId?: string;
  snapshotId?: string;
  entries: ResearchEvidenceLedgerEntryV3[];
  factIds: string[];
  groundableBranchCount: number;
  limitedScope: boolean;
  stoppingReason: ResearchEvidenceLedgerV1['stoppingReason'];
}

export interface ResearchEvidenceLedgerAnalyticalInputV3 {
  kind: 'analytical_result';
  index: number;
  entry: ResearchEvidenceLedgerEntryV2;
  hypothesisFingerprint?: string;
}

export interface ResearchEvidenceLedgerLineageInputV3 {
  kind: 'lineage_graph';
  index: number;
  id: string;
  branchId: string;
  receipt: ResearchLineageEvidenceReceiptV1;
  hypothesisFingerprint?: string;
  /** Omitted means the direct structural program completed normally. */
  status?: 'observed' | 'failed' | 'skipped';
}

function ledgerFactIdsV3(branchId: string, facts: string[]): { ids: string[]; byFact: Map<string, string> } {
  const byFact = new Map<string, string>();
  const ids: string[] = [];
  for (const fact of facts) {
    const normalized = fact.trim();
    if (!normalized || byFact.has(normalized)) continue;
    const id = `fact:${branchId}:${ids.length + 1}`;
    ids.push(id);
    byFact.set(normalized, id);
  }
  return { ids, byFact };
}

/**
 * Build a mixed V3 ledger without reinterpreting V1/V2.  The legacy ledgers
 * continue to contain analytical branches only, because their `observed`
 * state requires an execution/result receipt and would otherwise falsely
 * represent a graph walk as query execution.
 */
export function buildResearchEvidenceLedgerV3(input: {
  rootQuestionFingerprint: string;
  planId?: string;
  snapshotId?: string;
  groundableBranchCount?: number;
  entries: Array<ResearchEvidenceLedgerAnalyticalInputV3 | ResearchEvidenceLedgerLineageInputV3>;
  stoppingReason?: ResearchEvidenceLedgerV1['stoppingReason'];
}): ResearchEvidenceLedgerV3 {
  const entries = input.entries
    .slice(0, 6)
    .sort((left, right) => left.index - right.index || left.kind.localeCompare(right.kind))
    .map((source): ResearchEvidenceLedgerEntryV3 => {
      if (source.kind === 'analytical_result') {
        const entry = source.entry;
        const facts = ledgerFactIdsV3(entry.branchId, entry.facts);
        const counterEvidenceFactIds = [...new Set(entry.counterEvidenceFactIds)]
          .flatMap((fact) => facts.byFact.get(fact) ? [facts.byFact.get(fact)!] : []);
        const resultFingerprint = normalizeAnalyticalExecutionFingerprint(entry.resultFingerprint);
        return {
          version: 3,
          id: entry.id,
          branchId: entry.branchId,
          evidenceKind: 'analytical_result',
          status: entry.status,
          verdict: entry.verdict,
          ...(source.hypothesisFingerprint ? { hypothesisFingerprint: source.hypothesisFingerprint } : {}),
          factIds: facts.ids,
          counterEvidenceFactIds,
          receiptFingerprints: resultFingerprint ? [resultFingerprint] : [],
          ...(resultFingerprint ? { resultFingerprint } : {}),
        };
      }

      const facts = ledgerFactIdsV3(source.branchId, [
        `lineage:${source.receipt.status}`,
        `lineage:resolution:${source.receipt.resolution}`,
      ]);
      const status = source.status
        ?? (source.receipt.status === 'completed' || source.receipt.status === 'truncated'
          ? 'observed'
          : 'failed');
      return {
        version: 3,
        id: source.id,
        branchId: source.branchId,
        evidenceKind: 'lineage_graph',
        status,
        // The local graph can establish a structural dependency. It cannot
        // establish causation, even when a complete path exists.
        verdict: status === 'skipped' ? 'skipped' : 'inconclusive',
        ...(source.hypothesisFingerprint ? { hypothesisFingerprint: source.hypothesisFingerprint } : {}),
        factIds: facts.ids,
        counterEvidenceFactIds: [],
        receiptFingerprints: source.receipt.structuralFingerprint ? [source.receipt.structuralFingerprint] : [],
        lineageReceipt: source.receipt,
      };
    });
  const observedGroundableBranchCount = entries.filter((entry) => entry.status === 'observed' && entry.verdict !== 'skipped').length;
  const plannedGroundableBranchCount = Math.max(0, Math.min(6, Math.trunc(input.groundableBranchCount ?? 0)));
  const groundableBranchCount = Math.max(observedGroundableBranchCount, plannedGroundableBranchCount);
  return {
    version: 3,
    rootQuestionFingerprint: input.rootQuestionFingerprint,
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    entries,
    factIds: [...new Set(entries.flatMap((entry) => [...entry.factIds, ...entry.counterEvidenceFactIds]))],
    groundableBranchCount,
    limitedScope: groundableBranchCount < 3,
    stoppingReason: input.stoppingReason ?? (entries.length > 0 ? 'completed' : 'not_started'),
  };
}

export function capResearchBranches<T>(branches: T[], max = 6): T[] {
  return branches.slice(0, Math.max(1, Math.min(6, Math.trunc(max))));
}

export function buildResearchEvidenceLedger(input: {
  rootQuestion: string;
  planId?: string;
  snapshotId?: string;
  entries: ResearchLedgerEntryV1[];
  stoppingReason?: ResearchEvidenceLedgerV1['stoppingReason'];
}): ResearchEvidenceLedgerV1 {
  const entries = input.entries.slice(0, 6).map((entry) => {
    const resultFingerprint = normalizeAnalyticalExecutionFingerprint(entry.resultFingerprint);
    const executionReceipt = normalizeAnalyticalExecutionReceipt(entry.executionReceipt);
    const receiptFingerprint = executionReceipt?.resultFingerprint;
    const listedFingerprint = entry.receipts
      .map((receipt) => normalizeAnalyticalExecutionFingerprint(receipt))
      .find((receipt): receipt is string => Boolean(receipt));
    const executionProof = resultFingerprint ?? receiptFingerprint ?? listedFingerprint;

    // A receipt/result proof is meaningful only for an observed branch. Never
    // carry a preloaded receipt, child ID, context-pack ID, or malformed
    // fingerprint through a failed/cancelled/skipped entry.
    if (entry.status !== 'observed') {
      const { executionReceipt: _receipt, resultFingerprint: _fingerprint, ...withoutProof } = entry;
      return { ...withoutProof, receipts: [] };
    }

    // A ready/observed branch without a complete receipt or canonical result
    // fingerprint is not an observation. Downgrade it and retain no invented
    // proof; callers can still inspect the branch and retry it explicitly.
    if (!executionProof) {
      const { executionReceipt: _receipt, resultFingerprint: _fingerprint, ...withoutProof } = entry;
      return {
        ...withoutProof,
        status: 'failed' as const,
        receipts: [],
        error: entry.error ?? 'Research branch had no valid execution receipt or canonical result fingerprint.',
      };
    }

    return {
      ...entry,
      status: 'observed' as const,
      resultFingerprint: executionProof,
      ...(executionReceipt ? { executionReceipt } : {}),
      receipts: [executionProof],
    };
  });
  return {
    version: 1,
    rootQuestion: input.rootQuestion,
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    entries,
    factIds: [...new Set(entries.flatMap((entry) => entry.facts))],
    stoppingReason: input.stoppingReason ?? (entries.length > 0 ? 'completed' : 'not_started'),
  };
}

export function buildResearchEvidenceLedgerV2(input: {
  rootQuestion: string;
  planId?: string;
  snapshotId?: string;
  /** Number of catalog-grounded branches admitted before execution. A runtime
   * failure must not be misreported as if the catalog had fewer hypotheses. */
  groundableBranchCount?: number;
  entries: Array<ResearchLedgerEntryV1 & {
    verdict?: ResearchEvidenceVerdictV2;
    hypothesis?: string;
    validator?: ResearchEvidenceValidatorV2;
    counterEvidenceFactIds?: string[];
  }>;
  stoppingReason?: ResearchEvidenceLedgerV1['stoppingReason'];
}): ResearchEvidenceLedgerV2 {
  const v1 = buildResearchEvidenceLedger(input);
  const entries = v1.entries.map((entry, index) => {
    const source = input.entries[index];
    const validator = normalizeResearchEvidenceValidator(source?.validator, entry);
    const requestedVerdict = /\b(?:because|caused?|driven by|due to)\b/i.test(source?.hypothesis ?? '')
      ? undefined
      : source?.verdict;
    const verdict = researchVerdictFromValidatedObservation({
      status: entry.status,
      requestedVerdict,
      validator,
    });
    const validFactIds = new Set(entry.facts);
    const counterEvidenceFactIds = [...new Set(source?.counterEvidenceFactIds ?? [])]
      .filter((factId) => validFactIds.has(factId));
    return {
      ...entry,
      verdict,
      ...(source?.hypothesis?.trim() ? { hypothesis: source.hypothesis.trim() } : {}),
      ...(validator ? { validator } : {}),
      counterEvidenceFactIds,
    };
  });
  const observedGroundableBranchCount = entries.filter((entry) => entry.status === 'observed' && entry.verdict !== 'failed' && entry.verdict !== 'skipped').length;
  const plannedGroundableBranchCount = Math.max(0, Math.min(6, Math.trunc(input.groundableBranchCount ?? 0)));
  const groundableBranchCount = Math.max(observedGroundableBranchCount, plannedGroundableBranchCount);
  return {
    version: 2,
    rootQuestion: v1.rootQuestion,
    ...(v1.planId ? { planId: v1.planId } : {}),
    ...(v1.snapshotId ? { snapshotId: v1.snapshotId } : {}),
    entries,
    factIds: [...new Set(entries.flatMap((entry) => [...entry.facts, ...entry.counterEvidenceFactIds]))],
    groundableBranchCount,
    limitedScope: groundableBranchCount < 3,
    stoppingReason: v1.stoppingReason,
  };
}

/**
 * Normalise a hypothesis plan into the bounded research contract. The caller
 * may supply fewer than three grounded hypotheses; that is retained honestly as
 * limited scope rather than padded with invented joins or explanations.
 */
export function buildResearchHypothesisPlanV2(input: {
  hypotheses: Array<{
    id?: string;
    statement: string;
    expectation: string;
    targetId: string;
    validatorKind?: ResearchEvidenceValidatorKindV2;
  }>;
}): ResearchHypothesisPlanV2 {
  const seen = new Set<string>();
  const hypotheses: ResearchHypothesisPlanEntryV2[] = [];
  for (const candidate of input.hypotheses) {
    const statement = candidate.statement.trim();
    const expectation = candidate.expectation.trim();
    const targetId = candidate.targetId.trim();
    if (!statement || !expectation || !targetId) continue;
    const key = `${statement.toLowerCase()}\u0000${targetId.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hypotheses.push({
      id: candidate.id?.trim() || `hypothesis:${hypotheses.length + 1}`,
      statement,
      expectation,
      targetId,
      validatorKind: candidate.validatorKind ?? inferResearchValidatorKind(statement, expectation),
    });
    if (hypotheses.length >= 6) break;
  }
  return { version: 2, hypotheses, limitedScope: hypotheses.length < 3 };
}

/** Map an action/expectation to a deterministic observation class only. */
export function inferResearchValidatorKind(statement: string, expectation = ''): ResearchEvidenceValidatorKindV2 {
  const text = `${statement} ${expectation}`.toLowerCase();
  if (/fresh|updated|stale|as of|recency/.test(text)) return 'freshness';
  if (/contribut|driver|segment|breakdown|dominant/.test(text)) return 'contributor';
  if (/trend|time|month|week|quarter|year|shift|change/.test(text)) return 'trend';
  if (/compare|versus|vs\.?|difference/.test(text)) return 'comparison';
  if (/anomal|outlier|spike|drop/.test(text)) return 'anomaly';
  return 'counter_evidence';
}

/**
 * A verdict is promoted only from a validator that evaluated a deterministic
 * observation against a branch receipt. Rows by themselves stay inconclusive;
 * causal statements are never supported by this helper.
 */
export function researchVerdictFromValidatedObservation(input: {
  status: ResearchLedgerEntryV1['status'];
  requestedVerdict?: ResearchEvidenceVerdictV2;
  validator?: ResearchEvidenceValidatorV2;
}): ResearchEvidenceVerdictV2 {
  if (input.status === 'failed') return 'failed';
  if (input.status === 'skipped') return 'skipped';
  if (!input.validator?.evaluated || input.validator.receiptFingerprints.length === 0) return 'inconclusive';
  if (input.requestedVerdict === 'supported' && input.validator.outcome === 'supports_observation') return 'supported';
  if (input.requestedVerdict === 'contradicted' && input.validator.outcome === 'contradicts_observation') return 'contradicted';
  return 'inconclusive';
}

function normalizeResearchEvidenceValidator(
  validator: ResearchEvidenceValidatorV2 | undefined,
  entry: ResearchLedgerEntryV1,
): ResearchEvidenceValidatorV2 | undefined {
  if (!validator || validator.version !== 1) return undefined;
  const knownReceipt = entry.resultFingerprint;
  const receiptFingerprints = [...new Set(validator.receiptFingerprints)]
    .map(normalizeAnalyticalExecutionFingerprint)
    .filter((fingerprint): fingerprint is string => Boolean(fingerprint))
    .filter((fingerprint) => !knownReceipt || fingerprint === knownReceipt);
  return {
    version: 1,
    kind: validator.kind,
    evaluated: validator.evaluated === true && receiptFingerprints.length > 0,
    ...(validator.outcome ? { outcome: validator.outcome } : {}),
    receiptFingerprints,
  };
}

/** The only accepted host-side execution identity is a SHA-256 fingerprint. */
export function normalizeAnalyticalExecutionFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

/**
 * Normalize a complete DQL execution receipt. A partial object or arbitrary
 * identifier is deliberately not execution evidence.
 */
export function normalizeAnalyticalExecutionReceipt(value: unknown): DqlArtifactExecutionReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sourceFingerprint = normalizeAnalyticalExecutionFingerprint(record.sourceFingerprint);
  const compiledSqlFingerprint = normalizeAnalyticalExecutionFingerprint(record.compiledSqlFingerprint);
  const parameterFingerprint = normalizeAnalyticalExecutionFingerprint(record.parameterFingerprint);
  const resultFingerprint = normalizeAnalyticalExecutionFingerprint(record.resultFingerprint);
  return sourceFingerprint && compiledSqlFingerprint && parameterFingerprint && resultFingerprint
    ? { sourceFingerprint, compiledSqlFingerprint, parameterFingerprint, resultFingerprint }
    : undefined;
}

export function buildCoverageGap(input: Omit<AnalyticalCoverageGapV1, 'version'>): AnalyticalCoverageGapV1 {
  return { version: 1, ...input };
}

function columnName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return String((value as { name: unknown }).name);
  }
  return String(value ?? 'column');
}

function objectRowColumns(rows: unknown[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const column of Object.keys(row as Record<string, unknown>)) columns.add(column);
  }
  return [...columns];
}

function firstArrayRow(rows: unknown[]): unknown[] | undefined {
  const row = rows.find((candidate) => Array.isArray(candidate));
  return row as unknown[] | undefined;
}

function normalizeRow(row: unknown, columns: string[]): Record<string, unknown> {
  if (Array.isArray(row)) return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
  if (row && typeof row === 'object') {
    const record = row as Record<string, unknown>;
    return Object.fromEntries(columns.map((column) => [column, record[column]]));
  }
  return Object.fromEntries(columns.map((column) => [column, undefined]));
}

function stableFingerprint(value: unknown): string {
  const text = stableStringify(value);
  return createHash('sha256').update(text).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
