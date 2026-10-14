import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@zlens/connectors';
import {
  completeProviderHttpDispatch,
  prepareProviderHttpDispatch,
  RESEARCH_ROW_EGRESS_POLICY,
  type AgentRunRequest,
  type AskTraceObserverV1,
} from '@zlens/agent';
import {
  agentRunProviderDispatchBudgetForMode,
  createRouterInterpretationProviderTrace,
  createProviderDispatchTrace,
  RunScopedProviderDispatchEvidence,
  startLocalServer,
} from './local-runtime.js';
import { saveProviderSettings } from './settings/provider-settings.js';

afterEach(() => vi.unstubAllGlobals());

const dispatchEvent = {
  provider: 'ollama' as const,
  operation: 'generate' as const,
  attemptIndex: 1,
  envelope: { messages: [{ role: 'user', content: 'bounded research follow-up' }] },
};

/** A minimal in-memory observer for the local provider-boundary harness. */
function providerTraceRecorder() {
  const spans: Array<{
    id: string;
    start: Record<string, unknown>;
    finish?: Record<string, unknown>;
  }> = [];
  let sequence = 0;
  const observer: AskTraceObserverV1 = {
    recordingStatus: 'recording',
    enabled: true,
    startSpan: (input) => {
      const id = `span-${++sequence}`;
      spans.push({ id, start: input as unknown as Record<string, unknown> });
      return id;
    },
    finishSpan: (spanId, input) => {
      const span = spans.find((candidate) => candidate.id === spanId);
      if (span) span.finish = input as unknown as Record<string, unknown>;
    },
    recordCandidateDecision: () => {},
    recordLink: () => {},
    finalize: () => undefined,
    markPartial: () => {},
    reference: () => undefined,
  };
  return { observer, spans };
}

function providerAttempt(span: { start: Record<string, unknown>; finish?: Record<string, unknown> }) {
  const payload = (span.finish?.payload ?? span.start.payload) as {
    kind?: string;
    attempt?: Record<string, unknown>;
  } | undefined;
  return payload?.attempt;
}

it('still narrates after generation has spent its whole budget', () => {
  // The regression this pins: narration used to share `generationGroup`, so a
  // run that used its generation attempts had nothing left to write the answer
  // and threw PROVIDER_DISPATCH_BUDGET_EXHAUSTED. The user saw the deterministic
  // draft instead of prose, with no error anywhere.
  const run = new RunScopedProviderDispatchEvidence({
    total: 6, meaningResolution: 1, generationGroup: 2, narration: 2, repair: 1,
  });
  run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  });
  run.observe({ ...dispatchEvent, attemptIndex: 2 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  });
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));

  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 4 }, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: false,
  })).not.toThrow();
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 5 }, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: false,
  })).not.toThrow();
  // Narration has its own ceiling; it is not unbounded.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 6 }, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
});

