/**
 * SQLite-backed agent-run persistence (P0, REL-002 follow-through).
 *
 * The legacy FileAgentRunStore kept every run in ONE pretty-printed JSON file
 * and rewrote the whole file on every save — with ~1 MB per run (full events,
 * evidence, and result payloads) a real project reached 123 MB and each answer
 * paid two full-file rewrites. This store keeps one row per run, enforces
 * retention on write, and compacts old runs' event streams so the recent runs
 * a user actually reopens stay complete while history stops growing unbounded.
 */
import Database from 'better-sqlite3';
import { canonicalJson, sha256 } from './ask-observability/utils.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeProviderEgressReceiptV1 } from '@duckcodeailabs/dql-core';
import type {
  AgentRun,
  AgentRunArtifact,
  AgentRunDiagnosticReceiptV1,
  AgentRunProgressV1,
  AgentRunStore,
} from './agent-run-engine.js';
import type {
  AnalyticalCoverageGapV1,
  AgentRunDiagnosticReceiptV5,
  AgentRunDiagnosticReceiptV6,
  AnalyticalTaskFailureV1,
  AnalyticalTaskOutcomeStatusV1,
  AnalyticalTaskOutcomeSummaryV1,
  AnalyticalTaskOutcomeTrustStateV1,
  AnalyticalTaskOutcomeV1,
  AskAnalystState,
  EvidenceCandidateRoleV1,
  EvidenceRoleCoverageStateV1,
} from './analytical-orchestration.js';

export interface SqliteAgentRunStoreOptions {
  /** Path of the .sqlite file (created on first use). */
  path: string;
  /** Legacy agent-runs.json to import once and rename to *.migrated. */
  legacyJsonPath?: string;
  /** Maximum retained runs (oldest pruned on write). Env DQL_AGENT_RUN_RETENTION overrides. */
  maxRuns?: number;
  /** Newest N runs keep their full event stream; older runs are compacted. */
  fullPayloadRuns?: number;
}

const DEFAULT_MAX_RUNS = 300;
const DEFAULT_FULL_PAYLOAD_RUNS = 50;
const EVIDENCE_CANDIDATE_ROLES: ReadonlySet<EvidenceCandidateRoleV1> = new Set([
  'metric',
  'entity_key',
  'entity_label',
  'categorical_dimension',
  'time_dimension',
  'member',
  'relationship',
  'context',
]);
const ANALYTICAL_TASK_OUTCOME_STATUSES: ReadonlySet<AnalyticalTaskOutcomeStatusV1> = new Set([
  'completed', 'partial', 'gap', 'blocked', 'dependency_blocked',
]);
const ANALYTICAL_TASK_OUTCOME_TRUST_STATES: ReadonlySet<AnalyticalTaskOutcomeTrustStateV1> = new Set([
  'certified', 'governed', 'review_required', 'blocked', 'not_applicable',
]);

export function resolveAgentRunRetention(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.DQL_AGENT_RUN_RETENTION);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_RUNS;
  return Math.max(20, Math.min(5_000, Math.floor(configured)));
}


/**
 * What a run is allowed to weigh when it is written down.
 *
 * A finished run carried the same context pack and artifact payloads four to
 * five times: on `run.artifacts`, inside the V1 receipt's `steps`/`artifacts`
 * (held by reference), inside the answer artifact's own embedded receipt,
 * inside every `steps[].artifacts`, and as the payload of the
 * `artifact.created` event. The API projection already drops the copies before
 * a client sees them — but the STORE wrote the raw object. Measured on a
 * 13-model project: 4.2 MB per run, 7.1 MB at worst, 1.25 GB across 300 runs,
 * and a server that reached its heap limit after half an hour of questions.
 *
 * Nothing here is lost. `run.artifacts` keeps every payload once; the other
 * carriers keep identity. The one exception is deliberate: a Research task
 * step keeps its artifacts whole, because `canonicalTaskResultProofsByTask`
 * rebuilds task trust from them on reload.
 */
export function slimRunForPersistence<T extends { artifacts?: unknown; steps?: unknown; events?: unknown }>(run: T): T {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const identity = (artifact: unknown): unknown => {
    const item = record(artifact);
    if (!item) return artifact;
    // A content address, when the store has minted one, survives: the
    // payload is one lookup away, and reload rebuilds Research task trust
    // from it. This function never mints an address itself — an address
    // without a blob behind it would be a lie.
    const { payload: _payload, ...rest } = item;
    return rest;
  };
  const withoutRunCopies = (receipt: unknown): unknown => {
    const item = record(receipt);
    if (!item) return receipt;
    const { steps: _steps, artifacts: _artifacts, ...rest } = item;
    return rest;
  };
  const artifacts = Array.isArray(run.artifacts)
    ? run.artifacts.map((artifact) => {
      const item = record(artifact);
      const payload = record(item?.payload);
      if (!item || !payload) return artifact;
      const slimmed: Record<string, unknown> = { ...payload };
      for (const key of Object.keys(payload)) {
        if (key.startsWith('diagnosticReceipt')) slimmed[key] = withoutRunCopies(payload[key]);
      }
      return { ...item, payload: slimmed };
    })
    : run.artifacts;
  const steps = Array.isArray(run.steps)
    ? run.steps.map((step) => {
      const item = record(step);
      if (!item || !Array.isArray(item.artifacts)) return step;
      // A Research task step used to keep its artifacts whole because reload
      // rebuilt task trust from them; content addressing keeps every payload
      // retrievable, so identity is enough here too.
      return { ...item, artifacts: item.artifacts.map(identity) };
    })
    : run.steps;
  const events = Array.isArray(run.events)
    ? run.events.map((event) => {
      const item = record(event);
      if (!item) return event;
      if (item.type === 'artifact.created') {
        const artifact = record(item.payload);
        return artifact
          ? { ...item, payload: { artifactId: artifact.id, kind: artifact.kind, title: artifact.title, trustState: artifact.trustState } }
          : event;
      }
      return event;
    })
    : run.events;
  const receipt = withoutRunCopies((run as Record<string, unknown>).diagnosticReceipt);
  return {
    ...run,
    artifacts,
    steps,
    events,
    ...((run as Record<string, unknown>).diagnosticReceipt !== undefined ? { diagnosticReceipt: receipt } : {}),
  };
}

/** A persisted run heavier than this is one written before slimming; it gets slimmed in place. */
const OVERSIZED_RUN_BYTES = 512 * 1024;

export class SqliteAgentRunStore implements AgentRunStore {
  private readonly db: Database.Database;
  private readonly maxRuns: number;
  private readonly fullPayloadRuns: number;

