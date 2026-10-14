import type {
  AskSpanIdV1,
  AskTraceEnvelopeV1,
  AskTraceIdV1,
  AskTraceLinkV1,
  AskTraceModeV1,
  AskTraceReasonCodeV1,
  AskTraceRecordingStatusV1,
  AskTraceStageV1,
  AskTraceSpanNameV1,
  AskTraceSpanOutcomeV1,
  AskTraceSpanPayloadV1,
  AskTraceSpanV1,
  AskTraceStatusV1,
  AskTraceSurfaceV1,
  AskTraceTerminalOutcomeV1,
  AgentRunTraceReferenceV1,
  CandidateDecisionV1,
} from './types.js';
import type { AnalyticalCascadeTierV1 } from '../analytical-orchestration.js';
import { ASK_TRACE_SCHEMA_VERSION } from './types.js';
import { AskTraceSqliteStoreV1, type AskTraceStoreWriteResult } from './store.js';
import { durationMs, fingerprint, isoNow, mintHexId } from './utils.js';
import { readEnv } from '@zlens/core';

export const ASK_TRACE_OBSERVER_V1 = Symbol('dql.askTraceObserver.v1');

export interface AskTraceStartSpanInputV1 {
  name: Exclude<AskTraceSpanNameV1, 'ask.run' | 'research.run'>;
  stage: AskTraceStageV1;
  parentSpanId?: AskSpanIdV1;
  payload: AskTraceSpanPayloadV1;
  reasonCode?: AskTraceReasonCodeV1;
  startedAt?: string;
}

export interface AskTraceFinishSpanInputV1 {
  outcome?: AskTraceSpanOutcomeV1;
  reasonCode?: AskTraceReasonCodeV1;
  payload?: AskTraceSpanPayloadV1;
  completedAt?: string;
}

export interface AskTraceObserverV1 {
  readonly traceId?: AskTraceIdV1;
  readonly rootSpanId?: AskSpanIdV1;
  readonly recordingStatus: AskTraceRecordingStatusV1;
  readonly enabled: boolean;
  startSpan(input: AskTraceStartSpanInputV1): AskSpanIdV1 | undefined;
  finishSpan(spanId: AskSpanIdV1 | undefined, input?: AskTraceFinishSpanInputV1): void;
  recordCandidateDecision(input: Omit<CandidateDecisionV1, 'version' | 'traceId' | 'sequence'>): void;
  recordLink(input: Omit<AskTraceLinkV1, 'version' | 'sourceTraceId' | 'sourceRunId' | 'createdAt'>): void;
  finalize(input: {
    status: AskTraceStatusV1;
    terminalOutcome?: AskTraceTerminalOutcomeV1;
    trustState?: string;
    selectedTier?: AnalyticalCascadeTierV1;
    completedAt?: string;
    firstIssueSpanId?: AskSpanIdV1;
  }): AgentRunTraceReferenceV1 | undefined;
  markPartial(reason?: AskTraceReasonCodeV1): void;
  reference(): AgentRunTraceReferenceV1 | undefined;
}

export interface CreateAskTraceObserverInputV1 {
  store?: AskTraceSqliteStoreV1;
  runId: string;
  surface: AskTraceSurfaceV1;
  mode: AskTraceModeV1;
  questionFingerprint: string;
  threadId?: string;
  snapshotId?: string;
  parentTraceId?: AskTraceIdV1;
  parentRunId?: string;
  now?: () => Date;
}

/**
 * Explicit no-op is the universal failure mode. Callers must not need a
 * conditional and an observability failure cannot influence the answer path.
 */
export const noOpAskTraceObserverV1: AskTraceObserverV1 = Object.freeze({
  recordingStatus: 'unavailable' as const,
  enabled: false,
  startSpan: () => undefined,
  finishSpan: () => {},
  recordCandidateDecision: () => {},
  recordLink: () => {},
  finalize: () => undefined,
  markPartial: () => {},
  reference: () => undefined,
});

