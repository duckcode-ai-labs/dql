import { describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { AgentMessage, AgentProvider, AgentRunRequest, AnalyticalIntentV1, VocabularyIndex } from '@duckcodeailabs/dql-agent';
import { createAskPipelineHost, type AskPipelineHostDeps } from './host.js';

const connection = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
const manifest = { sources: { opportunities: { name: 'opportunities', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.opportunities', schema: 'sales', columns: { opportunity_id: { name: 'opportunity_id' }, stage: { name: 'stage' }, amount: { name: 'amount' } } } } } };
const DRAFTER = 'You write exactly ONE read-only SQL statement';

function fixture(options: { reading?: () => string; admitSources?: AskPipelineHostDeps['admitSources'] } = {}) {
  const statements: string[] = [];
  const draftPrompts: string[] = [];
  const readPrompts: string[] = [];
  const purposes: string[] = [];
  const contextPacks = vi.fn(async () => undefined);
  const provider: AgentProvider = {
    name: 'ollama', available: async () => true,
    generate: async (messages: AgentMessage[]) => {
      if (messages[0]!.content.startsWith(DRAFTER)) { draftPrompts.push(messages[1]!.content); return 'SELECT stage, SUM(amount) AS amount FROM sales.opportunities GROUP BY stage'; }
      if (messages[0]!.content === 'research select') return '{"dimensions":["d1"]}';
      readPrompts.push(messages[0]!.content);
      return options.reading?.() ?? '{}';
    },
  };
  const deps: AskPipelineHostDeps = {
    projectRoot: '/tmp/ask-scope',
    executor: { executeQuery: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('information_schema.columns')) {
        return { columns: [], rowCount: 3, executionTimeMs: 1, rows: ['opportunity_id', 'stage', 'amount'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: column === 'amount' ? 'DOUBLE' : 'VARCHAR' })) };
      }
      return { columns: ['stage', 'amount'], rowCount: 2, executionTimeMs: 1, rows: [{ stage: 'won', amount: 5 }, { stage: 'lost', amount: 3 }] };
    }) } as unknown as QueryExecutor,
    resolveConnection: async () => connection,
    getSemanticLayer: () => undefined,
    getManifest: () => ({ snapshotId: 'snapshot:scope', manifest: manifest as never }),
    selectProvider: async () => provider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
    buildContextPack: contextPacks,
    dispatchOptions: (purpose) => { purposes.push(purpose); return { options: {}, settle: () => undefined }; },
    ...(options.admitSources ? { admitSources: options.admitSources } : {}),
  };
  return { host: createAskPipelineHost(deps), statements, draftPrompts, readPrompts, purposes, contextPacks };
}

const context = (emit: (event: unknown) => void = () => undefined) => ({
  runId: 'run:scope', route: 'research' as const, maxRepairAttempts: 0, attempt: 0, emit,
  request: { question: 'Why did the amount change by stage?', requestedMode: 'research' } as AgentRunRequest,
});

const refNamed = (vocabulary: VocabularyIndex, name: string) => vocabulary.entries.find((entry) => (entry.kind === 'column' || entry.kind === 'dimension') && entry.name === name)?.ref;

const amountByStage = (vocabulary: VocabularyIndex): AnalyticalIntentV1 => ({
  version: 1, kind: 'analytics', reading: 'Amount by stage.',
  measures: [{ ref: refNamed(vocabulary, 'amount')!, aggregation: 'sum' }],
  groupBy: [{ ref: refNamed(vocabulary, 'stage')!, role: 'categorical' }],
  display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
} as AnalyticalIntentV1);

