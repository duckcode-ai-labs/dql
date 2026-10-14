/** @deprecated Superseded by the Ask pipeline (`ask-pipeline/pipeline.ts`); kept one release as a public export with no runtime consumer, removed in the next. */
import type { AdmittedIdentifier } from './identifier-ledger.js';
import { createAgenticSqlExecutionCapability } from './sql-authorization.js';
/**
 * The analyst loop — explore, then compose, with provenance enforced.
 *
 * This is the handler the strangler seam has been holding a slot for. It runs
 * the governed tools, harvests every identifier a tool actually returned, and
 * refuses to execute SQL naming anything it did not observe. A violation comes
 * back as a CORRECTION with the nearest observed name and one bounded retry —
 * not a refusal, which is what the legacy pipeline turned it into.
 *
 * It is deliberately small. The legacy loop earned its 10k lines by owning
 * retrieval, certified matching, semantic compilation, narration, and trust
 * labelling; re-implementing any of that here would fork behaviour that already
 * works. This owns exactly one thing the old path cannot do: notice that a
 * proposed identifier was never observed, and say which real one was meant.
 */
import type { AgentAnswer, AnswerLoopInput } from '../answer-loop.js';
import type { AgentToolDefinition, ProviderToolLoopOptions } from '../providers/types.js';
import type { AnalystTurnPlan } from './turn-plan.js';
import { runAgenticToolLoopDetailed, type TextToolLoopResult } from './tool-loop.js';
import { IdentifierLedger } from './identifier-ledger.js';
import { ANALYST_TOOL_POLICY, adjudicateProposedSql, withLedgerHarvest } from './ledger-tools.js';
import { readEnv } from '@zlens/core';

/** One observable step, so the wait is legible instead of a spinner. */
export interface AnalystStep {
  kind: 'plan' | 'tool' | 'observe' | 'verify' | 'answer';
  label: string;
  detail?: string;
}

export interface AnalystLoopDeps {
  /** Extract relations/columns from candidate SQL. Injected so the loop does not fork a parser. */
  extractReferences: (sql: string) => { relations: string[]; columns: string[] };
  /** Turn raw model output into SQL. Injected for the same reason. */
  parseSql: (raw: string) => string | undefined;
  /** Tools the model may call. Already surface-filtered by the host. */
  tools: AgentToolDefinition[];
  /**
   * Run the deterministic safety verifiers over candidate SQL and return a
   * correction, or `undefined` when it passes.
   *
   * The verifiers keep their logic — aggregation safety, grain, relationship
   * proof — but a failure becomes an OBSERVATION the loop can act on instead of
   * a terminal refusal. That inversion is the point: the legacy path turned
   * "this would double-count" into "nothing was executed", which is true and
   * useless. Telling the model that joining those tables fans out is something
   * it can fix.
   */
  verifySql?: (sql: string) => string | undefined;
  maxIterations: number;
  /** Physical provider sends available to this text/native tool loop. */
  maxProviderDispatches?: number;
  /**
   * Optional structured planning call. Absent, the loop runs exactly as before
   * and the trace falls back to a fixed label.
   */
  planTurn?: (question: string, toolNames: string[]) => Promise<AnalystTurnPlan | undefined>;
  /**
   * Physical tool-call observation owned by the runtime boundary.  It records
   * only typed, redacted trace evidence; it never changes the tool result,
   * routing decision, or execution authority.
   */
  onToolCall?: ProviderToolLoopOptions['onToolCall'];
  onStep?: (step: AnalystStep) => void;
}

export interface AnalystOutcome {
  sql?: string;
  /** Identifiers the run proved, for the audit trail. */
  admitted: string[];
  /** The same admissions with their evidence, for minting an authorization. */
  admittedEntries: AdmittedIdentifier[];
  /** Corrections fed back to the model, in order. */
  corrections: string[];
  /** Why the loop stopped. */
  stop: 'composed' | 'no_sql' | 'unverified' | 'budget_exhausted';
  /** Typed terminal detail: this never grants an execution fallback. */
  terminal?: 'no_final_sql'
    | 'tool_budget_exhausted'
    | 'provider_dispatch_budget_exhausted'
    | 'unverified_identifiers'
    | 'missing_execution_binding'
    | 'tool_loop_error';
}

