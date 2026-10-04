/**
 * Git-authoritative store for scoped correction memory.
 *
 * Files (the source of truth, consistent with DQL):
 *   - `.dql/traces/<id>.trace.json`  — correction traces
 *   - `.dql/hints/<id>.hint.yaml`     — candidate / approved / rejected / retired hints
 *   - `.dql/evaluations/<id>.hint-evaluation.yaml` — required evaluation results
 *   - `.dql/reviews/<id>.review.yaml` — human review decisions
 *
 * `.dql/cache/agent-kg.sqlite` is a rebuildable index (see {@link HintStore}).
 *
 * The lifecycle:
 *   recordCorrectionTrace() → derives a `candidate` hint
 *   evaluateHint() → writes a passed/failed Git evaluation against the trace snapshot
 *   reviewHint('approved') → requires a passing evaluation in dbt-first v3,
 *                            flips status, writes the review, and reindexes SQLite
 * Approved-only is enforced at retrieval; nothing here auto-applies a hint.
 */

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import * as yaml from 'js-yaml';
import { loadProjectConfig } from '@duckcodeailabs/dql-core';
import { HintStore } from './store.js';
import type {
  CorrectionTrace,
  Hint,
  HintEvaluation,
  HintEvaluationCheck,
  HintDependency,
  HintLifecycleFailure,
  HintLesson,
  HintReview,
  HintScope,
} from './types.js';
import { deriveHintLesson, normalizeHintLesson } from './lesson.js';

const TRACES_DIR = ['.dql', 'traces'];
const HINTS_DIR = ['.dql', 'hints'];
const EVALUATIONS_DIR = ['.dql', 'evaluations'];
const REVIEWS_DIR = ['.dql', 'reviews'];
const HINT_INDEX_PROJECTION_VERSION = 'hint-graph-v2-lessons';

export function tracesDir(projectRoot: string): string {
  return join(projectRoot, ...TRACES_DIR);
}
export function hintsDir(projectRoot: string): string {
  return join(projectRoot, ...HINTS_DIR);
}
export function evaluationsDir(projectRoot: string): string {
  return join(projectRoot, ...EVALUATIONS_DIR);
}
export function reviewsDir(projectRoot: string): string {
  return join(projectRoot, ...REVIEWS_DIR);
}

export function defaultHintIndexPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'cache', 'agent-kg.sqlite');
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// --- Traces -----------------------------------------------------------------

export interface RecordCorrectionTraceInput {
  question: string;
  scope: HintScope;
  wrongAnswer: string;
  correction: string;
  rationale?: string;
  author?: string;
  anchorObjectKey?: string;
  /** Failed governed route/tool path. Required by dbt-first manifest v3. */
  failedRoute?: string;
  /** Reviewable evidence supporting the proposed correction. Required by v3. */
  evidence?: string[];
  /** Immutable project snapshot for this correction. Required by v3. */
  snapshotId?: string;
  /** Stable evaluation name that must pass before approval. Required by v3. */
  requiredEvaluation?: string;
  /** Exact governed inputs used to validate the correction. */
  dependencies?: HintDependency[];
  /** Fail-closed validation problems retained with the candidate. */
  lifecycleErrors?: HintLifecycleFailure[];
  /** Override the derived candidate hint's title. */
  hintTitle?: string;
  /** Override the derived candidate hint's guidance (defaults to the correction). */
  hintGuidance?: string;
  /** Structured reusable experience. New writers keep its rule aligned to guidance. */
  lesson?: Partial<HintLesson>;
  correctedSql?: string;
  tags?: string[];
}

export interface RecordCorrectionTraceResult {
  trace: CorrectionTrace;
  hint: Hint;
}

/** An id DQL made (`trace_…`, `hint_…`): one file name in its folder, never a path. */
function fileId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id) || id.includes('..')) throw new Error('Not an id DQL made.');
  return id;
}