  constructor(options: SqliteAgentRunStoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.maxRuns = options.maxRuns ?? resolveAgentRunRetention();
    this.fullPayloadRuns = Math.max(1, options.fullPayloadRuns ?? DEFAULT_FULL_PAYLOAD_RUNS);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        route TEXT NOT NULL,
        status TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        compacted INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);
      CREATE TABLE IF NOT EXISTS agent_run_artifacts (
        fingerprint TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_run_artifact_refs (
        run_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY (run_id, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS agent_run_requests (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_run_requests_run ON agent_run_requests(run_id);
    `);
    this.finalizeInterruptedRuns();
    if (options.legacyJsonPath) this.migrateLegacyJson(options.legacyJsonPath);
    this.slimOversizedRuns();
    this.externalizeInlineRows();
  }

  /**
   * CONTENT-ADDRESSED ARTIFACT PAYLOADS.
   *
   * A run row used to carry every artifact payload inline — the result, the
   * context pack, the compiled program — and `steps[].artifacts` carried the
   * same objects again. Each payload is now stored ONCE under the fingerprint
   * of its canonical JSON (`agent_run_artifacts`), the run keeps
   * `{ id, kind, title, trustState, ref, payloadRef }`, and a ref table ties
   * blobs to the runs that cite them so retention can drop orphans. Two runs
   * that produced the same payload share one blob. `get`/`getProgress`
   * hydrate `payload` back, so every reader sees the artifact exactly as it
   * was written; `list` deliberately does not (the index projection strips
   * payloads anyway).
   */
  private externalizeArtifacts<T extends { artifacts?: unknown; steps?: unknown }>(
    runId: string,
    run: T,
  ): T {
    const blobs = new Map<string, string>();
    const insertBlob = this.db.prepare('INSERT OR IGNORE INTO agent_run_artifacts (fingerprint, payload_json, bytes, created_at) VALUES (?, ?, ?, ?)');
    const insertRef = this.db.prepare('INSERT OR IGNORE INTO agent_run_artifact_refs (run_id, fingerprint) VALUES (?, ?)');
    const externalize = (artifact: unknown): unknown => {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return artifact;
      const item = artifact as Record<string, unknown>;
      if (item.payload === undefined) return artifact;
      const json = canonicalJson(item.payload);
      const ref = sha256(json);
      blobs.set(ref, json);
      const { payload: _payload, ...rest } = item;
      return { ...rest, payloadRef: ref };
    };
    const artifacts = Array.isArray(run.artifacts) ? run.artifacts.map(externalize) : run.artifacts;
    const steps = Array.isArray(run.steps)
      ? run.steps.map((step) => (step && typeof step === 'object' && !Array.isArray(step) && Array.isArray((step as { artifacts?: unknown }).artifacts)
        ? { ...(step as Record<string, unknown>), artifacts: ((step as { artifacts: unknown[] }).artifacts).map(externalize) }
        : step))
      : run.steps;
    const now = new Date().toISOString();
    const write = this.db.transaction(() => {
      for (const [ref, json] of blobs) {
        insertBlob.run(ref, json, Buffer.byteLength(json, 'utf8'), now);
        insertRef.run(runId, ref);
      }
    });
    write();
    return { ...run, artifacts, steps };
  }

  /**
   * Put `payloadRef` back as `payload`; a blob that was retention-pruned
   * stays absent. `task_steps` hydrates only the artifacts of Research task
   * steps — the ones reload rebuilds task trust from — which is what an index
   * listing needs and all it can afford.
   */
  private hydrateArtifacts<T extends { artifacts?: unknown; steps?: unknown }>(run: T, scope: 'all' | 'task_steps' = 'all'): T {
    const refs = new Set<string>();
    const collect = (artifact: unknown) => {
      const ref = artifact && typeof artifact === 'object' && !Array.isArray(artifact)
        ? (artifact as { payloadRef?: unknown }).payloadRef
        : undefined;
      if (typeof ref === 'string') refs.add(ref);
    };
    const taskStep = (step: unknown): boolean => Boolean(step && typeof step === 'object'
      && typeof (step as { askAnalystTaskId?: unknown }).askAnalystTaskId === 'string'
      && (step as { askAnalystTaskId: string }).askAnalystTaskId);
    if (scope === 'all' && Array.isArray(run.artifacts)) run.artifacts.forEach(collect);
    if (Array.isArray(run.steps)) {
      for (const step of run.steps) {
        if (scope === 'task_steps' && !taskStep(step)) continue;
        const artifacts = step && typeof step === 'object' ? (step as { artifacts?: unknown }).artifacts : undefined;
        if (Array.isArray(artifacts)) artifacts.forEach(collect);
      }
    }
    if (refs.size === 0) return run;
    const payloads = new Map<string, unknown>();
    const ids = [...refs];
    for (let offset = 0; offset < ids.length; offset += 200) {
      const page = ids.slice(offset, offset + 200);
      const rows = this.db.prepare(
        `SELECT fingerprint, payload_json FROM agent_run_artifacts WHERE fingerprint IN (${page.map(() => '?').join(', ')})`,
      ).all(...page) as Array<{ fingerprint: string; payload_json: string }>;
      for (const row of rows) {
        try { payloads.set(row.fingerprint, JSON.parse(row.payload_json)); } catch { /* a corrupt blob stays absent */ }
      }
    }
    const hydrate = (artifact: unknown): unknown => {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return artifact;
      const item = artifact as Record<string, unknown>;
      if (typeof item.payloadRef !== 'string' || item.payload !== undefined) return artifact;
      return payloads.has(item.payloadRef) ? { ...item, payload: payloads.get(item.payloadRef) } : artifact;
    };
    return {
      ...run,
      ...(Array.isArray(run.artifacts) ? { artifacts: run.artifacts.map(hydrate) } : {}),
      ...(Array.isArray(run.steps)
        ? {
          steps: run.steps.map((step) => (step && typeof step === 'object' && !Array.isArray(step) && Array.isArray((step as { artifacts?: unknown }).artifacts)
            ? { ...(step as Record<string, unknown>), artifacts: ((step as { artifacts: unknown[] }).artifacts).map(hydrate) }
            : step)),
        }
        : {}),
    };
  }

  /**
   * Read a stored row. Hydration comes BEFORE normalization: the trust
   * sanitizers rebuild Research task proofs from step artifact payloads, and
   * a payload that is still only an address would read as no proof at all.
   */
  private readRun(json: string, scope: 'all' | 'task_steps' = 'all'): AgentRun | undefined {
    let value: unknown;
    try { value = JSON.parse(json); } catch { return undefined; }
    if (!isAgentRunRecord(value)) return undefined;
    return normalizeRunProviderEgressReceipts(this.hydrateArtifacts(value, scope));
  }

  private readProgress(json: string): AgentRunProgressV1 | undefined {
    let value: unknown;
    try { value = JSON.parse(json); } catch { return undefined; }
    if (!isAgentRunProgressRecord(value)) return undefined;
    return sanitizeProgressRoleCoverage(this.hydrateArtifacts(value));
  }

  /**
   * The persisted form of a run: content-addressed FIRST, so every payload —
   * including a task step's own — is in the blob table before slimming
   * reduces the carriers to identity, then slimmed.
   */
  private persistedRunJson(run: AgentRun, options: { compacted?: boolean } = {}): string {
    const externalized = this.externalizeArtifacts(run.id, run);
    const slim = slimRunForPersistence(externalized);
    return JSON.stringify(options.compacted ? { ...slim, events: [] } : slim);
  }

  /**
   * Rows written before content addressing still carry inline payloads; move
   * a few of the heaviest out each time the store opens, so an old project
   * heals without a migration step. Best-effort: a row that cannot be parsed
   * is left alone.
   */
  private externalizeInlineRows(batch = 24): void {
    try {
      const rows = this.db.prepare(`
        SELECT id, payload_json, compacted, completed_at FROM agent_runs
        WHERE payload_json LIKE '%"payload":%' AND payload_json NOT LIKE '%"payloadRef":%'
        ORDER BY length(payload_json) DESC LIMIT ?
      `).all(batch) as Array<{ id: string; payload_json: string; compacted: number; completed_at: string | null }>;
      if (rows.length === 0) return;
      const update = this.db.prepare('UPDATE agent_runs SET payload_json = ? WHERE id = ?');
      for (const row of rows) {
        if (row.completed_at === null) continue;
        const run = this.readRun(row.payload_json);
        if (!run) continue;
        const json = this.persistedRunJson(run, { compacted: row.compacted === 1 });
        if (json.length < row.payload_json.length) update.run(json, row.id);
      }
    } catch {
      // A store that cannot be backfilled still serves reads and writes.
    }
  }

  save(run: AgentRun): void {
    const persistedRun = normalizeRunProviderEgressReceipts(run);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_runs (id, question, route, status, started_at, completed_at, compacted, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        question = excluded.question,
        route = excluded.route,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        compacted = 0,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      persistedRun.id,
      persistedRun.question,
      persistedRun.route,
      (persistedRun as { status?: string }).status ?? null,
      persistedRun.startedAt,
      (persistedRun as { completedAt?: string }).completedAt ?? null,
      this.persistedRunJson(persistedRun),
      now,
    );
    this.enforceRetention();
    this.compactOldRuns();
  }

  saveProgress(progress: AgentRunProgressV1): void {
    const persistedProgress = sanitizeProgressRoleCoverage(progress);
    const updatedAt = persistedProgress.lifecycle.updatedAt;
    this.db.prepare(`
      INSERT INTO agent_runs (id, question, route, status, started_at, completed_at, compacted, payload_json, updated_at)
      VALUES (?, ?, ?, NULL, ?, NULL, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        question = excluded.question,
        route = excluded.route,
        status = NULL,
        started_at = excluded.started_at,
        completed_at = NULL,
        compacted = 0,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
      WHERE agent_runs.completed_at IS NULL
    `).run(
      persistedProgress.id,
      persistedProgress.question,
      persistedProgress.route ?? 'blocked',
      persistedProgress.lifecycle.startedAt,
      JSON.stringify(this.externalizeArtifacts(persistedProgress.id, persistedProgress)),
      updatedAt,
    );
  }

  get(id: string): AgentRun | undefined {
    const row = this.db.prepare('SELECT payload_json FROM agent_runs WHERE id = ?').get(id) as { payload_json: string } | undefined;
    return row ? this.readRun(row.payload_json) : undefined;
  }

  /**
   * Durable request identity. A submission that carries an Idempotency-Key
   * claims it here BEFORE any expensive work; a replay of the same key finds
   * the original run instead of starting another, and a different question
   * under the same key is a conflict, never a silent second execution.
   */
  claimRequest(requestId: string, runId: string, fingerprint: string): { runId: string; fingerprint: string; createdAt: string; existing: boolean } {
    const existing = this.requestClaim(requestId);
    if (existing) return { ...existing, existing: true };
    const createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO agent_run_requests (request_id, run_id, request_fingerprint, created_at) VALUES (?, ?, ?, ?)').run(requestId, runId, fingerprint, createdAt);
    return { runId, fingerprint, createdAt, existing: false };
  }

  requestClaim(requestId: string): { runId: string; fingerprint: string; createdAt: string } | undefined {
    const row = this.db.prepare('SELECT run_id, request_fingerprint, created_at FROM agent_run_requests WHERE request_id = ?').get(requestId) as { run_id: string; request_fingerprint: string; created_at: string } | undefined;
    return row ? { runId: row.run_id, fingerprint: row.request_fingerprint, createdAt: row.created_at } : undefined;
  }

  getProgress(id: string): AgentRunProgressV1 | undefined {
    const row = this.db.prepare('SELECT payload_json FROM agent_runs WHERE id = ? AND completed_at IS NULL').get(id) as { payload_json: string } | undefined;
    return row ? this.readProgress(row.payload_json) : undefined;
  }

  /**
   * Newest first. `limit` bounds the rows READ, not just the rows returned:
   * parsing every stored run to answer a page of fifty took the server past
   * its heap on a project with months of history. Artifacts come back
   * UNHYDRATED — `payloadRef` without `payload` — because a listing is an
   * index, and hydrating every page's payloads is the memory the limit
   * exists to avoid. `get(id)` hydrates.
   */
  list(limit?: number, options: { ownerId?: string } = {}): AgentRun[] {
    // One person's runs only, when a host signs people in (RFC 0010).
    const owned = options.ownerId !== undefined;
    const where = owned ? "WHERE json_extract(payload_json, '$.ownerId') = ?" : '';
    const args: unknown[] = owned ? [options.ownerId] : [];
    const rows = (Number.isFinite(limit) && (limit as number) > 0
      ? this.db.prepare(`SELECT payload_json FROM agent_runs ${where} ORDER BY started_at DESC LIMIT ?`).all(...args, Math.floor(limit as number))
      : this.db.prepare(`SELECT payload_json FROM agent_runs ${where} ORDER BY started_at DESC`).all(...args)) as Array<{ payload_json: string }>;
    return rows.flatMap((row) => {
      const run = this.readRun(row.payload_json, 'task_steps');
      return run ? [run] : [];
    });
  }

  count(options: { ownerId?: string } = {}): number {
    const row = (options.ownerId !== undefined
      ? this.db.prepare("SELECT COUNT(*) AS total FROM agent_runs WHERE json_extract(payload_json, '$.ownerId') = ?").get(options.ownerId)
      : this.db.prepare('SELECT COUNT(*) AS total FROM agent_runs').get()) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  close(): void {
    this.db.close();
  }

  /**
   * A local runtime restart cannot safely recreate provider/tool continuations.
   * Close orphaned rows with one inspectable, retryable terminal receipt instead
   * of leaving the UI in a permanent running state.
   *
   * Acceptance: API-008, API-007.
   */
  private finalizeInterruptedRuns(): void {
    const rows = this.db.prepare(
      'SELECT id, payload_json FROM agent_runs WHERE completed_at IS NULL',
    ).all() as Array<{ id: string; payload_json: string }>;
    if (rows.length === 0) return;
    const update = this.db.prepare(`
      UPDATE agent_runs
      SET route = ?, status = ?, completed_at = ?, payload_json = ?, updated_at = ?
      WHERE id = ? AND completed_at IS NULL
    `);
    const closeAll = this.db.transaction(() => {
      for (const row of rows) {
        const progress = this.readProgress(row.payload_json);
        if (!progress) continue;
        const completedAt = new Date().toISOString();
        const userCancelled = progress.lifecycle.state === 'cancelling'
          || progress.events.some((event) => event.type === 'run.cancelled');
        const route = progress.route ?? (userCancelled ? 'cancelled' : 'blocked');
        const retainedArtifacts = retainedInterruptedArtifacts(progress, userCancelled);
        const retainedIndependentResult = retainedArtifacts.some((artifact) => artifact.trustState !== 'blocked');
        const failure: AgentRunDiagnosticReceiptV1['failure'] = {
          code: userCancelled ? 'RUN_CANCELLED' : 'RUN_INTERRUPTED',
          phase: progress.lifecycle.phase,
          message: userCancelled
            ? 'Stopped by user.'
            : retainedIndependentResult
              ? 'The local DQL runtime restarted before this agent run completed. Completed independent task results remain available for inspection.'
              : 'The local DQL runtime restarted before this agent run completed. No result was accepted.',
          recoverable: !userCancelled,
          safeActions: userCancelled ? [] : ['retry_same_request'],
        };
        const receipt: AgentRunDiagnosticReceiptV1 = {
          version: 1,
          runId: progress.id,
          phase: progress.lifecycle.phase,
          route,
          plan: progress.plan,
          steps: progress.steps,
          artifacts: retainedArtifacts,
          evaluations: progress.evaluations,
          failure,
        };
        const runtimeReceipt = interruptedRuntimeReceiptV5(progress, userCancelled, route);
        const runtimeReceiptV6 = runtimeReceipt
          ? interruptedRuntimeReceiptV6(progress, userCancelled, runtimeReceipt)
          : undefined;
        const diagnosticArtifact = {
          id: `${progress.id}:diagnostic`,
          kind: 'answer' as const,
          title: userCancelled ? 'Cancelled agent run' : 'Interrupted agent run',
          trustState: 'blocked' as const,
          payload: {
            diagnosticReceipt: receipt,
            ...(runtimeReceipt ? { diagnosticReceiptV5: runtimeReceipt } : {}),
            ...(runtimeReceiptV6 ? { diagnosticReceiptV6: runtimeReceiptV6 } : {}),
          },
        };
        const run: AgentRun = {
          id: progress.id,
          question: progress.question,
          requestedMode: progress.requestedMode,
          route,
          status: userCancelled ? 'cancelled' : 'blocked',
          trustState: userCancelled ? 'not_applicable' : 'blocked',
          stopReason: userCancelled ? 'cancelled' : 'blocked',
          startedAt: progress.lifecycle.startedAt,
          completedAt,
          selectedObject: progress.selectedObject,
          plan: progress.plan,
          steps: progress.steps,
          summary: failure.message,
          artifacts: userCancelled
            ? retainedArtifacts
            : [...retainedArtifacts, diagnosticArtifact],
          evaluations: [
            ...progress.evaluations,
            userCancelled
              ? {
                  id: 'run-cancelled',
                  label: 'Run cancelled',
                  passed: true,
                  severity: 'info' as const,
                  message: failure.message,
                }
              : {
                  id: 'run-interrupted',
                  label: 'Run interrupted',
                  passed: false,
                  severity: 'blocking' as const,
                  message: failure.message,
                  suggestedRepair: 'Retry the same request.',
                },
          ],
          events: [
            ...progress.events,
            {
              id: `${progress.id}:event:${progress.events.length + 1}`,
              runId: progress.id,
              type: userCancelled ? 'run.cancelled' : 'run.failed',
              at: completedAt,
              message: failure.message,
              route,
              status: userCancelled ? 'cancelled' : 'blocked',
              trustState: userCancelled ? 'not_applicable' : 'blocked',
            },
          ],
          nextActions: userCancelled
            ? []
            : [{ id: 'retry-interrupted-run', label: 'Retry request', route: progress.route }],
          repairAttempts: 0,
          escalationAttempts: 0,
          diagnosticReceipt: receipt,
          ...(runtimeReceipt ? { diagnosticReceiptV5: runtimeReceipt } : {}),
          ...(runtimeReceiptV6 ? { diagnosticReceiptV6: runtimeReceiptV6 } : {}),
          ...(progress.askAnalystState ? { askAnalystState: progress.askAnalystState } : {}),
          ...(progress.analyticalTaskOutcomes?.length
            ? { analyticalTaskOutcomes: progress.analyticalTaskOutcomes }
            : {}),
          ...(progress.analyticalTaskOutcomeSummary
            ? { analyticalTaskOutcomeSummary: progress.analyticalTaskOutcomeSummary }
            : {}),
          ...(progress.traceReference ? { traceReference: progress.traceReference } : {}),
          lifecycle: {
            ...progress.lifecycle,
            state: 'terminal',
            phase: userCancelled ? 'run.cancelled' : 'run.failed',
            revision: progress.lifecycle.revision + 1,
            eventCursor: progress.events.length + 1,
            updatedAt: completedAt,
            completedAt,
          },
        };
        update.run(run.route, run.status, completedAt, this.persistedRunJson(run), completedAt, run.id);
      }
    });
    closeAll();
  }

  private enforceRetention(): void {
    this.db.prepare(`
      DELETE FROM agent_runs WHERE id NOT IN (
        SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT ?
      )
    `).run(this.maxRuns);
    // A blob lives as long as one retained run cites it.
    this.db.prepare('DELETE FROM agent_run_artifact_refs WHERE run_id NOT IN (SELECT id FROM agent_runs)').run();
    this.db.prepare('DELETE FROM agent_run_artifacts WHERE fingerprint NOT IN (SELECT fingerprint FROM agent_run_artifact_refs)').run();
  }

  /**
   * Strip the verbose event stream (progress narration) from runs that fell out
   * of the recent window. Artifacts, evaluations, and answers stay intact so
   * old runs still render their results — they just lose the step-by-step log.
   */
  private compactOldRuns(): void {
    const stale = this.db.prepare(`
      SELECT id, payload_json FROM agent_runs
      WHERE compacted = 0 AND id NOT IN (
        SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT ?
      )
    `).all(this.fullPayloadRuns) as Array<{ id: string; payload_json: string }>;
    if (stale.length === 0) return;
    const update = this.db.prepare('UPDATE agent_runs SET payload_json = ?, compacted = 1 WHERE id = ?');
    for (const row of stale) {
      const run = this.readRun(row.payload_json);
      if (!run) {
        update.run(row.payload_json, row.id);
        continue;
      }
      update.run(this.persistedRunJson(run, { compacted: true }), row.id);
    }
    this.slimOversizedRuns();
  }

  /**
   * Rows written before persisted runs were slimmed still carry the context
   * pack and artifacts four to five times — 4 MB a run, 1.2 GB over a
   * project's history — and reading a page of them took the server past its
   * heap. Bring a few of the heaviest down each time a run is saved (and
   * once at open), so an old project heals without a migration step.
   */
  private slimOversizedRuns(batch = 8): void {
    const heavy = this.db.prepare(`
      SELECT id, payload_json, compacted FROM agent_runs
      WHERE length(payload_json) > ?
      ORDER BY length(payload_json) DESC LIMIT ?
    `).all(OVERSIZED_RUN_BYTES, batch) as Array<{ id: string; payload_json: string; compacted: number }>;
    if (heavy.length === 0) return;
    const update = this.db.prepare('UPDATE agent_runs SET payload_json = ? WHERE id = ?');
    for (const row of heavy) {
      const run = this.readRun(row.payload_json);
      if (!run) continue;
      const slim = this.persistedRunJson(run, { compacted: row.compacted === 1 });
      if (slim.length < row.payload_json.length) update.run(slim, row.id);
    }
  }

  /** One-time import of the legacy JSON store; the file is renamed to *.migrated as a backup. */
  private migrateLegacyJson(legacyJsonPath: string): void {
    if (!existsSync(legacyJsonPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(legacyJsonPath, 'utf-8')) as { runs?: unknown };
      const runs = Array.isArray(parsed.runs)
        ? parsed.runs.filter(isAgentRunRecord).map(normalizeRunProviderEgressReceipts)
        : [];
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO agent_runs (id, question, route, status, started_at, completed_at, compacted, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      `);
      const now = new Date().toISOString();
      const importAll = this.db.transaction((records: AgentRun[]) => {
        for (const run of records) {
          insert.run(
            run.id,
            run.question,
            run.route,
            (run as { status?: string }).status ?? null,
            run.startedAt,
            (run as { completedAt?: string }).completedAt ?? null,
            this.persistedRunJson(run),
            now,
          );
        }
      });
      importAll(runs);
      this.enforceRetention();
      this.compactOldRuns();
    } catch {
      // A corrupt legacy file must not block the new store; keep it for forensics.
    }
    try {
      renameSync(legacyJsonPath, `${legacyJsonPath}.migrated`);
    } catch {
      // Rename is best-effort (e.g. another process holds the file on Windows).
    }
  }
}

/**
 * Restart recovery retains the typed continuation state for a deliberate retry,
 * but its diagnostic artifact/export receipt must remain content-free. Never
 * copy the question, filter values, member values, answer, SQL, or rows here.
 */
function interruptedRuntimeReceiptV5(
  progress: AgentRunProgressV1,
  cancelled: boolean,
  route: NonNullable<AgentRunProgressV1['route']>,
): AgentRunDiagnosticReceiptV5 | undefined {
  const state = progress.askAnalystState;
  if (!state) return undefined;
  const diagnosticState = interruptedDiagnosticState(state);
  const summaryInput = {
    version: 2 as const,
    runtimeMode: state.mode,
    whatHappened: cancelled
      ? 'The Ask runtime was cancelled before its final result was accepted.'
      : 'The Ask runtime was interrupted before its final result was accepted.',
    why: cancelled
      ? 'The local run was cancelled before finalization.'
      : 'The local DQL runtime restarted before finalization.',
    impact: 'No executable data answer was accepted for this run.',
    nextAction: cancelled ? 'none' as const : 'retry_same_plan' as const,
    ...(state.resolvedPlan?.compiler ? { selectedCompiler: state.resolvedPlan.compiler } : {}),
    programTaskCount: state.program.taskIds.length,
    admittedCandidateCount: state.workspace.admittedCandidateIds.length,
    toolCallCount: state.toolCalls,
    executionAttempts: state.executionAttempts,
  };
  return {
    version: 5,
    runId: progress.id,
    state: diagnosticState,
    summary: {
      ...summaryInput,
      summaryFingerprint: `sha256:${createHash('sha256').update(JSON.stringify(summaryInput)).digest('hex')}`,
    },
    businessAnswer: {
      version: 1,
      mode: 'deterministic_fallback',
      trustState: cancelled ? 'not_applicable' : 'blocked',
      factIds: [],
      limitationCount: 1,
    },
    finalStopReason: cancelled ? 'cancelled' : 'blocked',
  };
}

/**
 * Restart recovery has no live trace collector, so V6 is projected only from
 * the persisted V2 state and its content-free V5 envelope. Do not infer a
 * connection or SQL attempt from elapsed time/prose: an interrupted execution
 * count is retained separately and the connection boundary remains skipped
 * unless a terminal run receipt recorded it before restart.
 */
function interruptedRuntimeReceiptV6(
  progress: AgentRunProgressV1,
  cancelled: boolean,
  receipt: AgentRunDiagnosticReceiptV5,
): AgentRunDiagnosticReceiptV6 {
  const state = progress.askAnalystState!;
  const planning = state.version === 2 || state.version === 3
    ? state.planningReceipt
    : undefined;
  const plannerTool = state.workspace.tools.find((tool) => tool.kind === 'provider_meaning');
  const recoveryTool = state.workspace.tools.find((tool) => tool.kind === 'candidate_extension');
  const planFrozen = state.resolvedPlan?.planFrozen === true;
  const verification = planning?.verification ?? {
    version: 1 as const,
    status: state.phase === 'clarify' ? 'ambiguous' as const : state.phase === 'blocked' ? 'invalid' as const : 'valid' as const,
    missingRoles: [],
    candidateIds: [],
    reasonCode: state.phase === 'clarify'
      ? 'persisted_clarification_state'
      : state.phase === 'blocked'
        ? 'persisted_blocked_state'
        : 'persisted_program_state',
  };
  // A durable failed provider tool is a planner attempt too. This restores a
  // truthful concise V6 restart story for V2 checkpoints saved between
  // dispatch and planning-receipt finalization.
  const plannerAttempted = plannerTool?.status === 'completed' || plannerTool?.status === 'failed';
  const plannerCalls = Math.max(
    planning?.plannerCalls ?? 0,
    plannerAttempted ? Math.max(1, state.planningContinuations) : 0,
  );
  const revisionCalls = planning?.revisionCalls
    ?? (recoveryTool?.status === 'completed' && plannerCalls > 1 ? 1 : 0);
  const planningMode = planning?.mode
    ?? (plannerCalls === 0
      ? 'deterministic_binding'
      : revisionCalls > 0 ? 'targeted_revision' : 'initial_planner');
  const executionAttempts = state.executionAttempts;
  return {
    ...receipt,
    version: 6,
    planning: {
      version: 1,
      mode: planningMode,
      plannerCalls,
      revisionCalls,
      verification,
    },
    // V2 stores count-only admission coverage, so reload can retain the
    // meaningful "required versus admitted" story without exposing labels,
    // prompts, or result values. Older V1 states remain content-free.
    roleCoverage: state.workspace.version === 2
      ? (state.workspace.roleCoverage ?? [])
        .filter((entry) => Number.isFinite(entry.candidateCount) && entry.candidateCount >= 0)
        .map((entry) => ({
          role: entry.role,
          candidateCount: entry.candidateCount,
          ...(entry.state === 'alternatives' || entry.state === 'proven' ? { state: entry.state } : {}),
        }))
      : [],
    cascade: {
      attempts: [],
      ...(state.resolvedPlan?.selectedTier ? { selectedTier: state.resolvedPlan.selectedTier } : {}),
      ...(state.resolvedPlan?.compiler && state.resolvedPlan.compiler !== 'none'
        ? { stopReason: `persisted_${state.resolvedPlan.compiler}_plan` }
        : {}),
      planFrozen,
    },
    connection: { attempted: false },
    execution: { attempts: executionAttempts },
    facts: { factCount: 0 },
    safeNextAction: receipt.summary.nextAction,
    story: [
      { stage: 'retrieval', status: state.workspace.snapshotId ? 'completed' : 'skipped', reasonCode: state.workspace.snapshotId ? 'persisted_snapshot' : 'snapshot_not_retained' },
      {
        stage: 'role_coverage',
        status: state.workspace.version === 2 && (state.workspace.roleCoverage?.length ?? 0) > 0
          ? 'completed'
          : 'skipped',
        reasonCode: state.workspace.version === 2 && (state.workspace.roleCoverage?.length ?? 0) > 0
          ? 'persisted_role_admission_coverage'
          : 'content_free_restart_projection',
      },
      {
        stage: 'planner',
        status: plannerTool?.status === 'failed' ? 'blocked' : plannerCalls > 0 ? 'completed' : 'skipped',
        reasonCode: plannerTool?.reasonCode ?? planningMode,
      },
      { stage: 'verification', status: verification.status === 'valid' ? 'completed' : 'blocked', reasonCode: verification.reasonCode },
      { stage: 'targeted_recovery', status: recoveryTool?.status === 'completed' ? 'completed' : 'skipped', reasonCode: recoveryTool?.reasonCode ?? 'not_required' },
      { stage: 'cascade', status: planFrozen ? 'completed' : state.phase === 'blocked' ? 'blocked' : 'skipped', reasonCode: state.resolvedPlan?.compiler ?? 'no_persisted_compiler' },
      { stage: 'freeze', status: planFrozen ? 'completed' : 'skipped', reasonCode: planFrozen ? 'persisted_plan_frozen' : 'no_persisted_plan' },
      { stage: 'connection', status: 'skipped', reasonCode: 'connection_boundary_not_retained_on_restart' },
      { stage: 'execution', status: executionAttempts > 0 ? 'blocked' : 'skipped', reasonCode: executionAttempts > 0 ? 'interrupted_after_execution_attempt' : 'execution_not_attempted' },
      { stage: 'facts', status: 'skipped', reasonCode: cancelled ? 'run_cancelled_before_final_facts' : 'run_interrupted_before_final_facts' },
    ],
  };
}

function interruptedDiagnosticState(state: AskAnalystState): AgentRunDiagnosticReceiptV5['state'] {
  return {
    version: 1,
    mode: state.mode,
    phase: state.phase,
    questionFingerprint: state.frame.questionFingerprint,
    kind: state.frame.kind,
    requirementCounts: {
      measures: state.frame.requirements.measures.length,
      dimensions: state.frame.requirements.dimensions.length,
      entityTerms: state.frame.requirements.entityTerms.length + state.frame.requirements.entityDisplayTerms.length,
      members: state.frame.requirements.memberTerms.length,
      filters: state.program.filters.length,
    },
    mission: {
      mode: state.mission.mode,
      taskCount: state.mission.tasks.length,
      deferredTaskCount: state.mission.deferredTasks?.length ?? 0,
      hypothesisCount: state.mission.hypotheses.length,
    },
    workspace: {
      ...(state.workspace.snapshotId ? { snapshotId: state.workspace.snapshotId } : {}),
      ...(state.workspace.sourceFingerprint ? { sourceFingerprint: state.workspace.sourceFingerprint } : {}),
      admittedCandidateCount: state.workspace.admittedCandidateIds.length,
      excludedCandidateCount: state.workspace.excludedCandidates.length,
      sourceCoverage: state.workspace.sourceCoverage.map((coverage) => ({
        source: coverage.source,
        status: coverage.status,
        candidateCount: coverage.candidateIds.length,
      })),
      tools: state.workspace.tools.map((tool) => ({
        id: tool.id,
        kind: tool.kind,
        status: tool.status,
        reasonCode: tool.reasonCode,
      })),
    },
    program: {
      id: state.program.id,
      taskCount: state.program.taskIds.length,
      candidateCount: state.program.candidateIds.length,
      requiredRoles: state.program.requiredRoles,
      outputAssertionCount: state.program.outputs.assertions.length,
    },
    ...(state.resolvedPlan ? { resolvedPlan: state.resolvedPlan } : {}),
    counters: {
      planningContinuations: state.planningContinuations,
      toolCalls: state.toolCalls,
      executionAttempts: state.executionAttempts,
      repairAttempts: state.repairAttempts,
    },
  };
}

export function defaultAgentRunSqlitePath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'agent-runs.sqlite');
}


