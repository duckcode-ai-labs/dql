/**
 * Compact, provider-agnostic evidence contracts for retrieval-first routing.
 *
 * Retrieval owns recall and ranking. The meaning resolver sees only this bounded
 * package and may reference only IDs contained in it. Execution remains owned by
 * the host after it validates the selected candidates and route.
 */

import type {
  AnalyticalPolicyContract,
  AnalyticalQuestionFrameV2,
  MetricCapabilityContract,
} from '@zlens/core';
import type { KnowledgeLens } from './domain-context.js';
import {
  buildAnalyticalRequirementSet,
  candidateConflictsWithExplicitRankingMeasure,
  evidenceCandidateRoles,
  hasEntityAttributeTerm,
  isEntityAttributeCandidate,
  selectRoleBalancedMeaningCandidates,
  type AnalyticalRequirementSetV1,
  type AnalyticalRequirementSeedV1,
  type ContextSourceCoverageV1,
  type SameSnapshotRoleExtensionV1,
} from './analytical-orchestration.js';

export type AgentEvidenceKind =
  | "certified_block"
  | "semantic_metric"
  | "semantic_member"
  | "dql_modeling"
  | "dbt_model"
  | "dbt_source"
  | "sql_table"
  | "sql_column";

export type AgentEvidenceTrustTier = "certified" | "semantic" | "governed_sql" | "exploratory";
export type AgentEvidenceCompatibility = "compatible" | "partial" | "incompatible" | "unknown";
/**
 * Host-authored classification of a relationship path card. `exploratory`
 * remains review-required and cannot be displayed or compiled as governed.
 */
export type AgentRelationshipProofClassV1 = 'governed' | 'exploratory';

/**
 * Compact, snapshot-bound relationship proof carried beside raw evidence.
 *
 * Relationship IDs are identities, not safety claims.  Hosts may only use this
 * record to permit an automatic exploratory composition after the router has
 * checked its lifecycle, validation, fanout, cardinality, and join authority.
 * Keeping the proof structured prevents a friendly-looking relationship name
 * from accidentally authorizing a join.
 */
export interface AgentRelationshipSafetyEvidence {
  /** Canonical, qualified relationship identity. */
  id: string;
  /** Other snapshot identities for the same relationship; never safety facts. */
  aliases?: string[];
  from?: string;
  to?: string;
  keys: Array<{ from: string; to: string }>;
  status?: string;
  cardinality?: string;
  fanout?: string;
  staleCertification?: boolean;
  automaticJoinAllowed?: boolean;
  /**
   * Host-minted attestation for one declared, structurally-safe draft/review
   * edge.  It is intentionally distinct from `automaticJoinAllowed`: this
   * can only authorize the review-required exploratory compiler, never a
   * governed relational plan.  Retrieval/LLM payloads must not manufacture
   * this field.
   */
  exploratoryJoinAllowed?: boolean;
  /** Opaque host path fingerprint paired with exploratoryJoinAllowed. */
  exploratoryPathFingerprint?: string;
  certificationFingerprint?: string;
  evidenceExpiresAt?: string;
  validation?: {
    status?: string;
    checkedAt?: string;
    queryFingerprint?: string;
    proofFingerprint?: string;
  };
}

/**
 * One snapshot-local proof that a concrete categorical value was observed on
 * a qualified physical column.  This is deliberately host-only execution
 * evidence: it is not a retrieval synonym, a provider card, or permission to
 * search arbitrary values.  A compiler may turn it into a filter only when
 * the selected qualified column and the current-question literal agree
 * exactly and uniquely.
 */
export interface AgentSafeValueEvidenceV1 {
  version: 1;
  relation: string;
  column: string;
  value: string;
  normalizedValue: string;
}

export interface AgentEvidenceCandidate {
  /** Stable, source-qualified ID. Leaf names are not valid identities. */
  id: string;
  /** Canonical registry identity; `id` may remain a legacy execution key during shadow rollout. */
  qualifiedId?: string;
  kind: AgentEvidenceKind;
  /** Exact semantic registry object class when `kind` intentionally collapses members. */
  semanticObjectType?: 'metric' | 'measure' | 'dimension' | 'entity' | 'model' | 'saved_query';
  trustTier: AgentEvidenceTrustTier;
  name: string;
  aliases?: string[];
  definition?: string;
  formula?: string;
  aggregation?: string;
  /** Source provenance retained so routing can distinguish authored metrics from measure-derived execution shims. */
  provenance?: string;
  domain?: string;
  semanticModel?: string;
  /**
   * Host-captured compiler identity for a semantic object.  This is distinct
   * from the user-facing qualified/display name: the V2 provider selects the
   * opaque candidate ID, while the local MetricFlow/dbt adapter needs the
   * authored local field name (for example `metric_time`).  It is populated
   * only from the immutable semantic snapshot and is intentionally omitted
   * from provider cards and persisted receipts.
   */
  semanticRuntimeName?: string;
  primaryEntity?: string;
  /**
   * Source-authored semantic or physical value type. This is intentionally
   * retained separately from the display name so Ask never treats a typed
   * date/timestamp field as an ordinary categorical grouping just because
   * older semantic indexes serialize every member as `dimension`.
   */
  dataType?: string;
  dimensions?: string[];
  /**
   * Physical columns of a relation candidate, as retrieved from the immutable
   * catalog. This is the vocabulary a governed-relational or exploratory-SQL
   * plan is built from: without it the planner can name the table and nothing
   * inside it. Bounded on the card; `columnCount` reports the true total and
   * `describe_relation` serves the rest.
   */
  columns?: Array<{ name: string; type?: string; description?: string }>;
  columnCount?: number;
  timeGrains?: string[];
  requiredParameters?: string[];
  sourceObjects?: string[];
  relationshipEvidence?: string[];
  /** Canonical modeling entity IDs proven to bind this physical relation. */
  relationshipEndpointIds?: string[];
  /** Structured relationship proof; IDs alone can never authorize a join. */
  relationshipSafety?: AgentRelationshipSafetyEvidence[];
  /**
   * Snapshot-local observed values for a qualified physical categorical
   * column.  This field is never included in a provider meaning card; it is
   * retained only for deterministic literal-to-field binding after a planner
   * selects the candidate.
   */
  safeValueEvidence?: AgentSafeValueEvidenceV1[];
  /**
   * Opaque, host-minted, single-use authorization for one exact-value probe.
   * It has no field metadata and is stripped before planner, trace, receipt,
   * or persistence projections. The local host resolves it against its
   * request/snapshot/candidate registry before it can construct SQL.
   */
  hostLiteralProbeToken?: string;
  /** Present only on a host-authored bounded relationship-path planner card. */
  relationshipProofClass?: AgentRelationshipProofClassV1;
  /** Cross-source relevance score normalized to 0..1 by the retriever. */
  relevanceScore: number;
  matchReasons: string[];
  compatibility: AgentEvidenceCompatibility;
  compatibilityFacts?: string[];
  /**
   * Host-authored role admission from one immutable semantic capability
   * snapshot.  A resolver may select this supplied card, but cannot mint or
   * alter it; the selected metric capability remains the execution authority.
   */
  sameSnapshotRoleExtension?: SameSnapshotRoleExtensionV1;
  /** Normalized executable capability. Names alone never supply missing facts. */
  analyticalCapability?: MetricCapabilityContract;
  /** Deterministic certified-asset fit; ignored for non-certified evidence. */
  analyticalFitClass?: 'exact' | 'parameterized' | 'adaptable';
  /** False means the object must not be shown to the resolver. */
  eligible?: boolean;
  /** True only for an exact qualified/name/approved-alias match. */
  exactMatch?: boolean;
  /**
   * Real membership in the immutable retrieval snapshot. Multiple lanes are
   * retained because fusion must not erase whether a card came from vector,
   * graph, lexical, exact, or the conversation continuation boundary.
   */
  retrievalLanes?: Array<{ lane: 'exact' | 'lexical' | 'vector' | 'graph' | 'conversation'; rank?: number }>;
}