/**
 * A skipped span normally documents an expected branch, rather than a failure.
 * Only an explicit terminal/failure reason may make it the trace's first
 * issue. This prevents an expected skipped meaning stage from eclipsing the
 * authoritative cascade clarification or gap that follows it.
 */
const ISSUE_ELIGIBLE_SKIPPED_REASONS = new Set<AskTraceReasonCodeV1>([
  'meaning_rejected',
  'snapshot_unavailable',
  'source_stale',
  'source_unavailable',
  'cascade_ambiguous',
  'cascade_unavailable',
  'cascade_denied',
  'post_freeze_failure',
  'provider_failure',
  'tool_failure',
  'sql_denied',
  'sql_failure',
  'cancelled',
  'interrupted',
  'recording_failure',
  'cap_reached',
]);

/** Exported for focused contract tests; never used as routing authority. */
export function isAskTraceIssueSpanV1(input: Pick<AskTraceSpanV1, 'outcome' | 'reasonCode'>): boolean {
  if (input.outcome === 'error' || input.outcome === 'denied' || input.outcome === 'unavailable' || input.outcome === 'interrupted' || input.outcome === 'cancelled') return true;
  return input.outcome === 'skipped' && ISSUE_ELIGIBLE_SKIPPED_REASONS.has(input.reasonCode);
}

function isFinishedAskTraceSpanV1(input: unknown): input is Pick<AskTraceSpanV1, 'outcome' | 'reasonCode'> {
  if (!input || typeof input !== 'object') return false;
  const record = input as Record<string, unknown>;
  return typeof record.reasonCode === 'string'
    && (record.outcome === 'ok'
      || record.outcome === 'error'
      || record.outcome === 'denied'
      || record.outcome === 'cancelled'
      || record.outcome === 'skipped'
      || record.outcome === 'unavailable'
      || record.outcome === 'interrupted');
}

class BufferedAskTraceObserverV1 implements AskTraceObserverV1 {
  readonly traceId: AskTraceIdV1;
  readonly rootSpanId: AskSpanIdV1;
  readonly enabled = true;
  private envelope: AskTraceEnvelopeV1;
  private readonly spans = new Map<AskSpanIdV1, {
    name: AskTraceStartSpanInputV1['name'] | AskTraceSpanNameV1;
    stage: AskTraceStageV1;
    parentSpanId?: AskSpanIdV1;
    payload: AskTraceSpanPayloadV1;
    startedAt: string;
    startedAtMs: number;
    ordinal: number;
    reasonCode: AskTraceReasonCodeV1;
  }>();
  private sequence = 0;
  /** One random root seed yields collision-resistant unique child IDs per trace. */
  private spanSeed = 0n;
  private spanIdSequence = 0n;
  private candidateSequence = 0;
  private dropped = 0;
  private partial = false;
  /** True only after the envelope itself is safely persisted. */
  private started = false;
  private finalized = false;

  constructor(private readonly store: AskTraceSqliteStoreV1, input: CreateAskTraceObserverInputV1) {
    const startedAtDate = input.now ? input.now() : new Date();
    const now = startedAtDate.toISOString();
    this.traceId = mintHexId(16);
    this.rootSpanId = mintHexId(8);
    this.spanSeed = BigInt(`0x${this.rootSpanId}`);
    this.envelope = {
      version: 1,
      traceId: this.traceId,
      rootSpanId: this.rootSpanId,
      runId: input.runId,
      surface: input.surface,
      mode: input.mode,
      ...(input.threadId ? { threadId: fingerprint(input.threadId) } : {}),
      ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
      questionFingerprint: input.questionFingerprint,
      status: 'running',
      recordingStatus: 'recording',
      startedAt: now,
      spanCount: 1,
      candidateDecisionCount: 0,
      droppedRecordCount: 0,
      ...(input.parentTraceId ? { parentTraceId: input.parentTraceId } : {}),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    };
    const begin = this.store.begin(this.envelope);
    if (!begin.accepted) {
      // Do not hand a caller an apparently-live observer when no envelope
      // exists. The factory converts this exact start failure into the shared
      // explicit no-op, preserving Ask's normal path and transport shape.
      return;
    }
    this.started = true;
    const root = {
      version: 1 as const,
      traceId: this.traceId,
      spanId: this.rootSpanId,
      ordinal: this.sequence++,
      name: input.mode === 'research' ? 'research.run' as const : 'ask.run' as const,
      stage: 'request' as const,
      startedAt: now,
      outcome: 'ok' as const,
      reasonCode: 'started' as const,
      payload: { kind: 'stage' as const, requestedMode: input.mode, fingerprint: input.questionFingerprint },
      startedAtMs: startedAtDate.getTime(),
    };
    this.spans.set(this.rootSpanId, root);
    const rootResult = this.store.appendSpan(root);
    if (!rootResult.accepted) this.markPartial('recording_failure', storeAlreadyRecordedDrop(rootResult.dropped));
  }