/**
 * Durable run JSON is local and therefore untrusted on import/read. Keep an
 * invalid provider receipt from advertising historical row egress through the
 * primary run field, diagnostic receipt, or its diagnostic artifact payload.
 */
function normalizeRunProviderEgressReceipts(run: AgentRun): AgentRun {
  const normalizeReceiptList = (value: unknown) => Array.isArray(value)
    ? value.flatMap((receipt) => {
        const normalized = normalizeProviderEgressReceiptV1(receipt);
        return normalized ? [normalized] : [];
      })
    : undefined;
  const normalizeReceiptContainer = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const providerEgressReceipts = normalizeReceiptList(record.providerEgressReceipts);
    return providerEgressReceipts === undefined
      ? value
      : { ...record, providerEgressReceipts };
  };
  const rootReceipts = normalizeReceiptList((run as unknown as Record<string, unknown>).providerEgressReceipts);
  const diagnosticReceipt = normalizeReceiptContainer((run as unknown as Record<string, unknown>).diagnosticReceipt);
  const artifacts = run.artifacts.map((artifact) => {
    if (!artifact.payload || typeof artifact.payload !== 'object' || Array.isArray(artifact.payload)) return artifact;
    const payload = artifact.payload as Record<string, unknown>;
    const normalizedDiagnosticReceipt = normalizeReceiptContainer(payload.diagnosticReceipt);
    return normalizedDiagnosticReceipt === payload.diagnosticReceipt
      ? artifact
      : { ...artifact, payload: { ...payload, diagnosticReceipt: normalizedDiagnosticReceipt } };
  });
  const askAnalystState = sanitizeAskAnalystStateRoleCoverage(run.askAnalystState);
  const taskReceipts = sanitizeTaskOutcomeReceipts({
    outcomes: (run as unknown as Record<string, unknown>).analyticalTaskOutcomes,
    summary: (run as unknown as Record<string, unknown>).analyticalTaskOutcomeSummary,
    steps: run.steps,
  });
  // Do not spread untrusted V3 receipts back onto the returned object. Older
  // V1/V2 runs simply omit the additive fields; malformed V3 JSON is stripped
  // or reduced to a blocked receipt before the notebook/API can render it.
  const {
    analyticalTaskOutcomes: _rawTaskOutcomes,
    analyticalTaskOutcomeSummary: _rawTaskOutcomeSummary,
    ...durableRun
  } = run;
  return {
    ...durableRun,
    ...(rootReceipts === undefined ? {} : { providerEgressReceipts: rootReceipts }),
    ...(diagnosticReceipt === (run as unknown as Record<string, unknown>).diagnosticReceipt
      ? {}
      : { diagnosticReceipt: diagnosticReceipt as AgentRun['diagnosticReceipt'] }),
    artifacts,
    ...(askAnalystState === run.askAnalystState ? {} : { askAnalystState }),
    ...(taskReceipts.outcomes ? { analyticalTaskOutcomes: taskReceipts.outcomes } : {}),
    ...(taskReceipts.summary ? { analyticalTaskOutcomeSummary: taskReceipts.summary } : {}),
  };
}