type AnalystBudgetTerminal = Extract<AnalystOutcome['terminal'],
  'tool_budget_exhausted' | 'provider_dispatch_budget_exhausted'>;

function budgetTerminalForToolLoop(stop: TextToolLoopResult['stop']): AnalystBudgetTerminal | undefined {
  return stop === 'tool_budget_exhausted' || stop === 'provider_dispatch_budget_exhausted'
    ? stop
    : undefined;
}

/**
 * Run explore-then-compose and return verified SQL.
 *
 * Returns `stop: 'unverified'` rather than throwing when the repair budget is
 * spent: the caller decides whether an unverified draft is still worth showing
 * as review-required, and that is a governance choice, not this loop's.
 */
export async function runAnalystLoop(
  input: AnswerLoopInput,
  deps: AnalystLoopDeps,
): Promise<AnalystOutcome> {
  const ledger = new IdentifierLedger();
  const corrections: string[] = [];

  // Seed from the context pack. These are retrieved, not observed, so they enter
  // at the weakest tier — enough to let correct SQL through without pretending a
  // catalog row proves a column exists in the warehouse.
  for (const object of input.contextPack?.allowedSqlContext?.relations ?? []) {
    ledger.admit('catalog', [object.relation, object.name], 'context_pack');
    ledger.admit('catalog', (object.columns ?? []).map((column) => column.name), 'context_pack');
  }

  const tools = withLedgerHarvest(deps.tools, ledger, (event) => {
    deps.onStep?.({
      kind: 'observe',
      label: `${event.tool} returned ${event.admitted} identifier${event.admitted === 1 ? '' : 's'}`,
    });
  });

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: ANALYST_TOOL_POLICY },
    { role: 'user', content: input.question },
  ];

  // One structured planning call before acting. It is optional by design:
  // `planAnalystTurn` swallows its own failures, so a slow or unparseable plan
  // costs a bounded wait and nothing else. What it buys is a trace that names
  // what the agent is about to verify instead of a fixed string.
  const turnPlan = deps.planTurn
    ? await deps.planTurn(input.question, tools.map((tool) => tool.name))
    : undefined;
  if (turnPlan) {
    deps.onStep?.({ kind: 'plan', label: turnPlan.restatement });
    for (const item of turnPlan.mustEstablish) {
      deps.onStep?.({ kind: 'plan', label: `Must establish: ${item}` });
    }
    // Carry the plan into the loop so it steers the run rather than only
    // describing it — otherwise the trace would promise work the model never
    // agreed to do.
    messages.push({
      role: 'assistant' as const,
      content: `Before answering I must establish, using tools:\n${
        turnPlan.mustEstablish.map((item) => `- ${item}`).join('\n')
      }${turnPlan.openingTool ? `\nStarting with ${turnPlan.openingTool}.` : ''}`,
    });
  } else {
    deps.onStep?.({ kind: 'plan', label: 'Establishing what exists before writing SQL' });
  }

  const initial = await runAgenticToolLoopDetailed(input.provider, messages, tools, {
    ...(input.signal ? { signal: input.signal } : {}),
    maxToolCalls: deps.maxIterations,
    ...(deps.maxProviderDispatches !== undefined ? { maxProviderDispatches: deps.maxProviderDispatches } : {}),
    ...(deps.onToolCall ? { onToolCall: deps.onToolCall } : {}),
  });
  let raw = initial.text;
  const initialBudgetTerminal = budgetTerminalForToolLoop(initial.stop);
  if (initialBudgetTerminal) {
    return {
      admitted: ledger.entries().map((e) => e.identifier),
      admittedEntries: ledger.entries(),
      corrections,
      stop: 'budget_exhausted',
      terminal: initialBudgetTerminal,
    };
  }
  let sql = deps.parseSql(raw);
  if (!sql) {
    return {
      admitted: ledger.entries().map((e) => e.identifier),
      admittedEntries: ledger.entries(),
      corrections,
      stop: 'no_sql',
      terminal: 'no_final_sql',
    };
  }

  // One bounded repair. A second would mostly re-spend the budget: if the first
  // correction — which names the exact identifier that was observed — does not
  // land, the problem is not a typo.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    deps.onStep?.({ kind: 'verify', label: 'Checking every identifier was actually observed' });
    const verdict = adjudicateProposedSql(ledger, deps.extractReferences(sql));
    // Identifiers first: a safety verdict over SQL naming a column that does not
    // exist is noise, and would send the model chasing the wrong correction.
    const safety = verdict.ok ? deps.verifySql?.(sql) : undefined;
    if (verdict.ok && !safety) {
      deps.onStep?.({ kind: 'answer', label: 'Verified — every name came from a tool result' });
      return { sql, admitted: ledger.entries().map((e) => e.identifier), admittedEntries: ledger.entries(), corrections, stop: 'composed' };
    }
    const correction = verdict.ok ? safety! : verdict.correction;
    corrections.push(correction);
    if (attempt === 1) break;
    deps.onStep?.({
      kind: 'tool',
      label: verdict.ok ? 'Correcting an unsafe aggregation' : 'Correcting an unobserved identifier',
      detail: verdict.ok ? safety : verdict.unadmitted.join(', '),
    });
    const repair = await runAgenticToolLoopDetailed(
      input.provider,
      [...messages, { role: 'assistant' as const, content: raw }, { role: 'user' as const, content: correction }],
      tools,
      {
        ...(input.signal ? { signal: input.signal } : {}),
        maxToolCalls: deps.maxIterations,
        ...(deps.maxProviderDispatches !== undefined ? { maxProviderDispatches: deps.maxProviderDispatches } : {}),
        ...(deps.onToolCall ? { onToolCall: deps.onToolCall } : {}),
      },
    );
    raw = repair.text;
    const repairBudgetTerminal = budgetTerminalForToolLoop(repair.stop);
    if (repairBudgetTerminal) {
      return {
        admitted: ledger.entries().map((e) => e.identifier),
        admittedEntries: ledger.entries(),
        corrections,
        stop: 'budget_exhausted',
        terminal: repairBudgetTerminal,
      };
    }
    const repaired = deps.parseSql(raw);
    if (!repaired) break;
    sql = repaired;
  }

  return {
    sql,
    admitted: ledger.entries().map((e) => e.identifier),
    admittedEntries: ledger.entries(),
    corrections,
    stop: 'unverified',
    terminal: 'unverified_identifiers',
  };
}

