
import { type SemanticLayer, type ResolvedTrustLabel, type TrustLabelId, type DqlArtifactReference, type DqlArtifactExecutionReceipt, type DqlExecutableArtifactV1, type DQLManifest, type AnalyticalFailureV1, type SemanticAggregationCompilerReceiptV1, type ProviderEgressReceiptV1, type AggregationSafetyProofV1 } from '@zlens/core';
import type { KGStore } from './kg/sqlite-fts.js';
import type { KGNode, KGSearchHit } from './kg/types.js';
import type { AgentProvider, AgentToolDefinition, ProviderToolLoopOptions } from './providers/types.js';
import type { AgentRunClarificationOption } from './agent-run-engine.js';
import type { ReasoningEffort } from './providers/reasoning-effort.js';
import type { Skill } from './skills/loader.js';
import type { AgentMemory } from './memory/sqlite-memory.js';
import { type ConversationSnapshot } from './conversation/snapshot.js';
import type { LocalContextPack, MetadataAgentIntent, MetadataObject } from './metadata/catalog.js';
import { type DomainContextEnvelope } from './domain-context.js';
import type { GeneratedDraftBlock, GeneratedDraftSourceDqlArtifact } from './metadata/drafts.js';
import { type AnalysisQuestionPlan } from './metadata/analysis-planner.js';
import { matchSemanticMetric, type MetricMatch } from './metadata/metric-match.js';
import type { EmbeddingProvider } from './embeddings/provider.js';
import { type IntentDecision } from './intent-controller.js';
import type {
  SqlContextValidationCode,
  SqlContextValidationOffending,
} from './metadata/sql-context-validation.js';
import type { GroundingContextExpander } from './grounding/regrounding.js';
import {
  analyticalErrorDetail,
  type AnalyticalErrorDetailV1,
  type AnalyticalErrorOffending,
  type AnalyticalErrorOrigin,
  type AnalyticalErrorStage,
} from './analytical-error.js';
import { humanizeAnalyticalEntityId, type AnalyticalExploratoryPath, type AnalyticalPolicyCode } from './metadata/analytical-policy.js';
import { type SemanticMemberSelection } from './semantic-bridge/compose.js';
import type { AgenticSqlExecutionCapabilityV1 } from './agentic/sql-authorization.js';
import { type CascadeAnswerResult } from './cascade/cascade.js';
import type { AnalyticalCascadeTierV1, ExploratoryExecutionAuthorizationAttemptV1, ExploratoryExecutionFreezeV1 } from './analytical-orchestration.js';
import { type ResolvedAnalyticalPlan, type ResolvedAnalyticalPlanDelta } from './resolved-analytical-plan.js';
import { type PlanExecutionBinding, type PlanExecutionBlockedCode, type SemanticGraphExecutionBinding } from './plan-execution-adapter.js';
import { type GovernedCompilationReceipt, type GovernedAnalyticalGraphCompilationReceipt, type GovernedAnalyticalGraphCompileResult, type GovernedRelationalCompileResult } from './governed-relational-compiler.js';
import { type AnalyticalExecutionGraphBlockedCode, type AnalyticalExecutionGraphV1, type AnalyticalExecutionReceiptV1, type AnalyticalGraphExecutionFailureCode } from './analytical-execution-graph.js';
import { type AnalyticalNarrativeV1, type AnalyticalResultFactSetV1 } from './analytical-result-facts.js';
import { type AnalyticalFreshnessObservationV1, type AnalyticalFreshnessRequestV1, type ResolveAnalyticalPeriodsResult } from './analytical-period-resolution.js';
import { type CascadeAnalysisDepth, type PartialCascadeBudgetModel } from './cascade/budgets.js';

export type AnswerKind = 'certified' | 'uncertified' | 'no_answer';
export type AnswerSourceTier = 'certified_artifact' | 'business_context' | 'semantic_layer' | 'dbt_manifest' | 'no_answer';
/**
 * The coarse, host-facing disposition. `policy_blocked` is deliberately distinct
 * from `ambiguous`: an attribution/export/proof policy is a metadata decision,
 * not a request for the analyst to rewrite an otherwise clear question.
 */
export type AnswerRefusalCode = 'grounding_gap' | 'modeling_gap' | 'no_data' | 'ambiguous' | 'model_declined' | 'provider_error' | 'orchestration_budget_exhausted' | 'policy_blocked' | 'execution_error';
export type AnalysisDepth = CascadeAnalysisDepth;

/**
 * A native semantic direct join is governed only after its fanout probe proves
 * that aggregation will not multiply fact rows. These codes deliberately do
 * not include adapter/warehouse error text: that text can contain credentials,
 * SQL literals, or other operator-only detail.
 */
import { probeSemanticJoinFanout, type SemanticFanoutProbeFailureCodeV1, type SemanticFanoutProbeResultV1 } from './semantic-bridge/fanout-probe.js';
export { probeSemanticJoinFanout };
export type { SemanticFanoutProbeFailureCodeV1, SemanticFanoutProbeResultV1 };

export interface SemanticExecutionTrace {
  version: 1;
  adapter: 'native' | 'metricflow-cli' | 'dbt-cloud';
  status: 'compiled' | 'ambiguous' | 'failed';
  authoringRequest: {
    metrics: string[];
    dimensions: string[];
    filters?: Array<{ dimension?: string; operator?: string; values?: string[]; expression?: string }>;
    timeDimension?: { name: string; granularity: string };
    orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
    limit?: number;
    savedQuery?: string;
    engine?: string;
  };
  runtimeRequest?: {
    metrics: string[];
    dimensions: string[];
    filters?: Array<{ dimension?: string; operator?: string; values?: string[]; expression?: string }>;
    timeDimension?: { name: string; granularity: string };
    orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
    limit?: number;
    savedQuery?: string;
    engine?: string;
  };
  bindings: Array<{
    role: string;
    authoringReference: string;
    runtimeReference: string;
    entityPath: string[];
    status: 'resolved' | 'ambiguous';
  }>;
  warnings: string[];
  steps: Array<{
    id: string;
    label: string;
    status: 'completed' | 'failed' | 'not_started';
    detail: string;
  }>;
  targetBinding?: object;
  executionReceipt?: object;
  aggregationCompilerReceipt?: SemanticAggregationCompilerReceiptV1;
  failure?: {
    code: string;
    phase: string;
    message: string;
    identifier?: string;
    sqlExcerpt?: { startLine: number; endLine: number; text: string };
    compiledSqlFingerprint?: string;
    safeActions?: string[];
    candidates?: Array<{
      id: string;
      label: string;
      description?: string;
      authoringReference: string;
      runtimeReference: string;
      entityPath: string[];
      selectionReference: string;
    }>;
  };
}

export type SemanticQueryCompiler = (selection: SemanticMemberSelection) => Promise<{
  sql: string;
  engine: 'native' | 'metricflow-cli' | 'dbt-cloud';
  /** Relations the native composer joined; empty for a single-model query. */
  joins?: string[];
  /** Every relation the native composer read, for the fanout proof's message. */
  tables?: string[];
  /**
   * The native composer's unfiltered join-fanout probe (`base_rows` vs
   * `joined_rows`); absent for a single-model query and for engines that own
   * their join semantics. The host runs it before the governed query.
   */
  fanoutProbeSql?: string;
  /** The compiler may add deterministic requirements such as metric_time. */
  selection?: SemanticMemberSelection;
  /** Authoring identity, exact runtime binding, adapter, and compiler phases. */
  trace?: SemanticExecutionTrace;
  aggregationCompilerReceipt?: SemanticAggregationCompilerReceiptV1;
}>;

/**
 * A generated query that was grounded in dbt metadata but cannot be executed as
 * governed SQL because its final v3 relationship check found missing modeling
 * coverage. Hosts may hand this to their bounded exploratory executor; the
 * answer loop deliberately never executes it on this route.
 */
export interface ExploratorySqlCandidate {
  kind: 'dbt_grounded_exploration';
  /** Only absence-of-modeling outcomes are eligible — never an unsafe policy. */
  reason: 'unbound_relation' | 'unplanned_join' | 'relationship_not_certified' | 'unsafe_relationship';
  sql: string;
  message: string;
  /** Business-language explanation, safe to show a stakeholder verbatim. */
  userFacingReason?: string;
  /** Bound entity ids, if any, that the v3 guard resolved before it stopped. */
  modeledEntityIds: string[];
  /** Relationships the guard considered; empty means no certified route exists. */
  relationshipIds: string[];
  /**
   * Declared (uncertified) join path from the manifest, re-bound to this SQL's
   * actual joins. Suggestion-only key hints for the host's structural
   * validation and gating probes — never join authorization.
   */
  exploratoryPath?: AnalyticalExploratoryPath;
  /** The SQL was NOT executed by the governed generated-SQL lane. */
  executionStatus: 'not_executed';
}

export interface AgentRefusalDetails {
  /**
   * Validator or provider-specific code behind a no-answer outcome. For
   * grounding gaps, this preserves the exact validation code so repair loops can
   * re-ground the named identifier instead of parsing prose.
   */
  code?:
    | AnswerRefusalCode
    | SqlContextValidationCode
    | AnalyticalPolicyCode
    | PlanExecutionBlockedCode
    | AnalyticalExecutionGraphBlockedCode
    | AnalyticalGraphExecutionFailureCode
    | Extract<ResolveAnalyticalPeriodsResult, { status: 'blocked' }>['code']
    | Extract<GovernedAnalyticalGraphCompileResult, { status: 'blocked' }>['code']
    | 'COMPILATION_FAILED'
    | 'EXECUTION_FAILED'
    | 'GENERATED_ANALYTICAL_TUPLE_DRIFT'
    | 'OUTPUT_BINDING_TUPLE_DRIFT'
    | 'semantic_path_ambiguous'
    | 'semantic_runtime_required'
    | SemanticFanoutProbeFailureCodeV1
    /** DQL's own run budget stopped the turn; the AI provider did not fail. */
    | 'orchestration_budget_exhausted'
    /**
     * DQL declined to START another call it predicted would not fit in the
     * remaining budget. Distinct from an exhausted clock: it can fire seconds
     * into a run with most of the budget unspent, so sharing the "ran out of
     * time" wording sent readers to debug latency instead of the estimate.
     */
    | 'RUN_DEADLINE_INSUFFICIENT';
  message: string;
  offending?: SqlContextValidationOffending;
}

/**
 * The chosen route, surfaced on EVERY AI result (spec 17, part C) so the UI can
 * show "where the answer came from". `tier` is the coarse route bucket; `ref`
 * names the governed artifact/metric used (e.g. `cumulative_revenue`); `label`
 * is a ready-to-render sentence.
 */
export type AiRouteTier =
  | 'certified_block'
  | 'semantic_metric'
  | 'generated_sql'
  | 'business_context'
  | 'no_answer';

export interface AiRoute {
  tier: AiRouteTier;
  label: string;
  ref?: string;
}
export type AnswerCertification = 'certified' | 'governed' | 'ai_generated' | 'analyst_review_required';
export type AnswerReviewStatus = 'none' | 'governed' | 'draft_ready' | 'analyst_review_required' | 'certified';
export type AgentIntent = MetadataAgentIntent | 'ad_hoc_analysis' | 'drillthrough';

export interface AgentCitation {
  nodeId: string;
  kind: KGNode['kind'] | 'memory' | 'runtime_schema';
  name: string;
  /** Frozen-in-time SHA at the moment of indexing. */
  gitSha?: string;
  sourceTier?: AnswerSourceTier | 'memory';
  provenance?: string;
}

export type AgentEvidenceRouteStatus = 'selected' | 'checked' | 'skipped' | 'failed';
export type AgentEvidenceLineageRole =
  | 'question'
  | 'selected_asset'
  | 'business_context'
  | 'semantic_object'
  | 'source_table'
  | 'consumer'
  | 'memory';

export interface AgentEvidenceRouteStep {
  tool: string;
  status: AgentEvidenceRouteStatus;
  label: string;
  detail?: string;
}

export interface AgentEvidenceAsset {
  nodeId: string;
  kind: KGNode['kind'] | 'memory' | 'question' | 'runtime_schema';
  name: string;
  description?: string;
  sourceTier?: AnswerSourceTier | 'memory' | 'project';
  certification?: TrustLabelId | AnswerCertification | 'uncertified' | 'analyst_review_required';
  provenance?: string;
  sourcePath?: string;
  owner?: string;
  domain?: string;
  status?: string;
}