/**
 * V2 role coverage is an observability summary, not a payload lane. Persist
 * only the typed count tuples so an injected label, raw query fragment, or
 * result value cannot survive a restart through the Ask state or diagnostic
 * projection. The rest of the local continuation state remains intact.
 */
function sanitizeAskAnalystStateRoleCoverage(
  state: AskAnalystState | undefined,
): AskAnalystState | undefined {
  if (!state || (state.version !== 2 && state.version !== 3) || !Array.isArray(state.workspace.roleCoverage)) return state;
  const roleCoverage = state.workspace.roleCoverage.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.role !== 'string'
      || !EVIDENCE_CANDIDATE_ROLES.has(record.role as EvidenceCandidateRoleV1)
      || !Number.isFinite(record.candidateCount)
      || Number(record.candidateCount) < 0) return [];
    const coverageState: EvidenceRoleCoverageStateV1 | undefined = record.state === 'alternatives' || record.state === 'proven'
      ? record.state
      : undefined;
    return [{
      role: record.role as typeof entry.role,
      candidateCount: Math.floor(Number(record.candidateCount)),
      ...(coverageState ? { state: coverageState } : {}),
    }];
  });
  return {
    ...state,
    workspace: {
      ...state.workspace,
      roleCoverage,
    },
  };
}

