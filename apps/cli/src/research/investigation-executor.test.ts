import { describe, expect, it } from 'vitest';
import {
  buildVocabularyIndex,
  type AgentRouteExecutorResult,
  type AgentRun,
  type AgentRunRequest,
  type AnalyticalIntentV1,
  type AskStoryStepV1,
  type InvestigationReportV1,
  type PipelineOutcome,
  type PipelineReceipt,
} from '@duckcodeailabs/dql-agent';
import { toExecutorResult, type AskPipelineHost, type AskRequestScope } from '../ask-pipeline-host/host.js';
import { compatibleDimensionRefs, createInvestigationExecutor, investigationSourceIntent } from './investigation-executor.js';

const TIME = 'dimension:orders.ordered_at';
const REVENUE = 'metric:orders.revenue';
const vocabulary = buildVocabularyIndex({
  metrics: [{ name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' }],
  dimensions: [{ name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] }],
});

/** Revenue is 100 a day from July 2024 to July 2025 and 70 a day in August 2025. */
const DAYS: Array<{ day: string; revenue: number }> = [];
for (let at = Date.UTC(2024, 6, 1); at < Date.UTC(2025, 8, 1); at += 86_400_000) {
  const day = new Date(at).toISOString().slice(0, 10);
  DAYS.push({ day, revenue: day >= '2025-08-01' ? 70 : 100 });
}

const receipt = (extra: Partial<PipelineReceipt> = {}): PipelineReceipt => ({
  version: 1, vocabularyFingerprint: 'test', dispatches: [], candidates: [], refusals: [], tiers: [], timings: {}, ...extra,
} as PipelineReceipt);

/** What the pipeline would answer for a settled reading of revenue over DAYS. */
function answer(intent: AnalyticalIntentV1): PipelineOutcome {
  const window = intent.time?.window;
  const rows = DAYS.filter((row) => !window || (row.day >= window.start && row.day < window.end));
  const time = intent.groupBy.find((group) => group.role === 'time');
  const column = `ordered_at__${time?.grain}`;
  const groups = new Map<string, number>();
  for (const row of rows) {
    const key = time ? (time.grain === 'day' ? row.day : `${row.day.slice(0, 7)}-01`) : 'all';
    groups.set(key, (groups.get(key) ?? 0) + row.revenue);
  }
  const result = {
    columns: [...(time ? [column] : []), 'value'],
    rows: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ ...(time ? { [column]: key } : {}), value })),
    rowCount: groups.size,
    executionTimeMs: 1,
    columnsMeta: [...(time ? [{ name: column, kind: 'date' as const, ref: TIME }] : []), { name: 'value', kind: 'currency' as const, unit: 'USD', ref: REVENUE }],
  };
  return {
    kind: 'answered', intent, text: '', result,
    candidate: { tier: 'semantic', trust: 'governed', sql: 'SELECT revenue FROM orders', proof: [] } as unknown as Extract<PipelineOutcome, { kind: 'answered' }>['candidate'],
    receipt: receipt({ warehouse: { attempts: 1, failures: 0, executions: 1 } }),
  };
}

const august = {
  version: 1, kind: 'analytics', reading: 'Revenue in August 2025.',
  measures: [{ ref: REVENUE }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {},
  time: { ref: TIME, grain: 'month', window: { start: '2025-08-01', end: '2025-09-01' } },
} as AnalyticalIntentV1;

function fakeHost(options: { read?: PipelineOutcome; blocked?: AgentRouteExecutorResult; dispatch?: (purpose: string, messages: Array<{ role: string; content: string }>) => Promise<string> } = {}) {
  const calls = { reads: 0, intents: [] as AnalyticalIntentV1[], readOptions: [] as unknown[], dispatches: [] as Array<{ purpose: string; messages: Array<{ role: string; content: string }> }> };
  const scope = {
    route: 'research', contextMs: 12, hasConnection: true,
    contextSteps: [{ version: 1, phase: 'context', title: 'Searched the project', state: 'done', at: 1 }] as AskStoryStepV1[],
    vocabulary: () => vocabulary,
    semanticLayer: () => undefined,
    manifest: () => undefined,
    read: async (_question: string, readOptions?: unknown) => {
      calls.reads += 1;
      calls.readOptions.push(readOptions);
      if (!options.read) throw new Error('an investigation started from an answer must not read the question again');
      return options.read;
    },
    runIntent: async (intent: AnalyticalIntentV1) => { calls.intents.push(intent); return answer(intent); },
    dispatch: async (purpose: string, messages: Array<{ role: string; content: string }>) => {
      calls.dispatches.push({ purpose, messages });
      return options.dispatch ? options.dispatch(purpose, messages) : '';
    },
  } as unknown as AskRequestScope;
  const host: Pick<AskPipelineHost, 'openScope'> = { openScope: async () => (options.blocked ? { blocked: options.blocked } : { scope }) };
  return { host, calls };
}

function run(request: Partial<AgentRunRequest>) {
  const events: Array<{ message: string; route?: string; payload?: unknown }> = [];
  const context = {
    runId: 'run-investigation', route: 'research' as const, maxRepairAttempts: 0, attempt: 0,
    emit: (event: { message: string; route?: string; payload?: unknown }) => { events.push(event); },
    request: { question: 'Why did revenue drop in August 2025?', requestedMode: 'research', ...request } as AgentRunRequest,
  };
  return { context, events };
}

const storedRun = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run-source', question: 'revenue in August 2025', requestedMode: 'ask', route: 'semantic_answer', status: 'completed', trustState: 'governed',
  stopReason: 'governed_semantic_answer', startedAt: '', completedAt: '', steps: [], summary: '', events: [], evaluations: [], nextActions: [], repairAttempts: 0,
  artifacts: [{ id: 'answer', kind: 'answer', title: 'Semantic answer', trustState: 'governed', payload: { askIntentV1: august } }],
  ...overrides,
} as AgentRun);