  get recordingStatus(): AskTraceRecordingStatusV1 {
    return this.finalized ? this.envelope.recordingStatus : this.partial ? 'partial' : 'recording';
  }

  get initialized(): boolean {
    return this.started;
  }

  startSpan(input: AskTraceStartSpanInputV1): AskSpanIdV1 | undefined {
    if (this.finalized) return undefined;
    try {
      const spanId = this.mintChildSpanId();
      const started = input.startedAt ? undefined : new Date();
      const startedAt = input.startedAt ?? started!.toISOString();
      const span = {
        version: 1 as const,
        traceId: this.traceId,
        spanId,
        parentSpanId: input.parentSpanId ?? this.rootSpanId,
        ordinal: this.sequence++,
        name: input.name,
        stage: input.stage,
        startedAt,
        startedAtMs: input.startedAt ? Date.parse(input.startedAt) : started!.getTime(),
        outcome: 'ok' as const,
        reasonCode: input.reasonCode ?? 'started',
        payload: input.payload,
      };
      this.spans.set(spanId, span);
      // Most logical stages complete synchronously in the same call stack. A
      // start record followed immediately by its finish was previously pushed
      // through the producer twice only to be coalesced before SQLite. Retain
      // the authoritative start timestamp in memory and persist one completed
      // span at the physical completion boundary. The root span is still
      // admitted at run start, so a process restart continues to expose an
      // interrupted run even when no child stage could complete.
      return spanId;
    } catch {
      this.markPartial('recording_failure');
      return undefined;
    }
  }

  finishSpan(spanId: AskSpanIdV1 | undefined, input: AskTraceFinishSpanInputV1 = {}): void {
    if (!spanId || this.finalized) return;
    const previous = this.spans.get(spanId);
    if (!previous) return;
    try {
      const completed = input.completedAt ? undefined : new Date();
      const completedAt = input.completedAt ?? completed!.toISOString();
      const completedAtMs = input.completedAt ? Date.parse(input.completedAt) : completed!.getTime();
      const outcome = input.outcome ?? 'ok';
      const reasonCode = input.reasonCode ?? (outcome === 'ok' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'unknown');
      const next = {
        version: 1 as const,
        traceId: this.traceId,
        spanId,
        ...(previous.parentSpanId ? { parentSpanId: previous.parentSpanId } : {}),
        ordinal: previous.ordinal,
        name: previous.name,
        stage: previous.stage,
        startedAt: previous.startedAt,
        startedAtMs: previous.startedAtMs,
        completedAt,
        durationMs: elapsedDurationMs(previous.startedAtMs, completedAtMs, previous.startedAt, completedAt),
        outcome,
        reasonCode,
        payload: input.payload ?? previous.payload,
      };
      this.spans.set(spanId, next);
      const result = this.store.appendSpan(next);
      if (!result.accepted) this.markPartial(result.dropped === 'detail_cap' ? 'cap_reached' : 'recording_failure', storeAlreadyRecordedDrop(result.dropped));
    } catch {
      this.markPartial('recording_failure');
    }
  }