/**
 * Wrap the loop as a lane handler, falling back to the legacy answer loop.
 *
 * The legacy loop still produces the ANSWER — trust labels, citations,
 * narration, execution. This only decides whether the SQL that reaches it was
 * built from observed identifiers. Handing verified SQL to a path that already
 * knows how to govern it is a much smaller change than replacing that path.
 */
export function createAnalystLaneHandler(deps: {
  legacy: (input: AnswerLoopInput) => Promise<AgentAnswer>;
  buildDeps: (input: AnswerLoopInput) => AnalystLoopDeps | undefined;
}) {
  return async (input: AnswerLoopInput): Promise<AgentAnswer> => {
    const noGeneratedExecution = {
      ...input,
      forcedGeneratedProposal: undefined,
      agenticSqlExecutionCapability: undefined,
      executeGeneratedSql: undefined,
      executeAgenticGeneratedSql: undefined,
    } satisfies AnswerLoopInput;
    const safeLegacy = async (outcome: AnalystOutcome): Promise<AgentAnswer> => {
      try {
        return await deps.legacy(noGeneratedExecution);
      } catch {
        // Never let `answerAgentic` turn a failure in the guarded path into an
        // ambient legacy retry. This explicit no-answer retains the truthful
        // non-executing terminal rather than emitting a second, unproved SQL.
        return analystNonExecutingAnswer(input, outcome);
      }
    };
    const loopDeps = deps.buildDeps(input);
    // A generated agentic route may never fall through to an ambient generated
    // executor when its proof tools are unavailable. Certified/semantic routes
    // remain host-owned, but this lane has no generated SQL authority.
    if (!loopDeps || loopDeps.tools.length === 0) {
      return safeLegacy({ admitted: [], admittedEntries: [], corrections: [], stop: 'no_sql', terminal: 'no_final_sql' });
    }

    let outcome: AnalystOutcome;
    try {
      outcome = await runAnalystLoop(input, loopDeps);
    } catch {
      outcome = {
        admitted: [],
        admittedEntries: [],
        corrections: [],
        stop: 'no_sql',
        terminal: 'tool_loop_error',
      };
    }
    if (readEnv('ZLENS_ORCHESTRATOR_TRACE')) {
      console.warn(`[dql] analyst loop outcome: stop=${outcome.stop} sql=${outcome.sql ? 'yes' : 'no'} admitted=${outcome.admitted.length} corrections=${outcome.corrections.length}`);
    }
    // The agentic generated lane normally makes its one generation attempt in
    // `runAnalystLoop`.  A router-frozen exploratory plan is the narrow
    // exception: a model decline is allowed ONE server-owned correction before
    // we declare the plan non-executing.  Previously this handler returned the
    // no-SQL diagnostic here, before the bounded repair authority in the answer
    // loop could run.  That made a reserved repair dispatch unreachable while
    // still spending the initial generation.
    //
    // This is deliberately not a second analyst loop or a replan.  The helper
    // only runs for a complete, authoritative bounded-exploration RAP with the
    // host's mint-and-consume callbacks.  Its output is handed to the existing
    // legacy execution boundary as a forced proposal, where the exact frozen
    // snapshot, closure, target, read-only SQL and output tuple are all
    // re-authorized before one execution.
    if (outcome.stop === 'no_sql') {
      const repair = await repairFrozenExploratoryModelDecline(input);
      if (repair.sql) {
        outcome = {
          ...outcome,
          sql: repair.sql,
          stop: 'composed',
          corrections: [
            ...outcome.corrections,
            'The initial model response omitted SQL; one frozen-plan correction was requested.',
          ],
        };
      } else if (repair.terminal) {
        outcome = { ...outcome, stop: 'budget_exhausted', terminal: repair.terminal };
      }
    }
    const scope = input.agenticExecutionScope;
    const composedSql = outcome.stop === 'composed' ? outcome.sql : undefined;
    // A router-selected exploratory tier has a stricter handoff than the
    // analyst loop's ordinary generated lane: only the host may mint its
    // execution capability after it rechecks the selected snapshot, target,
    // and qualified physical evidence.  Do not pre-mint a generic capability
    // here, or the router-owned freeze/authorization receipt would be skipped.
    const routerSelectedExploratory = input.selectedCascadeTier === 'exploratory_sql';
    const capability = composedSql && !routerSelectedExploratory
      ? createAgenticSqlExecutionCapability({
          sql: composedSql,
          // Retrieval catalog rows cannot mint execution authority. Preserve
          // them in the audit ledger, but pass only observed evidence to the
          // server-only capability.
          proven: outcome.admittedEntries
            .filter((entry) => entry.source !== 'catalog')
            .map((entry) => ({ identifier: entry.identifier, evidence: entry.source })),
          runId: scope?.runId,
          executionId: scope?.executionId,
          snapshotId: scope?.snapshotId ?? input.resolvedAnalyticalPlan?.snapshotId,
          planId: scope?.planId ?? input.resolvedAnalyticalPlan?.planId,
          targetFingerprint: scope?.targetFingerprint ?? input.generatedProposalTargetFingerprint,
          bindings: scope?.bindings ?? {},
        })
      : undefined;
    if (outcome.stop === 'composed' && composedSql && !capability && !routerSelectedExploratory) {
      outcome = { ...outcome, stop: 'unverified', terminal: 'missing_execution_binding' };
    }
    const answer = outcome.stop === 'budget_exhausted'
      // A terminal budget is not a recoverable model answer. Do not ask the
      // legacy path to take another generation turn: it would conceal the
      // terminal reason and could turn an explicit bounded stop into an
      // unrelated answer. This remains deliberately non-executing.
      ? analystNonExecutingAnswer(input, outcome)
      // A router-owned exploratory closure is an execution boundary, not a
      // retrieval hint. If the analyst loop cannot compose SQL that passes
      // that closure's identifiers and relationship proof, returning through
      // the broad legacy answer path would let it prepare an unrelated draft.
      // Keep this pre-capability failure terminal and preserve the router's
      // frozen tier rather than retrying meaning or generating new SQL.
      : routerSelectedExploratory && (outcome.stop !== 'composed' || !composedSql)
        ? analystNonExecutingAnswer(input, outcome)
      : outcome.stop === 'composed' && composedSql && (capability || routerSelectedExploratory)
        ? await (async (): Promise<AgentAnswer> => {
            try {
              return await deps.legacy({
                ...input,
                // This is a hard handoff, not prompt context. The legacy answer loop
                // keeps its validation/narration/artifact behavior but cannot ask a
                // second model to replace the analyst SQL.
                forcedGeneratedProposal: {
                  sql: composedSql,
                  summary: 'Prepared from identifiers observed during this bounded analyst run. Review-required until an analyst promotes it.',
                },
                // The router-selected exploratory path intentionally reaches
                // the answer loop without a capability.  That loop invokes
                // the host-owned preparation callback after validating these
                // exact SQL bytes, then immediately consumes its one-shot
                // capability.  Other analyst lanes retain the existing
                // pre-bound capability handoff.
                ...(capability ? { agenticSqlExecutionCapability: capability } : {}),
              });
            } catch {
              // Do not rethrow into `answerAgentic`: its compatibility fallback
              // executes the original legacy input, which lacks this capability.
              const failed: AnalystOutcome = {
                ...outcome,
                stop: 'unverified',
                terminal: 'tool_loop_error',
              };
              return analystNonExecutingAnswer(input, failed);
            }
          })()
        : await safeLegacy(outcome);
    // ALWAYS record the verdict, not only when a correction was needed. A
    // verification that passed is precisely what an audit wants to see, and a
    // loop that is invisible when it works cannot be told apart from one that
    // never ran — the same silent-degradation trap the fallback marker avoids.
    return withAnalystEvidence(answer, outcome);
  };
}