describe('one request scope serves several pipeline runs', () => {
  it('assembles the context once; each settled reading gets its own receipt with its own drafting call and no reading', async () => {
    const { host, contextPacks, draftPrompts } = fixture();
    const opened = await host.openScope(context());
    if (!('scope' in opened)) throw new Error('the scope should open');
    const { scope } = opened;
    expect(scope.contextSteps[0]).toMatchObject({ phase: 'context' });
    const intent = amountByStage(scope.vocabulary());
    expect(intent.measures[0]!.ref).toBeTruthy();
    const first = await scope.runIntent(intent, { allowAiSql: true });
    const second = await scope.runIntent(intent, { allowAiSql: true });
    expect(contextPacks).toHaveBeenCalledTimes(1);
    for (const outcome of [first, second]) {
      expect(outcome.kind).toBe('answered');
      expect(outcome.receipt.reuse).toBe('interpretation');
      expect(outcome.receipt.dispatches.filter((dispatch) => dispatch.purpose.startsWith('intent:resolve'))).toEqual([]);
      expect(outcome.receipt.dispatches.filter((dispatch) => dispatch.purpose === 'intent:draft')).toHaveLength(1);
    }
    expect(draftPrompts).toHaveLength(2);
  });

  it('a settled reading over tables is not drafted when the caller does not allow AI-written SQL', async () => {
    const { host, draftPrompts, statements } = fixture();
    const opened = await host.openScope(context());
    if (!('scope' in opened)) throw new Error('the scope should open');
    const outcome = await opened.scope.runIntent(amountByStage(opened.scope.vocabulary()), { allowAiSql: false });
    expect(draftPrompts).toHaveLength(0);
    expect(outcome.kind).not.toBe('answered');
    expect(statements.filter((sql) => !sql.includes('information_schema'))).toEqual([]);
  });

  it('reads a question into its policed reading without preparing or running anything', async () => {
    let vocabulary: VocabularyIndex | undefined;
    const { host, statements, draftPrompts } = fixture({ reading: () => JSON.stringify(amountByStage(vocabulary!)) });
    const opened = await host.openScope(context());
    if (!('scope' in opened)) throw new Error('the scope should open');
    vocabulary = opened.scope.vocabulary();
    const outcome = await opened.scope.read('Why did the amount change by stage?');
    expect(outcome).toMatchObject({ kind: 'reading', lane: 'ai' });
    expect(draftPrompts).toHaveLength(0);
    expect(statements.filter((sql) => !sql.includes('information_schema'))).toEqual([]);
  });

  it('a reading can carry the caller\'s guidance after the project\'s, and keeps a clarification the user picked', async () => {
    let vocabulary: VocabularyIndex | undefined;
    const { host, readPrompts } = fixture({ reading: () => JSON.stringify(amountByStage(vocabulary!)) });
    const scoped = context();
    const opened = await host.openScope(scoped);
    if (!('scope' in opened)) throw new Error('the scope should open');
    vocabulary = opened.scope.vocabulary();
    scoped.request.selectedEvidenceId = refNamed(vocabulary, 'amount');
    const outcome = await opened.scope.read('Why did the amount change by stage?', { guidance: 'THIS QUESTION IS BEING INVESTIGATED BY RESEARCH.' });
    expect(outcome.kind).toBe('reading');
    expect(readPrompts.at(-1)).toContain('PROJECT GUIDANCE\nTHIS QUESTION IS BEING INVESTIGATED BY RESEARCH.');
    expect(readPrompts.at(-1)).toContain('THE MEANING IS ALREADY CHOSEN');
    await opened.scope.read('Amount by stage.');
    expect(readPrompts.at(-1)).not.toContain('BEING INVESTIGATED');
  });

  it('steps of a settled reading go to the caller, not the live stream; Research prompts run on the ledger', async () => {
    const emitted: unknown[] = [];
    const { host, purposes } = fixture();
    const opened = await host.openScope(context((event) => emitted.push(event)));
    if (!('scope' in opened)) throw new Error('the scope should open');
    const before = emitted.length;
    const sink: string[] = [];
    await opened.scope.runIntent(amountByStage(opened.scope.vocabulary()), { allowAiSql: true, onStep: (step) => sink.push(step.title) });
    expect(sink).toContain('Used the settled reading');
    expect(emitted.slice(before).filter((event) => (event as { payload?: { askStep?: unknown } }).payload?.askStep)).toEqual([]);
    expect(await opened.scope.dispatch('research_select', [{ role: 'system', content: 'research select' }, { role: 'user', content: 'x' }])).toBe('{"dimensions":["d1"]}');
    expect(purposes).toContain('research_select');
  });

  it('a request with no AI model gets the blocked result instead of a scope', async () => {
    const { host } = fixture();
    const blockedHost = createAskPipelineHost({
      projectRoot: '/tmp/none', executor: {} as QueryExecutor, resolveConnection: async () => connection, getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:none', manifest: {} as never }), selectProvider: async () => undefined,
      compileSemantic: async () => { throw new Error('unused'); }, priorIntent: () => undefined,
    });
    expect(host).toBeTruthy();
    const opened = await blockedHost.openScope(context());
    expect('blocked' in opened && opened.blocked.answer).toContain('No AI model is configured');
  });
});

describe('sources a person may use (RFC 0010 HH-13)', () => {
  it('builds the vocabulary only from what the host admits for this person', async () => {
    const admitted: string[] = [];
    const { host } = fixture({
      admitSources: {
        key: () => 'u-dev',
        admit: async (source) => { admitted.push('called'); return { ...source, relations: [] }; },
      },
    });
    const opened = await host.openScope(context());
    if (!('scope' in opened)) throw new Error('the scope should open');
    expect(admitted.length).toBeGreaterThan(0);
    expect(refNamed(opened.scope.vocabulary(), 'amount')).toBeUndefined();

    const open = fixture();
    const unfiltered = await open.host.openScope(context());
    if (!('scope' in unfiltered)) throw new Error('the scope should open');
    expect(refNamed(unfiltered.scope.vocabulary(), 'amount')).toBeDefined();
  });
});