/**
 * Return the authored output identity that proves a certified block can answer
 * one requested measure. This normally reads only the block's own `output:`
 * facts, which are populated from declared/output-contract fields at indexing
 * time. An exact block-title request may additionally carry a
 * `catalog-proven-output:` fact from the snapshot-local catalog fit. That fact
 * is minted only after the catalog has already bound this exact title to a
 * high-confidence certified answer contract; names, tags, examples,
 * definitions, and unrelated retrieved metrics are intentionally absent.
 */
export function certifiedCandidateDeclaredMeasureOutput(
  candidate: AgentEvidenceCandidate,
  requested: string,
): string | undefined {
  if (candidate.kind !== 'certified_block') return undefined;
  const requestedIdentity = canonicalCertifiedOutputMetricIdentity(requested);
  if (!requestedIdentity) return undefined;
  const declared = (candidate.compatibilityFacts ?? [])
    .flatMap((fact) => /^(?:output|catalog-proven-output):\s*(.+)$/i.exec(fact)?.[1] ?? [])
    .map((output) => output.trim())
    .filter(Boolean);
  return declared.find((output) =>
    canonicalCertifiedOutputMetricIdentity(output) === requestedIdentity,
  );
}

/**
 * Return the block output that proves a requested display/grouping dimension.
 * This is intentionally narrower than retrieval matching: only a declared
 * output or the catalog-proven output bridge for an exact certified title may
 * bind a dimension to the block executor. `customer_name` is a valid output
 * for the business term `customer`; arbitrary attributes such as owner or
 * sentiment are not.
 */
export function certifiedCandidateDeclaredDimensionOutput(
  candidate: AgentEvidenceCandidate,
  requested: string,
): string | undefined {
  if (candidate.kind !== 'certified_block') return undefined;
  const requestedIdentity = canonicalCertifiedOutputDimensionIdentity(requested);
  if (!requestedIdentity) return undefined;
  const declared = (candidate.compatibilityFacts ?? [])
    .flatMap((fact) => /^(?:output|catalog-proven-output):\s*(.+)$/i.exec(fact)?.[1] ?? [])
    .map((output) => output.trim())
    .filter(Boolean);
  return declared.find((output) =>
    canonicalCertifiedOutputDimensionIdentity(output) === requestedIdentity,
  );
}

/**
 * Return only the declared block dimensions that define its authored result
 * grain.  A certified block can return descriptive attributes alongside the
 * grain key without changing the number of result rows: a one-row-per-customer
 * profile may legitimately include both `customer_name` and `customer_type`.
 * Treating every returned attribute as a grouping key rejects that complete
 * customer answer and unnecessarily sends a catalog-proven exact match to the
 * provider planner.
 *
 * The proof is deliberately conservative.  When an authored grain fact is
 * present, an output is grain-driving only when its canonical identity is
 * wholly represented by the grain wording.  If no output can be tied back to
 * the grain, retain the older all-dimensions behaviour rather than weakening
 * a block with an opaque grain declaration.  This keeps a customer-ranked
 * block from answering the scalar request `show me revenue`: `customer_name`
 * is still a grain-driving output that the scalar request did not ask for.
 */
export function certifiedCandidateGrainDimensionOutputs(
  candidate: AgentEvidenceCandidate,
): string[] {
  if (candidate.kind !== 'certified_block') return [];
  const declared = [...new Set((candidate.dimensions ?? [])
    .map((dimension) => certifiedCandidateDeclaredDimensionOutput(candidate, dimension))
    .filter((output): output is string => Boolean(output))
    .map((output) => output.trim())
    .filter(Boolean))];
  if (declared.length === 0) return [];

  const grainFacts = (candidate.compatibilityFacts ?? [])
    .flatMap((fact) => /^grain:\s*(.+)$/i.exec(fact)?.[1] ?? [])
    .map((grain) => grain.trim())
    .filter(Boolean);
  if (grainFacts.length === 0) return declared;

  const ignoredGrainTokens = new Set([
    'a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'per', 'row',
    'rows', 'the', 'to', 'with', 'result', 'results', 'record', 'records',
    'ranking', 'rank', 'purchase', 'profile', 'value', 'values',
  ]);
  const grainTokenSets = grainFacts.map((grain) => new Set(
    grain.toLowerCase()
      .replace(/[_./:-]+/g, ' ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token)
      .filter((token) => token.length > 0 && !ignoredGrainTokens.has(token)),
  ));
  const grainDriving = declared.filter((output) => {
    const outputTokens = canonicalCertifiedOutputDimensionIdentity(output)
      .split('_')
      .filter(Boolean);
    return outputTokens.length > 0 && grainTokenSets.some((tokens) =>
      outputTokens.every((token) => tokens.has(token)));
  });
  // An opaque/legacy grain fact is not enough to waive the existing
  // no-extra-grouping protection.  Fall back to every declared dimension if
  // none can be proven as the block's grain key.
  return grainDriving.length > 0 ? grainDriving : declared;
}

/**
 * A certified tier can freeze only when the selected block itself declares
 * every requested measure.  This is deliberately stricter than retrieval
 * relevance: `top_customers` tagged with revenue but outputting only
 * `lifetime_spend` is context, never a certified revenue answer.
 */
export function certifiedCandidateExplicitlyCoversMeasures(
  candidate: AgentEvidenceCandidate,
  requestedMeasures: string[] | undefined,
): boolean {
  if (candidate.kind !== 'certified_block') return false;
  const requested = [...new Set((requestedMeasures ?? [])
    .map(canonicalCertifiedOutputMetricIdentity)
    .filter(Boolean))];
  const effectiveRequested = requested.length > 1
    ? requested.filter((measure) => measure !== 'total' && measure !== 'average')
    : requested;
  return effectiveRequested.every((measure) =>
    Boolean(certifiedCandidateDeclaredMeasureOutput(candidate, measure)),
  );
}

/**
 * Output identity deliberately has a much smaller alias surface than retrieval
 * matching. Generic presentation modifiers are safe (gross/total/monthly
 * revenue); business qualifiers are not (product revenue, beverage revenue,
 * lifetime spend). This mirrors the certified fit gate and prevents a loosely
 * correlated output from borrowing another metric's authority.
 */
function canonicalCertifiedOutputMetricIdentity(value: string): string {
  const aliases: Record<string, string> = {
    avg: 'average',
    drink: 'beverage',
    sale: 'revenue',
    sales: 'revenue',
    score: 'point',
    scorer: 'point',
    scoring: 'point',
    sum: 'total',
  };
  const genericModifiers = new Set([
    'annual', 'average', 'current', 'daily', 'gross', 'monthly', 'net',
    'quarterly', 'total', 'yearly',
  ]);
  // A typed resolver may retain a qualified metric selection in
  // queryIntent. Only its leaf is comparable to a block output; the namespace
  // is authority metadata, not part of the returned column identity.
  const outputLeaf = value.includes(':')
    ? value.split(':').filter(Boolean).at(-1) ?? value
    : value;
  const tokens = outputLeaf
    .toLowerCase()
    .replace(/%/g, ' percentage ')
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .map((token) => aliases[token] ?? token)
    .map((token) => token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token)
    .filter(Boolean);
  while (tokens.length > 1 && genericModifiers.has(tokens[0]!)) tokens.shift();
  while (tokens.length > 1 && genericModifiers.has(tokens.at(-1)!)) tokens.pop();
  return tokens.join('_');
}

function canonicalCertifiedOutputDimensionIdentity(value: string): string {
  const tokens = value
    .toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token)
    .filter(Boolean);
  const displaySuffixes = new Set(['display', 'id', 'key', 'label', 'name', 'title']);
  while (tokens.length > 1 && displaySuffixes.has(tokens.at(-1)!)) tokens.pop();
  return tokens.join('_');
}