  recordCandidateDecision(input: Omit<CandidateDecisionV1, 'version' | 'traceId' | 'sequence'>): void {
    if (this.finalized) return;
    try {
      const result = this.store.appendCandidate({ version: 1, traceId: this.traceId, sequence: this.candidateSequence++, ...input });
      if (!result.accepted) this.markPartial(result.dropped === 'candidate_cap' || result.dropped === 'detail_cap' ? 'cap_reached' : 'recording_failure', storeAlreadyRecordedDrop(result.dropped));
    } catch {
      this.markPartial('recording_failure');
    }
  }

  recordLink(input: Omit<AskTraceLinkV1, 'version' | 'sourceTraceId' | 'sourceRunId' | 'createdAt'>): void {
    if (this.finalized) return;
    try {
      const result = this.store.appendLink({
        version: 1,
        sourceTraceId: this.traceId,
        sourceRunId: this.envelope.runId,
        createdAt: isoNow(),
        ...input,
      });
      if (!result.accepted) this.markPartial('recording_failure', storeAlreadyRecordedDrop(result.dropped));
    } catch {
      this.markPartial('recording_failure');
    }
  }

  finalize(input: {
    status: AskTraceStatusV1;
    terminalOutcome?: AskTraceTerminalOutcomeV1;
    trustState?: string;
    selectedTier?: AnalyticalCascadeTierV1;
    completedAt?: string;
    firstIssueSpanId?: AskSpanIdV1;
  }): AgentRunTraceReferenceV1 | undefined {
    if (this.finalized) return this.reference();
    this.finalized = true;
    const droppedReader = (this.store as unknown as { droppedRecordCount?: (traceId: string) => number }).droppedRecordCount;
    const storeDropped = typeof droppedReader === 'function' ? droppedReader.call(this.store, this.traceId) : 0;
    if (storeDropped > this.dropped) {
      this.dropped = storeDropped;
      this.partial = true;
    }
    const completed = input.completedAt ? undefined : new Date();
    const completedAt = input.completedAt ?? completed!.toISOString();
    const completedAtMs = input.completedAt ? Date.parse(input.completedAt) : completed!.getTime();
    // The root is intentionally left open until all server-owned stages have
    // completed.  Derive its terminal reason from the recorded typed issue
    // before closing it so a real analytical coverage gap is not presented as
    // the generic `unknown` incident merely because the root has no direct
    // executor callback.
    const rootTerminalReason = terminalRootReasonCodeV1(this.spans.values(), input.status);
    for (const [spanId, span] of this.spans) {
      // Do not reopen a root that happened to be updated as an ordinary span.
      if (!('completedAt' in span) || !span.completedAt) {
        this.finishBeforeFinalize(spanId, span, completedAt, completedAtMs, input.status, rootTerminalReason);
      }
    }
    // Older callers may still provide a provisional first issue. Keep it only
    // when it wins the same authoritative priority calculation; this prevents
    // a stale pre-freeze pointer from masking a terminal post-freeze failure.
    // This calculation needs the full trace to distinguish a recoverable
    // pre-freeze cascade attempt from a later physical failure. Computing it
    // once at finalization preserves the same result while avoiding an O(n²)
    // scan over the growing span map on every producer completion.
    const firstIssueSpanId = selectAskTraceIssueSpanIdV1(this.spans.values(), input.firstIssueSpanId);
    const traceFingerprint = fingerprint({
      traceId: this.traceId,
      runId: this.envelope.runId,
      status: input.status,
      terminalOutcome: input.terminalOutcome,
      selectedTier: input.selectedTier,
      spanCount: this.sequence,
      candidateDecisionCount: this.candidateSequence,
      dropped: this.dropped,
    });
    this.envelope = {
      ...this.envelope,
      status: input.status,
      ...(input.terminalOutcome ? { terminalOutcome: input.terminalOutcome } : {}),
      recordingStatus: this.partial ? 'partial' : 'complete',
      ...(input.trustState ? { trustState: input.trustState } : {}),
      ...(input.selectedTier ? { selectedTier: input.selectedTier } : {}),
      completedAt,
      durationMs: durationMs(this.envelope.startedAt, completedAt),
      ...(firstIssueSpanId ? { firstIssueSpanId } : {}),
      traceFingerprint,
      spanCount: this.sequence,
      candidateDecisionCount: this.candidateSequence,
      droppedRecordCount: this.dropped,
    };
    const persisted = this.store.finalize(this.envelope);
    if (!persisted.accepted) {
      this.envelope = { ...this.envelope, recordingStatus: 'unavailable' };
    }
    return this.reference();
  }