function sanitizeProgressRoleCoverage(progress: AgentRunProgressV1): AgentRunProgressV1 {
  const askAnalystState = sanitizeAskAnalystStateRoleCoverage(progress.askAnalystState);
  const taskReceipts = sanitizeTaskOutcomeReceipts({
    outcomes: (progress as unknown as Record<string, unknown>).analyticalTaskOutcomes,
    summary: (progress as unknown as Record<string, unknown>).analyticalTaskOutcomeSummary,
    steps: progress.steps,
  });
  const {
    analyticalTaskOutcomes: _rawTaskOutcomes,
    analyticalTaskOutcomeSummary: _rawTaskOutcomeSummary,
    ...durableProgress
  } = progress;
  return {
    ...durableProgress,
    ...(askAnalystState === progress.askAnalystState ? {} : { askAnalystState }),
    ...(taskReceipts.outcomes ? { analyticalTaskOutcomes: taskReceipts.outcomes } : {}),
    ...(taskReceipts.summary ? { analyticalTaskOutcomeSummary: taskReceipts.summary } : {}),
  };
}

interface SanitizedTaskOutcomeReceiptsV1 {
  outcomes?: AnalyticalTaskOutcomeV1[];
  summary?: AnalyticalTaskOutcomeSummaryV1;
}

