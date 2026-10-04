/**
 * RESEARCH AS AN INVESTIGATION. The route opens one request's Ask context,
 * frames the change from the question (or from the answer being investigated),
 * and runs every query of the investigation as a settled reading through the
 * same pipeline as Ask. The run keeps one receipt: the reading, Research's own
 * story, and a pipeline receipt per query.
 */
import {
  ASK_NARRATION_SYSTEM_PROMPT,
  renderAskNarrationBrief,
  runInvestigation,
  verifyAskNarration,
  type AgentRouteExecutor,
  type AgentRouteExecutorResult,
  type AgentRun,
  type AgentRunArtifact,
  type AgentRunEvaluation,
  type AgentRunNextAction,
  type AgentRunRequest,
  type AnalyticalIntentV1,
  type AskStoryStepV1,
  type InvestigationContextSource,
  type InvestigationFrameSource,
  type InvestigationOutcome,
  type InvestigationReportV1,
  type PipelineOutcome,
  type PipelineReceipt,
} from '@duckcodeailabs/dql-agent';
import { toExecutorResult, type AskPipelineHost, type AskRequestScope } from '../ask-pipeline-host/host.js';
import { joinableRelations, modelingRelationshipEdges } from '../ask-pipeline-host/join-relationships.js';

/**
 * What the reader is told when Research reads the question. Ask declines to
 * compute a cause; Research investigates it, so the reading is what can be
 * measured, never an empty reading because the question asks why.
 */
export const RESEARCH_READING_GUIDANCE = [
  'THIS QUESTION IS BEING INVESTIGATED BY RESEARCH. Research compares the periods and looks for what drove the change itself, so a why, what-drove or what-changed question is never a reason to leave the measure out.',
  'Read what can be measured: the measure the question names (a metric, or a numeric column with its aggregation when no metric declares it), the period it names as `time.window`, and the restrictions it states.',
  'Name the LEVEL the question asks about (revenue, orders, points scored), never a metric that is itself a change, a growth rate or a running total (revenue_growth_mom, cumulative_revenue): Research compares the periods itself, so a growth metric would be compared as if it were a level.',
  'Put the causal words ("why", "what drove", "what changed") in `unresolved` with material=false and no options.',
].join(' ');

/** Held back at the end of the run for the report and persistence. */
export const INVESTIGATION_FINALIZE_RESERVE_MS = 15_000;
/** Without a run budget (tests, embeddings), the investigation's own soft deadline. */
export const INVESTIGATION_SOFT_DEADLINE_MS = 150_000;
/** The AI is asked to word the summary only with at least this much time left. */
export const NARRATION_MIN_REMAINING_MS = 30_000;

/**
 * The AI's wording of the summary, asked only when the reader opted in for
 * this run. It sees the computed facts, never rows, and its text is used only
 * when every number in it is one of those facts; otherwise the summary written
 * from the figures stands. There is no second try.
 */
