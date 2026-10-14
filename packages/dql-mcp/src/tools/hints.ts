/**
 * MCP tools for scoped correction memory ("mini Hint Graph").
 *
 * `record_correction` — capture a Tier-2 correction as a Git trace + candidate
 *                       hint (NOT used until approved).
 * `approve_hint`      — human review: approve/reject a candidate hint. Approval
 *                       is the only path that makes a hint usable in retrieval.
 * `list_hints`        — list hints (optionally filtered by status) for review.
 *
 * Source of truth is Git (`.dql/hints`, `.dql/traces`, `.dql/reviews`); SQLite
 * (`.dql/cache/agent-kg.sqlite`) is reindexed automatically on every write.
 */

import type { DQLContext } from '../context.js';
import {
  getHintFromGit,
  listHintsFromGit,
  recordGovernedCorrection,
  reviewGovernedHint,
  type Hint,
  type HintLesson,
} from '@zlens/agent';
import { zodInputShapeForTool } from '../tool-schema.js';

export const recordCorrectionInput = zodInputShapeForTool('record_correction');

export async function recordCorrection(
  ctx: DQLContext,
  args: {
    question: string;
    wrongAnswer: string;
    correction: string;
    scope: {
      metric?: string;
      dbtModel?: string;
      domain?: string;
      dialect?: string;
      term?: string;
      block?: string;
    };
    rationale?: string;
    author?: string;
    correctedSql?: string;
    hintTitle?: string;
    hintGuidance?: string;
    lesson?: Partial<HintLesson>;
    tags?: string[];
    anchorObjectKey?: string;
  },
) {
  const { trace, hint } = await recordGovernedCorrection(ctx.projectRoot, {
    question: args.question,
    scope: args.scope,
    wrongAnswer: args.wrongAnswer,
    correction: args.correction,
    rationale: args.rationale,
    author: args.author,
    correctedSql: args.correctedSql,
    hintTitle: args.hintTitle,
    hintGuidance: args.hintGuidance,
    lesson: args.lesson,
    tags: args.tags,
    anchorObjectKey: args.anchorObjectKey,
    failedRoute: 'mcp_generated_answer',
  });
  return {
    ok: true,
    traceId: trace.id,
    hintId: hint.id,
    status: hint.status,
    note:
      'Recorded as a CANDIDATE hint. It is NOT used in answers until approved via `approve_hint`. ' +
      'Both the trace and hint are written under .dql/ and should be committed to Git.',
    hint: summarizeHint(hint),
  };
}

export const approveHintInput = zodInputShapeForTool('approve_hint');

export async function approveHint(
  ctx: DQLContext,
  args: { hintId: string; decision: 'approved' | 'rejected'; reviewer: string; note?: string },
) {
  const existing = getHintFromGit(ctx.projectRoot, args.hintId);
  if (!existing) {
    return { ok: false, error: `Hint ${args.hintId} not found under .dql/hints/.` };
  }
  let result;
  try {
    result = await reviewGovernedHint(ctx.projectRoot, {
      hintId: args.hintId,
      decision: args.decision,
      reviewer: args.reviewer,
      note: args.note,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: getHintFromGit(ctx.projectRoot, args.hintId)?.status ?? existing.status,
    };
  }
  if (!result) {
    return { ok: false, error: `Could not review hint ${args.hintId}.` };
  }
  return {
    ok: true,
    hintId: result.hint.id,
    status: result.hint.status,
    reviewId: result.review.id,
    note:
      result.hint.status === 'approved'
        ? 'Approved. This scoped hint will now be folded into matching Tier-2 drafts (after certified routing). Commit the updated .dql/ files to Git.'
        : 'Rejected. This hint will not be used. Commit the updated .dql/ files to Git.',
    hint: summarizeHint(result.hint),
  };
}

export const listHintsInput = zodInputShapeForTool('list_hints');

/** API-003: MCP exposes the same persisted lifecycle statuses as CLI/notebook. */
export function listHints(
  ctx: DQLContext,
  args: { status?: 'candidate' | 'approved' | 'rejected' | 'retired'; domain?: string; metric?: string },
) {
  let hints = listHintsFromGit(ctx.projectRoot);
  if (args.status) hints = hints.filter((hint) => hint.status === args.status);
  if (args.domain) hints = hints.filter((hint) => eq(hint.scope.domain, args.domain));
  if (args.metric) hints = hints.filter((hint) => eq(hint.scope.metric, args.metric));
  return {
    count: hints.length,
    hints: hints.map(summarizeHint),
  };
}

function summarizeHint(hint: Hint) {
  return {
    id: hint.id,
    title: hint.title,
    status: hint.status,
    guidance: hint.guidance,
    lesson: hint.lesson,
    scope: hint.scope,
    correctedSql: hint.correctedSql,
    traceId: hint.traceId,
    author: hint.author,
    reviewer: hint.reviewer,
    updatedAt: hint.updatedAt,
  };
}

function eq(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