  markPartial(_reason: AskTraceReasonCodeV1 = 'recording_failure', alreadyRecorded = false): void {
    this.partial = true;
    if (!alreadyRecorded) {
      this.dropped += 1;
      try { this.store.markPartial(this.traceId); } catch { /* fail open */ }
    }
    const storeDropped = this.store.droppedRecordCount?.(this.traceId) ?? 0;
    this.dropped = Math.max(this.dropped, storeDropped);
  }

  reference(): AgentRunTraceReferenceV1 | undefined {
    return {
      version: 1,
      traceId: this.traceId,
      recordingStatus: this.recordingStatus,
      storeSchemaVersion: ASK_TRACE_SCHEMA_VERSION,
      ...(this.envelope.traceFingerprint ? { traceFingerprint: this.envelope.traceFingerprint } : {}),
    };
  }

  private finishBeforeFinalize(
    spanId: AskSpanIdV1,
    span: { name: AskTraceSpanNameV1; stage: AskTraceStageV1; parentSpanId?: AskSpanIdV1; payload: AskTraceSpanPayloadV1; startedAt: string; startedAtMs: number; ordinal: number; reasonCode: AskTraceReasonCodeV1 },
    completedAt: string,
    completedAtMs: number,
    status: AskTraceStatusV1,
    rootTerminalReason?: AskTraceReasonCodeV1,
  ): void {
    const outcome: AskTraceSpanOutcomeV1 = status === 'cancelled' ? 'cancelled' : status === 'interrupted' ? 'interrupted' : status === 'failed' || status === 'blocked' ? 'error' : 'ok';
    const next = {
      version: 1 as const,
      traceId: this.traceId,
      spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      ordinal: span.ordinal,
      name: span.name,
      stage: span.stage,
      startedAt: span.startedAt,
      startedAtMs: span.startedAtMs,
      completedAt,
      durationMs: elapsedDurationMs(span.startedAtMs, completedAtMs, span.startedAt, completedAt),
      outcome,
      reasonCode: outcome === 'ok'
        ? 'completed' as const
        : outcome === 'cancelled'
          ? 'cancelled' as const
          : outcome === 'interrupted'
            ? 'interrupted' as const
            : (span.name === 'ask.run' || span.name === 'research.run') && rootTerminalReason
              ? rootTerminalReason
              : 'unknown' as const,
      payload: span.payload,
    };
    this.spans.set(spanId, next);
    const result = this.store.appendSpan(next);
    if (!result.accepted) this.markPartial('recording_failure', storeAlreadyRecordedDrop(result.dropped));
  }

  private mintChildSpanId(): AskSpanIdV1 {
    const mask = 0xffff_ffff_ffff_ffffn;
    let value = (this.spanSeed + (++this.spanIdSequence)) & mask;
    // W3C IDs may not be all-zero. A wrap can only happen at the boundary,
    // but preserve the invariant without consuming a second random byte draw.
    if (value === 0n) value = (this.spanSeed + (++this.spanIdSequence)) & mask;
    return value.toString(16).padStart(16, '0');
  }
}

/**
 * Root spans have no independent route authority. They may, however, reflect
 * the terminal typed stage already persisted in the same trace. This keeps a
 * coverage gap, provider failure, or SQL refusal actionable without deriving
 * an incident from user-facing prose.
 */
