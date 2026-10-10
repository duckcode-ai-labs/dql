import { describe, expect, it } from 'vitest';
import { readByOwnWords } from './lexical-reading.js';
import { runAskPipeline } from './pipeline.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';
import type { AgentMessage, AgentProvider } from '../providers/types.js';

/**
 * The by-own-words reading must yield to everything the model path honours:
 * approved corrections, skills, host guidance, the thread's last analysis, and
 * words that change the question ("per", "with", "list", a second metric).
 */
const base: VocabularySource = {
  metrics: [
    { name: 'claim_count', model: 'claims', label: 'Claims filed', aggregation: 'count' },
    { name: 'paid_amount', model: 'claims', label: 'Paid amount', aggregation: 'sum' },
    { name: 'revenue', model: 'claims', label: 'Revenue', aggregation: 'sum' },
    { name: 'customer', model: 'claims', label: 'Customer', aggregation: 'count' },
  ],
  dimensions: [
    { name: 'region', model: 'claims', label: 'Region', dataType: 'string' },
    { name: 'claim_status', model: 'claims', label: 'Claim status', dataType: 'string' },
  ],
};

describe('the by-own-words reading yields', () => {
  it('reads a plain metric by dimension', () => {
    expect(readByOwnWords('Claims filed by region', buildVocabularyIndex(base))).toBeDefined();
  });

  it('to an approved correction that speaks about the metric', () => {
    const guided = buildVocabularyIndex({ ...base, hints: [{ id: 'h1', title: 'Claims filed excludes withdrawn', guidance: 'Leave out withdrawn claims.', tags: [] }] });
    expect(readByOwnWords('Claims filed by region', guided)).toBeUndefined();
  });

  it('to a selected skill that prefers the metric', () => {
    const guided = buildVocabularyIndex({ ...base, skills: [{ ref: 'skill:claims-desk', id: 'claims-desk', preferredRefs: ['metric:claims.claim_count'] }] });
    expect(readByOwnWords('Claims filed by region', guided)).toBeUndefined();
  });

  it.each([
    ['revenue per customer'],
    ['customers with claims by region'],
    ['list claims by region'],
    ['Claims filed and paid amount by region'],
  ])('to the model for "%s"', (question) => {
    expect(readByOwnWords(question, buildVocabularyIndex(base))).toBeUndefined();
  });
});

function counting(): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  return { name: 'ollama', calls, available: async () => true, generate: async (messages) => { calls.push(messages); return '{}'; } };
}

const ask = (question: string, provider: AgentProvider, extra: Record<string, unknown> = {}) => runAskPipeline({
  question, vocabulary: buildVocabularyIndex(base), provider, clauseCoverage: false,
  prepareDeps: { compileSemantic: async () => ({ sql: 'SELECT 1', engine: 'native' }) },
  executeDeps: { run: async () => ({ columns: ['region', 'claim_count'], rows: [], rowCount: 0, executionTimeMs: 1 }) },
  ...extra,
});

describe('the pipeline asks the model when context applies', () => {
  it('does not call the model for a lone governed question', async () => {
    const provider = counting();
    await ask('Claims filed by region', provider);
    expect(provider.calls).toHaveLength(0);
  });

  it('calls the model when the thread has a prior reading', async () => {
    const first = counting();
    const settled = await ask('Claims filed by region', first);
    if (settled.kind !== 'answered') throw new Error('expected an answer');
    const provider = counting();
    await ask('paid amount by claim status', provider, { prior: settled.intent, priorExecuted: true });
    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it('calls the model when host guidance is present', async () => {
    const provider = counting();
    await ask('Claims filed by region', provider, { guidance: 'Claims are counted by filing date.' });
    expect(provider.calls.length).toBeGreaterThan(0);
  });
});