/**
 * Whether the host has supplied everything needed for the one permitted
 * model-decline correction on a router-frozen exploratory plan.  This must
 * stay stricter than "selected exploratory": without the immutable RAP and
 * the host-owned authorization closures, another provider call would be a
 * fresh generated attempt rather than a repair.
 */
function mayRepairFrozenExploratoryModelDecline(input: AnswerLoopInput): boolean {
  const plan = input.resolvedAnalyticalPlan;
  return input.selectedCascadeTier === 'exploratory_sql'
    && plan?.mode === 'authoritative'
    && plan.capability === 'bounded_exploration'
    && Boolean(plan.planId && plan.fingerprint && plan.snapshotId)
    && plan.sourceRelationIds.length > 0
    && Boolean(input.prepareExploratorySqlExecution && input.executeAgenticGeneratedSql);
}

type FrozenExploratoryRepairResult = {
  sql?: string;
  terminal?: Extract<AnalystOutcome['terminal'], 'provider_dispatch_budget_exhausted'>;
};

/**
 * Performs the only provider-side correction available to a frozen
 * exploratory plan after its initial generation declined to emit SQL.
 *
 * No result rows, extra retrieval, candidate IDs, route choices, or new
 * relationship paths cross this boundary.  The schema excerpt is selected
 * from the already-rendered host context by the frozen physical relation leaf;
 * execution still requires the stronger capability check in the host.
 */
