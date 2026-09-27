import { afterEach, describe, expect, it } from 'vitest';
import {
  consultKnowledge,
  createKnowledgeSession,
  knowledgeContextSource,
  knowledgeForAnswer,
  knowledgeOnlyFigures,
  withoutFigures,
  withoutKnowledgeOnlyFigures,
  KNOWLEDGE_FETCH_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  type KnowledgeActivity,
  type KnowledgeSource,
} from './index.js';
import { setAgentToolGate } from '../agentic/tool-gate.js';
import { AgentRunEngine } from '../agent-run-engine.js';
import type { AgentMessage, AgentProvider } from '../providers/types.js';

const HANDBOOK = 'A claim counts as paid when a payment has cleared. Last year 1,234 claims were paid on average per week.';

function handbookSource(overrides: Partial<KnowledgeSource> = {}): KnowledgeSource & { searched: string[] } {
  const searched: string[] = [];
  return {
    id: 'confluence',
    label: 'Confluence',
    searched,
    async search(query) {
      searched.push(query);
      return [{ id: 'page-1', title: 'Claims handbook', url: 'https://docs.example/claims-handbook', snippet: 'A claim counts as paid when…' }];
    },
    async fetch(id) {
      if (id !== 'page-1') throw new Error('not found');
      return { id, title: 'Claims handbook', url: 'https://docs.example/claims-handbook', text: HANDBOOK };
    },
    ...overrides,
  };
}

/** A text-protocol model: each reply in turn, recording what it was shown. */
function scripted(replies: string[]): AgentProvider & { seen: AgentMessage[][] } {
  const seen: AgentMessage[][] = [];
  return {
    name: 'ollama',
    seen,
    available: async () => true,
    async generate(messages) {
      seen.push(messages.map((message) => ({ ...message })));
      return replies.shift() ?? 'NONE';
    },
  } as AgentProvider & { seen: AgentMessage[][] };
}

const call = (tool: string, input: unknown) => '```json\n' + JSON.stringify({ tool, input }) + '\n```';

afterEach(() => setAgentToolGate(null));

describe('knowledge session', () => {
  it('offers only a read-only search and page read, and none without a source', () => {
    expect(createKnowledgeSession([]).tools()).toEqual([]);
    const names = createKnowledgeSession([handbookSource()]).tools().map((tool) => tool.name);
    expect(names).toEqual([KNOWLEDGE_SEARCH_TOOL, KNOWLEDGE_FETCH_TOOL]);
  });

  it('cites the pages it read and records ids, links and outcomes, never words or text', async () => {
    const activity: KnowledgeActivity[] = [];
    const session = createKnowledgeSession([handbookSource()], { onActivity: (entry) => activity.push(entry) });
    const hits = await session.search('what counts as a paid claim');
    expect(hits).toEqual([expect.objectContaining({ source: 'confluence', id: 'page-1', title: 'Claims handbook' })]);
    expect(session.citations()).toEqual([]);
    await session.fetch('confluence', 'page-1');
    await session.fetch('confluence', 'page-1');
    expect(session.citations()).toEqual([{ sourceId: 'confluence', sourceLabel: 'Confluence', docId: 'page-1', title: 'Claims handbook', url: 'https://docs.example/claims-handbook' }]);
    expect(activity).toEqual([
      { action: 'search', sourceId: 'confluence', outcome: 'ok', resultCount: 1 },
      { action: 'fetch', sourceId: 'confluence', docId: 'page-1', url: 'https://docs.example/claims-handbook', outcome: 'ok' },
      { action: 'fetch', sourceId: 'confluence', docId: 'page-1', url: 'https://docs.example/claims-handbook', outcome: 'ok' },
    ]);
    expect(JSON.stringify(activity)).not.toMatch(/paid claim|counts as paid/);
  });

  it('reads only pages a search in this answer returned', async () => {
    const activity: KnowledgeActivity[] = [];
    const session = createKnowledgeSession([handbookSource()], { onActivity: (entry) => activity.push(entry) });
    await expect(session.fetch('confluence', 'page-1')).rejects.toThrow(/returned by search_knowledge/);
    expect(activity).toEqual([{ action: 'fetch', sourceId: 'confluence', docId: 'page-1', outcome: 'refused' }]);
  });

  it('keeps going past a source that fails, and records the failure', async () => {
    const activity: KnowledgeActivity[] = [];
    const broken = handbookSource({ id: 'wiki', label: 'Wiki', search: async () => { throw new Error('401'); } });
    const session = createKnowledgeSession([broken, handbookSource()], { onActivity: (entry) => activity.push(entry) });
    const hits = await session.search('paid claim');
    expect(hits.map((hit) => hit.source)).toEqual(['confluence']);
    expect(activity).toContainEqual({ action: 'search', sourceId: 'wiki', outcome: 'error' });
  });

  it('drops links that are not http(s)', async () => {
    const session = createKnowledgeSession([handbookSource({ search: async () => [{ id: 'p', title: 'T', url: 'javascript:alert(1)' }] })]);
    const [hit] = await session.search('x');
    expect(hit.url).toBeUndefined();
  });
});