it('rejects legacy ordinary narration result rows before it creates a receipt', () => {
  const withLimit = (maxNarrationRows: number) => new RunScopedProviderDispatchEvidence(
    { total: 6, meaningResolution: 1, generationGroup: 3, narration: 2, repair: 1 },
    undefined,
    { maxNarrationRows, maxToolRows: 0, source: 'project_config', policyId: 'test-policy' },
  );

  const permissiveLegacyRun = withLimit(20);
  expect(() => permissiveLegacyRun.observe(dispatchEvent, {
    purpose: 'answer_narration', dispatchPhase: 'narration', optIn: true,
    serializedResultShape: { resultRowCount: 20, columnCount: 2 },
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));
  expect(permissiveLegacyRun.snapshot().providerEgressReceipts).toHaveLength(0);

  // A zero/manual policy is also denied. Result-bearing `answer_narration`
  // has no modern authorization path; only Research may mint one.
  expect(() => withLimit(0).observe(dispatchEvent, {
    purpose: 'answer_narration', dispatchPhase: 'narration', optIn: true,
    serializedResultShape: { resultRowCount: 1, columnCount: 2 },
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));
});

it('enforces explicit Research narration and local-analysis physical egress caps per run', () => {
  const collector = () => new RunScopedProviderDispatchEvidence({
    total: 8, meaningResolution: 1, generationGroup: 8, narration: 2, repair: 1,
  }, undefined, RESEARCH_ROW_EGRESS_POLICY);
  const run = collector();

  expect(() => run.observe(dispatchEvent, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: true,
    serializedResultShape: { resultRowCount: 20, columnCount: 2 }, cumulativeResultRowCount: 20,
  })).not.toThrow();
  expect(() => run.observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 200, columnCount: 4 }, cumulativeResultRowCount: 200,
  })).not.toThrow();
  expect(run.snapshot().providerEgressReceipts.map((receipt) => ({ purpose: receipt.purpose, rows: receipt.resultRowCount })))
    .toEqual([
      { purpose: 'research_narration', rows: 20 },
      { purpose: 'research_tool', rows: 200 },
    ]);

  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 201, columnCount: 1 }, cumulativeResultRowCount: 201,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_LIMIT_EXCEEDED' }));
  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: true,
    serializedResultShape: { resultRowCount: 21, columnCount: 1 }, cumulativeResultRowCount: 21,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_LIMIT_EXCEEDED' }));
  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: false,
    serializedResultShape: { resultRowCount: 1, columnCount: 1 }, cumulativeResultRowCount: 1,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));

  // Consent and cumulative counters are per collector/run; a new run begins at zero.
  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 200, columnCount: 4 }, cumulativeResultRowCount: 200,
  })).not.toThrow();
});

it('pairs an opted-in Research narration receipt with exactly one physical provider trace attempt', () => {
  const run = new RunScopedProviderDispatchEvidence(
    { total: 4, meaningResolution: 1, generationGroup: 2, narration: 1, repair: 0 },
    undefined,
    RESEARCH_ROW_EGRESS_POLICY,
  );
  const { observer, spans } = providerTraceRecorder();
  const trace = createProviderDispatchTrace({
    observer,
    phase: 'narration',
    purpose: 'research_narration',
    admit: (event) => run.observe(event, {
      purpose: 'research_narration',
      dispatchPhase: 'narration',
      optIn: true,
      serializedResultShape: { resultRowCount: 2, columnCount: 2 },
      cumulativeResultRowCount: 2,
    }),
  });
  const options = { ...trace.options, model: 'research-narrator-test' };
  prepareProviderHttpDispatch({
    provider: 'ollama', operation: 'generate', attemptIndex: 1,
    envelope: dispatchEvent.envelope, options,
  });
  completeProviderHttpDispatch({
    provider: 'ollama', operation: 'generate', attemptIndex: 1, options,
  }, { outcome: 'ok', settlement: 'transport', httpStatus: 200 });
  trace.settle('ok');

  expect(run.snapshot().providerEgressReceipts).toEqual([
    expect.objectContaining({
      purpose: 'research_narration', dispatchPhase: 'narration',
      resultRowCount: 2, columnCount: 2, optIn: true,
    }),
  ]);
  expect(spans).toHaveLength(1);
  expect(providerAttempt(spans[0]!)).toMatchObject({
    phase: 'narration', purpose: 'research_narration', admission: 'admitted',
  });
  expect(spans[0]?.finish).toMatchObject({ outcome: 'ok', reasonCode: 'completed' });
});

