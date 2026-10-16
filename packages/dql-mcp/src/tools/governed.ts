import { askScopeFromWorkspace, workspaceContextForScope } from '@zlens/agent';
import type { DQLContext } from '../context.js';
import { readEnv } from '@zlens/core';

/**
 * Governed-generation MCP tools. Unlike the BYOSQL Tier-2 tool
 * (`query_via_metadata`, where the CALLING agent authors the SQL), these run
 * DQL's OWN governed engines end-to-end and return the executed answer / block
 * draft — the SAME cascade the web UI uses, so every trust guard (honesty gate,
 * hollow-answer handling, forced-join retry, deterministic refusal) applies
 * automatically. They are thin proxies to the local runtime's governed HTTP
 * endpoints (`/api/agent-runs`, `/api/ai/build`), which already own the LLM
 * provider + warehouse executors, so there is no second provider to configure.
 *
 * Both require the ZLens runtime to be running (the workbench `zlens notebook`
 * starts) because governed
 * answering/building executes SQL against the warehouse.
 */

const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:3474';

function runtimeBase(serverUrl?: string): string {
  return (serverUrl ?? readEnv('ZLENS_RUNTIME_URL') ?? DEFAULT_RUNTIME_URL).replace(/\/$/, '');
}

function runtimeUnavailable(base: string, projectRoot: string, err: unknown) {
  return {
    ok: false as const,
    runtimeUnavailable: true as const,
    error:
      `Could not reach the ZLens runtime at ${base}. Governed answering/building needs it running — ` +
      `start the workbench with \`zlens notebook\` in ${projectRoot} (\`npm run notebook\` in a create-zlens-app project), or pass serverUrl, then retry. ` +
      `(${err instanceof Error ? err.message : String(err)})`,
  };
}

interface AgentAnswerPayload {
  answer?: string;
  text?: string;
  proposedSql?: string;
  sql?: string;
  result?: { columns?: unknown[]; rows?: unknown[]; rowCount?: number };
  executionError?: string;
  dqlArtifact?: unknown;
  draftBlockId?: string;
  draftBlock?: { path?: string };
  promoteCommand?: string;
  citations?: unknown[];
  validationWarnings?: string[];
  trustLabel?: string;
}

interface AgentRunLike {
  id?: string;
  question?: string;
  route?: string;
  status?: string;
  trustState?: string;
  answerKind?: string;
  answer?: string;
  summary?: string;
  artifacts?: Array<{ id?: string; kind?: string; title?: string; trustState?: string; ref?: string; payload?: unknown }>;
  nextActions?: unknown[];
  /** The Ask pipeline receipt; its context ledger says what the answer was read against. */
  diagnosticReceiptV9?: { context?: unknown };
  /** The draft a review-required answer left for review (graduated trust, Tier 2). */
  reviewDraft?: { path: string; status: 'draft'; askedTimes: number; created: boolean };
}

/** Reshape a runtime AgentRun into a compact, agent-friendly governed result. */
type InvestigationLike = {
  headline?: { text?: string; verdict?: string };
  drivers?: Array<{ path?: Array<{ dimension?: { label?: string }; member?: { label?: string } }>; prior?: { value?: string }; current?: { value?: string }; share?: string; verdict?: string }>;
  ruledOut?: Array<{ dimension?: { label?: string } }>;
  notInvestigated?: Array<{ dimension?: { label?: string }; reason?: string }>;
  caveats?: Array<{ text?: string }>;
  confidence?: { level?: string; reasons?: string[] };
};

/**
 * A Research investigation, compact: the headline, the drivers with their
 * share of the change, what was ruled out and not broken down, the caveats and
 * the confidence. Figures only; the rows stay in the run.
 */
function investigationSummary(run: AgentRunLike) {
  const research = (run.artifacts ?? []).find((artifact) => artifact?.kind === 'research_run');
  const payload = research?.payload as { kind?: string; investigation?: InvestigationLike } | undefined;
  const investigation = payload?.kind === 'investigation' ? payload.investigation : undefined;
  if (!investigation) return undefined;
  return {
    headline: investigation.headline?.text,
    verdict: investigation.headline?.verdict,
    drivers: (investigation.drivers ?? []).slice(0, 10).map((driver) => ({
      path: (driver.path ?? []).map((step) => `${step.dimension?.label ?? 'dimension'}: ${step.member?.label ?? ''}`).join(' › '),
      prior: driver.prior?.value,
      current: driver.current?.value,
      share: driver.share,
      verdict: driver.verdict,
    })),
    ruledOut: (investigation.ruledOut ?? []).map((entry) => entry.dimension?.label).filter(Boolean),
    notInvestigated: (investigation.notInvestigated ?? []).map((entry) => ({ dimension: entry.dimension?.label, reason: entry.reason })),
    caveats: (investigation.caveats ?? []).map((caveat) => caveat.text).filter(Boolean),
    confidence: investigation.confidence,
  };
}