async function repairFrozenExploratoryModelDecline(
  input: AnswerLoopInput,
): Promise<FrozenExploratoryRepairResult> {
  if (!mayRepairFrozenExploratoryModelDecline(input)) return {};

  const plan = input.resolvedAnalyticalPlan!;
  const relations = frozenExploratoryPromptRelations(input);
  // Do not ask a model to make up the physical relation when the host did not
  // retain a matching, bounded schema excerpt.  The caller will surface the
  // original no-SQL outcome instead of treating this as a fresh planning turn.
  if (relations.length === 0) return {};

  const outputs = plan.outputContract.requiredOutputs
    ?.filter((output) => output.status === 'resolved' && output.outputName && output.qualifiedId)
    .map((output) => `${output.outputName} <- ${output.qualifiedId}`)
    ?? [];
  const requestedLimit = plan.query.limit;
  const schema = relations.map((relation) => {
    const columns = relation.columns
      .slice(0, 48)
      .map((column) => column.name)
      .filter(Boolean)
      .join(', ');
    return `${relation.relation} (${columns})`;
  }).join('\n');
  try {
    const raw = await input.provider.generate([
      {
        role: 'system',
        content: [
          'Return exactly one JSON object with `summary`, `sql`, `viz`, and `outputs`.',
          'This is the one permitted correction for an already frozen, review-required exploratory plan.',
          'Produce one read-only SELECT or WITH query. Do not explain a refusal, call tools, choose a different route, add a relation, remove an output, alter the ranking, or change the limit.',
          'Use only the supplied physical relations and columns. The host will reject any SQL that differs from the frozen snapshot, source closure, target, read-only policy, or required output bindings.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Question: ${input.question}`,
          outputs.length > 0
            ? `Frozen required output bindings (preserve exactly): ${outputs.join('; ')}`
            : 'Preserve the frozen requested output tuple exactly.',
          requestedLimit !== undefined ? `Frozen limit: ${requestedLimit}` : '',
          `Bounded physical schema:\n${schema}`,
        ].filter(Boolean).join('\n\n'),
      },
    ], {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      // The runtime ledger owns the cross-phase ceiling.  This local cap stops a
      // provider implementation from internally retrying the correction.
      maxProviderDispatches: 1,
      dispatchPhase: 'repair',
      egressPurpose: 'repair_sql',
    });
    return { sql: sqlFromFrozenExploratoryRepair(raw) };
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    const code = error && typeof error === 'object'
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    return code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED'
      ? { terminal: 'provider_dispatch_budget_exhausted' }
      : {};
  }
}