it('records a denied Research row-egress admission without a receipt or admitted trace attempt', () => {
  const run = new RunScopedProviderDispatchEvidence(
    { total: 4, meaningResolution: 1, generationGroup: 2, narration: 1, repair: 0 },
    undefined,
    RESEARCH_ROW_EGRESS_POLICY,
  );
  const { observer, spans } = providerTraceRecorder();
  const trace = createProviderDispatchTrace({
    observer,
    phase: 'narration',
    purpose: 'research_narration',
    admit: (event) => run.observe(event, {
      purpose: 'research_narration',
      dispatchPhase: 'narration',
      // The transport asks to serialize a result row but no one-run consent
      // was supplied. This must stop before any HTTP body can be admitted.
      optIn: false,
      serializedResultShape: { resultRowCount: 1, columnCount: 1 },
      cumulativeResultRowCount: 1,
    }),
  });
  const options = { ...trace.options, model: 'research-narrator-test' };
  expect(() => prepareProviderHttpDispatch({
    provider: 'ollama', operation: 'generate', attemptIndex: 1,
    envelope: dispatchEvent.envelope, options,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));
  // The outer provider error must not fabricate a second unknown attempt.
  trace.settle('error', Object.assign(new Error('result rows blocked'), { code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));

  expect(run.snapshot().providerEgressReceipts).toHaveLength(0);
  expect(spans).toHaveLength(1);
  expect(providerAttempt(spans[0]!)).toMatchObject({
    phase: 'narration', purpose: 'research_narration', admission: 'denied',
    cause: 'admission_denied', safeAction: 'inspect_run',
  });
  expect(spans[0]?.finish).toMatchObject({ outcome: 'denied', reasonCode: 'provider_failure' });
});

it('reserves one third ordinary Ask send for a single frozen-plan provider repair', () => {
  const run = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('ask'));

  expect(() => run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'meaning_resolution', optIn: false,
  })).not.toThrow();
  expect(() => run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).not.toThrow();
  // A repair is a separately typed, same-plan capability. The answer loop only
  // mints this phase after its frozen exploratory authority check; the ledger
  // makes room for it without allowing a second generation/replan.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 2 }, {
    purpose: 'repair_sql', dispatchPhase: 'repair', optIn: false,
  })).not.toThrow();
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'repair_sql', dispatchPhase: 'repair', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 4 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
  expect(run.snapshot().providerEgressReceipts).toHaveLength(3);
  expect(run.snapshot().providerEgressReceipts.map((receipt) => receipt.dispatchPhase)).toEqual([
    'meaning_resolution',
    'generation',
    'repair',
  ]);
});

it('admits exactly one initial planner and one verifier-directed targeted revision in the CLI ledger', () => {
  const run = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('ask'));

  // This uses the CLI host ledger rather than the runtime's injected planner
  // seam: the second call is the physical egress that previously died because
  // planning shared the one generation slot.
  expect(() => run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'planning', planningKind: 'initial', optIn: false,
  })).not.toThrow();
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 2 }, {
    purpose: 'answer_generation', dispatchPhase: 'planning', planningKind: 'targeted_revision', optIn: false,
  })).not.toThrow();
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'answer_generation', dispatchPhase: 'planning', planningKind: 'targeted_revision', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 4 }, {
    purpose: 'answer_generation', dispatchPhase: 'planning', planningKind: 'initial', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
  // SQL generation retains its independent one-send cap; planner turns do not
  // consume it.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 5 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).not.toThrow();
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 6 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
  expect(run.snapshot().providerEgressReceipts.map((receipt) => receipt.dispatchPhase)).toEqual([
    'planning',
    'planning',
    'generation',
  ]);
});

