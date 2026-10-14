/**
 * Ask AI observability is deliberately a separate, local-only contract.  It
 * records typed execution evidence; it is never an authority for routing,
 * authorization, trust, or execution.
 *
 * Acceptance: OBS-001..OBS-010, SEC-003, SEC-004.
 */
import type {
  AnalyticalCascadeDecisionV1,
  AnalyticalCascadeTierV1,
  AskDecisionSummaryV1,
  AskDecisionSummaryV2,
  ContextSourceCoverageV1,
  EvidenceCandidateRoleV1,
  ProviderFailureCauseV1,
  ProviderFailureDiagnosticV1,
} from '../analytical-orchestration.js';
import type { ProviderEgressPurpose } from '@zlens/core';

export type AskTraceIdV1 = string;
export type AskSpanIdV1 = string;

export type AskTraceStatusV1 =
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** The user-visible AgentRun terminal state, kept separate from trace health. */
export type AskTraceTerminalOutcomeV1 =
  | 'completed'
  | 'needs_review'
  | 'needs_clarification'
  | 'cancelled'
  | 'blocked';

export type AskTraceRecordingStatusV1 =
  | 'recording'
  | 'complete'
  | 'partial'
  | 'unavailable'
  | 'detail_expired';

export type AskTraceSurfaceV1 = 'browser' | 'cli' | 'mcp' | 'chat';
export type AskTraceModeV1 = 'ask' | 'research';

/** Additive, compact AgentRun reference. Full spans are never embedded in a run. */
export interface AgentRunTraceReferenceV1 {
  version: 1;
  traceId: AskTraceIdV1;
  recordingStatus: AskTraceRecordingStatusV1;
  storeSchemaVersion: 1;
  traceFingerprint?: string;
}

export interface AskTraceEnvelopeV1 {
  version: 1;
  traceId: AskTraceIdV1;
  rootSpanId: AskSpanIdV1;
  runId: string;
  surface: AskTraceSurfaceV1;
  mode: AskTraceModeV1;
  threadId?: string;
  snapshotId?: string;
  /** A one-way fingerprint; the question is never persisted in a trace. */
  questionFingerprint: string;
  status: AskTraceStatusV1;
  /** Optional for V1 compatibility; distinguishes a completed Ask from a clarification terminal state. */
  terminalOutcome?: AskTraceTerminalOutcomeV1;
  recordingStatus: AskTraceRecordingStatusV1;
  trustState?: string;
  selectedTier?: AnalyticalCascadeTierV1;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  firstIssueSpanId?: AskSpanIdV1;
  traceFingerprint?: string;
  spanCount: number;
  candidateDecisionCount: number;
  droppedRecordCount: number;
  /** Research child traces retain the relationship without copying parent data. */
  parentTraceId?: AskTraceIdV1;
  parentRunId?: string;
}

export type AskTraceStageV1 =
  | 'request'
  | 'conversation'
  | 'snapshot'
  | 'retrieval'
  | 'meaning'
  | 'cascade'
  | 'plan'
  | 'provider'
  | 'tool'
  | 'sql'
  | 'result'
  | 'narration'
  | 'persistence'
  | 'research';

export type AskTraceSpanNameV1 =
  | 'ask.run'
  | 'research.run'
  | 'request.classify'
  | 'conversation.hydrate'
  | 'snapshot.acquire'
  | 'retrieval'
  | 'retrieval.exact'
  | 'retrieval.lexical'
  | 'retrieval.vector'
  | 'retrieval.graph'
  | 'retrieval.certified'
  | 'retrieval.semantic'
  | 'retrieval.governed_relational'
  | 'retrieval.dbt_manifest'
  | 'retrieval.runtime_schema'
  | 'retrieval.safe_value'
  | 'retrieval.conversation'
  | 'retrieval.fuse'
  | 'meaning.package'
  | 'meaning.resolve'
  | 'cascade.evaluate'
  | 'cascade.certified'
  | 'cascade.semantic'
  | 'cascade.governed_relational'
  | 'cascade.exploratory_sql'
  | 'cascade.clarify_or_gap'
  | 'plan.freeze'
  | 'plan.compile'
  | 'semantic.compile'
  | 'provider.preflight'
  | 'provider.attempt'
  | 'tool.call'
  | 'sql.generate'
  | 'sql.validate'
  | 'sql.authorize'
  | 'sql.execute'
  | 'sql.repair'
  | 'result.normalize'
  | 'narration.generate'
  | 'narration.verify'
  | 'conversation.persist'
  | 'run.persist'
  | 'research.plan'
  /** A zero-call, bounded local structural lineage program. */
  | 'research.lineage'
  | 'research.validate'
  | 'research.synthesize';