function isDurableString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1_000;
}

function durableStringList(value: unknown, maxItems = 32): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isDurableString).map((item) => item.trim()))].slice(0, maxItems);
}

function durableRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function taskReceiptTrustForArtifact(value: unknown): AnalyticalTaskOutcomeTrustStateV1 | undefined {
  if (value === 'grounded') return 'governed';
  return ANALYTICAL_TASK_OUTCOME_TRUST_STATES.has(value as AnalyticalTaskOutcomeTrustStateV1)
    ? value as AnalyticalTaskOutcomeTrustStateV1
    : undefined;
}

interface CanonicalTaskResultProofV1 {
  resultFingerprint: string;
  trustState: AnalyticalTaskOutcomeTrustStateV1;
}

function canonicalTaskResultProofForArtifact(value: unknown): CanonicalTaskResultProofV1 | undefined {
  const artifact = durableRecord(value);
  const trustState = taskReceiptTrustForArtifact(artifact?.trustState);
  if (!artifact || artifact.kind !== 'answer' || !trustState || trustState === 'blocked') return undefined;
  const payload = durableRecord(artifact.payload);
  const result = durableRecord(payload?.result);
  const fingerprint = result?.resultFingerprint;
  if (!result || !isDurableString(fingerprint)
    || !Array.isArray(result.columns) || result.columns.length === 0
    || !Array.isArray(result.rows)) return undefined;
  return { resultFingerprint: fingerprint, trustState };
}