it('sends exactly two planner transports through the real CLI planning bridge only after targeted recovery', () => {
  const ledger = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('ask'));
  const request: AgentRunRequest = {
    runId: 'ask-planning-revision-egress',
    question: 'show revenue by product',
    requestedMode: 'ask',
  };
  let physicalSends = 0;
  const sendPlanning = (planningKind: 'initial' | 'targeted_revision') => {
    const trace = createRouterInterpretationProviderTrace({
      request,
      routerPhase: 'planning',
      planningKind,
      ledger,
    });
    const options = { maxProviderDispatches: 1, ...trace.options };
    prepareProviderHttpDispatch({
      provider: 'ollama',
      operation: 'generate',
      attemptIndex: 1,
      envelope: dispatchEvent.envelope,
      options,
    });
    // This line is deliberately after prepareProviderHttpDispatch: a ledger
    // denial must prove that no provider transport body would have started.
    physicalSends += 1;
    completeProviderHttpDispatch({
      provider: 'ollama', operation: 'generate', attemptIndex: 1, options,
    }, { outcome: 'ok', settlement: 'transport', httpStatus: 200 });
    trace.settle('ok');
  };

  sendPlanning('initial');
  sendPlanning('targeted_revision');
  expect(physicalSends).toBe(2);
  expect(ledger.snapshot().providerEgressReceipts).toEqual([
    expect.objectContaining({ dispatchPhase: 'planning' }),
    expect.objectContaining({ dispatchPhase: 'planning' }),
  ]);

  // A second revision is denied at the same CLI physical-send bridge; it is
  // not merely rejected by an in-memory counter after egress.
  expect(() => sendPlanning('targeted_revision')).toThrow(expect.objectContaining({
    code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED',
  }));
  expect(physicalSends).toBe(2);
  expect(ledger.snapshot().providerEgressReceipts).toHaveLength(2);
});

it('admits one parent-bound transient retry without turning it into a second generation budget', () => {
  const run = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('ask'));
  const first = { ...dispatchEvent, attemptIndex: 1 };
  const retry = { ...dispatchEvent, attemptIndex: 2 };

  run.observe(first, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  });
  // The retry retains phase/purpose/provider identity and consumes the total
  // budget, but is not rejected merely because the normal generation group is
  // one physical send.
  run.observe(retry, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
    retryOfAttemptIndex: 1,
  });
  expect(run.snapshot().providerEgressReceipts).toEqual([
    expect.objectContaining({ attemptIndex: 1, dispatchPhase: 'generation' }),
    expect.objectContaining({ attemptIndex: 2, dispatchPhase: 'generation', retryOfAttemptIndex: 1 }),
  ]);
  // No retry chaining, cross-phase borrowing, or repair retry is admitted.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
    retryOfAttemptIndex: 2,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_RETRY_NOT_ALLOWED' }));
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'repair_sql', dispatchPhase: 'repair', optIn: false,
    retryOfAttemptIndex: 1,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_RETRY_NOT_ALLOWED' }));
});

it('keeps legacy category classification distinct from candidate-ID meaning resolution', () => {
  const run = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('ask'));

  run.observe(dispatchEvent, {
    purpose: 'classification', dispatchPhase: 'classification', optIn: false,
  });
  expect(run.snapshot().providerEgressReceipts).toEqual([
    expect.objectContaining({ purpose: 'classification', dispatchPhase: 'classification', resultRowCount: 0 }),
  ]);
  // A category-only prompt has no qualified candidate binding. It must never
  // be followed by (or presented as) a candidate-ID meaning resolution.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 2 }, {
    purpose: 'answer_generation', dispatchPhase: 'meaning_resolution', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_INTERPRETATION_PHASE_CONFLICT' }));
  expect(run.snapshot().providerEgressReceipts).toHaveLength(1);
});

it('caps explicit Research at sixteen physical sends with no seventeenth receipt', () => {
  const run = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('research'));
  run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'meaning_resolution', optIn: false,
  });
  run.observe({ ...dispatchEvent, attemptIndex: 1 }, {
    purpose: 'answer_generation', dispatchPhase: 'planning', optIn: false,
  });
  for (let attemptIndex = 1; attemptIndex <= 12; attemptIndex += 1) {
    run.observe({ ...dispatchEvent, attemptIndex }, {
      purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
    });
  }
  run.observe({ ...dispatchEvent, attemptIndex: 14 }, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: false,
  });
  run.observe({ ...dispatchEvent, attemptIndex: 15 }, {
    purpose: 'repair_sql', dispatchPhase: 'repair', optIn: false,
  });

  expect(run.snapshot().providerEgressReceipts).toHaveLength(16);
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 16 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
  expect(run.snapshot().providerEgressReceipts).toHaveLength(16);
});