function frozenExploratoryPromptRelations(input: AnswerLoopInput) {
  const sourceLeaves = new Set(
    (input.resolvedAnalyticalPlan?.sourceRelationIds ?? [])
      .map(frozenRelationLeaf)
      .filter(Boolean),
  );
  return (input.contextPack?.allowedSqlContext.relations ?? []).filter((relation) =>
    sourceLeaves.has(frozenRelationLeaf(relation.relation))
    || sourceLeaves.has(frozenRelationLeaf(relation.name)),
  );
}

function frozenRelationLeaf(value: string | undefined): string {
  return (value ?? '')
    .replace(/["`\[\]]/g, '')
    .split(/[.:/]/)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase() ?? '';
}

function sqlFromFrozenExploratoryRepair(raw: string): string | undefined {
  const candidates = [
    raw.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim(),
    raw.trim().startsWith('{') && raw.trim().endsWith('}') ? raw.trim() : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { sql?: unknown; query?: unknown };
      const sql = typeof parsed.sql === 'string'
        ? parsed.sql.trim()
        : typeof parsed.query === 'string'
          ? parsed.query.trim()
          : undefined;
      if (sql) return sql;
    } catch {
      // A malformed repair is treated as the original model decline; never
      // attempt a second correction or derive SQL from prose.
    }
  }
  return raw.match(/```sql\s*([\s\S]*?)```/i)?.[1]?.trim() || undefined;
}

function analystNonExecutingAnswer(input: AnswerLoopInput, outcome: AnalystOutcome): AgentAnswer {
  const reason = outcome.terminal === 'missing_execution_binding'
    ? 'ZLens established the query identifiers but could not bind this run to its frozen plan and execution target, so it did not run generated SQL.'
    : outcome.terminal === 'tool_loop_error'
      ? 'ZLens could not complete the bounded evidence check, so it did not run generated SQL.'
      : outcome.terminal === 'tool_budget_exhausted'
        ? 'ZLens reached its bounded tool budget before it received final SQL, so no generated warehouse query was run.'
        : outcome.terminal === 'provider_dispatch_budget_exhausted'
          ? 'ZLens reached its bounded AI dispatch budget before it received final SQL, so no generated warehouse query was run.'
      : outcome.terminal === 'no_final_sql'
        ? 'ZLens did not receive final SQL from the bounded analyst loop, so no generated warehouse query was run.'
        : 'ZLens could not verify every generated identifier against a tool observation, so no generated warehouse query was run.';
  return {
    kind: 'no_answer',
    certification: 'analyst_review_required',
    reviewStatus: 'analyst_review_required',
    refusalCode: 'grounding_gap',
    text: reason,
    answer: reason,
    citations: [],
    considered: [],
    ...(input.contextPack ? { contextPack: input.contextPack } : {}),
  };
}

function withAnalystEvidence(answer: AgentAnswer, outcome: AnalystOutcome): AgentAnswer {
  // The host initialises `evidence` AFTER the answer call, so at this point it is
  // usually undefined. Bailing out then silently dropped the verdict on every
  // real run — the loop worked and left no trace, which is indistinguishable
  // from it never having run. Create the envelope instead of skipping.
  const evidence: NonNullable<AgentAnswer['evidence']> = answer.evidence ?? {
    route: [], lineage: [], businessContext: [], selectedAssets: [],
    sourceTables: [], semanticObjects: [], citations: answer.citations ?? [],
  };
  return {
    ...answer,
    evidence: {
      ...evidence,
      route: [
        ...(evidence.route ?? []),
        {
          tool: 'identifier_ledger',
          // 'checked' not 'ok': the ledger VERIFIED the identifiers, it did not
          // select the route or execute anything.
          status: outcome.stop === 'composed' ? ('checked' as const) : ('failed' as const),
          label: outcome.stop === 'composed'
            ? `Verified ${outcome.admitted.length} identifier(s) against tool observations`
            : outcome.terminal === 'no_final_sql'
              ? 'The analyst loop did not produce final SQL; no generated warehouse query was run'
              : outcome.terminal === 'tool_budget_exhausted'
                ? 'The analyst loop reached its bounded tool budget before final SQL; no generated warehouse query was run'
                : outcome.terminal === 'provider_dispatch_budget_exhausted'
                  ? 'The analyst loop reached its bounded provider-dispatch budget before final SQL; no generated warehouse query was run'
              : outcome.terminal === 'missing_execution_binding'
                ? 'The analyst proposal had no complete run/plan/target execution binding; no generated warehouse query was run'
              : 'Could not verify every identifier against a tool observation',
          ...(outcome.corrections.length > 0 ? { detail: outcome.corrections.join(' ') } : {}),
        },
      ],
    },
  };
}