function canonicalTaskResultProofsByTask(steps: unknown): ReadonlyMap<string, ReadonlyMap<string, AnalyticalTaskOutcomeTrustStateV1>> {
  const byTask = new Map<string, Map<string, AnalyticalTaskOutcomeTrustStateV1>>();
  if (!Array.isArray(steps)) return byTask;
  for (const rawStep of steps) {
    const step = durableRecord(rawStep);
    const taskId = step?.askAnalystTaskId;
    if (!step || !isDurableString(taskId) || !Array.isArray(step.artifacts)) continue;
    const proofs = step.artifacts
      .map(canonicalTaskResultProofForArtifact)
      .filter((proof): proof is CanonicalTaskResultProofV1 => Boolean(proof));
    if (proofs.length > 0) {
      const byFingerprint = new Map<string, AnalyticalTaskOutcomeTrustStateV1>();
      for (const proof of proofs) {
        const existing = byFingerprint.get(proof.resultFingerprint);
        byFingerprint.set(proof.resultFingerprint, existing
          ? leastTrustedTaskReceiptState([existing, proof.trustState])
          : proof.trustState);
      }
      byTask.set(taskId, byFingerprint);
    }
  }
  return byTask;
}

function sanitizeTaskOutcomeFailure(value: unknown): AnalyticalTaskFailureV1 | undefined {
  const failure = durableRecord(value);
  if (!failure || !isDurableString(failure.code) || !isDurableString(failure.message)) return undefined;
  if (failure.phase !== 'planning' && failure.phase !== 'execution' && failure.phase !== 'dependency') return undefined;
  return { version: 1, code: failure.code, message: failure.message, phase: failure.phase };
}

function sanitizeTaskOutcomeGap(value: unknown): AnalyticalCoverageGapV1 | undefined {
  const gap = durableRecord(value);
  const allowedCodes = new Set<AnalyticalCoverageGapV1['code']>([
    'MISSING_MEASURE', 'MISSING_DIMENSION', 'MISSING_ATTRIBUTE', 'MISSING_RELATIONSHIP',
    'MISSING_RUNTIME_CAPABILITY', 'RESULT_CONTRACT_MISMATCH', 'PROVIDER_UNAVAILABLE',
    'EXECUTION_FAILED', 'AMBIGUOUS_MEANING', 'POLICY_BLOCKED',
  ]);
  const allowedPhases = new Set<AnalyticalCoverageGapV1['phase']>([
    'retrieval', 'meaning', 'planning', 'compilation', 'execution', 'presentation',
  ]);
  const allowedRoutes = new Set<AnalyticalCoverageGapV1['attemptedRoutes'][number]>([
    'certified', 'semantic', 'governed_relational', 'generated', 'research',
  ]);
  if (!gap || !allowedCodes.has(gap.code as AnalyticalCoverageGapV1['code'])
    || !allowedPhases.has(gap.phase as AnalyticalCoverageGapV1['phase'])
    || !isDurableString(gap.message) || typeof gap.recoverable !== 'boolean'
    || typeof gap.planFrozen !== 'boolean') return undefined;
  const attemptedRoutes = Array.isArray(gap.attemptedRoutes)
    ? gap.attemptedRoutes.filter((route): route is AnalyticalCoverageGapV1['attemptedRoutes'][number] =>
        typeof route === 'string' && allowedRoutes.has(route as AnalyticalCoverageGapV1['attemptedRoutes'][number]))
    : [];
  return {
    version: 1,
    code: gap.code as AnalyticalCoverageGapV1['code'],
    phase: gap.phase as AnalyticalCoverageGapV1['phase'],
    message: gap.message,
    searchedSources: durableStringList(gap.searchedSources),
    attemptedRoutes,
    missing: durableStringList(gap.missing),
    recoverable: gap.recoverable,
    planFrozen: gap.planFrozen,
    nextActions: durableStringList(gap.nextActions),
  };
}

function leastTrustedTaskReceiptState(states: AnalyticalTaskOutcomeTrustStateV1[]): AnalyticalTaskOutcomeTrustStateV1 {
  if (states.length === 0) return 'blocked';
  const score: Record<AnalyticalTaskOutcomeTrustStateV1, number> = {
    certified: 4, governed: 3, review_required: 2, not_applicable: 1, blocked: 0,
  };
  return states.reduce((least, candidate) => score[candidate] < score[least] ? candidate : least);
}