async function narrateInvestigation(scope: Pick<AskRequestScope, 'dispatch'>, question: string, report: InvestigationReportV1, onStep: (step: AskStoryStepV1) => void): Promise<{ text: string; verified: true } | undefined> {
  const started = Date.now();
  let reply: string;
  try {
    reply = await scope.dispatch('research_narrate', [
      { role: 'system', content: ASK_NARRATION_SYSTEM_PROMPT },
      { role: 'user', content: renderAskNarrationBrief({ question, factSet: report.facts }) },
    ]);
  } catch (error) {
    onStep({ version: 1, phase: 'report', title: 'Kept the summary written from the figures', state: 'missed', at: Date.now(), ms: Date.now() - started, detail: `The AI wording could not be requested: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600) });
    return undefined;
  }
  const text = reply.trim();
  const verification = verifyAskNarration({ text, factSet: report.facts });
  if (!verification.ok) {
    const why = [...verification.failures, ...(verification.unverified.length ? [`numbers not in the figures: ${verification.unverified.join(', ')}`] : [])].join('; ');
    onStep({ version: 1, phase: 'report', title: 'Kept the summary written from the figures', state: 'missed', at: Date.now(), ms: Date.now() - started, detail: `The AI wording was not used (${why}).` });
    return undefined;
  }
  onStep({ version: 1, phase: 'report', title: 'The AI worded the summary; every number in it was checked', state: 'done', at: Date.now(), ms: Date.now() - started });
  return { text, verified: true };
}

export interface InvestigationExecutorDeps {
  host: Pick<AskPipelineHost, 'openScope'>;
  /** A stored run of this project, by id. */
  loadRun(runId: string): Promise<AgentRun | null | undefined>;
  /** Outside context for this run (e.g. the person's knowledge sources); a function decides per run. */
  contextSources?: InvestigationContextSource[] | ((context: Parameters<AgentRouteExecutor>[0]) => InvestigationContextSource[] | undefined);
  /**
   * RFC 0010 HH-5: whether this run's computed facts (figures, driver members) may reach the model that words the
   * summary. The run's own opt-in asks for the wording; this decides whether it may have it (the privacy boundary,
   * the project's row-egress switch). Without it, the run's opt-in alone decides, as before.
   */
  narrationMayCarryValues?(request: Parameters<AgentRouteExecutor>[0]['request']): boolean | Promise<boolean>;
  now?: () => Date;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

const isAnalyticsIntent = (value: unknown): value is AnalyticalIntentV1 => {
  const intent = recordOf(value);
  return intent?.kind === 'analytics' && Array.isArray(intent.measures) && intent.measures.length > 0;
};

/**
 * The reading an earlier answer settled, when that run finished with one. Only
 * the server's stored run counts: whatever SQL or rows the client sends along
 * with "Research deeper" are never read.
 */
export function investigationSourceIntent(run: AgentRun): AnalyticalIntentV1 | undefined {
  if (run.status !== 'completed' && run.status !== 'needs_review') return undefined;
  for (const artifact of run.artifacts) {
    const intent = recordOf(artifact.payload)?.askIntentV1;
    if (isAnalyticsIntent(intent)) return intent;
  }
  const receipted = run.diagnosticReceiptV9?.intent;
  return isAnalyticsIntent(receipted) ? receipted : undefined;
}

/** One query's own deadline: room for a draft and a warehouse call, never the whole remaining run. */
const queryDeadlineMs = (remainingMs: number) => Math.max(5_000, Math.min(45_000, remainingMs - 20_000));

export function createInvestigationExecutor(deps: InvestigationExecutorDeps): AgentRouteExecutor {
  return async (context) => {
    const { runId, request, routeDecision, emit } = context;
    const startedAt = Date.now();
    const opened = await deps.host.openScope(context, { route: 'research' });
    if ('blocked' in opened) return opened.blocked;
    const { scope } = opened;
    const contextSources = typeof deps.contextSources === 'function' ? deps.contextSources(context) : deps.contextSources;

    const steps: AskStoryStepV1[] = [];
    const onStep = (step: AskStoryStepV1) => {
      steps.push(step);
      emit({ type: 'executor.started', message: step.title, route: 'research', payload: { askStep: step } });
    };
    const source = await frameSource(deps, request, onStep);
    let reading: PipelineOutcome | undefined;
    const remainingMs = () => (request.runBudget
      ? Math.max(0, request.runBudget.remainingMs() - INVESTIGATION_FINALIZE_RESERVE_MS)
      : Math.max(0, INVESTIGATION_SOFT_DEADLINE_MS - (Date.now() - startedAt)));

    const outcome = await runInvestigation({
      question: request.question,
      source,
      runtime: {
        read: async (question) => { reading = await scope.read(question, { guidance: RESEARCH_READING_GUIDANCE }); return reading; },
        runIntent: (intent, { allowAiSql }) => scope.runIntent(intent, { allowAiSql, origin: 'research_program', deadlineMs: queryDeadlineMs(remainingMs()) }),
        vocabulary: () => scope.vocabulary(),
        remainingMs,
        onStep,
        compatibleDimensionRefs: (metricRef) => compatibleDimensionRefs(scope, metricRef),
        joinableRelations: (relations) => joinableRelations(modelingRelationshipEdges(scope.manifest()), relations),
        selectDimensions: (prompt) => scope.dispatch('research_select', [{ role: 'user', content: prompt }]),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(contextSources?.length ? { contextSources } : {}),
      },
      ...(deps.now ? { now: deps.now } : {}),
    });

    const optedIn = (request as { researchResultRowsOptIn?: boolean }).researchResultRowsOptIn === true
      && (!deps.narrationMayCarryValues || await Promise.resolve().then(() => deps.narrationMayCarryValues!(request)).then((allowed) => allowed === true, () => false));
    if (outcome.kind === 'report' && optedIn && outcome.report.status === 'answered' && remainingMs() > NARRATION_MIN_REMAINING_MS) {
      outcome.receipt.budget.aiCalls += 1;
      const narration = await narrateInvestigation(scope, request.question, outcome.report, onStep);
      if (narration) outcome.report.narration = narration;
    }

    const frameIntent = source.kind === 'run' ? source.intent : reading?.kind === 'reading' ? reading.intent : undefined;
    const receipt = investigationRootReceipt({ scope, reading, outcome, steps, startedAt, ...(frameIntent ? { intent: frameIntent } : {}) });
    const telemetry = investigationTelemetry(receipt, outcome, scope, startedAt);

    if (outcome.kind === 'reading_ended') {
      return { ...toExecutorResult(runId, outcome.outcome, startedAt), askPipelineReceipt: receipt };
    }
    if (outcome.kind === 'clarify') {
      const label = (ref: string) => { const entry = scope.vocabulary().get(ref); return (entry?.label ?? entry?.name ?? ref).replace(/_/g, ' '); };
      return {
        summary: outcome.question, answer: outcome.question, status: 'needs_clarification', trustState: 'not_applicable', stopReason: 'needs_clarification',
        resolvedRoute: 'clarify', answerRefusalCode: 'ambiguous',
        clarificationOptions: outcome.options.map((ref) => ({ id: ref, label: label(ref), kind: 'vocabulary' as const })),
        artifacts: [{ id: `${runId}:clarify`, kind: 'answer', title: 'One question before investigating', trustState: 'not_applicable', payload: { kind: 'no_answer', text: outcome.question, answer: outcome.question } }],
        evaluations: [], nextActions: [{ id: 'clarify', label: 'Clarify question', route: 'research' }],
        telemetry, askPipelineReceipt: receipt,
      };
    }
    if (outcome.kind === 'not_investigable') {
      const text = `${outcome.reason} Ask the question instead, or name the measure and the period to investigate.`;
      return {
        summary: outcome.reason, answer: text, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'research',
        artifacts: [{ id: `${runId}:not-investigable`, kind: 'answer', title: 'Not something Research can investigate', trustState: 'blocked', payload: { kind: 'no_answer', text, answer: text } }],
        evaluations: [], nextActions: [{ id: 'ask-instead', label: 'Ask it instead', route: 'generated_answer' }],
        telemetry, askPipelineReceipt: receipt,
      };
    }
    return reportResult({ runId, report: outcome.report, receipt, telemetry, routeReason: routeDecision?.reason });
  };
}

/**
 * The dimensions the semantic layer can group a governed metric by, as
 * vocabulary refs. Undefined when there is no semantic layer or the metric is
 * not one of its metrics: the vocabulary's join reach decides instead.
 */
export function compatibleDimensionRefs(scope: Pick<AskRequestScope, 'semanticLayer' | 'vocabulary'>, metricRef: string): string[] | undefined {
  const layer = scope.semanticLayer();
  const vocabulary = scope.vocabulary();
  const metric = vocabulary.get(metricRef) ?? vocabulary.resolve(metricRef);
  if (!layer || !metric || metric.kind !== 'metric') return undefined;
  let explained: ReturnType<NonNullable<typeof layer>['explainCompatibleDimensions']>;
  try {
    explained = layer.explainCompatibleDimensions([metric.sourceId ?? metric.name]);
  } catch {
    return undefined;
  }
  if (explained.incompatible.some((item) => item.reason === 'metric_unresolved')) return undefined;
  // A vocabulary dimension's source id is `<semantic model or table>.<name>`.
  const bySource = new Map(vocabulary.entries.filter((entry) => entry.kind === 'dimension' && entry.sourceId).map((entry) => [entry.sourceId!, entry.ref]));
  const refs = explained.compatible
    .map((definition) => {
      const home = definition.cube ?? definition.table?.split('.').pop();
      return home ? bySource.get(`${home}.${definition.name}`) : undefined;
    })
    .filter((ref): ref is string => Boolean(ref));
  return refs.length ? [...new Set(refs)] : undefined;
}

async function frameSource(deps: InvestigationExecutorDeps, request: AgentRunRequest, onStep: (step: AskStoryStepV1) => void): Promise<InvestigationFrameSource> {
  const runId = recordOf(request.workspaceContext?.researchSource)?.runId;
  if (typeof runId !== 'string' || !runId.trim()) return { kind: 'question' };
  const run = await deps.loadRun(runId).catch(() => undefined);
  const intent = run ? investigationSourceIntent(run) : undefined;
  if (intent) return { kind: 'run', runId, intent };
  onStep({
    version: 1, phase: 'frame', title: 'Could not start from the earlier answer', state: 'missed', at: Date.now(),
    detail: run ? 'That answer has no settled reading to start from, so the question is read again.' : 'That answer is no longer stored, so the question is read again.',
  });
  return { kind: 'question' };
}

function investigationRootReceipt(input: {
  scope: AskRequestScope;
  reading?: PipelineOutcome;
  outcome: InvestigationOutcome;
  steps: AskStoryStepV1[];
  startedAt: number;
  intent?: AnalyticalIntentV1;
}): PipelineReceipt {
  const base: PipelineReceipt = input.reading?.receipt ?? {
    version: 1, vocabularyFingerprint: input.scope.vocabulary().fingerprint, dispatches: [], candidates: [], refusals: [], tiers: [], timings: {}, reuse: 'interpretation',
  };
  const queries = input.outcome.receipt.queries.map((query) => query.receipt);
  const sum = (pick: (receipt: PipelineReceipt) => number) => queries.reduce((total, receipt) => total + pick(receipt), 0);
  return {
    ...base,
    ...(input.intent ? { intent: input.intent, reading: input.intent.reading } : {}),
    timings: { ...base.timings, context: input.scope.contextMs, total: Date.now() - input.startedAt },
    ...(queries.length ? {
      warehouse: {
        attempts: sum((receipt) => receipt.warehouse?.attempts ?? 0),
        failures: sum((receipt) => receipt.warehouse?.failures ?? 0),
        executions: sum((receipt) => receipt.warehouse?.executions ?? (receipt.executed ? 1 : 0)),
      },
    } : {}),
    story: [...input.scope.contextSteps, ...(base.story ?? []), ...input.steps].sort((left, right) => left.at - right.at),
    investigation: input.outcome.receipt,
  };
}

function investigationTelemetry(receipt: PipelineReceipt, outcome: InvestigationOutcome, scope: AskRequestScope, startedAt: number): NonNullable<AgentRouteExecutorResult['telemetry']> {
  const queries = outcome.receipt.queries.map((query) => query.receipt);
  const calls = receipt.dispatches.length + queries.reduce((total, query) => total + query.dispatches.length, 0);
  return {
    version: 1,
    stageDurationsMs: { retrieval: scope.contextMs, total: Date.now() - startedAt },
    providerRoundTrips: calls,
    toolCalls: queries.length,
    sqlExecutions: receipt.warehouse?.executions ?? 0,
    ...(receipt.warehouse ? { sqlAttempts: receipt.warehouse.attempts, sqlFailures: receipt.warehouse.failures } : {}),
    repairs: 0,
    egressReceipts: calls,
  };
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The periods the headline compared, as a small table every existing reader can render. */
function periodTable(report: InvestigationReportV1) {
  const headlineQuery = report.queries.find((query) => query.purpose === 'headline' && query.outcome === 'answered');
  const column = report.frame.metric.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value';
  const governedMeta = headlineQuery?.result?.columnsMeta?.find((meta) => meta.ref === report.frame.metric.ref);
  const valueMeta = governedMeta
    ? { ...governedMeta, name: column }
    : report.headline.current?.formatted.endsWith('%') ? { name: column, kind: 'percent' as const, unit: 'fraction' } : { name: column, kind: 'number' as const };
  const { windows } = report.frame;
  const periods = [
    [windows.current.label, report.headline.current],
    [windows.prior.label, report.headline.prior],
    [windows.yearAgo.label, report.headline.yearAgo],
  ] as const;
  const rows = periods.filter(([, figure]) => figure).map(([label, figure]) => ({ period: label, [column]: Number(figure!.value) }));
  return {
    headlineQuery,
    table: { columns: ['period', column], rows, rowCount: rows.length, columnsMeta: [{ name: 'period', kind: 'text' as const }, valueMeta] },
  };
}

function reportResult(input: {
  runId: string;
  report: InvestigationReportV1;
  receipt: PipelineReceipt;
  telemetry: NonNullable<AgentRouteExecutorResult['telemetry']>;
  routeReason?: string;
}): AgentRouteExecutorResult {
  const { runId, report, receipt, telemetry } = input;
  const { headlineQuery, table } = periodTable(report);
  // The breakdown behind the strongest driver is the reading a follow-up, a block or a SQL cell builds on.
  const driverQuery = report.drivers[0]
    ? report.queries.find((query) => query.id === report.drivers[0]!.queryIds[0] && query.outcome === 'answered')
    : undefined;
  const basisQuery = driverQuery ?? headlineQuery;
  const unreconciled = (report.breakdowns ?? []).filter((entry) => entry.reconciles === false);
  const notes = [...report.frame.notes, ...report.caveats.map((caveat) => caveat.text)].join(' ');
  const answer = report.narration ? (notes ? `${report.narration.text}\n\n${notes}` : report.narration.text) : report.text;
  const metric = report.frame.metric.label;
  const caveat = (code: string) => report.caveats.find((entry) => entry.code === code);
  const governedQueries = report.queries.filter((query) => query.outcome === 'answered' && (query.tier === 'certified' || query.tier === 'semantic'));
  const grounded = report.frame.lane === 'governed' && governedQueries.length > 0;
  const coverageNote = caveat('coverage_gap') ?? caveat('partial_period');
  const { level, reasons } = report.confidence;
  const evaluations: AgentRunEvaluation[] = [
    { id: 'route-decision', label: 'Route decision', passed: true, severity: 'info', message: input.routeReason ?? 'Routed the request to Research.' },
    {
      id: 'catalog-grounding', label: 'Catalog grounding', passed: grounded, severity: grounded ? 'info' : 'warning',
      message: grounded
        ? `${capitalize(metric)} is governed; ${governedQueries.length} of the investigation's queries ran on governed definitions.`
        : report.frame.lane === 'ai' ? `${capitalize(metric)} has no governed definition, so its figures come from SQL the AI wrote.` : 'No query of the investigation ran on a governed definition.',
    },
    {
      id: 'result-executed', label: 'Executed against data', passed: report.status === 'answered', severity: report.status === 'answered' ? 'info' : 'warning',
      message: report.status === 'answered'
        ? `The headline was measured from ${report.headline.queryIds.length} executed ${report.headline.queryIds.length === 1 ? 'query' : 'queries'}.`
        : report.status === 'no_data' ? 'The periods compared have no data.' : 'The investigation stopped before the headline was measured.',
    },
    { id: 'investigation-coverage', label: 'Data coverage', passed: !coverageNote, severity: coverageNote ? 'warning' : 'info', message: coverageNote?.text ?? 'Both periods are covered by data.' },
    ...(report.breakdowns?.length ? [{
      id: 'investigation-reconciliation', label: 'Breakdowns add up', passed: unreconciled.length === 0, severity: unreconciled.length ? 'warning' as const : 'info' as const,
      message: unreconciled.length
        ? `${unreconciled.map((entry) => entry.dimension.label).join(', ')} ${unreconciled.length === 1 ? 'does' : 'do'} not add up to the change, so ${unreconciled.length === 1 ? 'its' : 'their'} shares are not reliable.`
        : `Every breakdown adds up to the change (${report.breakdowns.length} measured).`,
    }] : []),
    { id: 'investigation-confidence', label: 'Confidence', passed: level !== 'low', severity: level === 'low' ? 'warning' : 'info', message: `${capitalize(level)} confidence${reasons.length ? `: ${reasons.join('; ')}` : ''}.` },
  ];
  const nextActions: AgentRunNextAction[] = [
    ...(report.status === 'incomplete' || receipt.investigation?.budget.stoppedBy ? [{ id: 'continue-investigation', label: 'Run the investigation again', route: 'research' as const }] : []),
    ...(report.status === 'no_data' ? [{ id: 'investigate-latest-period', label: 'Investigate the latest complete period', route: 'research' as const }] : []),
    ...(report.notInvestigated.some((entry) => entry.reason === 'budget' || entry.reason === 'deadline' || entry.reason === 'not_started')
      ? [{ id: 'investigate-remaining-dimensions', label: 'Investigate the remaining dimensions', route: 'research' as const }]
      : []),
    ...(caveat('coverage_gap') ? [{ id: 'review-data-coverage', label: 'Review data coverage', route: 'generated_answer' as const }] : []),
    ...(basisQuery?.sql ? [
      { id: 'create-block', label: driverQuery ? 'Save the driver breakdown as a block' : 'Save the trend as a block', route: 'dql_block_draft' as const, artifactKind: 'dql_block_draft' as const },
      { id: 'insert-sql', label: driverQuery ? 'Open the driver breakdown as SQL' : 'Open the trend query as SQL', route: 'sql_cell' as const, artifactKind: 'sql_cell' as const },
    ] : []),
    ...(report.frame.lane === 'ai' ? [{ id: 'model-metric', label: 'Model this metric', route: 'modeling_draft' as const }] : []),
  ];
  const artifact: AgentRunArtifact = {
    id: `${runId}:investigation`,
    kind: 'research_run',
    title: report.status === 'answered' ? `Investigation of ${metric}` : 'Investigation',
    trustState: 'review_required',
    payload: {
      kind: 'investigation',
      investigation: report,
      text: report.text,
      answer,
      certification: 'review_required',
      reviewStatus: 'review_required',
      result: table,
      // The strongest driver's breakdown, or the trend the headline came from, is the reading a follow-up builds on.
      ...(basisQuery ? {
        askIntentV1: basisQuery.intent,
        ...(basisQuery.sql ? { sql: basisQuery.sql } : {}),
        ...(basisQuery.dqlArtifact !== undefined ? { dqlArtifact: basisQuery.dqlArtifact } : {}),
      } : {}),
    },
  };
  return {
    summary: report.headline.text,
    answer,
    status: 'needs_review',
    trustState: 'review_required',
    stopReason: 'human_review_required',
    resolvedRoute: 'research',
    artifacts: [artifact],
    evaluations,
    nextActions,
    telemetry,
    askPipelineReceipt: receipt,
  };
}