describe('consulting knowledge for an answer', () => {
  it('runs search and read through the tool gate, cites the page and keeps no figure from it', async () => {
    const gated: Array<{ name: string }> = [];
    setAgentToolGate(async (toolCall, next) => {
      gated.push({ name: toolCall.name });
      return next();
    });
    const session = createKnowledgeSession([handbookSource()]);
    const provider = scripted([
      call(KNOWLEDGE_SEARCH_TOOL, { query: 'paid claim definition' }),
      call(KNOWLEDGE_FETCH_TOOL, { source: 'confluence', id: 'page-1' }),
      'The Claims handbook says a claim counts as paid once its payment has cleared. It also says 1,234 claims are paid a week.',
    ]);
    const knowledge = await consultKnowledge({ provider, question: 'What counts as a paid claim, and how many were paid last week?', session });
    expect(gated.map((entry) => entry.name)).toEqual([KNOWLEDGE_SEARCH_TOOL, KNOWLEDGE_FETCH_TOOL]);
    expect(knowledge).toEqual({
      version: 1,
      note: 'The Claims handbook says a claim counts as paid once its payment has cleared.',
      citations: [expect.objectContaining({ docId: 'page-1', title: 'Claims handbook' })],
      contextOnly: true,
      figuresRemoved: 1,
    });
    // The model was told documents are never a figure source.
    expect(provider.seen[0].map((message) => message.content).join('\n')).toMatch(/Never report a number from a document/);
  });

  it('has no knowledge when the gate refuses the search', async () => {
    setAgentToolGate(async (toolCall, next) => {
      if (toolCall.name === KNOWLEDGE_SEARCH_TOOL) throw new Error('refused');
      return next();
    });
    const session = createKnowledgeSession([handbookSource()]);
    const provider = scripted([call(KNOWLEDGE_SEARCH_TOOL, { query: 'paid claim' }), 'Nothing found.']);
    expect(await consultKnowledge({ provider, question: 'What counts as a paid claim?', session })).toBeUndefined();
  });

  it('has no knowledge without a source, and asks no model', async () => {
    const provider = scripted([]);
    expect(await consultKnowledge({ provider, question: 'What counts as a paid claim?', session: createKnowledgeSession([]) })).toBeUndefined();
    expect(provider.seen).toHaveLength(0);
  });

  it('keeps the citation but no note when the model says NONE', () => {
    const knowledge = knowledgeForAnswer({ citations: () => [{ sourceId: 's', sourceLabel: 'S', docId: 'd', title: 'T' }] }, 'NONE');
    expect(knowledge).toEqual({ version: 1, citations: [expect.objectContaining({ docId: 'd' })], contextOnly: true });
  });
});

describe('figures', () => {
  it('takes every figure out of a note, but not years or small counts', () => {
    expect(withoutFigures('Paid means cleared. About $4.2M paid. Paid in 12% of cases. Since 2024, 3 teams agree.')).toEqual({ text: 'Paid means cleared. Since 2024, 3 teams agree.', removed: 2 });
  });

  it('finds answer figures that only a document holds, and removes their sentences', () => {
    const docs = [HANDBOOK];
    expect(knowledgeOnlyFigures('Paid claims last week: 412. The handbook average is 1,234.', docs, [412])).toEqual(['1234']);
    expect(knowledgeOnlyFigures('Paid claims last week: 1,234.', docs, ['1234'])).toEqual([]);
    expect(withoutKnowledgeOnlyFigures('Paid claims last week: 412. The handbook average is 1,234.', ['1234'])).toBe(
      'Paid claims last week: 412. A figure taken from a document was left out: answer figures come only from governed queries.',
    );
  });
});

describe('research context', () => {
  it('gathers cited context through the gate after framing only', async () => {
    const gated: string[] = [];
    setAgentToolGate(async (toolCall, next) => { gated.push(toolCall.name); return next(); });
    const session = createKnowledgeSession([handbookSource()]);
    const source = knowledgeContextSource(session);
    const frame = { question: 'Why did paid claims drop?', metric: { label: 'Claims paid' } } as never;
    expect(await source.gather({ frame, stage: 'after_drivers', budgetMs: 1000 })).toEqual([]);
    const items = await source.gather({ frame, stage: 'after_frame', budgetMs: 1000 });
    expect(items).toEqual([{ sourceId: 'confluence', title: 'Claims handbook', excerpt: 'A claim counts as paid when a payment has cleared.', url: 'https://docs.example/claims-handbook', provenance: 'external' }]);
    expect(gated).toEqual([KNOWLEDGE_SEARCH_TOOL, KNOWLEDGE_FETCH_TOOL]);
    expect(session.citations()).toHaveLength(1);
  });
});

describe('trust', () => {
  it.each(['review_required', 'certified'] as const)('a %s answer keeps its trust when it cites a document', async (trustState) => {
    const knowledge = { version: 1 as const, citations: [{ sourceId: 'confluence', sourceLabel: 'Confluence', docId: 'page-1', title: 'Claims handbook' }], contextOnly: true as const };
    const run = (withKnowledge: boolean) => new AgentRunEngine({
      idGenerator: () => `run-${trustState}-${withKnowledge}`,
      executors: {
        generated_answer: () => ({ answer: 'Paid claims last week: 412.', status: trustState === 'certified' ? 'completed' : 'needs_review', trustState, ...(withKnowledge ? { knowledge } : {}) }),
      },
    }).run({ question: 'How many claims were paid last week?', requestedMode: 'ask', intent: 'ad_hoc_ranking', askAgentRuntimeMode: 'pipeline_v3' } as never);
    const [plain, cited] = await Promise.all([run(false), run(true)]);
    expect(cited.knowledge).toEqual(knowledge);
    expect(plain.knowledge).toBeUndefined();
    expect(cited.trustState).toBe(plain.trustState);
    expect(cited.status).toBe(plain.status);
  });
});