export type AskTraceSpanOutcomeV1 =
  | 'ok'
  | 'error'
  | 'denied'
  | 'cancelled'
  | 'skipped'
  | 'unavailable'
  | 'interrupted';

/** Stable, content-free stage reasons shown in the UI and portable bundles. */
export type AskTraceReasonCodeV1 =
  | 'started'
  | 'completed'
  | 'route_selected'
  | 'cache_hit'
  | 'snapshot_unavailable'
  | 'source_empty'
  | 'source_stale'
  | 'source_unavailable'
  | 'meaning_resolved'
  | 'meaning_rejected'
  | 'cascade_selected'
  | 'cascade_ineligible'
  | 'cascade_unavailable'
  | 'cascade_ambiguous'
  | 'cascade_denied'
  | 'plan_frozen'
  | 'post_freeze_failure'
  | 'provider_preflight'
  | 'provider_failure'
  | 'tool_failure'
  | 'sql_denied'
  | 'sql_failure'
  | 'repair_attempted'
  | 'result_accepted'
  | 'narration_fallback'
  /** A bounded Research child used its fair-share deadline. */
  | 'research_branch_timeout'
  /** The request-wide Research deadline elapsed before finalization. */
  | 'run_deadline'
  /** Remaining time is reserved for Research synthesis and persistence. */
  | 'budget_exhausted'
  /** A bounded Research child returned or threw a non-cancellation failure. */
  | 'execution_failed'
  | 'cancelled'
  | 'interrupted'
  | 'recording_failure'
  | 'cap_reached'
  | 'unknown';

export type CandidateDecisionKindV1 =
  | 'retrieved'
  | 'reserved'
  | 'admitted'
  | 'extended'
  | 'model_selected'
  | 'model_rejected'
  | 'excluded';

export type CandidateDecisionReasonV1 =
  | 'explicit_qualified_reference'
  | 'exact_name_match'
  | 'alias_match'
  | 'conversation_binding'
  | 'role_reserved'
  | 'candidate_for_unresolved_role'
  | 'fused_relevance_fill'
  | 'same_snapshot_extension'
  | 'configured_runtime_value_grounding_pin'
  | 'relationship_closure'
  | 'model_selected'
  | 'model_rejected'
  | 'duplicate_identity'
  | 'superseded_by_higher_trust_identity'
  | 'below_lane_limit'
  | 'below_fused_limit'
  | 'role_quota_exhausted'
  | 'role_mismatch'
  | 'explicit_measure_conflict'
  | 'entity_label_mismatch'
  | 'relationship_unreachable'
  | 'capability_incompatible'
  | 'source_stale'
  | 'source_unavailable'
  | 'policy_denied'
  | 'malformed_candidate'
  | 'unknown';

export interface CandidateDecisionV1 {
  version: 1;
  traceId: AskTraceIdV1;
  sequence: number;
  candidateId: string;
  // Do not persist a display label. Even a seemingly harmless alias can be a
  // customer/business value; traces retain qualified identifiers only.
  role: EvidenceCandidateRoleV1;
  source: ContextSourceCoverageV1['source'];
  lane?: 'exact' | 'lexical' | 'vector' | 'graph' | 'conversation';
  laneRank?: number;
  /**
   * Actual multi-lane membership carried from snapshot retrieval. The scalar
   * lane remains the compact/indexable primary lane for V1 readers.
   */
  lanes?: Array<{ lane: NonNullable<CandidateDecisionV1['lane']>; rank?: number }>;
  fusedRank?: number;
  reciprocalRankScore?: number;
  decision: CandidateDecisionKindV1;
  reasonCode: CandidateDecisionReasonV1;
  compatibilityCode?:
    | 'compatible'
    | 'missing_measure'
    | 'missing_dimension'
    | 'grain_mismatch'
    | 'time_role_mismatch'
    | 'fiscal_calendar_missing'
    | 'join_unproven'
    | 'fanout_unsafe'
    | 'operation_unsupported'
    | 'policy_denied'
    | 'unknown';
}