export interface AgentEvidenceLineageNode extends AgentEvidenceAsset {
  role: AgentEvidenceLineageRole;
}

export interface AgentEvidenceContextItem {
  label: string;
  value: string;
  source?: string;
}

export interface AgentEvidenceToolCall {
  name: string;
  status: Extract<AgentEvidenceRouteStatus, 'checked' | 'failed'>;
  inputSummary?: string;
  outputSummary?: string;
  order: number;
  /** Wall-clock time this tool call took, in ms — surfaces where a slow run spent its time. */
  durationMs?: number;
}

/** Coarse wall-clock spans for the request path, used to diagnose latency regressions. */
export interface AgentEvidenceTiming {
  phase: 'project_state' | 'context_retrieval' | 'source_search' | 'runtime_schema' | 'answer_resolution' | 'total';
  durationMs: number;
  detail?: string;
}

export interface AgentEvidenceOutcome {
  name?: string;
  owner?: string;
  decisionUse?: string;
  reviewCadence?: string;
  caveats?: string[];
}

export interface AgentSchemaColumn {
  name: string;
  type?: string;
  description?: string;
  /** Bounded runtime values that matched the user's question, used only as SQL-generation hints. */
  sampleValues?: string[];
}

type CertifiedInvocationParameterSource = NonNullable<CertifiedBlockInvocationInput['parameterSources']>[string];

/**
 * Map typed member bindings to a block's declared parameter contract. The
 * mapping is identifier-based (parameter name, semantic field, or declared
 * filter binding) and must select exactly one parameter. Structural SQL is
 * never accepted as a value.
 */
function certifiedInvocationInputs(
  block: KGNode,
  plan: AnalysisQuestionPlan,
): Pick<CertifiedBlockInvocationInput, 'parameters' | 'parameterSources'> {
  const definitions = block.parameters ?? [];
  if (definitions.length === 0) return {};
  const parameters: Record<string, unknown> = {};
  const parameterSources: Record<string, CertifiedInvocationParameterSource> = {};
  const declaredFilterBindings = new Map((block.filterBindings ?? []).map((entry) => [entry.filter, entry.binding]));

  const topN = plan.requestedShape.topN?.n;
  if (topN) {
    const limitCandidates = definitions.filter((definition) => definition.name === 'top_n' || definition.binding?.kind === 'limit');
    if (limitCandidates.length === 1) {
      parameters[limitCandidates[0]!.name] = topN;
      parameterSources[limitCandidates[0]!.name] = 'question';
    }
  }

  for (const member of plan.requestedShape.memberBindings ?? []) {
    const candidates = definitions.filter((definition) => {
      if (Object.prototype.hasOwnProperty.call(parameters, definition.name)) return false;
      const target = definition.binding?.kind === 'semantic_filter'
        ? definition.binding.field
        : declaredFilterBindings.get(definition.name) ?? definition.name;
      return outputConceptMatches(target, member.dimension);
    });
    if (candidates.length !== 1) continue;
    const definition = candidates[0]!;
    const values = Array.from(new Set(member.values.map((value) => value.trim()).filter(Boolean)));
    if (values.length === 0 || (!definition.type.endsWith('[]') && values.length !== 1)) continue;
    parameters[definition.name] = definition.type.endsWith('[]') ? values : values[0];
    parameterSources[definition.name] = member.source === 'prior_result' ? 'prior_result' : 'question';
  }

  return Object.keys(parameters).length > 0 ? { parameters, parameterSources } : {};
}

/**
 * Build the one typed certified-block invocation used by both the ordinary
 * answer loop and the authoritative V2 exact-fit path.  Keeping this at the
 * DQL boundary is important: a zero-provider Tier 1 shortcut may avoid
 * conversational planning, but it must not avoid declared parameter binding,
 * validation, or the normal overall top-N execution bound.
 */
export function buildCertifiedBlockInvocationInput(
  block: KGNode,
  plan: AnalysisQuestionPlan,
  question: string,
): CertifiedBlockInvocationInput {
  return {
    question,
    ...certifiedInvocationInputs(block, plan),
    ...(plan.requestedShape.topN?.scope === 'per_group'
      ? {}
      : plan.requestedShape.topN?.n
        ? { rowLimit: plan.requestedShape.topN.n }
        : {}),
  };
}


/**
 * Does the block's AUTHORED metadata declare every qualifying term of the
 * question? "Top customers by beverage" is answered by a block whose tags
 * are ["beverage", "customer", …] and whose outputs include
 * `beverage_revenue`: the author said what it is about. A title or a
 * description is not that statement — "Top Customers" matched "top BCM
 * customers" by title and silently lost BCM — so only tags, declared
 * outputs, dimensions and entities count.
 */
export function certifiedBlockDeclaresQualifiers(
  block: Pick<KGNode, 'tags' | 'declaredOutputs' | 'outputs' | 'dimensions' | 'entities'>,
  qualifiers: readonly string[],
): boolean {
  const words = (value: unknown): string[] => (typeof value === 'string' ? value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) : []);
  const singular = (term: string) => (term.endsWith('ies') ? `${term.slice(0, -3)}y` : term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term);
  const authored = new Set([
    ...(block.tags ?? []).flatMap(words),
    ...(block.declaredOutputs ?? []).flatMap(words),
    ...(block.outputs ?? []).flatMap((output) => words((output as { name?: string }).name)),
    ...(block.dimensions ?? []).flatMap(words),
    ...(block.entities ?? []).flatMap(words),
  ].map(singular));
  return qualifiers.every((qualifier) => words(qualifier).every((word) => authored.has(singular(word))));
}

/**
 * Prove that an immutable certified block may satisfy a question-driven
 * overall top-N result contract without conversational planning.  A declared
 * limit parameter alone is not enough: the authored SQL must order rows and
 * consume that exact parameter in its LIMIT clause.  This prevents a host
 * from slicing arbitrary connector order and presenting it as certified.
 */
export function certifiedBlockProvesRequestedTopN(
  block: KGNode,
  plan: AnalysisQuestionPlan,
  options: {
    /**
     * Direct, snapshot-local authored question/title/alias evidence. This is
     * still useful evidence, but is not the only way a uniquely complete
     * certified fit may use its authored ranking default.
     */
    exactCertifiedQuestionMatch?: boolean;
    /**
     * The host proved that exactly one admitted certified artifact covers the
     * requested tuple in this immutable snapshot. Provider text cannot set
     * this; it is a retrieval/capability fact.
     */
    uniqueCompleteCertifiedFit?: boolean;
    /**
     * Server-owned execution capability: the typed invocation row limit is
     * frozen into the plan and enforced at the read-only SQL boundary before
     * result normalisation. It only substitutes for an authored SQL LIMIT
     * when the immutable query has no outer LIMIT of its own.
     */
    hostEnforcedRowLimit?: number;
  } = {},
): boolean {
  const topN = plan.requestedShape.topN;
  if (!topN) {
    // No ranking was asked for. A block that RANKS — a fixed outer LIMIT —
    // still answers a scalar ("total revenue") or its own authored question,
    // but it does not answer "for each customer": ten customers are not
    // each customer. The catalog fit sees matching outputs; only the SQL
    // shows the truncation.
    if (options.exactCertifiedQuestionMatch === true) return true;
    if (plan.requestedShape.dimensions.length === 0 && !plan.requestedShape.grain) {
      // A scalar was asked for ("total revenue"). A block that GROUPS —
      // revenue per customer — is not that scalar, however relevant its
      // columns look; "top_customers" is not "revenue".
      const grouped = (Array.isArray(block?.dimensions) ? block!.dimensions : []).length > 0;
      return !grouped;
    }
    if (!block || block.kind !== 'block' || typeof block.sql !== 'string') return true;
    const outer = scanOutermostTopNClauses(block.sql);
    const fixedOuterLimit = outer !== undefined
      && typeof outer.limitValue === 'string'
      && /^\d+$/.test(outer.limitValue.trim());
    return !fixedOuterLimit;
  }
  // The artifact is loaded from the snapshot-bound KG, but that persisted
  // payload still crosses an older JSON schema boundary. Treat a malformed
  // parameter contract as *not proved*, never as a reason to crash the Ask
  // run or to infer an unordered ranking from connector row order.
  if (topN.scope !== 'overall' || !block || block.kind !== 'block') return false;

  const limitParameters = (Array.isArray(block.parameters) ? block.parameters : []).flatMap((parameter) => {
    if (!parameter || typeof parameter.name !== 'string' || parameter.name.trim() === '') return [];
    return parameter.name === 'top_n' || parameter.binding?.kind === 'limit'
      ? [parameter]
      : [];
  });
  if (typeof block.sql !== 'string') return false;
  const outerClauses = scanOutermostTopNClauses(block.sql);
  if (!outerClauses) return false;
  const { orderBy, limitValue } = outerClauses;

  // There are exactly two safe ways to prove the overall row bound:
  //
  // 1. The immutable artifact consumes its own declared top-N parameter in
  //    the outer LIMIT clause (the ordinary certified contract); or
  // 2. The artifact intentionally has no outer LIMIT and the local host owns
  //    a frozen, typed execution row limit at the read-only SQL boundary.
  //
  // We never treat a fixed, driver-style, compound, or stale outer LIMIT as
  // equivalent to the requested value. In particular, an existing fixed
  // LIMIT prevents the host executor from appending the frozen limit, so it
  // cannot prove a different user-requested top N.
  const limitUsesDeclaredParameter = limitParameters.length === 1
    && typeof limitValue === 'string'
    && outerLimitUsesDeclaredTopNParameter(limitValue, limitParameters[0]!.name);
  const hostOwnsFrozenRowLimit = limitValue === undefined
    && Number.isInteger(options.hostEnforcedRowLimit)
    && options.hostEnforcedRowLimit === topN.n
    && options.hostEnforcedRowLimit! > 0;
  // 3. The artifact's own fixed outer LIMIT is exactly the requested N, and
  //    the host holds snapshot evidence that this block is THE answer to
  //    this question (an authored example matched it, or it is the one
  //    complete certified fit). "Top customers" over a block authored with
  //    LIMIT 10 is the most ordinary certified question there is; refusing
  //    it because the 10 was not a parameter sent every such question down
  //    to the analyst. A fixed LIMIT still proves nothing for a DIFFERENT N.
  const fixedLimitMatchesRequest = typeof limitValue === 'string'
    && /^\d+$/.test(limitValue.trim())
    && Number(limitValue.trim()) === topN.n
    && (options.exactCertifiedQuestionMatch === true || options.uniqueCompleteCertifiedFit === true);
  if (!limitUsesDeclaredParameter && !hostOwnsFrozenRowLimit && !fixedLimitMatchesRequest) return false;

  // A question-driven ranking is only exact when the *primary* authored sort
  // expression proves the requested measure.  Finding `revenue DESC` later in
  // `ORDER BY customer_name ASC, revenue DESC` is not sufficient: the result
  // is primarily alphabetical, not a top-revenue result.  Do not infer a
  // ranking measure from row shape or candidate tags; that would turn an
  // unproven certified artifact into a false exact answer.
  const requestedMeasures = plan.requestedShape.measures
    .map(normalizedTopNMetricId)
    .filter(Boolean);
  // An omitted measure is not normally a license to infer a ranking from a
  // certified block. The narrow exception is server-owned evidence that this
  // is either a direct certified question/title/alias match *or* the one
  // complete certified tuple admitted by this immutable retrieval snapshot.
  // In both cases the artifact's own primary non-dimension output supplies
  // the authored default ranking contract. A provider cannot manufacture
  // either flag from text or a card count.
  const useAuthoredRankingDefault = requestedMeasures.length === 0
    && (options.exactCertifiedQuestionMatch === true
      || options.uniqueCompleteCertifiedFit === true);
  if (requestedMeasures.length === 0 && !useAuthoredRankingDefault) return false;

  const firstOrderExpression = splitTopLevelSqlList(orderBy)[0];
  if (!firstOrderExpression) return false;

  const firstOrder = parseTopNOrderExpression(firstOrderExpression);
  if (!firstOrder) return false;

  const requiredDirection = plan.requestedShape.rankingDirection === 'bottom' ? 'asc' : 'desc';
  if (firstOrder.direction !== requiredDirection) return false;

  const orderMetricIds = topNOrderMetricIds(firstOrder.expression, block);
  // An authored example that matches the question verbatim is the author's
  // own statement that this ranking answers it; the measure the parser
  // reduced the question to ("spend" for "lifetime spend") need not be
  // re-derived from the ORDER BY, only the ordering itself must be a metric.
  if (options.exactCertifiedQuestionMatch === true && orderMetricIds.size > 0) return true;
  if (requestedMeasures.length > 0) {
    return requestedMeasures.some((measure) => orderMetricIds.has(measure));
  }
  return [...authoredTopNRankingMetricIds(block)].some((metric) => orderMetricIds.has(metric));
}