it('isolates dispatch receipts across concurrent HTTP AgentRuns', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-concurrent-egress-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  saveProviderSettings(projectRoot, {
    id: 'openai', enabled: true, apiKey: 'secret',
    baseUrl: 'https://concurrent-egress.example.test/v1', model: 'probe-model',
  });
  const nativeFetch = globalThis.fetch;
  const providerBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith('https://concurrent-egress.example.test/')) return nativeFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    providerBodies.push(body);
    // The Ask pipeline's one interpreter read: a conversational intent
    // answers without a warehouse and without a second send.
    const content = JSON.stringify({
      version: 1, kind: 'conversation', reading: 'A request to explain revenue.', reply: 'A bounded explanation.',
      measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
    });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));

  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      // Exercise per-run isolation of the pipeline's dispatch ledger.
      preferredPort: 0,
      captureServer: (value) => { server = value; },
    });
    const submit = async (canary: string) => {
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/agent-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: `How should I explain revenue to ${canary}?`,
          requestedMode: 'ask',
        }),
      });
      expect(response.status).toBe(201);
      return (await response.json() as { run: any }).run;
    };
    const [alpha, beta] = await Promise.all([submit('RUN_ALPHA'), submit('RUN_BETA')]);
    // Each run's receipts account for exactly its own send: one physical
    // send per run here, carrying that run's canary and nobody else's. (A
    // native tool dispatch is receipted at the wrapper envelope, so its
    // fingerprint is not the HTTP body's; the isolation property is the point.)
    const bodiesFor = (canary: string) => providerBodies.filter((body) => JSON.stringify(body).includes(canary));
    expect(bodiesFor('RUN_ALPHA')).toHaveLength(1);
    expect(bodiesFor('RUN_BETA')).toHaveLength(1);
    expect(alpha.providerEgressReceipts).toHaveLength(1);
    expect(beta.providerEgressReceipts).toHaveLength(1);
    expect(alpha.telemetry.providerRoundTrips).toBe(1);
    expect(beta.telemetry.providerRoundTrips).toBe(1);
    expect(alpha.providerEgressReceipts[0].payloadFingerprint).not.toBe(beta.providerEgressReceipts[0].payloadFingerprint);
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 30_000);

it('stops before starting a dispatch the deadline cannot fit', () => {
  // The regression this pins: a provider costing ~13s a call burned the whole
  // 45s deadline in three calls and was killed mid-flight, so the run ended
  // with NO answer — strictly worse than stopping early and answering from
  // what it already gathered.
  let nowMs = 0;
  const budget = {
    startedAtMs: 0,
    hardDeadlineMs: 45_000,
    hardSignal: new AbortController().signal,
    mode: 'ask' as const,
    elapsedMs: () => nowMs,
    remainingMs: () => Math.max(0, 45_000 - nowMs),
    softTargetMs: () => 30_000,
    mayStartDiscovery: () => true,
    narrationSoftTargetMs: () => 38_000,
    mayStartNarration: () => true,
    hostFloorReserveMs: 0,
    mayStartHostFloor: () => true,
  };
  const run = new RunScopedProviderDispatchEvidence(
    { total: 6, meaningResolution: 1, generationGroup: 3, narration: 2, repair: 1 },
    budget,
  );

  // Two real dispatches, 13s apart, teach the sink what this provider costs.
  expect(() => run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).not.toThrow();
  nowMs = 13_000;
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 2 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).not.toThrow();

  // 32s in: 13s left, which cannot fit another ~13s call plus settle time.
  nowMs = 32_000;
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'RUN_DEADLINE_INSUFFICIENT' }));

  // Narration is exempt — it is the step that turns gathered work into an answer.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 4 }, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: false,
  })).not.toThrow();
});