export interface ProviderAttemptTraceV1 {
  version: 1;
  phase: ProviderFailureDiagnosticV1['phase'];
  /** Server-owned egress purpose for the matching physical provider receipt. */
  purpose?: ProviderEgressPurpose;
  physicalAttemptIndex: number;
  retryOfSpanId?: AskSpanIdV1;
  providerFingerprint?: string;
  modelFingerprint?: string;
  baseOriginFingerprint?: string;
  readiness?: 'ready' | 'unavailable' | 'unknown';
  admission?: 'admitted' | 'denied' | 'unknown';
  budgetRemaining?: number;
  httpStatusClass?: '4xx' | '5xx';
  retryable?: boolean;
  safeAction?: ProviderFailureDiagnosticV1['safeAction'];
  cause?: ProviderFailureCauseV1;
  /** Truthful non-terminal physical milestones retained on the final attempt. */
  transportOutcome?: 'ok' | 'error' | 'cancelled';
  processOutcome?: 'ok' | 'error' | 'cancelled';
  provenance: 'live' | 'recorded' | 'synthetic' | 'migrated' | 'unknown';
}

export interface ToolCallTraceV1 {
  version: 1;
  toolCallId: string;
  toolKind: string;
  attemptIndex: number;
  inputFingerprint?: string;
  outputFingerprint?: string;
  safeErrorCode?: string;
}

export interface SqlExecutionTraceV1 {
  version: 1;
  tier?: AnalyticalCascadeTierV1;
  snapshotFingerprint?: string;
  planFingerprint?: string;
  sqlFingerprint?: string;
  targetFingerprint?: string;
  capabilityFingerprint?: string;
  resultFingerprint?: string;
  validationReason?: string;
  executionReason?: string;
  repairSpanId?: AskSpanIdV1;
  reviewRequired: boolean;
}

/**
 * Terminal failure classes are deliberately enumerable. A trace may explain
 * which typed contract failed, but never retain the producer diagnostic or a
 * raw connector/compiler error.
 */
export type AskTraceTerminalFailureCodeV1 =
  | 'COLUMN_NOT_FOUND'
  | 'RELATION_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'AMBIGUOUS_COLUMN'
  | 'DIALECT_ERROR'
  | 'SNAPSHOT_DRIFT'
  | 'TIMEOUT'
  | 'RESULT_CONTRACT_MISMATCH'
  | 'COMPILATION_FAILED'
  | 'POLICY_DENIED'
  | 'SEMANTIC_ADAPTER_NOT_READY'
  | 'SEMANTIC_TARGET_BINDING_MISSING'
  | 'EXECUTION_TARGET_MISMATCH'
  | 'SEMANTIC_SOURCE_DRIFT'
  | 'SEMANTIC_MEMBER_BINDING_FAILED'
  | 'SEMANTIC_PATH_AMBIGUOUS'
  | 'IDENTIFIER_SCOPE_INVALID'
  | 'CONNECTION_NOT_CONFIGURED'
  | 'EXECUTION_CANCELLED'
  | 'SEMANTIC_COMPILATION_TIMEOUT';

/** Stable local recovery identifiers; raw error text and arbitrary actions stay out. */
export type AskTraceSafeActionV1 =
  | 'inspect_failure'
  | 'retry_same_plan'
  | 'retry_same_request'
  | 'refresh_snapshot'
  | 'edit_dql'
  | 'open_sql_notebook'
  | 'request_access'
  | 'change_authorized_connection'
  | 'configure_connection'
  | 'reapply_semantic_runtime'
  | 'review_analytical_failure';

export interface AskTraceLinkV1 {
  version: 1;
  kind: 'research_branch' | 'clarification_continuation' | 'derived_repair' | 'prior_result';
  sourceTraceId: AskTraceIdV1;
  sourceRunId: string;
  targetTraceId?: AskTraceIdV1;
  targetRunId?: string;
  hypothesisFingerprint?: string;
  choiceFingerprint?: string;
  verdictFingerprint?: string;
  createdAt: string;
}

/**
 * The cascade receipt contains human-facing reasons and typed requirements in
 * its authoritative form. Trace persistence needs the decision mechanics, not
 * that prose. This projection is the only cascade shape permitted in a span.
 */