export interface AgentRetrievalEvidence {
  snapshotId?: string;
  sourceFingerprint?: string;
  /**
   * Stable, content-addressed proof of the candidate identities and authored
   * capability contracts relevant to a server-issued Ask selection. Unlike a
   * local SQLite snapshot handle, it survives a process restart that rebuilds
   * equivalent index files. It is never a substitute for current candidate
   * membership/capability validation.
   */
  continuityFingerprint?: string;
  knowledgeLens?: KnowledgeLens;
  candidates: AgentEvidenceCandidate[];
  /**
   * Already-retrieved, qualified cards reserved for deterministic host
   * clarification. They do not enter the smaller provider meaning package.
   */
  clarificationCandidates?: AgentEvidenceCandidate[];
  parsedIntent?: Partial<MeaningQueryIntent>;
  /**
   * Member values the reader named that could NOT be bound to a governed value.
   * Live value grounding is opt-in per project, so with it disabled a named
   * member silently vanished from the plan and the run answered as though no
   * member had been asked for.
   */
  unboundMemberTerms?: string[];
  /** Snapshot-compiled policy only; Skill prose never enters route authority. */
  analyticalPolicies?: AnalyticalPolicyContract[];
  /** A snapshot-declared fiscal calendar; absence is never guessed from FY text. */
  fiscalCalendar?: {
    id: string;
    fiscalPeriodFieldId: string;
    /** Required at execution time; optional here preserves older snapshots. */
    dateRoleId?: string;
  };
  /**
   * Atomic same-snapshot relationship paths reserved by the host.  These are
   * identity-only cards for the planner; the local runtime retains the actual
   * relation/edge definitions in an ephemeral workspace bridge.
   */
  relationshipPathHandles?: Array<{
    id: string;
    edgeIds: string[];
    /** Snapshot-qualified relation/column cards covered by this atomic path. */
    candidateIds?: string[];
  }>;
  diagnostics?: {
    searchedKinds?: AgentEvidenceKind[];
    durationMs?: number;
    truncated?: boolean;
    /** Actual retrieval-lane/source state captured with this snapshot. */
    sourceCoverage?: ContextSourceCoverageV1[];
    /**
     * Pre-freeze execution readiness captured against this exact snapshot and
     * active target. These are availability signals, never permission to
     * bypass compiler/relationship safety.
     */
    tierReadiness?: {
      connector?: 'ready' | 'unavailable' | 'unknown';
      activeTarget?: 'ready' | 'unavailable' | 'unknown';
      semanticCompiler?: 'ready' | 'unavailable' | 'unknown';
      /**
       * Compiler readiness for the semantic metric identities in this exact
       * snapshot. The Ask runtime applies this only to its already-selected
       * metric set; a ready unrelated metric must not authorize another
       * external-only metric to freeze.
       */
      semanticCandidateReadiness?: Array<{
        candidateId: string;
        status: 'ready' | 'unavailable' | 'unknown';
        /** Target-bound semantic engines for this exact opaque candidate. */
        engines?: Array<'native' | 'metricflow-cli' | 'dbt-cloud'>;
        /**
         * Host proof that this exact metric can use the in-process semantic
         * compiler even when its imported adapter declaration names another
         * engine. This is never user/provider supplied.
         */
        nativeCompilerProven?: boolean;
      }>;
      physicalSchema?: 'ready' | 'unavailable' | 'unknown';
      targetFingerprint?: string;
      /**
       * Why a present, working semantic engine is nonetheless unusable for
       * this target — most often that dbt's default target and the active DQL
       * connection resolve to different warehouses. Redacted field names and
       * values only; never a credential. Reported so a refusal can name the
       * real cause instead of blaming an engine that is installed and healthy.
       */
      semanticTargetBindingMismatch?: string;
    };
  };
}

export interface MeaningQueryIntent {
  measures: string[];
  dimensions: string[];
  filters: Array<{ field: string; value: string }>;
  timeRange?: string;
  timeGrain?: string;
  order?: "asc" | "desc";
  limit?: number;
  /** Snapshot-bound fiscal binding injected only after a declared calendar is found. */
  fiscalCalendarId?: string;
  /** Declared date role paired with the fiscal calendar; never inferred from text. */
  fiscalDateRoleId?: string;
}

export type MeaningQuestionType =
  | "definition"
  | "value"
  | "ranking"
  | "trend"
  | "comparison"
  | "diagnosis"
  | "research";

export type MeaningExecutionRoute = "certified" | "semantic" | "governed_sql" | "exploratory" | "clarify";
export type MeaningConfidence = "high" | "medium" | "low";