export function correctionTraceFilePath(projectRoot: string, traceId: string): string {
  return join(tracesDir(projectRoot), `${fileId(traceId)}.trace.json`);
}

export function getCorrectionTraceFromGit(projectRoot: string, traceId: string): CorrectionTrace | null {
  let path: string;
  try { path = correctionTraceFilePath(projectRoot, traceId); } catch { return null; }
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as CorrectionTrace;
    return raw && raw.id === traceId ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Record a Tier-2 correction as a Git trace + a derived **candidate** hint.
 * The hint is NOT usable until reviewed/approved.
 */
export function recordCorrectionTrace(
  projectRoot: string,
  input: RecordCorrectionTraceInput,
): RecordCorrectionTraceResult {
  if (requiresEvaluatedApproval(projectRoot)) {
    const missing = [
      !strOrUndef(input.failedRoute) ? 'failedRoute' : undefined,
      cleanStringList(input.evidence).length === 0 ? 'evidence' : undefined,
      !strOrUndef(input.snapshotId) ? 'snapshotId' : undefined,
      !strOrUndef(input.requiredEvaluation) ? 'requiredEvaluation' : undefined,
    ].filter((item): item is string => Boolean(item));
    if (missing.length > 0) {
      throw new HintLifecycleError(
        'HINT_CORRECTION_EVIDENCE_REQUIRED',
        `dbt-first manifest v3 corrections require ${missing.join(', ')}.`,
      );
    }
  }
  const traceId = genId('trace');
  const hintId = genId('hint');
  const createdAt = nowIso();
  const guidance = (input.hintGuidance ?? input.correction).trim();
  const lesson = deriveHintLesson({
    question: input.question,
    wrongAnswer: input.wrongAnswer,
    correctedSql: input.correctedSql,
    guidance,
    lesson: input.lesson,
  });

  const trace: CorrectionTrace = {
    id: traceId,
    createdAt,
    question: input.question,
    scope: cleanScope(input.scope),
    wrongAnswer: input.wrongAnswer,
    correction: input.correction,
    lesson,
    rationale: input.rationale,
    author: input.author,
    anchorObjectKey: input.anchorObjectKey,
    failedRoute: strOrUndef(input.failedRoute),
    evidence: cleanStringList(input.evidence),
    snapshotId: strOrUndef(input.snapshotId),
    requiredEvaluation: strOrUndef(input.requiredEvaluation),
    dependencies: cleanDependencies(input.dependencies),
    lifecycleErrors: cleanLifecycleErrors(input.lifecycleErrors),
    derivedHintId: hintId,
  };

  const hint: Hint = {
    id: hintId,
    title: input.hintTitle?.trim() || deriveTitle(input.question, input.scope),
    guidance: lesson.rule,
    lesson,
    scope: cleanScope(input.scope),
    status: 'candidate',
    traceId,
    correctedSql: input.correctedSql,
    tags: input.tags,
    author: input.author,
    snapshotId: strOrUndef(input.snapshotId),
    requiredEvaluation: strOrUndef(input.requiredEvaluation),
    dependencies: cleanDependencies(input.dependencies),
    lifecycleErrors: cleanLifecycleErrors(input.lifecycleErrors),
    createdAt,
    updatedAt: createdAt,
  };

  mkdirSync(tracesDir(projectRoot), { recursive: true });
  mkdirSync(hintsDir(projectRoot), { recursive: true });
  writeFileSync(
    join(tracesDir(projectRoot), `${traceId}.trace.json`),
    `${JSON.stringify(trace, null, 2)}\n`,
    'utf-8',
  );
  writeHintFile(projectRoot, hint);

  // Index the candidate so review/dev mode can find it (status gate keeps it out
  // of normal retrieval).
  reindexHints(projectRoot);
  return { trace, hint };
}

// --- Hints ------------------------------------------------------------------

export function hintFilePath(projectRoot: string, hintId: string): string {
  return join(hintsDir(projectRoot), `${fileId(hintId)}.hint.yaml`);
}

export function writeHintFile(projectRoot: string, hint: Hint): void {
  mkdirSync(hintsDir(projectRoot), { recursive: true });
  const doc = {
    id: hint.id,
    title: hint.title,
    guidance: hint.guidance,
    lesson: hint.lesson,
    status: hint.status,
    scope: cleanScope(hint.scope),
    traceId: hint.traceId,
    correctedSql: hint.correctedSql,
    tags: hint.tags,
    author: hint.author,
    reviewer: hint.reviewer,
    snapshotId: hint.snapshotId,
    requiredEvaluation: hint.requiredEvaluation,
    evaluationId: hint.evaluationId,
    evaluationStatus: hint.evaluationStatus,
    dependencies: hint.dependencies,
    lifecycleErrors: hint.lifecycleErrors,
    supersedes: hint.supersedes,
    createdAt: hint.createdAt,
    updatedAt: hint.updatedAt,
  };
  writeFileSync(
    hintFilePath(projectRoot, hint.id),
    yaml.dump(stripUndefined(doc), { lineWidth: 100, noRefs: true }),
    'utf-8',
  );
}

export function readHintFile(path: string, sourcePath?: string): Hint | null {
  try {
    const raw = yaml.load(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return null;
    const scope = (raw.scope ?? {}) as Record<string, unknown>;
    const hint: Hint & { sourcePath?: string } = {
      id: String(raw.id ?? ''),
      title: String(raw.title ?? ''),
      guidance: String(raw.guidance ?? ''),
      lesson: lessonFromRaw(raw.lesson, String(raw.guidance ?? '')),
      status: (raw.status as Hint['status']) ?? 'candidate',
      scope: {
        metric: strOrUndef(scope.metric),
        dbtModel: strOrUndef(scope.dbtModel),
        domain: strOrUndef(scope.domain),
        dialect: strOrUndef(scope.dialect),
        term: strOrUndef(scope.term),
        block: strOrUndef(scope.block),
      },
      traceId: strOrUndef(raw.traceId),
      correctedSql: strOrUndef(raw.correctedSql),
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
      author: strOrUndef(raw.author),
      reviewer: strOrUndef(raw.reviewer),
      snapshotId: strOrUndef(raw.snapshotId),
      requiredEvaluation: strOrUndef(raw.requiredEvaluation),
      evaluationId: strOrUndef(raw.evaluationId),
      evaluationStatus: raw.evaluationStatus === 'passed' ? 'passed' : raw.evaluationStatus === 'failed' ? 'failed' : undefined,
      dependencies: cleanDependencies(raw.dependencies),
      lifecycleErrors: cleanLifecycleErrors(raw.lifecycleErrors),
      supersedes: strOrUndef(raw.supersedes),
      createdAt: String(raw.createdAt ?? nowIso()),
      updatedAt: String(raw.updatedAt ?? nowIso()),
      sourcePath,
    };
    if (!hint.id) return null;
    return hint;
  } catch {
    return null;
  }
}

export function listHintsFromGit(projectRoot: string): Hint[] {
  const dir = hintsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const hints: Hint[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.hint.yaml')) continue;
    const path = join(dir, file);
    const hint = readHintFile(path, path);
    if (hint) hints.push(hint);
  }
  return hints.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getHintFromGit(projectRoot: string, hintId: string): Hint | null {
  let path: string;
  try { path = hintFilePath(projectRoot, hintId); } catch { return null; }
  return existsSync(path) ? readHintFile(path, path) : null;
}

// --- Evaluations ------------------------------------------------------------

export class HintLifecycleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HintLifecycleError';
  }
}

export interface EvaluateHintInput {
  hintId: string;
  snapshotId: string;
  evaluation: string;
  evaluator: string;
  checks: HintEvaluationCheck[];
  evidence: string[];
  note?: string;
}

export interface EvaluateHintResult {
  hint: Hint;
  evaluation: HintEvaluation;
}

export function hintEvaluationFilePath(projectRoot: string, evaluationId: string): string {
  return join(evaluationsDir(projectRoot), `${evaluationId}.hint-evaluation.yaml`);
}

/** Record a deterministic required evaluation. Overall status is derived from every check. */
export function evaluateHint(projectRoot: string, input: EvaluateHintInput): EvaluateHintResult {
  const hint = getHintFromGit(projectRoot, input.hintId);
  if (!hint) throw new HintLifecycleError('HINT_NOT_FOUND', `Hint ${input.hintId} was not found.`);
  if (hint.status !== 'candidate') {
    throw new HintLifecycleError('HINT_NOT_CANDIDATE', `Hint ${input.hintId} is ${hint.status}; only candidates can be evaluated.`);
  }

  const snapshotId = strOrUndef(input.snapshotId);
  if (!snapshotId || !hint.snapshotId || snapshotId !== hint.snapshotId) {
    throw new HintLifecycleError(
      'HINT_SNAPSHOT_MISMATCH',
      `Hint ${input.hintId} was recorded against snapshot ${hint.snapshotId ?? 'unknown'}, not ${snapshotId ?? 'unknown'}. Refresh and evaluate the original correction snapshot.`,
    );
  }
  const evaluationName = strOrUndef(input.evaluation);
  if (!evaluationName || !hint.requiredEvaluation || evaluationName !== hint.requiredEvaluation) {
    throw new HintLifecycleError(
      'HINT_EVALUATION_MISMATCH',
      `Hint ${input.hintId} requires evaluation ${hint.requiredEvaluation ?? 'unknown'}, not ${evaluationName ?? 'unknown'}.`,
    );
  }
  const checks = cleanEvaluationChecks(input.checks);
  const evidence = cleanStringList(input.evidence);
  if (checks.length === 0 || evidence.length === 0) {
    throw new HintLifecycleError('HINT_EVALUATION_EVIDENCE_REQUIRED', 'Hint evaluation requires at least one check and one evidence reference.');
  }

  const evaluationId = genId('hint_eval');
  const createdAt = nowIso();
  const evaluation: HintEvaluation = {
    id: evaluationId,
    hintId: hint.id,
    traceId: hint.traceId,
    snapshotId,
    evaluation: evaluationName,
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks,
    evidence,
    evaluator: input.evaluator.trim(),
    note: strOrUndef(input.note),
    createdAt,
  };
  if (!evaluation.evaluator) {
    throw new HintLifecycleError('HINT_EVALUATOR_REQUIRED', 'Hint evaluation requires an evaluator.');
  }

  mkdirSync(evaluationsDir(projectRoot), { recursive: true });
  writeFileSync(
    hintEvaluationFilePath(projectRoot, evaluationId),
    yaml.dump(stripUndefined({ ...evaluation }), { lineWidth: 100, noRefs: true }),
    'utf-8',
  );
  const lifecycleErrors = evaluation.status === 'failed'
    ? appendLifecycleError(hint.lifecycleErrors, {
        code: 'HINT_EVALUATION_FAILED',
        message: `Evaluation ${evaluation.id} failed: ${checks.filter((check) => !check.passed).map((check) => check.name).join(', ')}`,
        at: createdAt,
      })
    : [];
  const updated: Hint = {
    ...hint,
    evaluationId,
    evaluationStatus: evaluation.status,
    lifecycleErrors,
    updatedAt: createdAt,
  };
  writeHintFile(projectRoot, updated);
  reindexHints(projectRoot);
  return { hint: updated, evaluation };
}

export function readHintEvaluationFile(path: string): HintEvaluation | null {
  try {
    const raw = yaml.load(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return null;
    const rawChecks = Array.isArray(raw.checks) ? raw.checks : [];
    const evaluation: HintEvaluation = {
      id: String(raw.id ?? ''),
      hintId: String(raw.hintId ?? ''),
      traceId: strOrUndef(raw.traceId),
      snapshotId: String(raw.snapshotId ?? ''),
      evaluation: String(raw.evaluation ?? ''),
      status: raw.status === 'passed' ? 'passed' : 'failed',
      checks: cleanEvaluationChecks(rawChecks as HintEvaluationCheck[]),
      evidence: cleanStringList(raw.evidence),
      evaluator: String(raw.evaluator ?? ''),
      note: strOrUndef(raw.note),
      createdAt: String(raw.createdAt ?? ''),
    };
    if (!evaluation.id || !evaluation.hintId || !evaluation.snapshotId || !evaluation.evaluation || !evaluation.evaluator) return null;
    return evaluation;
  } catch {
    return null;
  }
}

export function getHintEvaluationFromGit(projectRoot: string, evaluationId: string): HintEvaluation | null {
  const path = hintEvaluationFilePath(projectRoot, evaluationId);
  return existsSync(path) ? readHintEvaluationFile(path) : null;
}

export function listHintEvaluationsFromGit(projectRoot: string, hintId?: string): HintEvaluation[] {
  const dir = evaluationsDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.hint-evaluation.yaml'))
    .map((file) => readHintEvaluationFile(join(dir, file)))
    .filter((item): item is HintEvaluation => Boolean(item) && (!hintId || item!.hintId === hintId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// --- Reviews ----------------------------------------------------------------

export interface ReviewHintInput {
  hintId: string;
  decision: 'approved' | 'rejected';
  reviewer: string;
  note?: string;
  /** Current immutable project snapshot. Required for v3 approval. */
  snapshotId?: string;
}

export interface ReviewHintResult {
  hint: Hint;
  review: HintReview;
}

export interface UpdateHintCandidateInput {
  hintId: string;
  title?: string;
  guidance?: string;
  lesson?: Partial<HintLesson>;
  correctedSql?: string;
  scope?: HintScope;
  snapshotId: string;
  dependencies: HintDependency[];
  lifecycleErrors: HintLifecycleFailure[];
}

export function updateHintCandidate(
  projectRoot: string,
  input: UpdateHintCandidateInput,
): Hint {
  const hint = getHintFromGit(projectRoot, input.hintId);
  if (!hint) throw new HintLifecycleError('HINT_NOT_FOUND', `Hint ${input.hintId} was not found.`);
  if (hint.status !== 'candidate') {
    throw new HintLifecycleError('HINT_NOT_CANDIDATE', `Hint ${input.hintId} is ${hint.status}; only candidates can be edited.`);
  }
  const title = input.title?.trim() || hint.title;
  const guidance = input.guidance?.trim() || input.lesson?.rule?.trim() || hint.guidance;
  const correctedSql = input.correctedSql?.trim() || hint.correctedSql;
  if (!title || !guidance) {
    throw new HintLifecycleError('HINT_CONTENT_REQUIRED', 'A candidate requires a title and guidance.');
  }
  const lesson = normalizeHintLesson(input.lesson ?? hint.lesson, {
    rule: guidance,
    category: hint.lesson?.category ?? 'semantic_rule',
    intentExamples: hint.lesson?.intentExamples ?? [],
  });
  lesson.rule = guidance;
  const updated: Hint = {
    ...hint,
    title,
    guidance: lesson.rule,
    lesson,
    correctedSql,
    scope: input.scope ? cleanScope(input.scope) : hint.scope,
    snapshotId: input.snapshotId,
    dependencies: cleanDependencies(input.dependencies),
    lifecycleErrors: cleanLifecycleErrors(input.lifecycleErrors),
    evaluationId: undefined,
    evaluationStatus: undefined,
    reviewer: undefined,
    updatedAt: nowIso(),
  };
  writeHintFile(projectRoot, updated);
  reindexHints(projectRoot);
  return updated;
}

/**
 * Approve or reject a candidate hint. Writes the review record, flips the hint
 * file's status, and reindexes SQLite. Approval is the ONLY path that makes a
 * hint usable in normal retrieval.
 */
export function reviewHint(projectRoot: string, input: ReviewHintInput): ReviewHintResult | null {
  const hint = getHintFromGit(projectRoot, input.hintId);
  if (!hint) return null;
  if (hint.status !== 'candidate') {
    throw new HintLifecycleError(
      'HINT_NOT_CANDIDATE',
      `Hint ${input.hintId} is ${hint.status}; only candidates can be reviewed.`,
    );
  }

  if (input.decision === 'approved' && requiresEvaluatedApproval(projectRoot)) {
    if (!input.snapshotId || !hint.snapshotId || input.snapshotId !== hint.snapshotId) {
      throw new HintLifecycleError(
        'HINT_SNAPSHOT_MISMATCH',
        `Hint ${hint.id} was recorded against snapshot ${hint.snapshotId ?? 'unknown'}, not ${input.snapshotId ?? 'unknown'}. Refresh before review.`,
      );
    }
    const evaluation = hint.evaluationId ? getHintEvaluationFromGit(projectRoot, hint.evaluationId) : null;
    if (!evaluation) {
      throw new HintLifecycleError('HINT_EVALUATION_REQUIRED', `Hint ${hint.id} cannot be approved before its required evaluation runs.`);
    }
    if (evaluation.status !== 'passed') {
      throw new HintLifecycleError('HINT_EVALUATION_FAILED', `Hint ${hint.id} cannot be approved because evaluation ${evaluation.id} failed.`);
    }
    if (evaluation.snapshotId !== input.snapshotId || evaluation.evaluation !== hint.requiredEvaluation) {
      throw new HintLifecycleError('HINT_EVALUATION_STALE', `Hint ${hint.id} evaluation does not match the current correction snapshot and required evaluation.`);
    }
  }

  const createdAt = nowIso();
  const review = writeHintReview(projectRoot, {
    hintId: input.hintId,
    decision: input.decision,
    reviewer: input.reviewer,
    note: input.note,
    createdAt,
  });

  const updated: Hint = {
    ...hint,
    status: input.decision,
    reviewer: input.reviewer,
    updatedAt: createdAt,
  };
  writeHintFile(projectRoot, updated);
  reindexHints(projectRoot);
  return { hint: updated, review };
}

export function retireHint(
  projectRoot: string,
  input: { hintId: string; reviewer: string; note?: string },
): ReviewHintResult {
  const hint = getHintFromGit(projectRoot, input.hintId);
  if (!hint) throw new HintLifecycleError('HINT_NOT_FOUND', `Hint ${input.hintId} was not found.`);
  if (hint.status === 'retired') {
    throw new HintLifecycleError('HINT_ALREADY_RETIRED', `Hint ${input.hintId} is already retired.`);
  }
  const createdAt = nowIso();
  const review = writeHintReview(projectRoot, {
    hintId: hint.id,
    decision: 'retired',
    reviewer: input.reviewer,
    note: input.note,
    createdAt,
  });
  const updated: Hint = {
    ...hint,
    status: 'retired',
    reviewer: input.reviewer,
    updatedAt: createdAt,
  };
  writeHintFile(projectRoot, updated);
  reindexHints(projectRoot);
  return { hint: updated, review };
}

export function reopenHint(
  projectRoot: string,
  input: {
    hintId: string;
    reviewer: string;
    note?: string;
    snapshotId: string;
    dependencies: HintDependency[];
    lifecycleErrors: HintLifecycleFailure[];
  },
): ReviewHintResult {
  const hint = getHintFromGit(projectRoot, input.hintId);
  if (!hint) throw new HintLifecycleError('HINT_NOT_FOUND', `Hint ${input.hintId} was not found.`);
  if (hint.status !== 'approved' && hint.status !== 'retired') {
    throw new HintLifecycleError(
      'HINT_REOPEN_NOT_ALLOWED',
      `Hint ${input.hintId} is ${hint.status}; only approved or retired hints can be reopened.`,
    );
  }
  const createdAt = nowIso();
  const review = writeHintReview(projectRoot, {
    hintId: hint.id,
    decision: 'reopened',
    reviewer: input.reviewer,
    note: input.note,
    createdAt,
  });
  const updated: Hint = {
    ...hint,
    status: 'candidate',
    reviewer: undefined,
    snapshotId: input.snapshotId,
    dependencies: cleanDependencies(input.dependencies),
    lifecycleErrors: cleanLifecycleErrors(input.lifecycleErrors),
    evaluationId: undefined,
    evaluationStatus: undefined,
    updatedAt: createdAt,
  };
  writeHintFile(projectRoot, updated);
  reindexHints(projectRoot);
  return { hint: updated, review };
}

export function supersedeHint(
  projectRoot: string,
  input: { hintId: string; targetHintId: string; reviewer: string; note?: string },
): ReviewHintResult {
  const hint = getHintFromGit(projectRoot, input.hintId);
  const target = getHintFromGit(projectRoot, input.targetHintId);
  if (!hint || !target) {
    throw new HintLifecycleError('HINT_NOT_FOUND', 'Both the authoritative and superseded hints must exist.');
  }
  if (hint.id === target.id || hint.status !== 'approved' || target.status !== 'approved') {
    throw new HintLifecycleError(
      'HINT_SUPERSEDE_NOT_ALLOWED',
      'Supersede resolution requires two different approved hints.',
    );
  }
  const createdAt = nowIso();
  const review = writeHintReview(projectRoot, {
    hintId: hint.id,
    targetHintId: target.id,
    decision: 'superseded',
    reviewer: input.reviewer,
    note: input.note,
    createdAt,
  });
  const updated: Hint = {
    ...hint,
    supersedes: target.id,
    reviewer: input.reviewer,
    updatedAt: createdAt,
  };
  writeHintFile(projectRoot, updated);
  reindexHints(projectRoot);
  return { hint: updated, review };
}

function writeHintReview(
  projectRoot: string,
  input: Omit<HintReview, 'id'>,
): HintReview {
  const review: HintReview = { id: genId('review'), ...input };
  mkdirSync(reviewsDir(projectRoot), { recursive: true });
  writeFileSync(
    join(reviewsDir(projectRoot), `${review.id}.review.yaml`),
    yaml.dump(stripUndefined({ ...review }), { lineWidth: 100, noRefs: true }),
    'utf-8',
  );
  return review;
}

// --- Index ------------------------------------------------------------------

export interface EnsureHintIndexFreshResult {
  hintCount: number;
  fingerprint: string;
  rebuilt: boolean;
}

/**
 * Content-address the Git-authoritative hint files together with the SQLite
 * projection version. File names and bytes are stable across clones; absolute
 * paths and filesystem timestamps are intentionally excluded.
 */
export function hintIndexProjectionFingerprint(projectRoot: string): string {
  const hash = createHash('sha256').update(HINT_INDEX_PROJECTION_VERSION).update('\0');
  const dir = hintsDir(projectRoot);
  if (!existsSync(dir)) return hash.digest('hex');
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.hint.yaml')).sort()) {
    hash.update(file).update('\0').update(readFileSync(join(dir, file), 'utf-8')).update('\0');
  }
  return hash.digest('hex');
}

/** Rebuild the SQLite hint index from the Git-authoritative files. */
export function reindexHints(projectRoot: string, indexPath = defaultHintIndexPath(projectRoot)): number {
  const hints = listHintsFromGit(projectRoot);
  const fingerprint = hintIndexProjectionFingerprint(projectRoot);
  const store = new HintStore(indexPath);
  try {
    store.rebuild(hints, fingerprint);
    return hints.length;
  } finally {
    store.close();
  }
}

/**
 * Bootstrap or refresh the local hint projection only when Git data or the
 * projection schema changed. Safe to call whenever an OSS project is opened.
 */
export function ensureHintIndexFresh(
  projectRoot: string,
  indexPath = defaultHintIndexPath(projectRoot),
): EnsureHintIndexFreshResult {
  const hints = listHintsFromGit(projectRoot);
  const fingerprint = hintIndexProjectionFingerprint(projectRoot);
  const store = new HintStore(indexPath);
  try {
    if (store.projectionFingerprint() === fingerprint) {
      return { hintCount: hints.length, fingerprint, rebuilt: false };
    }
    store.rebuild(hints, fingerprint);
    return { hintCount: hints.length, fingerprint, rebuilt: true };
  } finally {
    store.close();
  }
}

// --- helpers ----------------------------------------------------------------

function deriveTitle(question: string, scope: HintScope): string {
  const scopeBits = [scope.metric, scope.dbtModel, scope.domain].filter(Boolean).join('/');
  const q = question.trim().replace(/\s+/g, ' ').slice(0, 60);
  return scopeBits ? `Correction for ${scopeBits}: ${q}` : `Correction: ${q}`;
}

function cleanScope(scope: HintScope): HintScope {
  return {
    metric: strOrUndef(scope.metric),
    dbtModel: strOrUndef(scope.dbtModel),
    domain: strOrUndef(scope.domain),
    dialect: strOrUndef(scope.dialect),
    term: strOrUndef(scope.term),
    block: strOrUndef(scope.block),
  };
}

function strOrUndef(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim();
  return str.length > 0 ? str : undefined;
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function cleanEvaluationChecks(value: HintEvaluationCheck[]): HintEvaluationCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((check) => {
    if (!check || typeof check !== 'object') return [];
    const name = strOrUndef(check.name);
    if (!name || typeof check.passed !== 'boolean') return [];
    return [{ name, passed: check.passed, evidence: strOrUndef(check.evidence) }];
  });
}

export function requiresEvaluatedApproval(projectRoot: string): boolean {
  try {
    const config = loadProjectConfig(projectRoot) as { manifestVersion?: number; modeling?: { mode?: string } };
    const mode = config.modeling?.mode;
    return config.manifestVersion === 3 && (mode === 'dbt-first' || mode === 'warehouse-first' || mode === 'hybrid');
  } catch {
    return false;
  }
}

function cleanDependencies(value: unknown): HintDependency[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, HintDependency>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = strOrUndef(item.id);
    const name = strOrUndef(item.name);
    const fingerprint = strOrUndef(item.fingerprint);
    const kind = strOrUndef(item.kind) as HintDependency['kind'] | undefined;
    if (!id || !name || !fingerprint || !kind) continue;
    if (!['relation', 'dbt_model', 'metric', 'domain', 'term', 'block', 'semantic'].includes(kind)) continue;
    byId.set(id, {
      id,
      kind,
      name,
      fingerprint,
      sourcePath: strOrUndef(item.sourcePath),
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function cleanLifecycleErrors(value: unknown): HintLifecycleFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const code = strOrUndef(item.code);
    const message = strOrUndef(item.message);
    const at = strOrUndef(item.at);
    return code && message && at ? [{ code, message, at }] : [];
  }).slice(-20);
}

function appendLifecycleError(
  existing: HintLifecycleFailure[] | undefined,
  next: HintLifecycleFailure,
): HintLifecycleFailure[] {
  return [...(existing ?? []), next].slice(-20);
}

function lessonFromRaw(raw: unknown, guidance: string): HintLesson | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  try {
    return normalizeHintLesson(raw as Partial<HintLesson>, {
      rule: guidance,
      category: 'semantic_rule',
      intentExamples: [],
    });
  } catch {
    return undefined;
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = stripUndefined(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) (out as Record<string, unknown>)[key] = nested;
      continue;
    }
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
