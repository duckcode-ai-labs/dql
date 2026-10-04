import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentProvider } from '../providers/types.js';
import { parseIntent, type AnalyticalIntentV1 } from './intent.js';
import { priorWithoutValues, sqlStringValues } from './prior-values.js';
import { resolveIntent } from './resolve-intent.js';
import { buildVocabularyIndex } from './vocabulary.js';

/**
 * RFC 0010 HH-5, a follow-up outside the privacy boundary: the earlier reading's values (and its SQL's literals)
 * reach the model named by position only, and what the model writes gets the real values back.
 */
const MEMBER = 'CANARY-MEMBER-3391';

function intentOf(value: Record<string, unknown>): AnalyticalIntentV1 {
  const parsed = parseIntent({ version: 1, kind: 'analytics', groupBy: [], display: [], unresolved: [], provenance: {}, expectedShape: 'scalar', ...value });
  if (!parsed.intent) throw new Error(JSON.stringify(parsed.errors));
  return parsed.intent;
}

const prior = intentOf({
  reading: `Total revenue for ${MEMBER} since 2024-01-01.`,
  measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:customers.customer_type', op: 'eq', values: ['returning'], source: 'question' }] }],
  filters: [
    { ref: 'dimension:customers.customer_name', op: 'eq', values: [MEMBER], source: 'question' },
    { ref: 'dimension:order_item.ordered_at', op: 'gte', values: ['2024-01-01'], source: 'question' },
  ],
});

describe('a follow-up\'s earlier values, named by position', () => {
  it('names each text value of the earlier restrictions and of its SQL by position, and leaves dates and numbers', () => {
    const sql = `SELECT SUM(price) FROM dev.order_items WHERE customer_name = '${MEMBER}' AND note = 'it''s' AND ordered_at >= '2024-01-01' AND qty > 3`;
    expect(sqlStringValues(sql)).toEqual([MEMBER, "it's", '2024-01-01']);
    const mask = priorWithoutValues(prior, sqlStringValues(sql));
    expect(JSON.stringify(mask.prior)).not.toContain(MEMBER);
    expect(JSON.stringify(mask.prior)).not.toContain('returning');
    expect(mask.prior.filters[0]!.values).toEqual(['[value 1]']);
    expect(mask.prior.filters[1]!.values).toEqual(['2024-01-01']);
    expect(mask.prior.reading).toBe('Total revenue for [value 1] since 2024-01-01.');
    const shown = mask.maskText(sql);
    expect(shown).not.toContain(MEMBER);
    expect(shown).not.toContain("it''s");
    expect(shown).toContain("'2024-01-01'");
    expect(shown).toContain('qty > 3');
    // What the model writes back (an edited statement) gets the real values.
    expect(mask.restoreText(`${shown} AND region = 'East'`)).toBe(`${sql} AND region = 'East'`);
  });

  it('puts the real values back in a reading the model wrote', () => {
    const mask = priorWithoutValues(prior);
    const written = intentOf({
      reading: 'Revenue for [value 1] by month.',
      measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:customers.customer_type', op: 'eq', values: ['[value 2]'], source: 'inherited' }] }],
      filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['[value 1]'], source: 'inherited' }],
    });
    const restored = mask.restoreIntent(written);
    expect(restored.reading).toBe(`Revenue for ${MEMBER} by month.`);
    expect(restored.filters[0]!.values).toEqual([MEMBER]);
    expect(restored.measures[0]!.scope![0]!.values).toEqual(['returning']);
  });

  it('the interpreter reads the earlier reading by position when told to, and its reading carries the real values', async () => {
    const vocabulary = buildVocabularyIndex({
      metrics: [{ name: 'revenue', model: 'order_item', label: 'Revenue', aggregation: 'sum' }],
      dimensions: [
        { name: 'customer_name', model: 'customers', dataType: 'string' },
        { name: 'customer_type', model: 'customers', dataType: 'string' },
        { name: 'ordered_at', model: 'order_item', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
      ],
      entities: [{ name: 'customer', model: 'customers', type: 'primary' }],
    });
    const reply = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Revenue for [value 1], by customer type.', measures: [{ ref: 'metric:order_item.revenue' }],
      groupBy: [{ ref: 'dimension:customers.customer_type', role: 'categorical' }], display: [],
      filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['[value 1]'], source: 'inherited' }],
      unresolved: [], provenance: { 'metric:order_item.revenue': 'inherited', 'dimension:customers.customer_type': 'q:by customer type', 'dimension:customers.customer_name': 'inherited' }, expectedShape: 'table',
    });
    const calls: AgentMessage[][] = [];
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async (messages) => { calls.push(messages); return reply; } };
    const earlier = intentOf({ reading: `Total revenue for ${MEMBER}.`, measures: [{ ref: 'metric:order_item.revenue' }], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: [MEMBER], source: 'question' }] });
    const hidden = await resolveIntent({ question: 'And by customer type?', vocabulary, provider, prior: earlier, hidePriorValues: true, maxAttempts: 1 });
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).not.toContain(MEMBER);
    expect(JSON.stringify(calls)).toContain('[value 1]');
    const intent = (hidden as { intent?: AnalyticalIntentV1 }).intent;
    expect(hidden.status, JSON.stringify(hidden).slice(0, 600)).not.toBe('failed');
    expect(intent?.filters.find((filter) => filter.ref === 'dimension:customers.customer_name')?.values).toEqual([MEMBER]);
    expect(JSON.stringify(intent)).not.toContain('[value 1]');
    // Inside the boundary (not told to hide them), the model reads the values as before.
    calls.length = 0;
    await resolveIntent({ question: 'And by customer type?', vocabulary, provider, prior: earlier, maxAttempts: 1 });
    expect(JSON.stringify(calls)).toContain(MEMBER);
  });
});