function mapRun(run: AgentRunLike) {
  const primary = (run.artifacts ?? [])[0];
  const p = (primary?.kind === 'answer' ? primary.payload : undefined) as AgentAnswerPayload | undefined;
  const investigation = investigationSummary(run);
  return {
    ok: true as const,
    question: run.question,
    route: run.route,
    status: run.status,
    // Canonical trust — report VERBATIM. Generated/semantic answers are
    // review-required, never certified.
    trustState: run.trustState,
    answerKind: run.answerKind,
    answer: run.answer ?? run.summary,
    summary: run.summary,
    ...(p
      ? {
          sql: p.proposedSql ?? p.sql,
          result: p.result,
          rowCount: p.result?.rowCount,
          dqlArtifact: p.dqlArtifact,
          draftBlockPath: run.reviewDraft?.path ?? p.draftBlockId ?? p.draftBlock?.path,
          promote: p.promoteCommand ?? (run.reviewDraft?.path ? `zlens certify --from-draft ${run.reviewDraft.path} --owner <you>` : undefined),
          citations: p.citations,
          validationWarnings: p.validationWarnings,
          executionError: p.executionError,
        }
      : {}),
    artifacts: run.artifacts,
    nextActions: run.nextActions,
    // The context ledger (CTX-010): envelope, what was admitted, rendered,
    // selected, enforced and used — ids and counts, never rows.
    ...(run.diagnosticReceiptV9?.context ? { context: run.diagnosticReceiptV9.context } : {}),
    ...(investigation ? { investigation } : {}),
    ...(run.reviewDraft ? { reviewDraft: run.reviewDraft } : {}),
    trustNote:
      'Report trustState verbatim and never upgrade it. A review-required answer is generated/semantic-layer backed and must be reviewed before it is trusted as certified.',
  };
}

export async function answerQuestion(
  ctx: DQLContext,
  args: {
    question: string;
    audience?: 'analyst' | 'stakeholder';
    requestedMode?: 'auto' | 'ask' | 'research';
    reasoningEffort?: 'low' | 'medium' | 'high';
    analysisDepth?: 'quick' | 'deep';
    threadId?: string;
    serverUrl?: string;
    domain?: string;
    purpose?: string;
    modelAreaId?: string;
    skillRefs?: string[];
  },
) {
  const question = args.question?.trim();
  if (!question) return { ok: false as const, error: 'Provide a non-empty { question }.' };
  const base = runtimeBase(args.serverUrl);
  // The same four selections the notebook sends (CTX-001); the runtime
  // resolves them into an envelope, this client never does.
  const workspaceContext = workspaceContextForScope(askScopeFromWorkspace(args));
  let response: Response;
  try {
    response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        requestedMode: args.requestedMode ?? 'auto',
        ...(args.audience ? { audience: args.audience } : {}),
        ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
        ...(args.analysisDepth ? { analysisDepth: args.analysisDepth } : {}),
        ...(args.threadId ? { threadId: args.threadId } : {}),
        ...(Object.keys(workspaceContext).length ? { workspaceContext } : {}),
      }),
    });
  } catch (err) {
    return runtimeUnavailable(base, ctx.projectRoot, err);
  }
  if (!response.ok) {
    return { ok: false as const, error: `ZLens runtime returned ${response.status}: ${await response.text()}` };
  }
  const payload = (await response.json().catch(() => ({}))) as { run?: AgentRunLike; error?: string };
  if (payload.error || !payload.run) return { ok: false as const, error: payload.error ?? 'No run returned by the runtime.' };
  return mapRun(payload.run);
}

interface BuildFromPromptResultLike {
  status?: string;
  route?: unknown;
  draftBlock?: { path?: string; slug?: string; name?: string; domain?: string; status?: string; askedTimes?: number };
  dqlArtifact?: unknown;
  verdict?: unknown;
  appliedSkills?: unknown[];
  citations?: unknown[];
  sql?: string;
  explanation?: string;
  error?: string;
}

export async function buildBlockFromPrompt(
  ctx: DQLContext,
  args: {
    prompt: string;
    mode?: 'create' | 'edit';
    blockPath?: string;
    owner?: string;
    serverUrl?: string;
  },
) {
  const prompt = args.prompt?.trim();
  if (!prompt) return { ok: false as const, error: 'Provide a non-empty { prompt } describing the block to build.' };
  const mode = args.mode === 'edit' ? 'edit' : 'create';
  if (mode === 'edit' && !args.blockPath?.trim()) {
    return { ok: false as const, error: 'Edit mode requires { blockPath } (the block to modify in place).' };
  }
  const base = runtimeBase(args.serverUrl);
  let response: Response;
  try {
    response = await fetch(`${base}/api/ai/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        target: 'block',
        mode,
        ...(args.blockPath ? { blockPath: args.blockPath.trim() } : {}),
        ...(args.owner ? { owner: args.owner } : {}),
      }),
    });
  } catch (err) {
    return runtimeUnavailable(base, ctx.projectRoot, err);
  }
  if (!response.ok) {
    return { ok: false as const, error: `ZLens runtime returned ${response.status}: ${await response.text()}` };
  }
  const result = (await response.json().catch(() => ({}))) as BuildFromPromptResultLike;
  if (result.error) return { ok: false as const, error: result.error };
  // Refresh the in-process context so subsequent tool calls see the new draft.
  ctx.refresh();
  return {
    ok: true as const,
    status: result.status,
    route: result.route,
    draftBlock: result.draftBlock,
    draftBlockPath: result.draftBlock?.path,
    dqlArtifact: result.dqlArtifact,
    verdict: result.verdict,
    appliedSkills: result.appliedSkills,
    citations: result.citations,
    promote: result.draftBlock?.path ? `zlens certify --from-draft ${result.draftBlock.path}` : undefined,
    trustNote:
      'AI drafts, humans certify. This is a review-required DRAFT — never present it as certified. Review the verdict, then certify explicitly.',
  };
}