export interface MeaningResolution {
  interpretedQuestion: string;
  questionType: MeaningQuestionType;
  selectedConceptIds: string[];
  recommendedExecutionId?: string;
  queryIntent: MeaningQueryIntent;
  rejectedCandidates: Array<{ id: string; reason: string }>;
  confidence: MeaningConfidence;
  missingInformation: string[];
  recommendedRoute: MeaningExecutionRoute;
  clarifyingQuestion?: string;
  /** RFC 0005 exact analytical meaning; absent for stored/simple v1 requests. */
  analyticalFrame?: AnalyticalQuestionFrameV2;
  /** Exact eligible structured policies applied by the deterministic solver. */
  analyticalPolicyIds?: string[];
  /** Host-owned result of deterministic capability solving; never model-authored. */
  compatibilityOutcome?: 'clarify' | 'modeling_gap' | 'policy_blocked';
  /** Stable solver codes and qualified candidates retained for route diagnostics. */
  compatibilityFailures?: Array<{
    code: string;
    field: string;
    message: string;
    candidateIds: string[];
  }>;
  /** Immutable host tuple supplied before the one bounded meaning call. */
  hostRequirementSeed?: AnalyticalRequirementSeedV1;
  /**
   * Canonical metric-capability dimensions restored from a validated,
   * server-issued clarification selection. This is host continuation state,
   * not a model-provided query-intent field; RAP revalidates each ID against
   * the selected metric capability before it can enter the frozen plan.
   */
  structuredDimensionIds?: string[];
  /** Content-safe record of model fields the host deliberately did not grant authority. */
  overrideReceipts?: MeaningResolutionOverrideReceiptV1[];
  /**
   * Parse-only distinction for the bounded candidate-ID protocol. A provider
   * may return a syntactically valid object with no selected IDs while omitting
   * every clarification instruction. That is not itself a business
   * clarification: the router may use a host-proven frozen plan, if one exists.
   * An explicit provider clarification is intentionally never marked here.
   */
  emptyCandidateBinding?: true;
}

export interface MeaningResolutionOverrideReceiptV1 {
  version: 1;
  field: 'interpreted_question' | 'question_type' | 'query_intent' | 'recommended_route' | 'analytical_frame' | 'candidate_selection' | 'member_binding';
  action: 'host_preserved' | 'selection_accepted';
  reason: string;
  candidateIds?: string[];
}

export interface MeaningResolutionInput {
  question: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  /** Host-owned typed request tuple; never model-authored. */
  requirementSeed?: AnalyticalRequirementSeedV1;
  signal?: AbortSignal;
}

export type AgentMeaningResolver = (input: MeaningResolutionInput) => Promise<MeaningResolution>;

const TRUST_ORDER: Record<AgentEvidenceTrustTier, number> = {
  certified: 4,
  semantic: 3,
  governed_sql: 2,
  exploratory: 1,
};

const COMPATIBILITY_ORDER: Record<AgentEvidenceCompatibility, number> = {
  compatible: 4,
  partial: 3,
  unknown: 2,
  incompatible: 1,
};

/**
 * Produce the bounded evidence package sent to the resolver. Relevance remains
 * primary; trust is only a tie-breaker, so an unrelated certified block cannot
 * displace a materially better semantic match.
 */
export function buildMeaningEvidencePackage(
  evidence: AgentRetrievalEvidence,
  maxCandidates = 16,
  question = '',
): AgentEvidenceCandidate[] {
  const limit = Math.max(1, Math.min(16, Math.floor(maxCandidates)));
  const perKindLimit = Math.max(2, Math.ceil(limit / 2));
  const requirements = buildAnalyticalRequirementSet({ question, parsedIntent: evidence.parsedIntent });
  // First reserve exact and required-role candidates from the FULL canonical
  // set. Applying the same-kind cap first let eight high-scoring owner/sentiment
  // dimensions erase the explicit revenue metric and Account Name before the
  // role-aware admission code ever saw them.
  const canonicalEligible = canonicalizeMetricMeasureCandidates(evidence.candidates)
    .filter((candidate) => candidate.eligible !== false)
    // Preserve the retrieval result for lifecycle/diagnostics, but do not put
    // a correlated non-requested metric in the bounded meaning package. An
    // explicit ranking measure is a typed requirement, not a prompt hint the
    // resolver may replace with a more highly scored BCM/run-rate card.
    .filter((candidate) => !candidateConflictsWithExplicitRankingMeasure(candidate, requirements))
    .sort(compareCandidates);
  const rawPinned = selectRoleBalancedMeaningCandidates({
    candidates: canonicalEligible,
    requirements,
    maxCandidates: limit,
    pinOnly: true,
  });
  // Guard the fill and the pins themselves. A terse request for "accounts"
  // must not retain Account Owner / Sentiment merely because a generic
  // categorical-dimension parser also saw the token "account". An explicit
  // attribute request remains eligible.
  const requestedEntityDisplay = requirements.entityDisplayTerms.length > 0;
  const explicitlyRequestsAttribute = hasEntityAttributeTerm(question);
  const hasRawPinnedEntityLabel = rawPinned.some((candidate) => evidenceCandidateRoles(candidate).includes('entity_label'));
  const pinned = requestedEntityDisplay && hasRawPinnedEntityLabel && !explicitlyRequestsAttribute
    ? rawPinned.filter((candidate) => !isEntityAttributeCandidate(candidate))
    : rawPinned;
  const kindCounts = new Map<AgentEvidenceKind, number>();
  const perKindQualified = canonicalEligible
    .filter((candidate) => {
      // Metric and member evidence share the semantic trust tier but serve
      // different binding lanes. Counting only by trust let several exact
      // member values crowd the executable metric out of the resolver package.
      // Bound noise per evidence kind so every retrieved lane retains recall;
      // downstream compatibility still owns execution authority.
      const count = kindCounts.get(candidate.kind) ?? 0;
      if (count >= perKindLimit) return false;
      kindCounts.set(candidate.kind, count + 1);
      return true;
    });
  // Fill the remaining package under the kind cap without evicting a pin. The
  // resolver still receives at most 16 cards and exactly one meaning call.
  const hasPinnedEntityLabel = pinned.some((candidate) => evidenceCandidateRoles(candidate).includes('entity_label'));
  const safeFill = perKindQualified.filter((candidate) => {
    if (pinned.some((pin) => pin.id === candidate.id)) return false;
    // An account owner/e-mail/sentiment is an attribute, never a substitute
    // for the requested account/customer display entity. Do not let it consume
    // the remaining meaning cards after that display role was successfully pinned.
    return !hasPinnedEntityLabel || !isEntityAttributeCandidate(candidate);
  });
  return [...pinned, ...safeFill]
    .slice(0, limit);
}

/**
 * A dbt semantic metric and its backing measure are one execution authority,
 * not two business meanings. Retain the metric capability and suppress only
 * exact measure identities named by that capability; unrelated measures remain
 * available for genuine ambiguity and multi-metric questions.
 */
export function canonicalizeMetricMeasureCandidates(
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const backingMeasureIds = new Set(candidates.flatMap((candidate) =>
    candidate.semanticObjectType === 'metric'
      || candidate.kind === 'semantic_metric'
      ? candidate.analyticalCapability?.measureIds ?? []
      : []));
  return candidates.filter((candidate) => {
    if (candidate.semanticObjectType !== 'measure') return true;
    return ![candidate.id, candidate.qualifiedId]
      .filter((value): value is string => Boolean(value))
      .some((identity) => backingMeasureIds.has(identity));
  });
}

