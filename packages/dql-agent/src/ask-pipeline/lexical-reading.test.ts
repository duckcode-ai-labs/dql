import { describe, expect, it } from 'vitest';
import { extractBlockContract } from './block-contract.js';
import { readByOwnWords } from './lexical-reading.js';
import { runAskPipeline } from './pipeline.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';
import type { AgentMessage, AgentProvider } from '../providers/types.js';

/**
 * Sandbox gate W1b: "Claims filed by region" came back Governed one run and
 * "AI-generated answer" the next, because the live model chose the route. A
 * question that is only a governed metric and dimensions, by their own words,
 * is read without the model and answered through the semantic tier.
 */
const harbor: VocabularySource = {
  metrics: [
    { name: 'claim_count', model: 'claims', label: 'Claims filed', aliases: ['claims submitted'], aggregation: 'count' },
    { name: 'paid_amount', model: 'claims', label: 'Paid amount', aggregation: 'sum' },
    { name: 'policy_count', model: 'policies', label: 'Policies in force', aggregation: 'count' },
  ],
  dimensions: [
    { name: 'region', model: 'claims', label: 'Region', aliases: ['territory'], dataType: 'string' },
    { name: 'claim_status', model: 'claims', label: 'Claim status', dataType: 'string' },
    { name: 'channel', model: 'policies', label: 'Channel', dataType: 'string' },
    { name: 'filed_at', model: 'claims', label: 'Filed at', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
  ],
  blocks: [{
    name: 'open_claims_by_adjuster', domain: 'claims', certified: true, description: 'Open claims per adjuster.',
    contract: extractBlockContract({ name: 'open_claims_by_adjuster', domain: 'claims', sql: 'SELECT adjuster, COUNT(*) AS open_claims FROM claims GROUP BY adjuster', declaredOutputs: ['adjuster', 'open_claims'] }),
  }],
  relations: [{ schema: 'main', name: 'claims', columns: [{ name: 'region', dataType: 'VARCHAR' }, { name: 'claim_id', dataType: 'VARCHAR' }] }],
};
const vocabulary = buildVocabularyIndex(harbor);

const GENERATED_SQL = 'SELECT region, COUNT(*) AS claims FROM main.claims GROUP BY region';
/** A model that, asked to read the question, names the raw table instead of the semantic layer. */
function wandering(): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  const column = vocabulary.entries.find((entry) => entry.kind === 'column' && entry.ref.endsWith('region'));
  const reply = JSON.stringify({
    version: 1, kind: 'analytics', reading: 'Count claims per region from the claims table', measures: [{ ref: column?.ref ?? 'column:main.claims.claim_id', aggregation: 'count' }],
    groupBy: [{ ref: column?.ref ?? 'column:main.claims.region', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
  });
  return { name: 'ollama', calls, available: async () => true, generate: async (messages) => { calls.push(messages); return reply; } };
}

const ask = (question: string, provider: AgentProvider, extra: Record<string, unknown> = {}) => runAskPipeline({
  question, vocabulary, provider, explorationAuto: true, clauseCoverage: false,
  prepareDeps: {
    compileSemantic: async () => ({ sql: 'SELECT region, COUNT(*) AS claim_count FROM main.claims GROUP BY region', engine: 'native' }),
    draftSql: async () => ({ sql: GENERATED_SQL, relations: ['main.claims'], proof: [] }),
  },
  executeDeps: { run: async () => ({ columns: ['region', 'claim_count'], rows: [{ region: 'West', claim_count: 3 }], rowCount: 1, executionTimeMs: 1 }) },
  ...extra,
});

describe('a question that is only a governed metric and dimensions is read by its own words', () => {
  it.each([
    ['Claims filed by region'],
    ['claims filed by territory'],
    ['Show me claims submitted per region?'],
    ['What are the Claims filed for each Region'],
  ])('%s is a governed semantic answer, with no model call, every time', async (question) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const provider = wandering();
      const outcome = await ask(question, provider);
      expect(provider.calls).toHaveLength(0);
      expect(outcome.kind).toBe('answered');
      if (outcome.kind !== 'answered') return;
      expect(outcome.candidate.tier).toBe('semantic');
      expect(outcome.candidate.trust).toBe('governed');
      expect(outcome.intent.measures.map((measure) => measure.ref)).toEqual(['metric:claims.claim_count']);
      expect(outcome.intent.groupBy.map((group) => group.ref)).toEqual(['dimension:claims.region']);
    }
  });

  it('does not depend on the thread: a prior reading and a thread summary change nothing', async () => {
    const provider = wandering();
    const first = await ask('Claims filed by region', wandering());
    if (first.kind !== 'answered') throw new Error('expected an answer');
    const outcome = await ask('Claims filed by region', provider, {
      prior: { ...first.intent, measures: [{ ref: 'metric:claims.paid_amount' }] },
      priorExecuted: true, conversation: { summary: 'The last answer was an AI-drafted paid amount by channel.' },
    });
    expect(provider.calls).toHaveLength(0);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') {
      expect(outcome.candidate.tier).toBe('semantic');
      expect(outcome.intent.measures.map((measure) => measure.ref)).toEqual(['metric:claims.claim_count']);
    }
  });

  it('keeps today\'s model-driven path when the question is not only a metric and dimensions', async () => {
    for (const question of [
      'Claims filed by region last quarter',
      'top 5 regions by claims filed',
      'Claims filed by region for open claims',
      'Claims filed by month',
      'Claims filed by channel',
      'Claims filed by',
      'region',
    ]) expect(readByOwnWords(question, vocabulary), question).toBeUndefined();
    const provider = wandering();
    const outcome = await ask('Claims filed by region last quarter', provider);
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(outcome.kind === 'answered' ? outcome.candidate.tier : 'not answered').not.toBe('semantic');
  });

  it('keeps the model path when a name belongs to two entries', async () => {
    const twice = buildVocabularyIndex({
      ...harbor,
      dimensions: [...harbor.dimensions!, { name: 'sales_region', model: 'claims', label: 'Region', dataType: 'string' }],
    });
    expect(readByOwnWords('Claims filed by region', twice)).toBeUndefined();
  });

  it('keeps the model path when a certified block carries the same words', async () => {
    const withBlock = buildVocabularyIndex({
      ...harbor,
      blocks: [...harbor.blocks!, {
        name: 'claims_filed_by_region', domain: 'claims', certified: true, description: 'Claims filed by region.',
        contract: extractBlockContract({ name: 'claims_filed_by_region', domain: 'claims', sql: 'SELECT region, COUNT(*) AS claim_count FROM claims GROUP BY region', declaredOutputs: ['region', 'claim_count'] }),
      }],
    });
    expect(readByOwnWords('claims filed by region', withBlock)).toBeUndefined();
  });

  it('keeps the model path when the dimension cannot be reached from the metric', () => {
    expect(readByOwnWords('Claims filed by channel', vocabulary)).toBeUndefined();
    expect(readByOwnWords('Policies in force by channel', vocabulary)?.measures.map((measure) => measure.ref)).toEqual(['metric:policies.policy_count']);
  });
});
