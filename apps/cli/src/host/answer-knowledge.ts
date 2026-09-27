/**
 * An Ask answer with the team documents it read (RFC 0010, HH-15).
 *
 * The governed answer is made first and is never changed by what follows,
 * except that a sentence stating a figure only a document holds is removed:
 * answer figures come only from governed queries. The documents' note and
 * citations are kept beside the answer (`knowledge`), and trust, status and
 * the answer's sources are exactly what the governed answer had.
 */
import {
  consultKnowledge,
  knowledgeOnlyFigures,
  withoutKnowledgeOnlyFigures,
  type AgentProvider,
  type AgentRouteExecutorResult,
  type AskStoryStepV1,
  type KnowledgeSession,
  type ProviderRunOptions,
} from '@duckcodeailabs/dql-agent';

type DispatchOptions = (purpose: 'knowledge', request: never) => { options: ProviderRunOptions; settle(outcome: 'ok' | 'error' | 'cancelled', error?: unknown): void };

/** Every knowledge dispatch goes through the run's ledger, like Ask's own calls. */
export function ledgeredProvider<R>(provider: AgentProvider, dispatchOptions: ((purpose: 'knowledge', request: R) => ReturnType<DispatchOptions>) | undefined, request: R): AgentProvider {
  if (!dispatchOptions) return provider;
  return {
    name: provider.name,
    available: () => provider.available(),
    generate: async (messages, options) => {
      const trace = dispatchOptions('knowledge', request);
      try {
        const text = await provider.generate(messages, { ...options, ...trace.options, ...(options?.signal ? { signal: options.signal } : {}) });
        trace.settle('ok');
        return text;
      } catch (error) {
        trace.settle('error', error);
        throw error;
      }
    },
  };
}

/** Every value a governed answer carries: result cells, row counts and its SQL. */
export function governedValuesOf(result: AgentRouteExecutorResult): unknown[] {
  const values: unknown[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'number' || typeof value === 'string') {
      values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 2000)) visit(entry, depth + 1);
      return;
    }
    if (typeof value === 'object') for (const entry of Object.values(value as Record<string, unknown>)) visit(entry, depth + 1);
  };
  for (const artifact of result.artifacts ?? []) {
    const payload = artifact.payload as Record<string, unknown> | undefined;
    visit(payload?.result, 0);
    visit(payload?.sql, 0);
  }
  return values;
}

export async function withAnswerKnowledge(input: {
  result: AgentRouteExecutorResult;
  question: string;
  session: KnowledgeSession | undefined;
  provider: AgentProvider | undefined;
  onStep?: (step: AskStoryStepV1) => void;
}): Promise<AgentRouteExecutorResult> {
  const { result, session, provider } = input;
  if (!session || !provider) return result;
  if (result.status === 'cancelled' || result.answerRefusalCode === 'provider_error') return result;
  const started = Date.now();
  const knowledge = await consultKnowledge({ provider, question: input.question, session });
  if (!knowledge) return result;
  const titles = knowledge.citations.map((citation) => citation.title);
  const step: AskStoryStepV1 = {
    version: 1,
    phase: 'search',
    title: `Read ${titles.length === 1 ? 'a team document' : `${titles.length} team documents`}`,
    detail: `${titles.join(', ')} — cited as context; figures come only from governed queries.`,
    state: 'done',
    ms: Date.now() - started,
    at: Date.now(),
  };
  input.onStep?.(step);
  // Defence in depth: the governed answer never saw a document, but if it
  // states a figure only a document holds, that sentence goes.
  const figures = typeof result.answer === 'string' ? knowledgeOnlyFigures(result.answer, session.documentTexts(), governedValuesOf(result)) : [];
  const receipt = result.askPipelineReceipt as { story?: AskStoryStepV1[] } | undefined;
  return {
    ...result,
    ...(figures.length && typeof result.answer === 'string' ? { answer: withoutKnowledgeOnlyFigures(result.answer, figures) } : {}),
    ...(receipt ? { askPipelineReceipt: { ...receipt, story: [...(receipt.story ?? []), step] } as AgentRouteExecutorResult['askPipelineReceipt'] } : {}),
    knowledge,
  };
}
