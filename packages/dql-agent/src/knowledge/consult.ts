/**
 * The Ask side of knowledge sources: after the governed answer is made, the
 * model may look up what the team's documents say about the question's terms,
 * with two read-only tools (search, read a page). Every call runs through the
 * one tool gate (HH-7). What comes back is a short, figure-free note and the
 * pages it read — kept beside the answer, never inside its trust decision.
 */
import type { AgentMessage, AgentProvider, AgentToolDefinition, ProviderRunOptions } from '../providers/types.js';
import type { InvestigationContextItemV1, InvestigationContextSource } from '../research/investigation/types.js';
import { runAgenticToolLoopDetailed } from '../agentic/tool-loop.js';
import { runGatedTool } from '../agentic/tool-gate.js';
import { foldFigures } from './figures.js';
import {
  KNOWLEDGE_CONTRACT,
  KNOWLEDGE_FETCH_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  type KnowledgeCitation,
  type KnowledgeSession,
} from './knowledge.js';

/** What an answer carries from knowledge sources. Stored on the run as `knowledge`. */
export interface AgentRunKnowledgeV1 {
  version: 1;
  /** A short note on what the documents say; never a figure. Absent when nothing relevant was read. */
  note?: string;
  /** The pages the answer read, shown under it. */
  citations: KnowledgeCitation[];
  /** Always true: citations are context and never changed the answer's trust. */
  contextOnly: true;
  /** Set when a figure was removed from the note. */
  figuresRemoved?: number;
}

const NONE = 'NONE';

const SYSTEM = `You look up what the team's documents say about the business terms in a question, so the answer can cite them.
You do NOT answer the data part of the question: a governed query already did that.
Use ${KNOWLEDGE_SEARCH_TOOL} to find pages, then ${KNOWLEDGE_FETCH_TOOL} to read at most two that matter.
Then reply in plain text, at most three sentences, saying what the documents say and naming each page by its title.
Never write a number, count, amount, percentage or date from a document. ${KNOWLEDGE_CONTRACT}
If the documents say nothing relevant, reply exactly ${NONE}.`;

function knowledgeTextContract(tools: readonly AgentToolDefinition[], maxToolCalls: number): string {
  const lines = tools.map((tool) => {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    return `- ${tool.name}(${Object.keys(props).join(', ')}): ${tool.description}`;
  });
  return [
    `You may call up to ${maxToolCalls} tools, one per reply. To call one, reply with ONLY a fenced JSON block:`,
    '```json\n{"tool":"<name>","input":{...}}\n```',
    'Tools:',
    ...lines,
    `When you are done, reply in plain text (no JSON), or exactly ${NONE}.`,
  ].join('\n');
}

export interface ConsultKnowledgeInput {
  provider: AgentProvider;
  question: string;
  session: KnowledgeSession;
  /** Provider options for each dispatch (egress accounting, cancellation). */
  providerOptions?: ProviderRunOptions;
  maxToolCalls?: number;
}

/**
 * Ask the model to read the team's documents for this question. Returns
 * undefined when there is no source or nothing was read; any failure is
 * "no knowledge" (the governed answer stands on its own).
 */
export async function consultKnowledge(input: ConsultKnowledgeInput): Promise<AgentRunKnowledgeV1 | undefined> {
  const tools = input.session.tools();
  if (!tools.length || !input.question.trim()) return undefined;
  const messages: AgentMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `QUESTION: ${input.question.trim()}` },
  ];
  let text = '';
  try {
    const result = await runAgenticToolLoopDetailed(input.provider, messages, tools, {
      ...(input.providerOptions ?? {}),
      maxToolCalls: Math.max(1, Math.min(4, input.maxToolCalls ?? 3)),
      textToolContract: knowledgeTextContract,
    });
    text = result.stop === 'final' ? result.text : '';
  } catch {
    text = '';
  }
  return knowledgeForAnswer(input.session, text);
}

/** The knowledge an answer keeps: the pages read and a note with every figure taken out. */
export function knowledgeForAnswer(session: Pick<KnowledgeSession, 'citations'>, modelText: string): AgentRunKnowledgeV1 | undefined {
  const citations = session.citations();
  if (!citations.length) return undefined;
  const raw = modelText.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  const none = !raw || raw.toUpperCase() === NONE;
  const { text, removed } = none ? { text: '', removed: 0 } : withoutFigures(raw.slice(0, 1200));
  return {
    version: 1,
    ...(text ? { note: text } : {}),
    citations,
    contextOnly: true,
    ...(removed ? { figuresRemoved: removed } : {}),
  };
}

/**
 * A knowledge note never carries a figure: it was written from documents, and
 * answer figures come only from governed queries. Every sentence stating one
 * is dropped (years and one-digit counts are not figures).
 */
export function withoutFigures(text: string): { text: string; removed: number } {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.filter((sentence) => !statesFigure(sentence));
  return { text: kept.join(' ').trim(), removed: sentences.length - kept.length };
}

function statesFigure(text: string): boolean {
  // A figure in words, another script's digits, spaced digits or a fraction counts like any other (figures.ts).
  const sentence = foldFigures(text);
  if (/\d\s*\/\s*\d/.test(sentence)) return true;
  for (const raw of sentence.match(/[$€£]?-?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g) ?? []) {
    if (/[$€£%]/.test(raw)) return true;
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    if (Number.isInteger(value) && Math.abs(value) < 10) continue;
    if (Number.isInteger(value) && value >= 1900 && value <= 2100 && !raw.includes(',')) continue;
    return true;
  }
  return false;
}

/**
 * Research's context source over a knowledge session: it searches for the
 * investigation's question and metric and reads the best page, each call
 * through the tool gate. Items are context, never used in a verdict.
 */
export function knowledgeContextSource(session: KnowledgeSession): InvestigationContextSource {
  const tools = new Map(session.tools().map((tool) => [tool.name, tool]));
  return {
    id: 'knowledge',
    kind: 'document',
    async gather({ frame, stage }) {
      if (stage !== 'after_frame') return [];
      const search = tools.get(KNOWLEDGE_SEARCH_TOOL);
      const fetchPage = tools.get(KNOWLEDGE_FETCH_TOOL);
      if (!search || !fetchPage) return [];
      const query = [frame.question, frame.metric?.label].filter(Boolean).join(' ').slice(0, 300);
      const found = await runGatedTool(search, { query, limit: 3 }) as { results?: Array<{ source: string; id: string; title: string; url?: string; snippet?: string }> };
      const items: InvestigationContextItemV1[] = [];
      for (const hit of (found.results ?? []).slice(0, 2)) {
        try {
          const read = await runGatedTool(fetchPage, { source: hit.source, id: hit.id }) as { document?: { title: string; url?: string; text: string } };
          const excerpt = withoutFigures((read.document?.text ?? hit.snippet ?? '').replace(/\s+/g, ' ').slice(0, 400)).text;
          items.push({ sourceId: hit.source, title: read.document?.title ?? hit.title, excerpt, ...(read.document?.url ?? hit.url ? { url: read.document?.url ?? hit.url } : {}), provenance: 'external' });
        } catch {
          // A page that cannot be read is simply not cited.
        }
      }
      return items;
    },
  };
}