function terminalRootReasonCodeV1(
  values: Iterable<unknown>,
  status: AskTraceStatusV1,
): AskTraceReasonCodeV1 | undefined {
  if (status !== 'blocked' && status !== 'failed') return undefined;
  const spans = [...values].filter(isFinishedTraceIssueSpanV1);
  const cascade = spans.find((span) => {
    const decision = safeCascadeDecisionRecordV1(span);
    return decision?.stopReason === 'coverage_gap';
  });
  if (cascade) return 'cascade_unavailable';
  if (spans.some((span) => span.reasonCode === 'cascade_denied')) return 'cascade_denied';
  if (spans.some((span) => span.reasonCode === 'cascade_ambiguous')) return 'cascade_ambiguous';
  if (spans.some((span) => span.reasonCode === 'run_deadline')) return 'run_deadline';
  if (spans.some((span) => span.reasonCode === 'research_branch_timeout')) return 'research_branch_timeout';
  if (spans.some((span) => span.reasonCode === 'execution_failed')) return 'execution_failed';
  if (spans.some((span) => span.reasonCode === 'provider_failure')) return 'provider_failure';
  if (spans.some((span) => span.reasonCode === 'sql_denied')) return 'sql_denied';
  if (spans.some((span) => span.reasonCode === 'sql_failure')) return 'sql_failure';
  if (spans.some((span) => span.reasonCode === 'post_freeze_failure')) return 'post_freeze_failure';
  return undefined;
}

type FinishedTraceIssueSpanV1 = Pick<AskTraceSpanV1,
  'spanId' | 'ordinal' | 'name' | 'stage' | 'outcome' | 'reasonCode' | 'payload'>;

/**
 * Select the incident that a local operator can act on. This deliberately
 * differs from `isAskTraceIssueSpanV1`: that exported predicate remains a
 * small compatibility check for one span, while the selection needs the
 * cascade and freeze context carried by the full trace.
 */
function selectAskTraceIssueSpanIdV1(
  values: Iterable<unknown>,
  _explicitIssueSpanId?: AskSpanIdV1,
): AskSpanIdV1 | undefined {
  const spans = [...values].filter(isFinishedTraceIssueSpanV1);
  const candidates = spans
    .map((span) => ({ span, priority: askTraceIssuePriorityV1(span, spans) }))
    .filter((entry) => entry.priority > 0)
    .sort((left, right) => right.priority - left.priority || right.span.ordinal - left.span.ordinal);
  return candidates[0]?.span.spanId;
}

function isFinishedTraceIssueSpanV1(value: unknown): value is FinishedTraceIssueSpanV1 {
  if (!isFinishedAskTraceSpanV1(value) || !value || typeof value !== 'object') return false;
  const span = value as Record<string, unknown>;
  return typeof span.spanId === 'string'
    && typeof span.ordinal === 'number'
    && typeof span.name === 'string'
    && typeof span.stage === 'string'
    && Boolean(span.payload && typeof span.payload === 'object');
}

function askTraceIssuePriorityV1(
  span: FinishedTraceIssueSpanV1,
  allSpans: FinishedTraceIssueSpanV1[],
): number {
  if (!isAskTraceIssueSpanV1(span)) return 0;
  if (isRecoverableCascadeAttemptV1(span)) return 0;
  if (isPostFreezePhysicalFailureV1(span, allSpans)) return 40;
  if (isTerminalCascadeIssueV1(span)) return 30;
  if (span.outcome === 'denied') return 20;
  return 10;
}

function isRecoverableCascadeAttemptV1(span: FinishedTraceIssueSpanV1): boolean {
  if (span.stage !== 'cascade' || !span.name.startsWith('cascade.') || span.name === 'cascade.evaluate' || span.name === 'cascade.clarify_or_gap') return false;
  if (span.outcome !== 'unavailable' && !(span.outcome === 'skipped' && span.reasonCode === 'cascade_ineligible')) return false;
  const decision = safeCascadeDecisionRecordV1(span);
  if (!decision || decision.stopReason !== 'selected' || !decision.selectedTier || decision.selectedTier === tierForCascadeSpanV1(span.name)) return false;
  const attempt = Array.isArray(decision.attempts) ? decision.attempts[0] : undefined;
  return Boolean(attempt && typeof attempt === 'object'
    && ((attempt as Record<string, unknown>).outcome === 'unavailable' || (attempt as Record<string, unknown>).outcome === 'ineligible'));
}