export interface SafeCascadeDecisionTraceV1 {
  selectedTier?: AnalyticalCascadeTierV1;
  planFrozen: boolean;
  stopReason: AnalyticalCascadeDecisionV1['stopReason'];
  /** Content-free requirement needed to explain a fiscal clarification safely. */
  requiresDeclaredFiscalCalendar?: boolean;
  /**
   * A typed terminal relationship proof requirement.  This is an allowlisted
   * projection of the router-owned cascade receipt, never router prose or a
   * reconstructed join diagnosis.
   */
  terminalGap?: {
    code: 'MISSING_RELATIONSHIP';
    requirement: 'certified_relationship_or_allocation_proof';
    witnessCandidateIds: string[];
  };
  sourceCoverage: Array<{
    source: ContextSourceCoverageV1['source'];
    status: ContextSourceCoverageV1['status'];
    candidateIds: string[];
    reasonFingerprint?: string;
  }>;
  attempts: Array<{
    tier: AnalyticalCascadeTierV1;
    outcome: 'executable' | 'ineligible' | 'unavailable' | 'ambiguous' | 'denied';
    candidateIds: string[];
    planFrozen: boolean;
    reasonFingerprint: string;
  }>;
}

/**
 * Typed and deliberately small payload union. No caller can attach arbitrary
 * provider messages, SQL, rows, headers, paths, or raw errors to a span.
 */
export type AskTraceSpanPayloadV1 =
  | { kind: 'stage'; route?: string; requestedMode?: string; count?: number; fingerprint?: string }
  | { kind: 'snapshot'; snapshotId?: string; sourceFingerprint?: string; freshness?: 'fresh' | 'stale' | 'unknown' }
  | { kind: 'retrieval'; source?: ContextSourceCoverageV1['source']; lane?: CandidateDecisionV1['lane']; candidateCount: number; coverage?: ContextSourceCoverageV1['status']; fingerprint?: string }
  | { kind: 'meaning'; selectedCandidateIds: string[]; rejectedCandidateIds: string[]; requirementFingerprint?: string; source?: 'model' | 'heuristic' | 'cache' | 'selection' }
  | { kind: 'cascade'; decision: SafeCascadeDecisionTraceV1 }
  | { kind: 'provider'; attempt: ProviderAttemptTraceV1 }
  | { kind: 'tool'; call: ToolCallTraceV1 }
  | { kind: 'sql'; execution: SqlExecutionTraceV1 }
  | {
      kind: 'result';
      resultFingerprint?: string;
      schemaFingerprint?: string;
      rowCount?: number;
      trustState?: string;
      /** Present only for a typed terminal failure after a frozen plan. */
      failureCode?: AskTraceTerminalFailureCodeV1;
      safeAction?: AskTraceSafeActionV1;
    }
  | {
      kind: 'conversation';
      threadFingerprint?: string;
      continuation?: boolean;
      persisted?: boolean;
      /**
       * Content-free binding class. It proves that history was considered
       * before retrieval without recording the prior question, member value,
       * result row, or selection text.
       */
      /** Legacy `context`/`clarification` remain readable on old traces. */
      binding?: 'none' | 'context' | 'clarification' | 'structured_clarification' | 'prior_result' | 'task_dependency';
    }
  | {
      kind: 'research';
      branchId?: string;
      hypothesisFingerprint?: string;
      verdict?: 'supported' | 'contradicted' | 'inconclusive' | 'failed' | 'skipped';
      branchCount?: number;
      /** Structural lineage is distinct from a provider/SQL analytical child. */
      evidenceKind?: 'analytical_result' | 'lineage_graph';
      /** Content-free local graph outcome; never target labels, paths, or rows. */
      lineageStatus?: 'completed' | 'missing' | 'ambiguous' | 'stale' | 'truncated' | 'unavailable';
      lineageResolution?: 'exact_id' | 'exact_name' | 'canonical_alias' | 'missing' | 'ambiguous' | 'stale' | 'unavailable';
      upstreamNodeCount?: number;
      downstreamNodeCount?: number;
      /**
       * Cardinality only.  Deliberately avoid retaining graph paths (or a
       * path-shaped field name) in the local trace payload.
       */
      upstreamRouteCount?: number;
      downstreamRouteCount?: number;
      /** Fixed bounds for the local structural program, not graph content. */
      lineageMaxDepth?: number;
      lineageMaxRoutes?: number;
      lineageMaxNodes?: number;
      lineageMaxEdges?: number;
      lineageTruncated?: boolean;
      /** Content-free fair-share budget assigned to one child branch. */
      branchBudgetMs?: number;
      /** Terminal child outcome; never a provider/warehouse error message. */
      branchStopReason?: 'completed' | 'research_branch_timeout' | 'budget_exhausted' | 'run_deadline' | 'cancelled' | 'execution_failed';
    }
  | { kind: 'persistence'; recordingStatus: AskTraceRecordingStatusV1; droppedRecordCount?: number };