function compareCandidates(left: AgentEvidenceCandidate, right: AgentEvidenceCandidate): number {
  return Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
    || clamp01(right.relevanceScore) - clamp01(left.relevanceScore)
    || COMPATIBILITY_ORDER[right.compatibility] - COMPATIBILITY_ORDER[left.compatibility]
    || TRUST_ORDER[right.trustTier] - TRUST_ORDER[left.trustTier]
    || left.id.localeCompare(right.id);
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Match only explicit qualified references; ordinary names still use resolution. */
export function findExplicitEvidenceReference(
  question: string,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate | undefined {
  const refs = new Set<string>();
  for (const match of question.matchAll(/@(metric|block|model|table|column)\(([^)]+)\)/gi)) {
    refs.add(normalizeRef(match[2]));
  }
  for (const candidate of candidates) {
    if (question.includes(candidate.id)) refs.add(normalizeRef(candidate.id));
  }
  if (refs.size === 0) return undefined;
  const matches = candidates.filter((candidate) => {
    const candidateRefs = [candidate.id, candidate.name, ...(candidate.aliases ?? [])].map(normalizeRef);
    return candidateRefs.some((ref) => refs.has(ref));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeRef(value: string): string {
  return value.trim().toLowerCase().replace(/[`"']/g, "");
}

/** Validate that a resolver cannot invent or select ineligible evidence. */
export function validateMeaningResolution(
  value: MeaningResolution,
  candidates: AgentEvidenceCandidate[],
  requestedMeasures: string[] = value.queryIntent.measures,
  options: { requirements?: AnalyticalRequirementSetV1 } = {},
): { ok: true; resolution: MeaningResolution } | { ok: false; reason: string } {
  // `id` is the compiler's local canonical identity while `qualifiedId` is
  // the immutable source/semantic handle that the planner and frozen meaning
  // receipt may intentionally preserve.  Both are server-issued identities
  // from this bounded snapshot; accepting the qualified handle here does not
  // create a lexical alias surface or permit invented evidence.
  const byId = new Map<string, AgentEvidenceCandidate>();
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
    if (candidate.qualifiedId) byId.set(candidate.qualifiedId, candidate);
  }
  const selectedConceptIds = value.selectedConceptIds.length > 0
    ? value.selectedConceptIds
    : value.recommendedExecutionId
      ? [value.recommendedExecutionId]
      : [];
  // Selected/recommended IDs are execution authority and must be present in
  // the bounded package the resolver received. Rejections are explanatory
  // only: hosts may retain a full-snapshot rejection ledger even when its
  // card was correctly pruned from the 16-card meaning package. Do not let a
  // non-authoritative rejected ID invalidate an otherwise valid frozen plan.
  const authoritativeIds = [
    ...value.selectedConceptIds,
    ...(value.recommendedExecutionId ? [value.recommendedExecutionId] : []),
  ];
  const invented = authoritativeIds.find((id) => !byId.has(id));
  if (invented) return { ok: false, reason: `The resolver referenced evidence that was not retrieved: ${invented}` };
  const packageRejectedCandidates = value.rejectedCandidates.filter((candidate) => byId.has(candidate.id));
  const normalizedValue = packageRejectedCandidates.length === value.rejectedCandidates.length
    ? value
    : { ...value, rejectedCandidates: packageRejectedCandidates };
  if (normalizedValue.confidence !== "low" && selectedConceptIds.length === 0) {
    return { ok: false, reason: "A medium/high-confidence resolution must select at least one retrieved concept." };
  }
  const selected = selectedConceptIds.map((id) => byId.get(id)!);
  if (selected.some((candidate) => candidate.eligible === false || candidate.compatibility === "incompatible")) {
    return { ok: false, reason: "The resolver selected ineligible or incompatible evidence." };
  }
  // The evidence package normally excludes a competing metric before the
  // resolver sees it. Keep the same check at the model-output boundary so an
  // extension, legacy caller, or malformed resolver response cannot turn an
  // explicitly named ranking measure into a correlated alternative.
  const explicitRankingConflict = options.requirements
    ? selected.find((candidate) => candidateConflictsWithExplicitRankingMeasure(candidate, options.requirements!))
    : undefined;
  if (explicitRankingConflict) {
    return {
      ok: false,
      reason: `The resolver selected a metric that conflicts with the explicit ranking measure: ${explicitRankingConflict.id}`,
    };
  }
  const rejectedIds = new Set(normalizedValue.rejectedCandidates.map((candidate) => candidate.id));
  if (selectedConceptIds.some((id) => rejectedIds.has(id))) {
    return { ok: false, reason: "The resolver both selected and rejected the same evidence." };
  }
  const executionId = normalizedValue.recommendedExecutionId ?? normalizedValue.selectedConceptIds[0];
  if (executionId) {
    const execution = byId.get(executionId)!;
    if (options.requirements && candidateConflictsWithExplicitRankingMeasure(execution, options.requirements)) {
      return {
        ok: false,
        reason: `The resolver selected a metric that conflicts with the explicit ranking measure: ${execution.id}`,
      };
    }
    if (execution.eligible === false || execution.compatibility === "incompatible") {
      return { ok: false, reason: "The recommended execution evidence is ineligible or incompatible." };
    }
    // `recommendedRoute` is deliberately not validated here.  The bounded
    // meaning call can nominate only supplied IDs; the authoritative cascade
    // subsequently evaluates the full host-owned requirement seed against
    // those IDs.  Rejecting a partial selected semantic metric at this boundary
    // used the model-adjacent nomination as route authority and stopped the
    // valid same-snapshot metric + grouping extension before the semantic
    // compatibility solver could prove it.  The same rule applies to a
    // selected certified block: its output contract is checked by the
    // certified cascade before freeze, where an incomplete block advances to
    // semantic/exploratory rather than becoming a false terminal failure.
    //
    // Package membership, eligibility, incompatible evidence, and explicit
    // ranking conflicts above remain hard boundaries; this only defers tier
    // fitness to the host-owned planner.
    void execution;
  }
  if (normalizedValue.analyticalFrame) {
    const invalidFrameReference = firstInvalidAnalyticalFrameReference(
      normalizedValue.analyticalFrame,
      candidates,
      executionId,
    );
    if (invalidFrameReference) {
      return { ok: false, reason: `The analytical frame referenced evidence that was not retrieved: ${invalidFrameReference}` };
    }
  }
  return {
    ok: true,
    resolution: selectedConceptIds === normalizedValue.selectedConceptIds
      ? normalizedValue
      : { ...normalizedValue, selectedConceptIds },
  };
}

function firstInvalidAnalyticalFrameReference(
  frame: AnalyticalQuestionFrameV2,
  candidates: AgentEvidenceCandidate[],
  executionId?: string,
): string | undefined {
  const metricIds = new Set<string>();
  const dimensionIds = new Set<string>();
  const entityIds = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const candidate of candidates) {
    evidenceIds.add(candidate.id);
    if (candidate.qualifiedId) evidenceIds.add(candidate.qualifiedId);
    // Semantic adapters can expose a retrieval-stable member identity beside
    // the canonical capability dimension ID. Those exact aliases are authored
    // snapshot identities, not a lexical fallback. Keep them in the frame
    // proof so a server-issued capability choice survives local index
    // normalization without being treated as invented evidence.
    for (const alias of candidate.aliases ?? []) evidenceIds.add(alias);
    if (candidate.kind === 'semantic_metric') {
      metricIds.add(candidate.id);
      if (candidate.qualifiedId) metricIds.add(candidate.qualifiedId);
    }
    if (candidate.kind === 'semantic_member') {
      dimensionIds.add(candidate.id);
      if (candidate.qualifiedId) dimensionIds.add(candidate.qualifiedId);
    }
    if (candidate.primaryEntity) entityIds.add(candidate.primaryEntity);
    for (const dimension of candidate.dimensions ?? []) dimensionIds.add(dimension);
    const capability = candidate.analyticalCapability;
    if (!capability) continue;
    metricIds.add(capability.metricId);
    entityIds.add(capability.primaryEntityId);
    for (const grain of capability.resultGrainIds) entityIds.add(grain);
    for (const dimension of capability.dimensions) {
      entityIds.add(dimension.entityId);
    }
    for (const dimension of capability.dimensions) dimensionIds.add(dimension.dimensionId);
    for (const dimension of capability.timeDimensions) dimensionIds.add(dimension.dimensionId);
  }
  const checks: Array<[string, Iterable<string>, Set<string>]> = [
    ['metric', frame.metricConceptIds, metricIds],
    ['entity grain', frame.entityGrainIds, entityIds],
    ['dimension', frame.dimensions.map((dimension) => dimension.dimensionId), dimensionIds],
    ['member dimension', frame.memberBindings.map((binding) => binding.dimensionId), dimensionIds],
    ['output metric', frame.requestedOutputs.flatMap((output) => output.metricId ? [output.metricId] : []), metricIds],
  ];
  if (frame.timeContext?.timeDimensionId) {
    checks.push(['time dimension', [frame.timeContext.timeDimensionId], dimensionIds]);
  }
  if (frame.ranking) {
    checks.push(
      ['ranking dimension', [frame.ranking.entityDimensionId], dimensionIds],
      ['ranking metric', [frame.ranking.byMetricId], metricIds],
    );
  }
  for (const [kind, ids, allowed] of checks) {
    for (const id of ids) if (!allowed.has(id)) return `${kind} ${id}`;
  }
  // A canonical multi-metric request has one recommended execution metric but
  // more than one explicit, retrieved capability. Validate membership against
  // the complete selected metric set here; compatibility/additivity across
  // that set is still proven by the immutable compiler below. Checking only
  // the first metric converted a valid `metric_a + metric_b` identity binding
  // into the false “not retrieved” gap before MetricFlow got a chance to
  // evaluate it.
  const selectedCapabilities = candidates
    .filter((candidate) => {
      const identities = [candidate.id, candidate.qualifiedId, candidate.analyticalCapability?.metricId]
        .filter((id): id is string => Boolean(id));
      return identities.some((id) => frame.metricConceptIds.includes(id))
        || Boolean(executionId && identities.includes(executionId));
    })
    .flatMap((candidate) => candidate.analyticalCapability ? [candidate.analyticalCapability] : []);
  if (selectedCapabilities.length > 0) {
    const selectedMetricIds = new Set(selectedCapabilities.map((capability) => capability.metricId));
    const selectedDimensionIds = new Set(selectedCapabilities.flatMap((capability) => [
      ...capability.dimensions.map((dimension) => dimension.dimensionId),
      ...capability.timeDimensions.map((dimension) => dimension.dimensionId),
    ]));
    const selectedEntityIds = new Set(selectedCapabilities.flatMap((capability) => [
      capability.primaryEntityId,
      ...capability.resultGrainIds,
      // A MetricFlow capability may safely expose a governed product/order
      // grouping dimension whose entity differs from its primary aggregate
      // entity.  The frame records that declared entity grain for the output;
      // rejecting it merely because it was not the metric's primary entity
      // turns a complete customer-by-product program into a false "not
      // retrieved" gap before semantic compilation can evaluate it.
      ...capability.dimensions.map((dimension) => dimension.entityId),
    ]));
    const selectedChecks: Array<[string, Iterable<string>, Set<string>]> = [
      ['selected capability metric', frame.metricConceptIds, selectedMetricIds],
      ['selected capability entity grain', frame.entityGrainIds, selectedEntityIds],
      ['selected capability dimension', frame.dimensions.map((dimension) => dimension.dimensionId), selectedDimensionIds],
      ['selected capability member dimension', frame.memberBindings.map((binding) => binding.dimensionId), selectedDimensionIds],
    ];
    if (frame.ranking) {
      selectedChecks.push(
        ['selected capability ranking dimension', [frame.ranking.entityDimensionId], selectedDimensionIds],
        ['selected capability ranking metric', [frame.ranking.byMetricId], selectedMetricIds],
      );
    }
    for (const [kind, ids, allowed] of selectedChecks) {
      for (const id of ids) if (!allowed.has(id)) return `${kind} ${id}`;
    }
  }
  for (const ambiguity of frame.ambiguity) {
    for (const id of ambiguity.candidateIds) if (!evidenceIds.has(id)) return `ambiguity candidate ${id}`;
  }
  return undefined;
}

/**
 * Merge the one model meaning response into the host-owned request seed.
 *
 * Candidate IDs are the only model-controlled execution-adjacent values, and
 * they are still validated against the exact supplied package afterwards. The
 * model's route, SQL-adjacent frame, query intent, and reworded question are
 * presentation suggestions at most; accepting them as authority was how an
 * omitted product category/order ID or an inherited prior filter silently
 * changed the answer tuple after retrieval.
 */
export function mergeMeaningResolutionWithRequirementSeed(input: {
  seed: AnalyticalRequirementSeedV1;
  resolution: MeaningResolution;
  candidates: AgentEvidenceCandidate[];
}): MeaningResolution {
  const { seed, resolution, candidates } = input;
  const modelSelectedConceptIds = [...new Set([
    ...resolution.selectedConceptIds,
    ...(resolution.recommendedExecutionId ? [resolution.recommendedExecutionId] : []),
  ])];
  // A model can bind only supplied IDs, but supplied is not synonymous with
  // grounded in the current request. Discard a known semantic metric that
  // would add a qualifier not present in the immutable seed. Keep unknown IDs
  // in the result so `validateMeaningResolution` still rejects inventions at
  // the boundary rather than silently laundering them away.
  const omittedUngroundedMetricIds = modelSelectedConceptIds.filter((id) => {
    const candidate = candidates.find((item) => item.id === id || item.qualifiedId === id);
    return candidate?.kind === 'semantic_metric'
      && !metricCandidateExactlyMatchesSeed(candidate, seed);
  });
  const selectedConceptIds = modelSelectedConceptIds.filter((id) =>
    !omittedUngroundedMetricIds.includes(id));
  // A minimal candidate-ID-only response is intentionally allowed for the
  // one bounded meaning call.  Do not let the order of a role-targeted member
  // extension turn that member into the execution target merely because the
  // model omitted the optional recommendation.  A selected metric is the
  // host-safe default; a member only supplies a dimension binding beside it.
  const selectedMetricId = selectedConceptIds.find((id) => {
    const candidate = candidates.find((item) => item.id === id || item.qualifiedId === id);
    return candidate?.kind === 'semantic_metric'
      // A selected metric can supersede a legacy recommendation only when it
      // proves the host-owned metric wording.  Token-overlap retrieval is not
      // enough here: otherwise `rollover amount` silently became
      // `rollover_balance_amount` merely because a pooled semantic card had
      // been selected alongside a certified nomination.  The cascade can
      // still evaluate a partial candidate later; this guard only prevents a
      // model selection from adding an unspoken metric qualifier.
      && metricCandidateExactlyMatchesSeed(candidate, seed);
  });
  // A model may nominate a certified block in its legacy recommendation while
  // selecting a supplied semantic metric.  The recommendation is not route
  // authority; when one selected metric exists, it is the only safe host
  // execution nomination.  This preserves the candidate-ID boundary without
  // letting an unproved block displace the selected complete semantic tuple.
  const recommendedExecutionId = selectedMetricId
    ?? resolution.recommendedExecutionId
    ?? selectedConceptIds[0];
  const recommendedCandidate = recommendedExecutionId
    ? candidates.find((candidate) => candidate.id === recommendedExecutionId || candidate.qualifiedId === recommendedExecutionId)
    : undefined;
  const rejectedCandidates = resolution.rejectedCandidates.filter((candidate) =>
    candidates.some((known) => known.id === candidate.id || known.qualifiedId === candidate.id));
  const queryIntent = bindSelectedMemberValuesToSeed({
    seed,
    selectedConceptIds,
    candidates,
  });
  const receipts: MeaningResolutionOverrideReceiptV1[] = [];
  const recordHostPreserved = (
    field: Exclude<MeaningResolutionOverrideReceiptV1['field'], 'candidate_selection' | 'member_binding'>,
    differs: boolean,
    reason: string,
  ) => {
    if (differs) receipts.push({ version: 1, field, action: 'host_preserved', reason });
  };
  recordHostPreserved(
    'interpreted_question',
    normalizeMeaningText(resolution.interpretedQuestion) !== normalizeMeaningText(seed.sourceQuestion),
    'The source question remains host-owned; model rephrasing cannot add context.',
  );
  recordHostPreserved(
    'question_type',
    resolution.questionType !== questionTypeFromText(seed.sourceQuestion),
    'The host classifies the request mode before meaning resolution.',
  );
  recordHostPreserved(
    'query_intent',
    !sameQueryIntent(resolution.queryIntent, seed.queryIntent),
    'Explicit measures, entity/grain, dimensions, filters, ranking, outputs, and time requirements remain host-owned.',
  );
  recordHostPreserved(
    'recommended_route',
    resolution.recommendedRoute !== (recommendedCandidate ? cascadeNominationForCandidate(recommendedCandidate) : 'clarify'),
    'Tier selection is deterministic cascade authority, not a model recommendation.',
  );
  recordHostPreserved(
    'analytical_frame',
    resolution.analyticalFrame !== undefined,
    'A model frame cannot introduce identifiers, SQL semantics, trust, or a replacement route.',
  );
  if (selectedConceptIds.length > 0) {
    receipts.push({
      version: 1,
      field: 'candidate_selection',
      action: 'selection_accepted',
      reason: 'The model selected supplied candidate IDs; host validation still verifies package membership and compatibility.',
      candidateIds: selectedConceptIds,
    });
  }
  if (omittedUngroundedMetricIds.length > 0) {
    receipts.push({
      version: 1,
      field: 'candidate_selection',
      action: 'host_preserved',
      reason: 'A selected semantic metric would add an unspoken qualifier to the host-owned measure requirement.',
      candidateIds: omittedUngroundedMetricIds,
    });
  }
  if (!sameQueryIntent(queryIntent, seed.queryIntent)) {
    receipts.push({
      version: 1,
      field: 'member_binding',
      action: 'selection_accepted',
      reason: 'A selected, supplied semantic member canonically bound an existing host filter value; no filter field or scope was added.',
      candidateIds: selectedConceptIds,
    });
  }
  return {
    interpretedQuestion: seed.sourceQuestion,
    questionType: questionTypeFromText(seed.sourceQuestion),
    selectedConceptIds,
    ...(recommendedExecutionId ? { recommendedExecutionId } : {}),
    queryIntent,
    rejectedCandidates,
    confidence: resolution.confidence,
    missingInformation: [...new Set(resolution.missingInformation)],
    recommendedRoute: recommendedCandidate ? cascadeNominationForCandidate(recommendedCandidate) : 'clarify',
    ...(resolution.clarifyingQuestion ? { clarifyingQuestion: resolution.clarifyingQuestion } : {}),
    hostRequirementSeed: seed,
    ...(receipts.length > 0 ? { overrideReceipts: receipts } : {}),
  };
}

/**
 * Keep the host's literal metric requirement authoritative when choosing a
 * primary nominated metric. This intentionally uses exact canonical identity
 * rather than retrieval-style token matching: aliases are normalized into the
 * requirement seed before this boundary, so a legitimate `sales` ->
 * `revenue` binding still matches while a related `rollover balance amount`
 * card cannot add `balance` to an unspoken request for `rollover amount`.
 */
function metricCandidateExactlyMatchesSeed(
  candidate: AgentEvidenceCandidate,
  seed: AnalyticalRequirementSeedV1,
): boolean {
  if (seed.requirements.measures.length === 0) return true;
  const identities = [candidate.name, ...(candidate.aliases ?? []), candidate.qualifiedId ?? candidate.id]
    .map((value) => canonicalMetricIdentity(value))
    .filter(Boolean);
  // A multi-metric tuple legitimately selects one candidate per requested
  // measure. Each candidate must prove at least one host metric; requiring a
  // single candidate to prove the entire tuple would drop `beverage revenue`
  // beside `total revenue` before the semantic compiler can combine them.
  return seed.requirements.measures.some((measure) => {
    const requested = canonicalMetricIdentity(measure);
    const genericBareTerm = /^(?:amount|value|count|number|total|rate|percentage|percent)$/.test(requested);
    return identities.some((identity) => identity === requested
      // A governed semantic metric may carry a leading accounting qualifier
      // (`net revenue`) for the reader's base term (`revenue`).  Keep that
      // narrow suffix form for the established semantic contract, but never
      // permit an inserted qualifier: `rollover balance amount` must not
      // satisfy the distinct request `rollover amount`.
      || (!genericBareTerm && identity.endsWith(` ${requested}`)));
  });
}

function canonicalMetricIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._:/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A selected semantic member can canonically correct an already-host-owned
 * filter value (for example a retrieved alias/typo), but it cannot introduce
 * a new filter field, member, or prior-result scope.  Ambiguous member cards
 * deliberately leave the seed value untouched for later clarification.
 */
function bindSelectedMemberValuesToSeed(input: {
  seed: AnalyticalRequirementSeedV1;
  selectedConceptIds: string[];
  candidates: AgentEvidenceCandidate[];
}): MeaningQueryIntent {
  const selectedMembers = input.selectedConceptIds.flatMap((id) => {
    const candidate = input.candidates.find((item) => item.id === id || item.qualifiedId === id);
    return candidate?.kind === 'semantic_member' ? [candidate] : [];
  });
  const queryIntent = cloneSeedQueryIntent(input.seed);
  return {
    ...queryIntent,
    filters: queryIntent.filters.map((filter) => {
      const matches = selectedMembers.filter((candidate) =>
        [candidate.name, ...(candidate.aliases ?? [])]
          .map(normalizeMemberBindingText)
          .includes(normalizeMemberBindingText(filter.value)));
      return matches.length === 1 ? { ...filter, value: matches[0]!.name } : filter;
    }),
  };
}

function normalizeMemberBindingText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The model's selected candidate is a nomination for the cascade, not the
 * final eligibility verdict. A partial certified card must therefore enter
 * the certified tier so the deterministic output-contract check can continue
 * to semantic/exploratory evidence instead of pretending it is raw SQL.
 */
function cascadeNominationForCandidate(candidate: AgentEvidenceCandidate): MeaningExecutionRoute {
  if (candidate.kind === 'certified_block') return 'certified';
  if (candidate.kind === 'semantic_metric' || candidate.kind === 'semantic_member') return 'semantic';
  return candidate.trustTier === 'governed_sql' ? 'governed_sql' : 'exploratory';
}

function cloneSeedQueryIntent(seed: AnalyticalRequirementSeedV1): MeaningQueryIntent {
  return {
    measures: [...seed.queryIntent.measures],
    dimensions: [...seed.queryIntent.dimensions],
    filters: seed.queryIntent.filters.map((filter) => ({ field: filter.field, value: filter.value })),
    ...(seed.queryIntent.timeRange ? { timeRange: seed.queryIntent.timeRange } : {}),
    ...(seed.queryIntent.timeGrain ? { timeGrain: seed.queryIntent.timeGrain } : {}),
    ...(seed.queryIntent.order ? { order: seed.queryIntent.order } : {}),
    ...(seed.queryIntent.limit !== undefined ? { limit: seed.queryIntent.limit } : {}),
    ...(seed.queryIntent.fiscalCalendarId ? { fiscalCalendarId: seed.queryIntent.fiscalCalendarId } : {}),
    ...(seed.queryIntent.fiscalDateRoleId ? { fiscalDateRoleId: seed.queryIntent.fiscalDateRoleId } : {}),
  };
}

function sameQueryIntent(
  left: MeaningQueryIntent,
  right: AnalyticalRequirementSeedV1['queryIntent'],
): boolean {
  return JSON.stringify({
    measures: left.measures,
    dimensions: left.dimensions,
    filters: left.filters,
    timeRange: left.timeRange,
    timeGrain: left.timeGrain,
    order: left.order,
    limit: left.limit,
    fiscalCalendarId: left.fiscalCalendarId,
    fiscalDateRoleId: left.fiscalDateRoleId,
  }) === JSON.stringify({
    measures: right.measures,
    dimensions: right.dimensions,
    filters: right.filters,
    timeRange: right.timeRange,
    timeGrain: right.timeGrain,
    order: right.order,
    limit: right.limit,
    fiscalCalendarId: right.fiscalCalendarId,
    fiscalDateRoleId: right.fiscalDateRoleId,
  });
}

function normalizeMeaningText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function routeForEvidenceCandidate(candidate: AgentEvidenceCandidate): MeaningExecutionRoute {
  if (candidate.kind === "certified_block" && candidate.compatibility === "compatible") return "certified";
  if ((candidate.kind === "semantic_metric" || candidate.kind === "semantic_member") && candidate.compatibility === "compatible") {
    return "semantic";
  }
  return candidate.trustTier === "governed_sql" ? "governed_sql" : "exploratory";
}

export function questionTypeFromText(question: string): MeaningQuestionType {
  if (/\b(why|root ?cause|diagnos|driver|what (?:caused|changed|happened)|anomal)\b/i.test(question)) return "diagnosis";
  if (/\b(research|investigate|deep ?dive)\b/i.test(question)) return "research";
  if (/\b(top|bottom|highest|lowest|rank)\b/i.test(question)) return "ranking";
  if (/\b(trend|over time|month over month|year over year|mom|yoy|by (?:day|week|month|quarter|year))\b/i.test(question)) return "trend";
  if (/\b(compare|versus|vs\.?|difference between)\b/i.test(question)) return "comparison";
  // "What is total revenue?" asks for a data value, not a definition. This
  // distinction matters because definition paths may intentionally bypass
  // execution-shape checks for glossary/certified descriptions.
  if (/\b(total|sum|count|number of|average|avg|minimum|maximum|across all|overall)\b/i.test(question)
    && /\b(what (?:is|was|were|are)|how (?:much|many)|show|report|calculate|give|tell)\b/i.test(question)) return "value";
  if (/^\s*what (?:is|was|were|are)\b/i.test(question)
    && /\b(today|current|yesterday|last|this|from|for|by|top|bottom|during|between|through)\b/i.test(question)) return "value";
  if (/^\s*(what (?:is|are|does)|define|definition|meaning of)\b/i.test(question)) return "definition";
  return "value";
}

export function defaultQueryIntent(evidence: AgentRetrievalEvidence): MeaningQueryIntent {
  return {
    measures: evidence.parsedIntent?.measures ?? [],
    dimensions: evidence.parsedIntent?.dimensions ?? [],
    filters: evidence.parsedIntent?.filters ?? [],
    ...(evidence.parsedIntent?.timeRange ? { timeRange: evidence.parsedIntent.timeRange } : {}),
    ...(evidence.parsedIntent?.timeGrain ? { timeGrain: evidence.parsedIntent.timeGrain } : {}),
    ...(evidence.parsedIntent?.order ? { order: evidence.parsedIntent.order } : {}),
    ...(evidence.parsedIntent?.limit !== undefined ? { limit: evidence.parsedIntent.limit } : {}),
  };
}