function isTerminalCascadeIssueV1(span: FinishedTraceIssueSpanV1): boolean {
  if (span.stage !== 'cascade') return false;
  const decision = safeCascadeDecisionRecordV1(span);
  if (!decision) return false;
  if (decision.stopReason === 'post_freeze_failure') return true;
  if (span.name === 'cascade.clarify_or_gap') {
    return decision.stopReason === 'ambiguous' || decision.stopReason === 'coverage_gap' || decision.stopReason === 'denied';
  }
  return span.name === 'cascade.evaluate' && (decision.stopReason === 'denied' || decision.stopReason === 'coverage_gap');
}

function isPostFreezePhysicalFailureV1(
  span: FinishedTraceIssueSpanV1,
  allSpans: FinishedTraceIssueSpanV1[],
): boolean {
  if (span.reasonCode === 'post_freeze_failure') return true;
  if (span.stage !== 'provider' && span.stage !== 'tool' && span.stage !== 'sql' && span.stage !== 'result') return false;
  return allSpans.some((candidate) => candidate.name === 'plan.freeze'
    && candidate.outcome === 'ok'
    && candidate.ordinal < span.ordinal);
}

function safeCascadeDecisionRecordV1(span: FinishedTraceIssueSpanV1): {
  selectedTier?: AnalyticalCascadeTierV1;
  stopReason?: string;
  attempts?: unknown[];
} | undefined {
  if (span.payload.kind !== 'cascade') return undefined;
  const payload = span.payload as unknown as Record<string, unknown>;
  const nested = payload.decision;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as { selectedTier?: AnalyticalCascadeTierV1; stopReason?: string; attempts?: unknown[] }
    : undefined;
}

function tierForCascadeSpanV1(name: FinishedTraceIssueSpanV1['name']): AnalyticalCascadeTierV1 | undefined {
  const tiers: Partial<Record<AskTraceSpanNameV1, AnalyticalCascadeTierV1>> = {
    'cascade.certified': 'certified',
    'cascade.semantic': 'semantic',
    'cascade.governed_relational': 'governed_relational',
    'cascade.exploratory_sql': 'exploratory_sql',
    'cascade.clarify_or_gap': 'clarify_or_gap',
  };
  return tiers[name];
}

function elapsedDurationMs(startedAtMs: number, completedAtMs: number, startedAt: string, completedAt: string): number {
  if (Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)) return Math.max(0, completedAtMs - startedAtMs);
  return durationMs(startedAt, completedAt);
}

function storeAlreadyRecordedDrop(dropped: AskTraceStoreWriteResult['dropped']): boolean {
  return dropped === 'span_cap'
    || dropped === 'candidate_cap'
    || dropped === 'detail_cap'
    || dropped === 'store_cap'
    || dropped === 'queue_cap';
}

export function createAskTraceObserverV1(input: CreateAskTraceObserverInputV1): AskTraceObserverV1 {
  if (!input.store || !input.store.status().recordingEnabled || readEnv('ZLENS_ASK_OBSERVABILITY') === 'off') {
    return noOpAskTraceObserverV1;
  }
  try {
    const observer = new BufferedAskTraceObserverV1(input.store, input);
    return observer.initialized ? observer : noOpAskTraceObserverV1;
  } catch {
    return noOpAskTraceObserverV1;
  }
}

/** The observer deliberately does not enumerate into HTTP/client payloads. */
export function attachAskTraceObserverV1<T extends object>(target: T, observer: AskTraceObserverV1): T {
  try {
    Object.defineProperty(target, ASK_TRACE_OBSERVER_V1, {
      value: observer,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    // Frozen caller input remains executable without observability.
  }
  return target;
}

export function askTraceObserverForV1(value: unknown): AskTraceObserverV1 {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return noOpAskTraceObserverV1;
  return ((value as Record<PropertyKey, unknown>)[ASK_TRACE_OBSERVER_V1] as AskTraceObserverV1 | undefined)
    ?? noOpAskTraceObserverV1;
}