/**
 * The implicit-ranking exception still needs an authored metric, not merely a
 * sortable dimension.  Keep this proof inside the immutable block contract:
 * declared outputs, compiler output lineage, and typed output roles are all
 * captured with the artifact.  If an older block cannot distinguish its
 * measures from dimensions, fail closed into the Ask planner.
 */
function authoredTopNRankingMetricIds(block: KGNode): Set<string> {
  const dimensionIds = new Set((block.dimensions ?? []).map(normalizedTopNMetricId).filter(Boolean));
  const outputRoles = new Map(
    (block.outputContract ?? [])
      .filter((output) => typeof output?.name === 'string')
      .map((output) => [normalizedTopNMetricId(output.name), String(output.role ?? '').toLowerCase()]),
  );
  const outputIds = new Set([
    ...(block.declaredOutputs ?? []),
    ...(block.outputs ?? []).map((output) => output.name),
    ...(block.outputContract ?? []).map((output) => output.name),
  ].map(normalizedTopNMetricId).filter(Boolean));
  const metrics = new Set<string>();
  for (const outputId of outputIds) {
    const role = outputRoles.get(outputId) ?? '';
    if (dimensionIds.has(outputId) || /(?:dimension|entity|label|attribute)/.test(role)) continue;
    metrics.add(outputId);
  }
  return metrics;
}

function outerLimitUsesDeclaredTopNParameter(limitValue: string, parameterName: string): boolean {
  const escapedParameter = parameterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // This proof is about an authored DQL artifact, not a connector SQL
  // statement. Accept only the two compiler-recognized interpolation forms
  // (`${name}` and `{name}`); driver placeholders, bare identifiers, fixed
  // values, and compound expressions do not prove that the requested typed
  // top-N binding controls the outer result contract.
  return new RegExp(
    `^(?:\\$\\{\\s*${escapedParameter}\\s*\\}|\\{\\s*${escapedParameter}\\s*\\})$`,
    'i',
  ).test(topNVisibleSql(limitValue).trim());
}

interface TopLevelSqlToken {
  text: string;
  start: number;
  end: number;
}

interface OutermostTopNClauses {
  /** The outer SELECT projection list, retained for alias resolution. */
  selectList: string;
  /** The outer ORDER BY expression list only. */
  orderBy: string;
  /** The outer LIMIT expression only, excluding OFFSET/FETCH/etc. */
  limitValue?: string;
}

/**
 * Locate the outer SELECT/ORDER BY/LIMIT clauses without treating text in a
 * CTE, subquery, quoted identifier/string, or comment as part of the answer
 * contract. A ranking proof must be about the query that actually returns the
 * block rows, never an unused inner query that happens to mention revenue.
 */
function scanOutermostTopNClauses(sql: string): OutermostTopNClauses | undefined {
  const tokens = topLevelSqlTokens(sql);
  if (!tokens) return undefined;

  let orderByIndex = -1;
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index]!.text === 'order' && tokens[index + 1]!.text === 'by') orderByIndex = index;
  }
  if (orderByIndex < 0) return undefined;

  let selectIndex = -1;
  for (let index = 0; index < orderByIndex; index += 1) {
    if (tokens[index]!.text === 'select') selectIndex = index;
  }
  if (selectIndex < 0) return undefined;

  let fromIndex = -1;
  for (let index = selectIndex + 1; index < orderByIndex; index += 1) {
    if (tokens[index]!.text === 'from') {
      fromIndex = index;
      break;
    }
  }
  if (fromIndex < 0) return undefined;

  let limitIndex = -1;
  for (let index = orderByIndex + 2; index < tokens.length; index += 1) {
    if (tokens[index]!.text === 'limit') {
      limitIndex = index;
      break;
    }
  }
  const orderByEnd = limitIndex >= 0 ? tokens[limitIndex]!.start : sql.length;
  // The outer ORDER BY must directly govern the outer LIMIT when one exists.
  // A set operation, second SELECT, or a second ORDER BY in between is too
  // complex for this exact shortcut and correctly falls back to the bounded
  // Ask tool runtime. The same guard applies through end-of-query for an
  // intentionally unbounded artifact whose host owns the frozen row limit.
  if (tokens.slice(orderByIndex + 2, limitIndex >= 0 ? limitIndex : tokens.length).some((token) =>
    token.text === 'select' || token.text === 'union' || token.text === 'intersect' || token.text === 'except')) {
    return undefined;
  }

  const afterLimit = limitIndex >= 0 ? tokens.find((token, index) => index > limitIndex && (
    token.text === 'offset' || token.text === 'fetch' || token.text === 'for'
  ))?.start ?? sql.length : sql.length;
  const selectList = sql.slice(tokens[selectIndex]!.end, tokens[fromIndex]!.start).trim();
  const orderBy = sql.slice(tokens[orderByIndex + 1]!.end, orderByEnd).trim();
  const limitValue = limitIndex >= 0
    ? sql.slice(tokens[limitIndex]!.end, afterLimit).replace(/;\s*$/, '').trim()
    : undefined;
  if (!selectList || !orderBy || (limitIndex >= 0 && !limitValue)) return undefined;
  return {
    selectList,
    orderBy,
    ...(limitValue ? { limitValue } : {}),
  };
}

/**
 * Tokenize only depth-zero SQL words. The state machine deliberately removes
 * comments and literals from consideration while retaining positional ranges
 * against the original SQL for clause slicing.
 */
function topLevelSqlTokens(sql: string): TopLevelSqlToken[] | undefined {
  const tokens: TopLevelSqlToken[] = [];
  let depth = 0;
  let quote: "'" | '"' | '`' | ']' | undefined;
  let lineComment = false;
  let blockCommentDepth = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];

    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (quote === ']' && character === ']') {
        if (next === ']') index += 1;
        else quote = undefined;
      } else if (quote !== ']' && character === quote) {
        if (next === quote) index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (character === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '[') {
      quote = ']';
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      if (depth === 0) return undefined;
      depth -= 1;
      continue;
    }
    if (depth !== 0 || !/[A-Za-z_]/.test(character)) continue;

    const start = index;
    index += 1;
    while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index += 1;
    tokens.push({ text: sql.slice(start, index).toLowerCase(), start, end: index });
    index -= 1;
  }

  // A line comment is valid through EOF. Unterminated string, bracket, block
  // comment, or parenthesis state is not a trustworthy exact-proof input.
  return depth === 0 && !quote && blockCommentDepth === 0 ? tokens : undefined;
}

/**
 * Split an authored comma-separated SQL list without treating a function
 * argument, quoted string, or quoted identifier as a second ORDER BY key.
 * This intentionally stays small and fails closed for malformed SQL; DQL's
 * compiler is still the authority for execution syntax.
 */
function splitTopLevelSqlList(value: string): string[] {
  const expressions: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | '`' | ']' | undefined;
  let lineComment = false;
  let blockCommentDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (quote === ']' && character === ']') {
        if (next === ']') index += 1;
        else quote = undefined;
      } else if (quote !== ']' && character === quote) {
        // SQL escapes an in-string quote by doubling it. Keep scanning inside
        // the quoted value rather than mistaking a later comma for a list
        // separator.
        if (value[index + 1] === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '[') {
      quote = ']';
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (character === ',' && depth === 0) {
      const expression = value.slice(start, index).trim();
      if (!expression) return [];
      expressions.push(expression);
      start = index + 1;
    }
  }

  if (quote || blockCommentDepth > 0 || depth !== 0) return [];
  const finalExpression = value.slice(start).trim();
  return finalExpression ? [...expressions, finalExpression] : [];
}

function parseTopNOrderExpression(expression: string): { expression: string; direction: 'asc' | 'desc' } | undefined {
  const visible = topNVisibleSql(expression);
  const match = visible.match(/^(.*?)(?:\s+(asc|desc))(?:\s+nulls\s+(?:first|last))?\s*$/i);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    expression: expression.slice(0, match[1].length).trim(),
    direction: match[2].toLowerCase() as 'asc' | 'desc',
  };
}