export interface AskTraceSpanV1 {
  version: 1;
  traceId: AskTraceIdV1;
  spanId: AskSpanIdV1;
  parentSpanId?: AskSpanIdV1;
  ordinal: number;
  name: AskTraceSpanNameV1;
  stage: AskTraceStageV1;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  outcome: AskTraceSpanOutcomeV1;
  reasonCode: AskTraceReasonCodeV1;
  payload: AskTraceSpanPayloadV1;
}

export interface AskTraceDataV1 {
  envelope: AskTraceEnvelopeV1;
  spans: AskTraceSpanV1[];
  candidateDecisions: CandidateDecisionV1[];
  links: AskTraceLinkV1[];
  /** Joined from the server-owned AgentRun receipt at read time. */
  decisionSummary?: AskDecisionSummaryV1;
  /** V1.15 runtime-owned story, joined from the same durable run receipt. */
  runtimeDecisionSummary?: AskDecisionSummaryV2;
}

export interface AskTraceListEntryV1 extends AskTraceEnvelopeV1 {
  detailAvailable: boolean;
  /**
   * Joined at read time from the local AgentRun store. It is intentionally not
   * written to ask-observability.sqlite, so trace retention never becomes
   * prompt retention.
   */
  questionPreview?: string;
  /** Route-level scenario label from the local run receipt, never a prompt. */
  scenarioLabel?: string;
}

export interface AskTraceListQueryV1 {
  limit?: number;
  cursor?: string;
  status?: AskTraceEnvelopeV1['status'];
  mode?: AskTraceEnvelopeV1['mode'];
  trustState?: string;
  selectedTier?: string;
  surface?: AskTraceEnvelopeV1['surface'];
  recordingStatus?: AskTraceRecordingStatusV1;
}

export interface AskTraceListResponseV1 {
  traces: AskTraceListEntryV1[];
  nextCursor?: string;
  total?: number;
}

export interface AskTraceStoreStatusV1 {
  available: boolean;
  schemaVersion: number;
  recordingEnabled: boolean;
  readOnly?: boolean;
  reason?: 'unsupported_schema' | 'store_error' | 'disabled';
}

export interface AskTraceExportReceiptV1 {
  version: 1;
  profile: 'strict' | 'support';
  bundleFingerprint: string;
  exportedAt: string;
  checksums: Record<'manifest.json' | 'trace.json' | 'run-receipt.json' | 'redaction-receipt.json', string>;
  canaryPassed: boolean;
  traceFingerprint?: string;
}

export interface ObservabilityEvalEvidenceV1 {
  version: 1;
  traceId?: AskTraceIdV1;
  traceFingerprint?: string;
  recordingStatus: AskTraceRecordingStatusV1 | 'unavailable';
  requiredSpans: AskTraceSpanNameV1[];
  observedSpans: AskTraceSpanNameV1[];
  candidateLifecycle: Partial<Record<CandidateDecisionKindV1, number>>;
  candidateReasons: Partial<Record<CandidateDecisionReasonV1, number>>;
  sourceCoverage: ContextSourceCoverageV1[];
  selectedTier?: AnalyticalCascadeTierV1;
  planFrozen?: boolean;
  providerAttempts: number;
  toolCalls: number;
  sqlAttempts: number;
  repairAttempts: number;
  finalRunFingerprint?: string;
  finalResultFingerprint?: string;
  redactionValid?: boolean;
  providerEvidenceProvenance: 'live' | 'recorded' | 'synthetic' | 'migrated' | 'unknown';
  liveProviderQualityEligible: boolean;
}

export const ASK_TRACE_SCHEMA_VERSION = 1 as const;