/**
 * Read local V3 task receipts as untrusted JSON. Successful status is valid
 * only when the same task step contains a canonical immutable result artifact
 * with the advertised fingerprint. This also keeps V1/V2 records readable:
 * absent additive fields remain absent.
 */
function sanitizeTaskOutcomeReceipts(input: {
  outcomes: unknown;
  summary: unknown;
  steps: unknown;
}): SanitizedTaskOutcomeReceiptsV1 {
  const rawSummary = durableRecord(input.summary);
  const rawOutcomes = Array.isArray(input.outcomes) ? input.outcomes : undefined;
  if (!rawOutcomes && !rawSummary) return {};
  const canonicalByTask = canonicalTaskResultProofsByTask(input.steps);
  const outcomes: AnalyticalTaskOutcomeV1[] = [];
  const seenTaskIds = new Set<string>();
  for (const rawOutcome of rawOutcomes ?? []) {
    const outcome = durableRecord(rawOutcome);
    const taskId = outcome?.taskId;
    const status = outcome?.status;
    if (!outcome || !isDurableString(taskId)
      || !ANALYTICAL_TASK_OUTCOME_STATUSES.has(status as AnalyticalTaskOutcomeStatusV1)
      || seenTaskIds.has(taskId)) continue;
    seenTaskIds.add(taskId);
    const persistedTrustState = ANALYTICAL_TASK_OUTCOME_TRUST_STATES.has(outcome.trustState as AnalyticalTaskOutcomeTrustStateV1)
      ? outcome.trustState as AnalyticalTaskOutcomeTrustStateV1
      : undefined;
    const requestedSuccess = status === 'completed' || status === 'partial';
    const resultFingerprint = isDurableString(outcome.resultFingerprint) ? outcome.resultFingerprint : undefined;
    const canonicalTrustState = resultFingerprint
      ? canonicalByTask.get(taskId)?.get(resultFingerprint)
      : undefined;
    const canonicalResult = Boolean(canonicalTrustState);
    if (requestedSuccess && !canonicalResult) {
      outcomes.push({
        version: 1,
        taskId,
        status: 'blocked',
        trustState: 'blocked',
        summary: 'This persisted task result has no matching immutable canonical artifact.',
        failure: {
          version: 1,
          code: 'TASK_RESULT_ARTIFACT_UNVERIFIED',
          message: 'This persisted task result has no matching immutable canonical artifact.',
          phase: 'execution',
        },
      });
      continue;
    }
    const trustState = canonicalTrustState
      ? persistedTrustState
        ? leastTrustedTaskReceiptState([persistedTrustState, canonicalTrustState])
        : canonicalTrustState
      : persistedTrustState ?? 'blocked';
    outcomes.push({
      version: 1,
      taskId,
      status: status as AnalyticalTaskOutcomeStatusV1,
      trustState,
      ...(isDurableString(outcome.summary) ? { summary: outcome.summary } : {}),
      ...(canonicalResult && resultFingerprint ? { resultFingerprint } : {}),
      ...(sanitizeTaskOutcomeGap(outcome.gap) ? { gap: sanitizeTaskOutcomeGap(outcome.gap) } : {}),
      ...(sanitizeTaskOutcomeFailure(outcome.failure) ? { failure: sanitizeTaskOutcomeFailure(outcome.failure) } : {}),
      ...(status === 'dependency_blocked' ? { dependencyTaskIds: durableStringList(outcome.dependencyTaskIds) } : {}),
    });
  }
  const requestedTaskCount = typeof rawSummary?.taskCount === 'number' && Number.isFinite(rawSummary.taskCount)
    ? Math.max(0, Math.min(100, Math.floor(rawSummary.taskCount)))
    : 0;
  // Preserve an execution-pending compiler checkpoint only when it makes no
  // success claim. It becomes execution-final after the first child step.
  const mayKeepEmptySummary = outcomes.length === 0
    && requestedTaskCount > 0
    && durableStringList(rawSummary?.successfulTaskIds).length === 0;
  if (outcomes.length === 0 && !mayKeepEmptySummary) return {};
  const successfulTaskIds = outcomes
    .filter((outcome) => outcome.status === 'completed' || outcome.status === 'partial')
    .map((outcome) => outcome.taskId);
  const failedTaskIds = outcomes
    .filter((outcome) => outcome.status !== 'completed' && outcome.status !== 'partial' && outcome.status !== 'dependency_blocked')
    .map((outcome) => outcome.taskId);
  const dependencyBlockedTaskIds = outcomes
    .filter((outcome) => outcome.status === 'dependency_blocked')
    .map((outcome) => outcome.taskId);
  const taskCount = Math.max(requestedTaskCount, outcomes.length);
  const summary: AnalyticalTaskOutcomeSummaryV1 = {
    version: 1,
    status: successfulTaskIds.length === 0
      ? 'blocked'
      : failedTaskIds.length > 0 || dependencyBlockedTaskIds.length > 0 || successfulTaskIds.length < taskCount
        ? 'partial'
        : 'completed',
    trustState: leastTrustedTaskReceiptState(outcomes
      .filter((outcome) => outcome.status === 'completed' || outcome.status === 'partial')
      .map((outcome) => outcome.trustState ?? 'blocked')),
    taskCount,
    successfulTaskIds,
    failedTaskIds,
    dependencyBlockedTaskIds,
  };
  return {
    ...(outcomes.length > 0 ? { outcomes } : {}),
    summary,
  };
}

/**
 * A restart never turns an in-flight Ask into a completed parent answer, but
 * it must not erase a completed independent child whose canonical result was
 * checkpointed before the interruption. Keep only blocked diagnostics plus
 * artifact/result pairs proved by the V3 task receipt.
 */
function retainedInterruptedArtifacts(
  progress: AgentRunProgressV1,
  userCancelled: boolean,
): AgentRunArtifact[] {
  if (userCancelled) return progress.artifacts;
  const retainedIds = new Set(progress.artifacts
    .filter((artifact) => artifact.trustState === 'blocked')
    .map((artifact) => artifact.id));
  for (const outcome of progress.analyticalTaskOutcomes ?? []) {
    if ((outcome.status !== 'completed' && outcome.status !== 'partial') || !outcome.resultFingerprint) continue;
    const step = progress.steps.find((candidate) => candidate.askAnalystTaskId === outcome.taskId);
    const artifact = step?.artifacts.find((candidate) =>
      canonicalTaskResultProofForArtifact(candidate)?.resultFingerprint === outcome.resultFingerprint);
    if (artifact) retainedIds.add(artifact.id);
  }
  return progress.artifacts.filter((artifact) => retainedIds.has(artifact.id));
}

function isAgentRunRecord(value: unknown): value is AgentRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.question === 'string'
    && typeof record.route === 'string'
    && typeof record.status === 'string'
    && typeof record.completedAt === 'string'
    && Array.isArray(record.events)
    && Array.isArray(record.artifacts)
    && Array.isArray(record.evaluations);
}

function isAgentRunProgressRecord(value: unknown): value is AgentRunProgressV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const lifecycle = record.lifecycle;
  return record.version === 1
    && typeof record.id === 'string'
    && typeof record.question === 'string'
    && Boolean(lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle))
    && (lifecycle as Record<string, unknown>).state !== 'terminal'
    && Array.isArray(record.events)
    && Array.isArray(record.artifacts)
    && Array.isArray(record.evaluations);
}
