import { describe, expect, it } from 'vitest';
import {
  createKnowledgeSession,
  KNOWLEDGE_FETCH_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  type AgentProvider,
  type AgentRouteExecutorResult,
  type KnowledgeSource,
} from '@duckcodeailabs/dql-agent';
import { readingOf, withAnswerKnowledge } from './answer-knowledge.js';

/**
 * RFC 0010 HH-15: an answer that cites a team document loses a sentence only
 * when it states a figure only the document holds. The governed answer's own
 * reading (the period it read) is never touched, whatever the document says.
 */
const HANDBOOK = 'A paid claim is a claim with at least one payment that has cleared. In 2025 the team paid 1,250 claims. Payments clear within 20 days.';
const READING = 'claims paid in the last full week (14–20 September 2026)';
const SQL = "SELECT COUNT(*) AS paid_claims FROM claim_payments WHERE paid_date >= '2026-09-14' AND paid_date < '2026-09-21'";

const handbook: KnowledgeSource = {
  id: 'confluence',
  label: 'Confluence',
  async search() { return [{ id: 'page-1', title: 'Claims handbook', url: 'https://docs.example/claims-handbook', snippet: 'A paid claim is…' }]; },
  async fetch(id) { return { id, title: 'Claims handbook', url: 'https://docs.example/claims-handbook', text: HANDBOOK }; },
};

const call = (tool: string, input: unknown) => '```json\n' + JSON.stringify({ tool, input }) + '\n```';
function model(): AgentProvider {
  const replies = [call(KNOWLEDGE_SEARCH_TOOL, { query: 'paid claim' }), call(KNOWLEDGE_FETCH_TOOL, { source: 'confluence', id: 'page-1' }), 'The Claims handbook says a claim counts as paid once a payment has cleared.'];
  return { name: 'ollama', available: async () => true, generate: async () => replies.shift() ?? 'NONE' } as AgentProvider;
}

function governed(answer: string): AgentRouteExecutorResult {
  return {
    summary: answer, answer, status: 'completed', trustState: 'governed',
    artifacts: [{ id: 'r:answer', kind: 'answer', title: 'Semantic answer', trustState: 'governed', payload: { sql: SQL, result: { columns: ['paid_claims'], rows: [{ paid_claims: 11 }], rowCount: 1 }, askIntentV1: { reading: READING } } }],
    evaluations: [], nextActions: [],
  } as unknown as AgentRouteExecutorResult;
}

describe('a cited answer keeps its own reading', () => {
  const question = 'What counts as a paid claim, and how many were paid last week?';

  it('the reading\'s dates are the answer\'s own: nothing is removed and nothing is said to be left out', async () => {
    const answer = `I read this as: ${READING}. paid claims: 11. Source: the semantic layer.`;
    expect(readingOf(governed(answer))).toBe(READING);
    const cited = await withAnswerKnowledge({ result: governed(answer), question, session: createKnowledgeSession([handbook]), provider: model() });
    expect(cited.knowledge?.citations).toHaveLength(1);
    expect(cited.answer).toBe(answer);
  });

  it('a sentence beyond the reading that states a document-only figure still goes; the reading and the governed figure stay', async () => {
    const answer = `I read this as: ${READING}. paid claims: 11. The handbook counts 1,250 paid claims a year. Source: the semantic layer.`;
    const cited = await withAnswerKnowledge({ result: governed(answer), question, session: createKnowledgeSession([handbook]), provider: model() });
    expect(cited.answer).toBe(`I read this as: ${READING}. paid claims: 11. Source: the semantic layer. A figure taken from a document was left out: answer figures come only from governed queries.`);
    expect(cited.trustState).toBe('governed');
  });
});