const readingOf = (intent: AnalyticalIntentV1): PipelineOutcome => ({
  kind: 'reading', intent, lane: 'governed', text: intent.reading,
  receipt: receipt({ intent, dispatches: [{ purpose: 'intent:resolve', ms: 5 }], story: [{ version: 1, phase: 'read', title: 'Read the question', state: 'done', at: 2 }] }),
});

const reportOf = (result: AgentRouteExecutorResult) => (result.artifacts?.[0]?.payload as { investigation: InvestigationReportV1 }).investigation;

describe('Research runs an investigation on the Ask pipeline', () => {
  it('"Research deeper" starts from the stored answer\'s reading, never the client\'s SQL, and keeps one receipt', async () => {
    const { host, calls } = fakeHost();
    const executor = createInvestigationExecutor({ host, loadRun: async (id) => (id === 'run-source' ? storedRun() : undefined) });
    const { context, events } = run({ workspaceContext: { researchSource: { runId: 'run-source', sql: 'DROP TABLE orders', result: { rows: [{ revenue: 999 }] } } } });
    const result = await executor(context);

    expect(calls.reads).toBe(0);
    expect(JSON.stringify(calls.intents)).not.toContain('DROP');
    expect(result).toMatchObject({ status: 'needs_review', trustState: 'review_required', resolvedRoute: 'research' });
    const artifact = result.artifacts![0]!;
    expect(artifact).toMatchObject({ kind: 'research_run', trustState: 'review_required', payload: { kind: 'investigation' } });
    const report = reportOf(result);
    expect(report.headline.verdict).toBe('change');
    expect(Number(report.headline.current!.value)).toBe(31 * 70);
    expect(Number(report.headline.prior!.value)).toBe(31 * 100);
    expect((artifact.payload as { result: unknown }).result).toMatchObject({
      columns: ['period', 'revenue'],
      rows: [{ period: 'August 2025', revenue: 2170 }, { period: 'July 2025', revenue: 3100 }, { period: 'August 2024', revenue: 3100 }],
    });
    const headline = report.queries.find((query) => query.purpose === 'headline')!;
    expect((artifact.payload as { askIntentV1: unknown }).askIntentV1).toEqual(headline.intent);

    const root = result.askPipelineReceipt!;
    expect(root).toMatchObject({ reuse: 'interpretation', intent: august, warehouse: { attempts: 2, executions: 2 } });
    expect(root.investigation?.budget).toMatchObject({ statementsUsed: 2, aiCalls: 0 });
    expect(root.investigation?.queries).toHaveLength(2);
    expect(root.story?.[0]?.title).toBe('Searched the project');
    expect(root.story?.map((step) => step.title)).toContain('Started from the answer being investigated');
    expect(result.telemetry).toMatchObject({ sqlExecutions: 2, providerRoundTrips: 0 });
    expect(result.evaluations?.find((evaluation) => evaluation.id === 'catalog-grounding')).toMatchObject({ passed: true });
    expect(events.some((event) => event.route === 'research' && Boolean((event.payload as { askStep?: unknown } | undefined)?.askStep))).toBe(true);
  });

  it('a question is read once, and the reading\'s AI call stays on the run\'s receipt', async () => {
    const { host, calls } = fakeHost({ read: readingOf(august) });
    const result = await createInvestigationExecutor({ host, loadRun: async () => undefined })(run({}).context);
    expect(calls.reads).toBe(1);
    // A why-question is read for what can be measured, not declined as a cause.
    expect(calls.readOptions[0]).toMatchObject({ guidance: expect.stringContaining('THIS QUESTION IS BEING INVESTIGATED BY RESEARCH') });
    expect(result.askPipelineReceipt?.dispatches).toHaveLength(1);
    expect(result.askPipelineReceipt?.investigation?.budget.aiCalls).toBe(1);
    expect(result.telemetry?.providerRoundTrips).toBe(1);
    expect(result.askPipelineReceipt?.story?.map((step) => step.title).slice(0, 2)).toEqual(['Searched the project', 'Read the question']);
  });

  it('an earlier answer that did not finish is not a starting point: the question is read again, and the story says so', async () => {
    const { host, calls } = fakeHost({ read: readingOf(august) });
    const result = await createInvestigationExecutor({ host, loadRun: async () => storedRun({ status: 'blocked' }) })(run({ workspaceContext: { researchSource: { runId: 'run-source' } } }).context);
    expect(calls.reads).toBe(1);
    expect(result.askPipelineReceipt?.story).toContainEqual(expect.objectContaining({ title: 'Could not start from the earlier answer', state: 'missed' }));
  });

  it('a reading that ends the turn is answered as Ask would, still with the investigation receipt', async () => {
    const conversation: PipelineOutcome = { kind: 'conversation', reply: 'Hello!', text: 'Hello!', receipt: receipt() };
    const result = await createInvestigationExecutor({ host: fakeHost({ read: conversation }).host, loadRun: async () => undefined })(run({ question: 'hi' }).context);
    expect(result).toMatchObject({ answer: 'Hello!', answerKind: 'conversational' });
    expect(result.askPipelineReceipt?.investigation).toBeDefined();
  });

  it('asks for a measure when the reading has none, and explains what is not a change over time', async () => {
    const clarify = await createInvestigationExecutor({ host: fakeHost({ read: readingOf({ ...august, measures: [] }) }).host, loadRun: async () => undefined })(run({}).context);
    expect(clarify).toMatchObject({ status: 'needs_clarification', resolvedRoute: 'clarify' });

    const notData = await createInvestigationExecutor({ host: fakeHost({ read: readingOf({ ...august, kind: 'conversation' } as AnalyticalIntentV1) }).host, loadRun: async () => undefined })(run({}).context);
    expect(notData).toMatchObject({ status: 'blocked', resolvedRoute: 'research' });
    expect(notData.answer).toContain('not a question about data');
  });

  it('a request without an AI model gets the host\'s blocked result', async () => {
    const blocked: AgentRouteExecutorResult = { status: 'blocked', answer: 'No AI model is configured.' };
    const result = await createInvestigationExecutor({ host: fakeHost({ blocked }).host, loadRun: async () => undefined })(run({}).context);
    expect(result).toBe(blocked);
  });

  it('the AI words the summary only for a reader who opted in, and only when every number in its wording is a computed figure', async () => {
    const source = { workspaceContext: { researchSource: { runId: 'run-source' } } };
    const loadRun = async (id: string) => (id === 'run-source' ? storedRun() : undefined);

    const quiet = fakeHost();
    const plain = await createInvestigationExecutor({ host: quiet.host, loadRun })(run(source).context);
    expect(quiet.calls.dispatches).toHaveLength(0);
    expect(reportOf(plain).narration).toBeUndefined();

    const faithful = fakeHost({ dispatch: async () => 'Revenue fell 930.00 (30.0%) in August 2025 compared with July 2025: 2170.00 against 3100.00.' });
    const worded = await createInvestigationExecutor({ host: faithful.host, loadRun })(run({ ...source, researchResultRowsOptIn: true } as Partial<AgentRunRequest>).context);
    expect(faithful.calls.dispatches.map((call) => call.purpose)).toEqual(['research_narrate']);
    // The AI is given the computed facts, never the rows.
    expect(faithful.calls.dispatches[0]!.messages[1]!.content).toContain('Facts computed by the host');
    expect(reportOf(worded).narration).toEqual({ text: 'Revenue fell 930.00 (30.0%) in August 2025 compared with July 2025: 2170.00 against 3100.00.', verified: true });
    expect(worded.answer?.startsWith('Revenue fell 930.00 (30.0%) in August 2025 compared with July 2025: 2170.00 against 3100.00.')).toBe(true);
    expect(worded.askPipelineReceipt?.investigation?.budget.aiCalls).toBe(1);

    const inventive = fakeHost({ dispatch: async () => 'Revenue fell 999.00 in August 2025 because of the weather.' });
    const refused = await createInvestigationExecutor({ host: inventive.host, loadRun })(run({ ...source, researchResultRowsOptIn: true } as Partial<AgentRunRequest>).context);
    expect(reportOf(refused).narration).toBeUndefined();
    expect(refused.answer).toBe(reportOf(refused).text);
    expect(refused.askPipelineReceipt?.story?.map((step) => step.title)).toContain('Kept the summary written from the figures');
  });

  it('the run\'s opt-in asks for the wording; the computed facts reach the model only where the boundary and the project allow (RFC 0010 HH-5)', async () => {
    const source = { workspaceContext: { researchSource: { runId: 'run-source' } } };
    const loadRun = async (id: string) => (id === 'run-source' ? storedRun() : undefined);
    const words = async () => 'Revenue fell 930.00 (30.0%) in August 2025 compared with July 2025: 2170.00 against 3100.00.';
    for (const decision of [() => false, () => Promise.resolve(false), () => { throw new Error('boundary rule down'); }]) {
      const kept = fakeHost({ dispatch: words });
      const result = await createInvestigationExecutor({ host: kept.host, loadRun, narrationMayCarryValues: decision })(run({ ...source, researchResultRowsOptIn: true } as Partial<AgentRunRequest>).context);
      expect(kept.calls.dispatches).toHaveLength(0);
      expect(reportOf(result).narration).toBeUndefined();
    }
    const allowed = fakeHost({ dispatch: words });
    const worded = await createInvestigationExecutor({ host: allowed.host, loadRun, narrationMayCarryValues: () => true })(run({ ...source, researchResultRowsOptIn: true } as Partial<AgentRunRequest>).context);
    expect(allowed.calls.dispatches.map((call) => call.purpose)).toEqual(['research_narrate']);
    expect(reportOf(worded).narration?.verified).toBe(true);
    // Without the run's own opt-in nothing is worded, whatever the boundary says.
    const unasked = fakeHost({ dispatch: words });
    await createInvestigationExecutor({ host: unasked.host, loadRun, narrationMayCarryValues: () => true })(run(source).context);
    expect(unasked.calls.dispatches).toHaveLength(0);
  });

  it('an Ask that declined a why-question offers "Investigate the drivers"; any other gap does not', () => {
    const gap = (clause: string): PipelineOutcome => ({
      kind: 'gap', gap: 'not_modeled', message: 'unsupported', nearest: [], text: 'Explaining why is something Research investigates.', offerExploration: false,
      intent: { ...august, unresolved: [{ clause, options: [], material: true, kind: 'unsupported', question: 'Research can investigate the drivers.' }] } as AnalyticalIntentV1,
      receipt: receipt(),
    } as PipelineOutcome);
    const why = toExecutorResult('run-why', gap('why'), Date.now());
    expect(why.nextActions?.[0]).toEqual({ id: 'investigate-drivers', label: 'Investigate the drivers', route: 'research' });
    const recommend = toExecutorResult('run-should', gap('should, invest'), Date.now());
    expect(recommend.nextActions?.map((action) => action.id)).not.toContain('investigate-drivers');
  });

  it("the semantic layer's compatible dimensions become vocabulary refs; without a layer, the vocabulary's join reach decides", () => {
    const semantic = buildVocabularyIndex({
      metrics: [{ name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum', sourceId: 'revenue' }],
      dimensions: [
        { name: 'category', model: 'orders', dataType: 'string', sourceId: 'orders.category' },
        { name: 'region', model: 'customers', dataType: 'string', sourceId: 'customers.region' },
      ],
    });
    const asked: string[][] = [];
    const layer = {
      explainCompatibleDimensions: (names: string[]) => {
        asked.push(names);
        return { compatible: [{ name: 'category', cube: 'orders' }, { name: 'region', table: 'analytics.customers' }, { name: 'not_in_vocabulary', cube: 'orders' }], incompatible: [] };
      },
    };
    expect(compatibleDimensionRefs({ semanticLayer: () => layer as never, vocabulary: () => semantic }, 'metric:orders.revenue')).toEqual(['dimension:orders.category', 'dimension:customers.region']);
    expect(asked).toEqual([['revenue']]);
    expect(compatibleDimensionRefs({ semanticLayer: () => undefined, vocabulary: () => semantic }, 'metric:orders.revenue')).toBeUndefined();
    const unknownMetric = { explainCompatibleDimensions: () => ({ compatible: [], incompatible: [{ name: 'revenue', reason: 'metric_unresolved' }] }) };
    expect(compatibleDimensionRefs({ semanticLayer: () => unknownMetric as never, vocabulary: () => semantic }, 'metric:orders.revenue')).toBeUndefined();
  });

  it('the starting reading is the stored answer\'s own, or its receipt\'s', () => {
    expect(investigationSourceIntent(storedRun())).toEqual(august);
    expect(investigationSourceIntent(storedRun({ artifacts: [], diagnosticReceiptV9: receipt({ intent: august }) }))).toEqual(august);
    expect(investigationSourceIntent(storedRun({ status: 'blocked' }))).toBeUndefined();
    expect(investigationSourceIntent(storedRun({ artifacts: [{ id: 'x', kind: 'answer', title: 'x', trustState: 'governed', payload: { askIntentV1: { kind: 'analytics', measures: [] } } }] }))).toBeUndefined();
  });
});