/** Preserve SQL positions while blanking literals/comments that cannot prove a ranking contract. */
function topNVisibleSql(value: string): string {
  let output = '';
  let quote: "'" | '"' | '`' | ']' | undefined;
  let lineComment = false;
  let blockCommentDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    const blank = () => { output += character === '\n' || character === '\r' ? character : ' '; };
    if (lineComment) {
      blank();
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      blank();
      if (character === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
        output += ' ';
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
        output += ' ';
      }
      continue;
    }
    if (quote === "'") {
      blank();
      if (character === "'") {
        if (next === "'") {
          index += 1;
          output += ' ';
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (quote) {
      // Keep quoted identifiers intact for identifier normalization while the
      // outer-clause scanner itself ignores their contents.
      output += character;
      if (quote === ']' && character === ']') {
        if (next === ']') {
          index += 1;
          output += next;
        } else {
          quote = undefined;
        }
      } else if (quote !== ']' && character === quote) {
        if (next === quote) {
          index += 1;
          output += next;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === '-' && next === '-') {
      output += '  ';
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === '/' && next === '*') {
      output += '  ';
      index += 1;
      blockCommentDepth = 1;
      continue;
    }
    if (character === "'") {
      output += ' ';
      quote = character;
      continue;
    }
    if (character === '"' || character === '`') {
      output += character;
      quote = character;
      continue;
    }
    if (character === '[') {
      output += character;
      quote = ']';
      continue;
    }
    output += character;
  }
  return output;
}

/** Normalize an identifier or business measure into its opaque-free SQL key. */
function normalizedTopNMetricId(value: string): string {
  return value
    .trim()
    .replace(/^['"`\[]|['"`\]]$/g, '')
    .split('.')
    .at(-1)!
    .trim()
    .replace(/^['"`\[]|['"`\]]$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolve the primary ORDER BY expression through selected-output aliases and
 * captured output lineage.  Qualified columns (`c.revenue`), SQL aliases
 * (`SUM(o.revenue) AS revenue` / `ORDER BY revenue`), and compiler-captured
 * output sources all converge on the same normalized key.  Unknown or
 * ambiguous expressions deliberately yield no proof.
 */
function topNOrderMetricIds(expression: string, block: KGNode): Set<string> {
  const keys = topNIdentifierIds(expression);
  const selectedAliases = selectedSqlOutputAliases(block.sql);
  const outputLineage = block.outputs ?? [];

  for (const key of [...keys]) {
    const selectedExpression = selectedAliases.get(key);
    if (selectedExpression) {
      for (const selectedKey of topNIdentifierIds(selectedExpression)) keys.add(selectedKey);
    }
    for (const output of outputLineage) {
      if (normalizedTopNMetricId(output.name) !== key) continue;
      for (const source of output.sources ?? []) {
        const sourceKey = normalizedTopNMetricId(source.column);
        if (sourceKey) keys.add(sourceKey);
      }
    }
  }

  return keys;
}

function topNIdentifierIds(expression: string): Set<string> {
  const keys = new Set<string>();
  // Quoted identifiers remain intact, while literals/comments were blanked.
  // Therefore a string such as `'revenue'` cannot prove a ranking measure.
  const identifierPattern = /(?:\[[^\]]+\]|"(?:""|[^"])+"|`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_$]*)/g;
  for (const identifier of topNVisibleSql(expression).match(identifierPattern) ?? []) {
    const key = normalizedTopNMetricId(identifier);
    if (key && !TOP_N_SQL_WORDS.has(key)) keys.add(key);
  }
  return keys;
}

function selectedSqlOutputAliases(sql: string | undefined): Map<string, string> {
  if (!sql) return new Map();
  const select = scanOutermostTopNClauses(sql)?.selectList;
  if (!select) return new Map();

  const aliases = new Map<string, string>();
  for (const projection of splitTopLevelSqlList(select)) {
    const visibleProjection = topNVisibleSql(projection);
    const explicitAlias = visibleProjection.match(/^(.*?)\s+as\s+((?:\[[^\]]+\])|(?:"(?:""|[^"])+")|(?:`(?:``|[^`])+`)|(?:[A-Za-z_][A-Za-z0-9_$]*))\s*$/i);
    const implicitAlias = explicitAlias
      ? undefined
      : visibleProjection.match(/^(.*?)\s+((?:\[[^\]]+\])|(?:"(?:""|[^"])+")|(?:`(?:``|[^`])+`)|(?:[A-Za-z_][A-Za-z0-9_$]*))\s*$/i);
    const expressionLength = (explicitAlias?.[1] ?? implicitAlias?.[1] ?? visibleProjection).length;
    const expression = projection.slice(0, expressionLength).trim();
    const alias = (explicitAlias?.[2] ?? implicitAlias?.[2] ?? projection).trim();
    const aliasId = normalizedTopNMetricId(alias);
    if (aliasId) aliases.set(aliasId, expression);
  }
  return aliases;
}

const TOP_N_SQL_WORDS = new Set([
  'asc', 'desc', 'nulls', 'first', 'last', 'sum', 'avg', 'average', 'count',
  'min', 'max', 'cast', 'coalesce', 'case', 'when', 'then', 'else', 'end',
]);

export interface AgentSchemaTable {
  relation: string;
  schema?: string;
  name: string;
  description?: string;
  columns: AgentSchemaColumn[];
  source?: string;
  /**
   * Whether `columns` is the WHOLE relation. Required: a producer that slices
   * a wide relation for a prompt must say so, because a gate that believed an
   * 80-column prefix was complete hard-rejected real columns. Caps are for
   * prompts, never for gates; this marker is how the gate knows.
   */
  columnCompleteness: 'partial' | 'complete';
  /** Optional metadata-context rank; lower is better. Used to preserve catalog relation ordering. */
  selectionRank?: number;
  selectionScore?: number;
  selectionReason?: string;
}

export interface AgentAnalysisPlan {
  question: string;
  intent: AgentIntent;
  routeReason: string;
  grain?: string;
  measures: string[];
  dimensions: string[];
  candidateTables: Array<{
    relation: string;
    columns: string[];
    reason?: string;
  }>;
  candidateJoins: AgentJoinPath[];
  trustedContext: Array<{
    kind: KGNode['kind'] | 'memory';
    name: string;
    certification?: TrustLabelId | AnswerCertification | 'uncertified' | 'analyst_review_required';
    sourceTier?: AnswerSourceTier | 'memory' | 'project';
  }>;
  assumptions: string[];
  sql?: string;
  suggestedViz?: string;
  followUps: string[];
  repairAttempts?: number;
}

export interface AgentJoinPath {
  leftRelation: string;
  leftColumn: string;
  rightRelation: string;
  rightColumn: string;
  reason?: string;
}

export interface AgentPriorResultReference {
  id: string;
  question?: string;
  columns: string[];
  rowCount?: number;
  sourceSql?: string;
}

export type AgentDqlArtifactReference = DqlArtifactReference;

/**
 * A warehouse member resolved before retrieval.  This is deliberately distinct
 * from a text search term: every downstream lane must preserve the dimension,
 * value, provenance, and match confidence instead of re-interpreting prose.
 * AGT-012.
 */
export interface AgentMemberBinding {
  dimension: string;
  values: string[];
  source: 'prior_result' | 'question' | 'clarification';
  confidence: 'exact' | 'unique_partial' | 'deictic';
  sourceTurnId?: string;
}

/**
 * Server-owned decision for whether a current turn may consume earlier
 * analytical state. Omitted values belong to historical persisted runs and
 * are treated as `none`; callers must never infer a binding from prose alone.
 */
export type AgentConversationBindingV1 =
  | 'none'
  | 'structured_clarification'
  | 'prior_result'
  | 'task_dependency';

export interface AgentFollowUpContext {
  /**
   * 'generic'/'drilldown' — regex-classified follow-ups with routing force.
   * 'contextual' — always-on advisory carry for any question in an ongoing
   * conversation; never excludes artifacts, forces filters, or shifts intent.
   */
  kind: 'generic' | 'drilldown' | 'contextual';
  /** Deterministic server decision; not an LLM-provided routing hint. */
  binding?: AgentConversationBindingV1;
  sourceTurnId?: string;
  sourceBlockName?: string;
  sourceQuestion?: string;
  sourceAnswer?: string;
  filters?: string[];
  dimensions?: string[];
  priorResultColumns?: string[];
  priorResultValues?: Record<string, string[]>;
  priorResultRef?: AgentPriorResultReference;
  priorDqlArtifact?: AgentDqlArtifactReference;
  priorLimit?: number;
  priorMeasures?: string[];
  memberBindings?: AgentMemberBinding[];
  resolvedReferences?: string[];
  unresolvedReferences?: string[];
  /**
   * An explicit plural reference (for example, "those customers") whose
   * bounded prior-result entity set was not retained locally. This is a typed
   * clarification/gap signal, never permission to widen the next query to all
   * members.
   */
  priorResultSetUnavailable?: boolean;
  /**
   * What a singular reference ("this customer") could have meant when the prior
   * result offered several. Present ONLY when the reference is genuinely
   * ambiguous; the run turns these into clarification options rather than
   * picking one and pretending the user chose it.
   */
  deicticChoices?: { dimension: string; values: string[] };
  /** Prior typed contract; prose and SQL remain evidence-only. */
  priorResolvedAnalyticalPlan?: ResolvedAnalyticalPlan;
  /** Explicit qualified delta applied to the prior plan for this turn. */
  resolvedAnalyticalPlanDelta?: ResolvedAnalyticalPlanDelta;
  /**
   * The prior turn's actual result rows (bounded sample), so a follow-up that
   * computes ACROSS the shown results ("of these, the average") is answered from
   * the returned rows instead of a fresh query. See result-ops.ts.
   */
  priorResult?: {
    columns: string[];
    rows: unknown[][];
    measureColumns?: string[];
    rowCount?: number;
  };
}

export interface AgentEvidence {
  route: AgentEvidenceRouteStep[];
  lineage: AgentEvidenceLineageNode[];
  businessContext: AgentEvidenceContextItem[];
  outcome?: AgentEvidenceOutcome;
  selectedAssets: AgentEvidenceAsset[];
  sourceTables: AgentEvidenceAsset[];
  semanticObjects: AgentEvidenceAsset[];
  /** Real provider-visible tool observations, distinct from deterministic route breadcrumbs. */
  toolCalls?: AgentEvidenceToolCall[];
  timings?: AgentEvidenceTiming[];
  /** Exact invocation counters captured at provider/tool/execution boundaries. */
  runtimeCounters?: {
    providerRoundTrips: number;
    toolCalls: number;
    sqlExecutions: number;
    repairs: number;
  };
  validation?: {
    status: 'passed' | 'warning' | 'failed' | 'not_run';
    message: string;
  };
  execution?: {
    status: 'executed' | 'failed' | 'not_requested' | 'not_applicable';
    message: string;
    rowCount?: number;
    executionTime?: number;
  };
  citations: AgentCitation[];
  analysisPlan?: AgentAnalysisPlan;
}

/**
 * A redacted, execution-bound projection for the local Ask trace. It is not
 * an analytical-routing or trust input: the originating error remains the
 * authority and this small allowlist merely lets a persisted trace explain a
 * post-freeze local setup failure without storing its message.
 */
export interface AgentAnswerObservabilityExecutionFailureV1 {
  version: 1;
  phase: 'execution';
  cause: 'connection_not_configured';
  safeAction: 'configure_connection';
}

export interface AgentAnswer {
  kind: AnswerKind;
  sourceTier?: AnswerSourceTier;
  certification?: AnswerCertification;
  reviewStatus?: AnswerReviewStatus;
  /** Certification of the governed metric behind a Lane-2 answer (drives 'reviewed' trust). */
  semanticMetricCertification?: string;
  confidence?: number;
  /**
   * P0 intent controller — the high-level action the agent decided this turn
   * deserves (answer / clarify / investigate / compose_app) with a rationale.
   * Advisory: callers route on it (compose_app → app build, investigate → research).
   */
  intentDecision?: IntentDecision;
  /**
   * Snapshot-bound interpretation produced before execution. The router emits
   * authoritative plans by default; shadow mode is the bounded rollback path.
   * Acceptance: AGT-013, API-006.
   */
  resolvedAnalyticalPlan?: ResolvedAnalyticalPlan;
  /** Versioned identity-only executable projection of the resolved plan. */
  executablePlan?: PlanExecutionBinding;
  /** Immutable multi-period graph compiled from the v2 plan. */
  analyticalExecutionGraph?: AnalyticalExecutionGraphV1;
  /**
   * Server-owned exploratory execution freeze. This is emitted only after the
   * selected proposal passed context validation and the host minted one
   * request-scoped capability, before the connector receives SQL.
   */
  exploratoryExecutionFreeze?: ExploratoryExecutionFreezeV1;
  /**
   * A second, repair-specific authorization receipt.  It is intentionally
   * separate from the initial receipt so the engine can prove that the repair
   * kept the same frozen plan rather than replacing it after execution began.
   */
  exploratoryRepairExecutionFreeze?: ExploratoryExecutionFreezeV1;
  /** Terminal receipt binding every source execution and validated output. */
  analyticalExecutionReceipt?: AnalyticalExecutionReceiptV1;
  /** Deterministic facts copied from validated result columns and bound to the receipt. */
  analyticalFacts?: AnalyticalResultFactSetV1;
  /** Business narration whose every claim cites those facts. */
  analyticalNarrative?: AnalyticalNarrativeV1;
  /** Snapshot-bound freshness proof used to resolve relative periods. */
  analyticalFreshnessObservation?: AnalyticalFreshnessObservationV1;
  /** Stable redacted diagnostics for the immutable failed analytical run. */
  analyticalFailure?: AnalyticalFailureV1;
  /**
   * Content-free terminal setup evidence for a frozen execution authority.
   * This is deliberately narrower than `analyticalFailure`: it projects an
   * already tagged host boundary into Ask observability without changing
   * routing, trust, or the user-facing execution error.
   */
  observabilityExecutionFailure?: AgentAnswerObservabilityExecutionFailureV1;
  /** Content-free evidence for provider-bound payloads used by this answer. */
  providerEgressReceipts?: ProviderEgressReceiptV1[];
  /** Positive-evidence aggregation authority; missing/blocked never authorizes repair. */
  aggregationSafetyProof?: AggregationSafetyProofV1;
  /**
   * The V2 lane's statement about a semantic execution's aggregation safety.
   * `safe` when the engine owns join semantics (MetricFlow, dbt Cloud) or the
   * native composer joined nothing, so no fact row could have been multiplied;
   * `unproven` when a native multi-model join ran without a fanout probe. The
   * run's trust label reads this the way it reads the V1 fanout proof.
   */
  semanticExecutionSafety?: { version: 1; status: 'safe' | 'unproven'; reason: string };
  /** Semantic member/path/compiler trace surfaced in How it was answered. */
  semanticExecutionTrace?: SemanticExecutionTrace;
  /** Runtime ambiguity choices discovered after the initial route decision. */
  clarificationOptions?: AgentRunClarificationOption[];
  /** Compiler/result receipt for the authoritative governed relational lane. */
  governedCompilationReceipt?: GovernedCompilationReceipt;
  /** Multi-statement compilation receipt for a governed relational graph. */
  governedAnalyticalGraphCompilationReceipt?: GovernedAnalyticalGraphCompilationReceipt;
  /** Final answer text (NL summary). */
  text: string;
  /**
   * Machine-readable reason for no-answer outcomes. This keeps grounding gaps
   * distinct from genuine ambiguity so callers can retry wider instead of asking
   * the user for clarification.
   */
  refusalCode?: AnswerRefusalCode;
  refusalDetails?: AgentRefusalDetails;
  /** Alias for UI envelopes. */
  answer?: string;
  /** Certified path: the matched block. */
  block?: KGNode;
  /** Certified path execution result, when a governed executor is supplied. */
  result?: AgentResultPayload;
  /** Certified path execution failure, if the block matched but execution failed. */
  executionError?: string;
  /**
   * The router froze a certified block, but its actual returned columns did
   * not prove the requested tuple. This retains certified-tier provenance for
   * a terminal failure without granting the result certified trust or allowing
   * the engine to substitute generated SQL.
   */
  certifiedResultShapeFailure?: boolean;
  /** Structured, redacted warehouse failure used by bounded repair and Inspect UI. */
  warehouseFailure?: WarehouseSqlFailureV1;
  /** Uncertified path: the LLM-proposed SQL the analyst should review. */
  proposedSql?: string;
  /**
   * A host-executable candidate for bounded, review-required exploration after
   * governed SQL was correctly rejected for missing relationship modeling.
   * Presence is the forward-compatible signal for runtimes; `refusalCode`
   * remains `grounding_gap` for older hosts until they adopt this field.
   */
  exploratoryCandidate?: ExploratorySqlCandidate;
  /** Alias for the structured answer envelope. */
  sql?: string;
  /** Suggested viz type for the proposed SQL (line/bar/single_value/...). */
  suggestedViz?: string;
  /** DQL-first artifact source assembled deterministically for the answer, when available. */
  dqlArtifact?: AgentDqlArtifactReference;
  /** Draft block id/path once a host persists the proposal. */
  draftBlockId?: string;
  draftBlock?: GeneratedDraftBlock;
  promoteCommand?: string;
  /** Legacy free-form trust label string, retained for backward compatibility. */
  trustLabel?: string;
  /**
   * Canonical trust label (base + optional qualifier) drawn from the one shared
   * vocabulary in dql-core, derived from this answer's source tier and review
   * state. Lets every surface render the same label set as the MCP answer
   * contract and the UI badge.
   */
  trustLabelInfo?: ResolvedTrustLabel;
  /**
   * One-line provenance footer (Anthropic pattern): where the answer came from
   * (source tier), how much to trust it, who owns the source, and whether the
   * data is current. Rendered by every surface so a stakeholder can judge an
   * answer at a glance. Undefined for no-answer outcomes.
   */
  provenanceFooter?: string;
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  /** Server-resolved domain/purpose scope used before retrieval. */
  domainContext?: DomainContextEnvelope;
  validationWarnings?: string[];
  selectedEvidence?: LocalContextPack['evidenceRoles'];
  citations: AgentCitation[];
  /** Relevant local memory supplied as advisory context. */
  memoryContext?: AgentMemory[];
  /** Approved Hint-Graph corrections that were applied to this answer (for transparency). */
  appliedHints?: LocalContextPack['appliedHints'];
  /** Evidence path connecting the question to metadata, SQL/block execution, and review state. */
  evidence?: AgentEvidence;
  /** Business-facing plan the agent used to answer the question. */
  analysisPlan?: AgentAnalysisPlan;
  /** Provider name used (for telemetry / UI badge). */
  providerUsed?: string;
  /** Local SQLite metadata context pack used to ground retrieval, when supplied by the host. */
  contextPack?: LocalContextPack;
  /** Top KG hits the loop considered, useful for the UI's "we considered" panel. */
  considered: KGSearchHit[];
  /** The Skills that shaped this answer (selected, not all), for transparency. */
  appliedSkills?: Array<{ id: string; description?: string }>;
  /**
   * The chosen route (spec 17, part C). Surfaced on every result so the UI can
   * show which tier answered (certified block, governed semantic metric,
   * generated SQL, business context, or an honest refusal). Computed once at the
   * single exit point in `answer()`.
   */
  route?: AiRoute;
  /** Structured terminal lane chosen by the governed answer cascade. */
  cascade?: CascadeAnswerResult;
  /**
   * Internal: the governed metric the semantic tier matched (spec 17, part C).
   * Used only to build `route` at the `answer()` exit point; not part of the
   * stable public payload.
   */
  _semanticMetricMatch?: MetricMatch;
}

export interface AgentResultPayload {
  columns: unknown[];
  rows: unknown[];
  rowCount: number;
  /** Canonical result-contract fingerprint, stable for the named rows/columns. */
  resultFingerprint?: string;
  /**
   * Durable result-level trust. This is intentionally repeated from the Ask
   * envelope because conversation persistence and result follow-ups consume
   * the canonical result independently of the surrounding card.
   */
  trustState?: 'certified' | 'governed' | 'review_required' | 'not_applicable' | 'blocked';
  /** Cascade tier that produced the rows; renderers do not infer it. */
  answerTier?: string;
  executionTime?: number;
  /**
   * The row bound actually cut rows off. Previously a bounded result was
   * indistinguishable from a complete one, so "the top 200" silently read as
   * "all of them".
   */
  truncated?: boolean;
  /**
   * The host-computed time window applied as range filters on this execution.
   * Recorded so the deterministic facts renderer can state WHICH period a
   * result covers — a zero-row answer without its window reads as failure
   * instead of a true "nothing between these dates".
   */
  appliedTimeWindow?: { expression: string; startInclusive: string; endExclusive: string };
  /**
   * Host-side notes about this execution — for example that the reusable DQL
   * block could not be rebuilt. These never mean the RESULT is wrong.
   */
  validationWarnings?: string[];
  chartConfig?: unknown;
  sql?: string;
  blockName?: string;
  blockPath?: string;
  parameters?: Array<{
    name: string;
    value: unknown;
    source: 'policy' | 'explicit' | 'question' | 'prior_result' | 'surface' | 'default';
  }>;
  auditId?: string;
  /** Internal canonical artifact used by the execution host for this result. */
  dqlArtifact?: DqlArtifactReference;
  /** Redacted proof binding source, compiled SQL, parameters, and rows. */
  executionReceipt?: DqlArtifactExecutionReceipt;
  /** Immutable preparation binding produced by the shared Ask/Notebook runtime boundary. */
  executableArtifact?: DqlExecutableArtifactV1;
  /** Full target-bound semantic proof; separate from the compact DQL receipt. */
  semanticExecutionReceipt?: object;
  semanticTargetBinding?: object;
  semanticTrace?: SemanticExecutionTrace;
}

export type WarehouseSqlFailureCategory =
  | 'syntax'
  | 'unknown_relation'
  | 'unknown_column'
  | 'ambiguous_column'
  | 'unsupported_function'
  | 'type_mismatch'
  | 'permission'
  | 'authentication'
  | 'connection'
  | 'timeout'
  | 'cancelled'
  | 'unsafe'
  | 'unknown';

export type WarehouseSqlRetryDisposition =
  | 'model_repair'
  | 'refresh_metadata'
  | 'explicit_retry'
  | 'change_authorized_access'
  | 'terminal';

/**
 * Redacted, connector-neutral execution failure surfaced to every Ask host.
 * Connector errors are duck-typed so dql-agent does not depend on the connector
 * package, while vendor codes and safe positions remain available to repair
 * prompts and Inspect surfaces.
 */
export interface WarehouseSqlFailureV1 {
  version: 1;
  /**
   * WHO produced this failure. Assigned at the throw site (see
   * `analytical-error.ts`); only a genuine connector error is `warehouse`.
   * Everything downstream — gate copy, repair eligibility, UI action — keys off
   * this rather than off regexes over the message text.
   */
  origin: AnalyticalErrorOrigin;
  stage?: AnalyticalErrorStage;
  category: WarehouseSqlFailureCategory;
  retryDisposition: WarehouseSqlRetryDisposition;
  redactedMessage: string;
  /** Full untruncated producer text, inspector-only. */
  diagnostic?: string;
  offending?: AnalyticalErrorOffending;
  driver?: string;
  vendorCode?: string;
  sqlState?: string;
  queryId?: string;
  line?: number;
  position?: number;
  retryable?: boolean;
}

export interface CertifiedBlockInvocationInput {
  question?: string;
  parameters?: Record<string, unknown>;
  parameterSources?: Record<string, 'policy' | 'explicit' | 'question' | 'prior_result' | 'surface' | 'default'>;
  /** Execute with the same global row bound recorded on the reusable artifact. */
  rowLimit?: number;
}

export interface AnswerLoopInput {
  question: string;
  /**
   * Server-owned continuation guard for a plural prior-result member binding.
   * Such a follow-up must execute its already-frozen analytical program with
   * the persisted member set as a filter.  It must not be mistaken for a
   * cross-result arithmetic request merely because it contains "those".
   * Public callers cannot hydrate this flag.
   */
  skipCrossResultComputation?: boolean;
  /** Immutable interpretation selected by the evidence-first router. */
  resolvedAnalyticalPlan?: ResolvedAnalyticalPlan;
  /**
   * Router-owned cascade selection.  An exploratory selection is a dispatch
   * constraint, not a ranking hint: downstream legacy lanes may not reopen a
   * certified or semantic route before the bounded proposal is generated.
   */
  selectedCascadeTier?: Exclude<AnalyticalCascadeTierV1, 'clarify_or_gap'>;
  /** Exact host-selected target authority for a bounded generated proposal. */
  generatedProposalTargetFingerprint?: string;
  /**
   * Router-owned physical closure for a selected exploratory tier.  These are
   * candidate identities from the same retrieval snapshot, never model-supplied
   * relation names.  The loop renders and validates only this closure before a
   * provider can propose executable SQL.
   */
  exploratoryCandidateIds?: string[];
  /** Internal: the single adapter result prepared once at the answer boundary. */
  resolvedPlanExecutionBinding?: PlanExecutionBinding;
  /** Internal: immutable route-neutral graph prepared once at the answer boundary. */
  analyticalExecutionGraph?: AnalyticalExecutionGraphV1;
  /** Internal: deterministic graph-build gap; never reopens routing. */
  analyticalExecutionGraphFailure?: {
    code: AnalyticalExecutionGraphBlockedCode;
    reason: string;
    field?: string;
  };
  /** Internal: governed relative-time binding gap; never reopens routing. */
  analyticalPeriodResolutionFailure?: {
    code: Extract<ResolveAnalyticalPeriodsResult, { status: 'blocked' }>['code'];
    reason: string;
    error?: unknown;
  };
  /** Internal: exact per-period semantic adapter selections. */
  semanticGraphExecutionBinding?: SemanticGraphExecutionBinding;
  /** Internal: constrained AST/SQL compilation prepared at the answer boundary. */
  governedRelationalCompilation?: GovernedRelationalCompileResult;
  /** Internal: per-period governed relational graph compilation. */
  governedAnalyticalGraphCompilation?: GovernedAnalyticalGraphCompileResult;
  /** Captured once by the host for deterministic relative-period resolution. */
  analyticalReferenceInstant?: string;
  /** Optional pre-fetched authorized freshness proof for this snapshot. */
  analyticalFreshnessObservation?: AnalyticalFreshnessObservationV1;
  /** At most one authorized freshness lookup; it cannot search or change route. */
  resolveAnalyticalFreshness?: (request: AnalyticalFreshnessRequestV1) => Promise<AnalyticalFreshnessObservationV1>;
  /**
   * Current notebook/app context, such as upstream SQL or selected filters.
   * This is prompt context only. It is intentionally excluded from KG and
   * memory retrieval so transient SQL cannot change governed routing.
   */
  extraContext?: string;
  /** Active user — used for Skills filtering and the "asked by" record. */
  userId?: string;
  /** Domain to scope the search. Optional. */
  domain?: string;
  /** Server-resolved governed scope. Prefer this over the v2 `domain` alias. */
  domainContext?: DomainContextEnvelope;
  /** Caller-supplied provider; the answer-loop never picks one itself. */
  provider: AgentProvider;
  /** Live KG store. */
  kg: KGStore;
  /**
   * Optional compiled project manifest. Manifest v3 contributes explicit
   * relationship proof to the generated-SQL guard; dbt DAG lineage never does.
   */
  manifest?: DQLManifest;
  /** Project + user-level Skills. */
  skills?: Skill[];
  /** Internal handoff: `skills` already materialize the snapshot KnowledgeLens. */
  skillsSelectionLocked?: boolean;
  /** Hints to prefer specific blocks first (vocabulary mappings from Skills). */
  blockHints?: string[];
  /**
   * Structured context from the host when the user is following up on a prior
   * answer. Generic follow-ups may reuse the same certified block; drilldowns
   * use the prior block as context but look for a distinct certified path or a
   * review-required draft.
   */
  followUp?: AgentFollowUpContext;
  /**
   * Persisted conversation-thread snapshot (working state + rolling summary +
   * recent turns). Advisory prompt context only — never changes governed routing.
   */
  conversationSnapshot?: ConversationSnapshot;
  /** Optional advisory memory. Never outranks project metadata. */
  memoryContext?: AgentMemory[];
  /** Optional AbortSignal forwarded to the provider. */
  signal?: AbortSignal;
  /**
   * Reasoning effort for the provider calls in this run (low/medium/high). The
   * host resolves it (engine per-route effort clamped by the Settings ceiling)
   * and the answer loop forwards it verbatim; providers no-op when unsupported.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Prompt/context depth. Quick keeps normal Ask AI fast; deep widens metadata
   * rendering for research, diagnostics, or explicitly high-effort runs.
   */
  analysisDepth?: AnalysisDepth;
  /**
   * Research-only escape hatch for bounded semantic-member selection. Ordinary
   * Ask resolves meaning before entering this loop and must not reopen routing
   * with another provider call when deterministic composition misses.
   */
  allowProviderSemanticMemberSelection?: boolean;
  /** Qualified candidate IDs selected by the bounded meaning resolver. */
  preferredEvidenceIds?: string[];
  /** Qualified execution ID recommended by meaning resolution. */
  preferredExecutionId?: string;
  /** Optional shared repair/escalation budget model for this answer-loop run. */
  cascadeBudgetModel?: PartialCascadeBudgetModel;
  /**
   * Governed block executor supplied by the CLI/UI/Slack host. The answer loop
   * keeps retrieval deterministic, while hosts enforce persona/RBAC/RLS in the
   * runtime they already own.
   */
  executeCertifiedBlock?: (block: KGNode, invocation?: CertifiedBlockInvocationInput) => Promise<AgentResultPayload>;
  /**
   * Optional host-side generated SQL preview executor. Generated SQL remains
   * AI-generated and review-required; this only lets local hosts show bounded
   * data evidence before an analyst promotes the query into a certified block.
   */
  executeGeneratedSql?: (sql: string, artifact?: DqlArtifactReference) => Promise<AgentResultPayload>;
  /**
   * Host-owned exact-existence probe over the project's explicitly
   * allowlisted physical columns (`agent.runtimeValueGrounding`). Given one
   * question literal it returns which allowlisted columns hold that exact
   * value (case-insensitively) plus the canonical stored spelling — nothing
   * else: no rows, no neighboring values, and never any provider egress. The
   * host-first binder uses it to ground a member filter deterministically;
   * anything other than exactly one match falls back to the analyst loop.
   */
  probeAllowlistedLiteral?: (literal: string) => Promise<{
    status: 'matched' | 'no_match' | 'ambiguous' | 'disabled' | 'unavailable';
    matches: Array<{ relation: string; column: string; canonicalValue: string }>;
  }>;
  /**
   * Host-owned full-catalog term lookup. The bounded RETAINED candidate set
   * can miss a term that IS modeled (routine on a 60k-object catalog), so a
   * "this term is not modeled" claim may only be made against the whole
   * snapshot catalog, never against retention.
   */
  catalogTermMentioned?: (term: string) => Promise<boolean>;
  /**
   * Host-only capability minting for a router-selected exploratory proposal.
   * The loop calls this only after its own SQL/context validation has passed;
   * the returned opaque capability is consumed immediately by the execution
   * closure and is never persisted.
   */
  prepareExploratorySqlExecution?: (
    sql: string,
    artifact?: DqlArtifactReference,
    authorizationAttempt?: Extract<ExploratoryExecutionAuthorizationAttemptV1, { index: 1 }>,
  ) => Promise<{
    capability: AgenticSqlExecutionCapabilityV1;
    freeze: ExploratoryExecutionFreezeV1;
  }>;
  /**
   * Authoritative Ask V2 exploratory boundary.  It is intentionally separate
   * from the V1 router-plan callback above: the host derives this capability
   * from the live V2 snapshot, admitted output closure, SQL bytes, connection
   * policy and a V2 plan fingerprint.  It must not read `resolvedAnalyticalPlan`
   * or a legacy route decision.
   */
  prepareAskV2ExploratorySqlExecution?: (input: {
    version: 2;
    sql: string;
    expectedOutputIds: string[];
    selectedCandidateIds: string[];
    snapshotId?: string;
    planFingerprint: string;
    repair?: boolean;
  }) => Promise<{
    capability: AgenticSqlExecutionCapabilityV1;
    freeze: ExploratoryExecutionFreezeV1;
  }>;
  /**
   * Server-only exact analyst proposal. When present, the ordinary generated
   * lane must execute this SQL through `executeAgenticGeneratedSql`, not ask a
   * second model to regenerate a replacement. It is intentionally excluded
   * from persisted answer/run/artifact contracts.
   */
  forcedGeneratedProposal?: {
    sql: string;
    summary?: string;
    suggestedViz?: string;
  };
  /** Opaque, request-scoped authority paired with forcedGeneratedProposal. */
  agenticSqlExecutionCapability?: AgenticSqlExecutionCapabilityV1;
  /** Server-owned identity used only to bind the in-memory capability. */
  agenticExecutionScope?: {
    runId?: string;
    executionId?: string;
    snapshotId?: string;
    planId?: string;
    targetFingerprint?: string;
    bindings?: unknown;
  };
  /** Host-only execution closure that consumes the capability immediately. */
  executeAgenticGeneratedSql?: (
    capability: AgenticSqlExecutionCapabilityV1,
    sql: string,
    artifact?: DqlArtifactReference,
  ) => Promise<AgentResultPayload>;
  /** Execute an already-finalized governed artifact without translating it back through generated SQL. */
  executeDqlArtifact?: (artifact: DqlArtifactReference) => Promise<AgentResultPayload>;
  /**
   * V2-only governed-relational authorization. The local host freezes the
   * selected qualified closure and connection target before DQL compilation;
   * this path is independent of legacy router decisions and resolved plans.
   */
  authorizeAskV2DqlArtifact?: (input: {
    version: 2;
    candidateIds: string[];
    expectedOutputIds: string[];
    relationshipPathIds: string[];
    snapshotId?: string;
    planFingerprint: string;
    repair?: boolean;
  }) => Promise<{
    planId: string;
    targetFingerprint?: string;
  }>;
  /**
   * Authoritative Ask V2 governed-DQL boundary.  The host compiles the
   * provider-supplied program only after binding every selected candidate and
   * relationship path to the immutable workspace closure.
   */
  executeAskV2DqlArtifact?: (input: {
    version: 2;
    artifact: DqlArtifactReference;
    candidateIds: string[];
    expectedOutputIds: string[];
    relationshipPathIds: string[];
    snapshotId?: string;
    planFingerprint: string;
    authorizationPlanId?: string;
    repair?: boolean;
  }) => Promise<AgentResultPayload>;
  captureGeneratedDraft?: (proposal: {
    question: string;
    sql: string;
    intent: AgentIntent;
    followUp?: AgentFollowUpContext;
    contextPack?: LocalContextPack;
    sourceBlock?: KGNode;
    sourceDqlArtifact?: GeneratedDraftSourceDqlArtifact;
    dqlArtifact?: NonNullable<AgentAnswer['dqlArtifact']>;
    proposedEntity?: string;
    requestedFilters?: string[];
    requestedDimensions?: string[];
    validationWarnings: string[];
    outputs?: string[];
  }) => Promise<GeneratedDraftBlock | undefined> | GeneratedDraftBlock | undefined;
  /** Runtime schema/column context supplied by the host for generated analysis. */
  schemaContext?: AgentSchemaTable[];
  /**
   * Optional resolved semantic layer. When supplied, the semantic lane compiles
   * metric/member selections through SemanticLayer.composeQuery before falling
   * back to generated SQL.
   */
  semanticLayer?: SemanticLayer;
  /**
   * Executability signal for metric SELECTION (composable natively OR the
   * host's semantic runtime — dbt Cloud / MetricFlow CLI — can run it). When
   * absent, defaults to the semantic layer's native composability so
   * runtime-only metrics are demoted rather than silently outranking an
   * executable sibling. Hosts with a full runtime should pass () => true-ish.
   */
  canExecuteSemanticMetric?: (metricName: string) => boolean;
  semanticDriver?: string;
  semanticTableMapping?: Record<string, string>;
  /** Host-owned compiler shared by Notebook, Block Studio, and Ask. */
  semanticQueryCompiler?: SemanticQueryCompiler;
  /**
   * Optional host-backed catalog/runtime expansion for context-validation misses.
   * The answer loop stays closed-world, but the host can widen the inspected
   * world when the validator names an existing relation or column it did not see.
   */
  expandGroundingContext?: GroundingContextExpander;
  /**
   * Optional bounded tool surface for Lanes 2-3. Providers without native tool
   * support ignore this through the generate() fallback.
   */
  answerLoopTools?: AgentToolDefinition[];
  /** Recursive, server-owned guard for provider-visible tool results. */
  providerPayloadGuard?: ProviderToolLoopOptions['providerPayloadGuard'];
  /** Shared local metadata context pack from `.dql/cache/metadata.sqlite`. */
  contextPack?: LocalContextPack;
  /**
   * The project's configured embedder, resolved by the HOST from
   * `dql.config.json` (`ai.embeddings`). Supplying it is an explicit opt-in:
   * without it, metric matching stays on the offline hashed-token provider and
   * `matchSemanticMetric` can never ground a match on embedding similarity
   * alone (`realEmbeddingProvider` is false), so a question that names a metric
   * only by synonym or acronym — "top customers for BCM" against
   * `billed_consumption_monthly` — finds nothing and the router falls through
   * to a bare-ranking clarification with no options.
   */
  embeddingProvider?: EmbeddingProvider;
}

/**
 * Business-language explanation for a failed SQL context validation. The chat
 * surface shows THIS; the validator's machine message (relation ids, repair
 * tool guidance) belongs in refusalDetails/validationWarnings only.
 */
/**
 * Name the ONE aggregation check that actually fired.
 *
 * The refusal used to list all four possible causes — "rounding too early,
 * losing decimal precision, summing a non-additive value, or multiplying rows
 * across a join" — because the specific one was never plumbed into the message.
 * The system knows: `aggregationIntegrityIssuesForSql` classifies each issue and
 * the proof carries the codes. A menu of four causes reads as "something is
 * wrong somewhere", which is exactly the report a user cannot act on.
 */
function aggregationRefusalReason(issueCodes: readonly string[] = []): string | undefined {
  const codes = new Set(issueCodes.map((code) => code.toUpperCase()));
  // Ordered by how badly each distorts the number, so a query tripping several
  // leads with the one that matters most.
  if (codes.has('FANOUT')) {
    return 'joining those tables multiplies rows, so the total would be inflated. Aggregate at the row-level grain first, then join';
  }
  if (codes.has('NON_ADDITIVE_MEASURE')) {
    return 'it sums a measure that is not additive (an average or a ratio cannot be added up). Ask for the governed metric, which carries the right rule';
  }
  if (codes.has('PREMATURE_ROUNDING')) {
    return 'it rounds each value before adding them, which loses money at scale. Rounding belongs on the final total';
  }
  if (codes.has('LOSSY_NUMERIC_CAST')) {
    return 'it converts amounts to floating point before adding them, which drifts on decimal currency';
  }
  return undefined;
}

export function renderContextValidationRefusalForUser(
  code: SqlContextValidationCode | undefined,
  machineError: string,
  memberBindings?: Array<{ dimension: string; values: string[] }>,
  aggregationIssueCodes?: readonly string[],
): string {
  switch (code) {
    case 'unknown_relation':
      return 'I drafted a query, but it uses a table that was not part of the metadata retrieved for this question, so I did not run it. Ask again (retrieval usually finds it on a follow-up), name the table or metric explicitly, or re-sync the dbt metadata.';
    case 'unknown_column':
      return 'I drafted a query, but it references a column that is not in the inspected metadata for those tables, so I did not run it. Name the exact field you mean, or re-sync the dbt metadata if the column is new.';
    case 'misbound_filter': {
      const binding = memberBindings?.[0];
      const target = binding ? `${humanizeAnalyticalEntityId(binding.dimension)} "${binding.values[0] ?? ''}"` : 'the requested value';
      return `I need to filter this answer to ${target}, but the query I drafted did not apply that filter to a matching column, so I did not run it. Tell me which column identifies ${binding ? humanizeAnalyticalEntityId(binding.dimension) : 'that value'}, or rephrase with the exact field name.`;
    }
    case 'ambiguous_filter':
      return 'The value you asked about matches more than one column in the inspected data, so I did not guess. Tell me which field it belongs to and I will run it.';
    case 'missing_baseline':
      return 'This comparison needs a baseline period or value that the drafted query did not include. Say what to compare against (for example, the prior month) and I will run it.';
    case 'unsafe_sql':
      return 'The drafted query used a statement type that is not allowed in this governed preview, so I did not run it.';
    case 'unsafe_aggregation': {
      const reason = aggregationRefusalReason(aggregationIssueCodes);
      if (reason) {
        return `I drafted a query but did not run it, because ${reason}. Ask for the governed metric and I will use the safe version.`;
      }
      // No classified code reached us — say that plainly rather than listing
      // every cause as if one of them were known to apply.
      return 'I drafted a query, but it would change how the metric is calculated, so I did not run it. Ask for the governed semantic metric and I will use the safe version.';
    }
    case 'insufficient_context':
      if (/could not be parsed|parse error|syntax/i.test(machineError)) {
        return 'I drafted a query, but its SQL syntax did not match the connected warehouse, so I did not run it. The failed draft is available in Inspect; retrying will generate a warehouse-specific query.';
      }
      return machineError.trim().length > 0 && !/inspect_metadata_context/i.test(machineError)
        ? `I could not prepare a governed query yet: ${machineError.replace(/\s*Use inspect_metadata_context[^.]*\.\s*$/i, '').trim()}`
        : 'I could not prepare a governed query from the retrieved metadata. Name the specific metric or table and how to break it down, and I can generate a review-required draft.';
    default:
      return machineError.trim().length > 0 && !/inspect_metadata_context/i.test(machineError)
        ? `I could not prepare a governed query yet: ${machineError.replace(/\s*Use inspect_metadata_context[^.]*\.\s*$/i, '').trim()}`
        : 'I could not prepare a governed query from the retrieved metadata. Name the specific metric or table and how to break it down, and I can generate a review-required draft.';
  }
}

/**
 * Materialize exactly the Skill IDs/hashes selected in the immutable context
 * pack. No downstream answer route may rerun trigger/domain selection or add a
 * Skill that was not recorded in the KnowledgeLens.
 *
 * Acceptance: SKILL-003, AGT-013.
 */
export function materializeKnowledgeLensSkills(
  contextPack: LocalContextPack,
  available: Skill[],
): Skill[] {
  const byIdentity = new Map<string, Skill>();
  for (const skill of available) {
    byIdentity.set(skill.qualifiedId ?? skill.id, skill);
    if (!byIdentity.has(skill.id)) byIdentity.set(skill.id, skill);
  }
  return (contextPack.skills ?? []).map((selected) => {
    const identity = selected.qualifiedId ?? selected.id;
    const source = byIdentity.get(identity) ?? byIdentity.get(selected.id);
    if (source) {
      // Guidance is the immutable, bounded snapshot body. Retain structured
      // source fields but never reread or inject a newer disk body mid-run.
      return { ...source, body: selected.guidance };
    }
    return {
      id: selected.id,
      localId: selected.id,
      qualifiedId: selected.qualifiedId,
      scope: 'project',
      domain: selected.domain,
      domains: selected.domains,
      modelAreaRefs: selected.modelAreaRefs,
      kind: selected.kind,
      status: selected.status,
      owner: selected.owner,
      triggers: selected.triggers,
      exclusions: selected.exclusions,
      description: selected.description,
      preferredMetrics: selected.preferredMetrics,
      preferredBlocks: selected.preferredBlocks,
      preferredDimensions: selected.preferredDimensions,
      requiredFilters: selected.requiredFilters,
      clarifyWhen: selected.clarifyWhen,
      examples: [],
      sourceRefs: selected.sourceRefs,
      vocabulary: selected.vocabulary,
      body: selected.guidance,
      sourcePath: selected.sourcePath ?? `snapshot:${selected.objectKey}`,
    };
  });
}

/**
 * Preserve the declared answer shape even when an authored certified block
 * returns a broader result set than its typed `top_n` input.  The V2 exact
 * path uses this same normalization so a provider-free execution cannot
 * present a different result than the ordinary certified route.
 */
export function trimCertifiedBlockResultToRequestedTopN(result: AgentResultPayload, plan: AnalysisQuestionPlan): AgentResultPayload {
  const topN = plan.requestedShape.topN;
  if (!topN || topN.scope === 'per_group' || !Array.isArray(result.rows) || result.rows.length <= topN.n) return result;
  return {
    ...result,
    rows: result.rows.slice(0, topN.n),
    rowCount: Math.min(result.rowCount, topN.n),
  };
}

/**
 * Make the router-selected exploratory physical closure the only SQL authority
 * visible to generation and execution.  The broad context pack remains on the
 * run as diagnostics, but must not make a same-snapshot neighbouring relation
 * executable merely because it ranked well for the surrounding question.
 *
 * Matching is canonical-ID only.  In particular this deliberately does not
 * fall back to relation/model leaf names: duplicate `orders` relations across
 * schemas/domains must not inherit each other's proof.
 */
export function scopeContextPackToExploratoryCandidateClosure(
  contextPack: LocalContextPack | undefined,
  candidateIds: readonly string[] | undefined,
): LocalContextPack | undefined {
  if (!contextPack || !candidateIds?.length) return undefined;
  const requestedIds = new Set(candidateIds.map(normalizeExploratoryCandidateIdentity).filter(Boolean));
  if (requestedIds.size === 0) return undefined;

  const intersects = (values: Iterable<string | undefined>): boolean => {
    for (const value of values) {
      const normalized = normalizeExploratoryCandidateIdentity(value ?? '');
      if (normalized && requestedIds.has(normalized)) return true;
    }
    return false;
  };
  const objectIdentities = (object: MetadataObject): string[] => {
    const payload = object.payload ?? {};
    return [
      object.objectKey,
      object.fullName,
      payload.qualifiedId,
      payload.uniqueId,
      payload.id,
      payload.localId,
      payload.relation,
      payload.table,
      payload.model,
      ...metadataStringValues(payload.sourceObjects),
      ...metadataStringValues(payload.sourceRelations),
      ...metadataStringValues(payload.tableDependencies),
    ].filter((value): value is string => typeof value === 'string');
  };
  const objectRelationReferences = (object: MetadataObject): string[] => {
    const payload = object.payload ?? {};
    return [
      payload.relation,
      payload.table,
      payload.model,
      ...metadataStringValues(payload.sourceObjects),
      ...metadataStringValues(payload.sourceRelations),
      ...metadataStringValues(payload.tableDependencies),
    ].filter((value): value is string => typeof value === 'string');
  };
  const directObjects = contextPack.objects.filter((object) => intersects(objectIdentities(object)));
  const requestedRelations = new Set<string>();
  for (const object of directObjects) {
    for (const relation of objectRelationReferences(object)) {
      const normalized = normalizeExploratoryCandidateIdentity(relation);
      if (normalized) requestedRelations.add(normalized);
    }
  }
  for (const relation of contextPack.allowedSqlContext.relations) {
    if (intersects([relation.objectKey, relation.relation])) {
      requestedRelations.add(normalizeExploratoryCandidateIdentity(relation.relation));
    }
  }
  const relations = contextPack.allowedSqlContext.relations.filter((relation) => {
    const normalized = normalizeExploratoryCandidateIdentity(relation.relation);
    return requestedIds.has(normalized)
      || requestedRelations.has(normalized)
      || Boolean(relation.objectKey && directObjects.some((object) => object.objectKey === relation.objectKey));
  });
  // A router-selected exploratory attempt without a physical relation is not
  // executable. Returning undefined is intentionally fail-closed; callers may
  // preserve the full pack for receipts but may not use it as SQL authority.
  if (relations.length === 0) return undefined;

  const relationIds = new Set(relations.map((relation) => normalizeExploratoryCandidateIdentity(relation.relation)));
  const relationshipEndpointIds = new Set<string>();
  for (const object of directObjects.filter((object) => object.objectType === 'relationship')) {
    const payload = object.payload ?? {};
    for (const endpoint of [payload.from, payload.to]) {
      if (typeof endpoint === 'string') {
        const normalized = normalizeExploratoryCandidateIdentity(endpoint);
        if (normalized) relationshipEndpointIds.add(normalized);
      }
    }
  }
  const objects = contextPack.objects.filter((object) => {
    if (directObjects.includes(object)) return true;
    const identities = objectIdentities(object).map(normalizeExploratoryCandidateIdentity);
    if (identities.some((identity) => relationIds.has(identity) || relationshipEndpointIds.has(identity))) return true;
    return objectRelationReferences(object)
      .map(normalizeExploratoryCandidateIdentity)
      .some((identity) => relationIds.has(identity));
  });
  const objectKeys = new Set(objects.map((object) => object.objectKey));
  const relationKeys = new Set(relations.map((relation) => normalizeRelationKey(relation.relation)));
  const selectedRelations = contextPack.retrievalDiagnostics.selectedRelations?.filter((relation) =>
    relationKeys.has(normalizeRelationKey(relation.relation)));
  const selectedJoinPaths = contextPack.retrievalDiagnostics.selectedJoinPaths?.filter((path) =>
    relationKeys.has(normalizeRelationKey(path.leftRelation))
    && relationKeys.has(normalizeRelationKey(path.rightRelation)));
  return {
    ...contextPack,
    focusObjectKey: contextPack.focusObjectKey && objectKeys.has(contextPack.focusObjectKey)
      ? contextPack.focusObjectKey
      : objects[0]?.objectKey ?? null,
    objects,
    skills: [],
    edges: contextPack.edges.filter((edge) => objectKeys.has(edge.fromKey) && objectKeys.has(edge.toKey)),
    citations: contextPack.citations.filter((citation) => objectKeys.has(citation.objectKey)),
    evidenceSummaries: contextPack.evidenceSummaries.filter((summary) => !summary.objectKey || objectKeys.has(summary.objectKey)),
    evidenceRoles: contextPack.evidenceRoles.filter((role) => objectKeys.has(role.objectKey)),
    allowedSqlContext: {
      relations,
      // Authored block SQL is not a physical exploratory authority.  The
      // selected dbt/runtime relation closure above is the whole prompt/SQL
      // boundary for this tier.
      sourceBlockSql: [],
    },
    retrievalDiagnostics: {
      ...contextPack.retrievalDiagnostics,
      selectedObjects: objects.length,
      selectedEvidence: contextPack.retrievalDiagnostics.selectedEvidence.filter((evidence) => objectKeys.has(evidence.objectKey)),
      selectedRelations,
      selectedJoinPaths,
      schemaShapeCandidates: contextPack.retrievalDiagnostics.schemaShapeCandidates?.filter((candidate) => objectKeys.has(candidate.objectKey)),
      certifiedCandidateFits: contextPack.retrievalDiagnostics.certifiedCandidateFits.filter((candidate) => objectKeys.has(candidate.objectKey)),
    },
  };
}

function metadataStringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizeExploratoryCandidateIdentity(value: string): string {
  return value.trim().replace(/["`\[\]]/g, '').replace(/\s*\.\s*/g, '.').toLowerCase();
}

interface ParsedProposal {
  text: string;
  sql?: string;
  viz?: string;
  outputs?: string[];
  proposedEntity?: string;
  requestedFilters?: string[];
  requestedDimensions?: string[];
}

/**
 * Remove the model's QUERY PLAN scaffolding from user-facing prose.
 *
 * Rule 4 of the SQL prompt tells the model to state its grain, measures, join
 * path, and join keys BEFORE writing SQL. That instruction is load-bearing —
 * it is what prevents wrong-grain answers and fan-out joins — but it is
 * reasoning, not an answer, and it was reaching the reader verbatim:
 *
 *   "QUERY PLAN: grain = one row per customer, filtered to the named customer
 *    (Matthew Meyer, honorific stripped) ... FROM dev.customers c, filtered on
 *    c.customer_name ILIKE '%Matthew Meyer%'."
 *
 * Someone who asked why a customer tops a list should not be handed a join
 * plan. The plan stays in the artifact and the trace; it leaves the prose.
 */
export function stripQueryPlanScaffolding(text: string): string {
  return text
    // A QUERY PLAN section runs to the next blank line or the end of the prose.
    .replace(/(?:^|\n)\s*(?:\*\*)?QUERY PLAN(?:\*\*)?\s*[::][\s\S]*?(?=\n\s*\n|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Public for tests. Prefer the structured W2.7 JSON proposal contract, then
 * fall back to the legacy prose + ```sql block + Viz line format.
 */
export function parseProposal(raw: string): ParsedProposal {
  const structured = parseStructuredProposal(raw);
  if (structured) return structured;
  const sqlMatch = raw.match(/```sql\s*([\s\S]*?)```/i);
  const sql = sqlMatch ? sqlMatch[1].trim() : undefined;
  const vizMatch = raw.match(/^Viz:\s*([a-z_]+)/im);
  const viz = vizMatch ? vizMatch[1].trim().toLowerCase() : undefined;
  // Strip the SQL block + Viz line from the prose to keep the summary clean.
  const text = stripQueryPlanScaffolding(raw
    .replace(/```json[\s\S]*?```/gi, '')
    .replace(/```sql[\s\S]*?```/gi, '')
    .replace(/^Viz:.*$/gim, '')
    .trim());
  return { text, sql, viz };
}

function parseStructuredProposal(raw: string): ParsedProposal | undefined {
  const trimmed = raw.trim();
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [
    fenced,
    trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const proposal = parsedProposalFromJson(parsed);
      if (proposal) return proposal;
    } catch {
      // Invalid structured output falls through to the legacy SQL-fence parser.
    }
  }
  return undefined;
}

function parsedProposalFromJson(value: unknown): ParsedProposal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sql = firstJsonString(record.sql, record.query)?.trim();
  const text = stripQueryPlanScaffolding(
    firstJsonString(record.summary, record.text, record.answer, record.description)?.trim() ?? '',
  );
  const viz = firstJsonString(record.viz, record.visualization, record.chartType)
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z_]/g, '');
  const dql = jsonRecord(record.dql);
  const outputs = firstJsonStringList(record.outputs, dql?.outputs);
  const proposedEntity = firstJsonString(
    dql?.entity,
    dql?.proposedEntity,
    dql?.proposed_entity,
    record.proposedEntity,
    record.proposed_entity,
    record.entity,
  )?.replace(/\s+/g, ' ').trim().slice(0, 160);
  const requestedFilters = firstJsonStringList(
    dql?.filters,
    dql?.requestedFilters,
    dql?.requested_filters,
    record.requestedFilters,
    record.requested_filters,
    record.filters,
  );
  const requestedDimensions = firstJsonStringList(
    dql?.dimensions,
    dql?.requestedDimensions,
    dql?.requested_dimensions,
    record.requestedDimensions,
    record.requested_dimensions,
    record.dimensions,
  );
  if (!sql && !text) return undefined;
  return {
    text,
    ...(sql ? { sql } : {}),
    ...(viz ? { viz } : {}),
    ...(outputs?.length ? { outputs } : {}),
    ...(proposedEntity ? { proposedEntity } : {}),
    ...(requestedFilters?.length ? { requestedFilters } : {}),
    ...(requestedDimensions?.length ? { requestedDimensions } : {}),
  };
}

function firstJsonString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstJsonStringList(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    const list = normalizeProposalStringList(value);
    if (list.length > 0) return list;
  }
  return undefined;
}

function normalizeProposalStringList(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawValues) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 20) break;
  }
  return out;
}

function outputConceptMatches(output: string, concept: string): boolean {
  const outputTokens = normalizedConceptTokens(output);
  const conceptTokens = normalizedConceptTokens(concept);
  return conceptTokens.length > 0 && conceptTokens.every((token) => outputTokens.includes(token));
}

function normalizedConceptTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && token !== 'name' && token !== 'label')
    .map((token) => token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token);
}

function normalizeRelationKey(relation: string): string {
  return relation.replace(/["`]/g, '').replace(/\s*\.\s*/g, '.').toLowerCase().trim();
}

export function normalizeWarehouseSqlFailure(
  error: unknown,
  fallbackDriver?: string,
): WarehouseSqlFailureV1 {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : undefined;
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof record?.message === 'string'
        ? record.message
        : String(error);
  const message = redactWarehouseSqlFailureMessage(rawMessage);
  // An error tagged at its throw site already knows what it is. Running the
  // warehouse regex classifier over it is how `I need values for: region.`
  // came to be reported as a warehouse execution failure.
  const tagged = analyticalErrorDetail(error);
  const category = tagged
    ? categoryForTaggedFailure(tagged)
    : classifyWarehouseSqlFailure(message);
  return {
    version: 1,
    origin: tagged?.origin ?? 'warehouse',
    ...(tagged?.stage ? { stage: tagged.stage } : {}),
    ...(tagged?.diagnostic ? { diagnostic: tagged.diagnostic } : { diagnostic: rawMessage }),
    ...(tagged?.offending ? { offending: tagged.offending } : {}),
    category,
    retryDisposition: tagged
      ? retryDispositionForOrigin(tagged.origin)
      : warehouseSqlRetryDisposition(category),
    redactedMessage: message,
    ...(stringField(record, 'driver') ?? fallbackDriver
      ? { driver: stringField(record, 'driver') ?? fallbackDriver }
      : {}),
    ...(stringField(record, 'vendorCode') ? { vendorCode: stringField(record, 'vendorCode') } : {}),
    ...(stringField(record, 'sqlState') ? { sqlState: stringField(record, 'sqlState') } : {}),
    ...(stringField(record, 'queryId') ? { queryId: stringField(record, 'queryId') } : {}),
    ...(numberField(record, 'line') !== undefined ? { line: numberField(record, 'line') } : {}),
    ...(numberField(record, 'position') !== undefined ? { position: numberField(record, 'position') } : {}),
    ...(typeof record?.retryable === 'boolean' ? { retryable: record.retryable } : {}),
  };
}

/**
 * A tagged failure carries its producer's own code. Map it onto the existing
 * category vocabulary where the meaning genuinely matches (so metadata-refresh
 * and repair affordances keep working), and to `unknown` otherwise — never by
 * pattern-matching the message.
 */
function categoryForTaggedFailure(detail: AnalyticalErrorDetailV1): WarehouseSqlFailureCategory {
  switch (detail.code) {
    case 'unknown_relation':
      return 'unknown_relation';
    case 'unknown_column':
      return 'unknown_column';
    case 'ambiguous_filter':
    case 'ambiguous_column':
      return 'ambiguous_column';
    case 'unsafe_sql':
      return 'unsafe';
    default:
      return 'unknown';
  }
}

/**
 * Repair eligibility by origin. Only a warehouse error is evidence that the SQL
 * itself is wrong, so only a warehouse error may spend a model-repair call.
 * Re-prompting the model to "fix the SQL" after a DQL block-compilation failure
 * or a governance refusal burns budget regenerating SQL that was already fine.
 */
function retryDispositionForOrigin(origin: AnalyticalErrorOrigin): WarehouseSqlRetryDisposition {
  if (origin === 'retrieval_gap') return 'refresh_metadata';
  if (origin === 'provider') return 'explicit_retry';
  return 'terminal';
}

function redactWarehouseSqlFailureMessage(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim()
    .replace(/\b(password|token|secret|private[_ -]?key)\s*[=:]\s*([^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\b(?:https?|snowflake|postgres(?:ql)?):\/\/[^\s]+/gi, '[redacted connection]');
  return (compact || 'Warehouse query failed.').slice(0, 700);
}

function classifyWarehouseSqlFailure(message: string): WarehouseSqlFailureCategory {
  if (/\b(read-only|readonly|select or with|unsafe statement|not permitted sql|delete|insert|update|drop|alter|create|attach|copy|pragma)\b/i.test(message)) {
    return 'unsafe';
  }
  if (/\b(authentication|authenticate|invalid credentials?|incorrect username|login failed|oauth|expired token)\b/i.test(message)) {
    return 'authentication';
  }
  // Snowflake deliberately combines missing-object and authorization wording
  // ("Schema X does not exist or not authorized"). Treat that as relation
  // visibility drift first; a broad permission match would otherwise suppress
  // metadata refresh and make Ask disagree with a working Notebook query.
  if (/\b(table|relation|view|object|schema)\b.*\b(not found|does not exist|unknown|not exist|not authorized)\b/i.test(message)) {
    return 'unknown_relation';
  }
  if (/\b(permission denied|insufficient privileges?|not authorized|access denied|authorization failed|does not have privilege)\b/i.test(message)) {
    return 'permission';
  }
  if (/\b(terminated connection|connection (?:is )?(?:closed|lost|terminated|reset)|not connected|session (?:has )?(?:expired|terminated)|invalid session|econnreset|socket hang up|broken pipe)\b/i.test(message)) {
    return 'connection';
  }
  if (/\b(cancelled|canceled|aborted by user)\b/i.test(message)) return 'cancelled';
  if (/\b(timeout|timed out|deadline exceeded|statement timeout)\b/i.test(message)) return 'timeout';
  if (/\bambiguous\s+(?:reference|column(?:\s+name)?)\b/i.test(message)) return 'ambiguous_column';
  if (/\b(column|identifier|field)\b.*\b(not found|does not exist|not recognized|invalid identifier|unknown)\b/i.test(message)
    || /\bdoes not have a column named\b/i.test(message)
    || /\binvalid identifier\b/i.test(message)) {
    return 'unknown_column';
  }
  if (/\b(function|routine)\b.*\b(not found|does not exist|unknown|unsupported|no matching signature)\b/i.test(message)) {
    return 'unsupported_function';
  }
  if (/\b(type mismatch|cannot cast|conversion error|invalid argument types?|operator does not exist)\b/i.test(message)) {
    return 'type_mismatch';
  }
  if (/\b(parser error|parse error|syntax error|sql compilation error|unexpected token|unexpected keyword)\b/i.test(message)) {
    return 'syntax';
  }
  return 'unknown';
}

function warehouseSqlRetryDisposition(
  category: WarehouseSqlFailureCategory,
): WarehouseSqlRetryDisposition {
  if (category === 'syntax'
    || category === 'unknown_column'
    || category === 'ambiguous_column'
    || category === 'unsupported_function'
    || category === 'type_mismatch') {
    return 'model_repair';
  }
  if (category === 'unknown_relation') return 'refresh_metadata';
  if (category === 'timeout' || category === 'connection') return 'explicit_retry';
  if (category === 'permission' || category === 'authentication') return 'change_authorized_access';
  return 'terminal';
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reduce a raw semantic-runtime compiler failure (often a full MetricFlow
 * resolver dump with repeated errors, suggestion arrays, log paths, and a bug-
 * report link) to the one sentence a business user can act on. The full text is
 * preserved separately in refusalDetails for Inspect.
 */
export function compactSemanticRuntimeFailure(rawFailure: string): string {
  // Strip transport prefixes and the CLI's upgrade nag before reading the
  // resolver's message; neither is the reason the query did not compile.
  const failure = rawFailure
    .replace(/^(?:[a-z-]+ semantic compilation failed:\s*)?(?:MetricFlow compile failed \(\d+\):\s*)?/i, '')
    .replace(/‼️\s*Warning:[^\n]*?dbt-metricflow\s*/g, '')
    .replace(/💡[^\n]*?dbt-metricflow\s*/g, '')
    .trim();
  const groupBy = /does not match any of the available group-by-items for\s+SimpleMetric\(?'?([^'()\s]+)'?\)?/i.exec(failure);
  if (groupBy) {
    const input = /Query Input:\s*\n?\s*['"]?([A-Za-z0-9_.]+)['"]?/.exec(failure)?.[1];
    const suggestions = /Suggestions:\s*\[([^\]]*)\]/.exec(failure)?.[1]
      ?.split(',').map((item) => item.replace(/['"\s]/g, '')).filter(Boolean).slice(0, 3) ?? [];
    return [
      `MetricFlow could not group ${groupBy[1]}${input ? ` by "${input}"` : ''} — the dimension needs its entity-qualified name.`,
      suggestions.length > 0 ? `Valid options include: ${suggestions.join(', ')}.` : '',
      'Ask again naming one of those dimensions, or update the semantic model so the join path is unambiguous.',
    ].filter(Boolean).join(' ');
  }
  // "ERROR: Got error(s) during query resolution. Error #1: Message: <the
  // reason>" — the reason is the part a reader can act on.
  const message = /Message:\s*([^\n]+)/.exec(failure)?.[1]?.trim();
  const firstLine = message ?? failure.split('\n').map((line) => line.trim()).find(Boolean) ?? failure;
  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine;
}
