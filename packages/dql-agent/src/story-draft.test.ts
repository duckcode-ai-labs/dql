import { describe, expect, it } from 'vitest';
import { buildStoryBindingCatalog } from '@duckcodeailabs/dql-core';
import { draftStoryNarrative, deterministicStoryNarrative, promptBindings, storyDraftUserPrompt, type StoryDraftInput } from './story-draft.js';

const catalog = buildStoryBindingCatalog([
  { tileId: 'revenue', status: 'ok', result: { columns: ['revenue'], rows: [{ revenue: 130 }], columnsMeta: [{ name: 'revenue', kind: 'currency', unit: 'USD' }] } },
  {
    tileId: 'why', status: 'ok', tileType: 'driver', driver: {
      headline: { current: '40', prior: '30', delta: '10', percentDelta: '33.3' },
      dimensions: [{ label: 'Region', members: [{ label: 'US', delta: '10', role: 'driver' }] }],
    },
  },
], { revenue: 'Revenue', why: 'Why revenue moved in March 2026' });
const input: StoryDraftInput = {
  pageTitle: 'Overview',
  goal: 'Help the sales lead see revenue',
  catalog,
  tiles: [{ tileId: 'revenue', title: 'Revenue', kind: 'kpi' }, { tileId: 'why', title: 'Why revenue moved in March 2026', kind: 'driver' }],
  includeValues: true,
};

describe('story drafting (RFC 0008 step 8)', () => {
  it('lists bindings, and shows values only to a local model', () => {
    expect(storyDraftUserPrompt(input)).toContain('{{revenue.revenue}} — Revenue — revenue (now $130)');
    expect(storyDraftUserPrompt({ ...input, includeValues: false })).not.toContain('$130');
  });

  it('accepts a draft that binds every number', async () => {
    const reply = '```json\n{"blocks":[{"kind":"text","markdown":"Revenue stands at {{revenue.revenue}}, up {{why.change}} with {{why.top_member}} moving most."},{"kind":"tile","tileId":"why"}]}\n```';
    const result = await draftStoryNarrative(input, async () => reply, { model: 'qwen3.8:27b' });
    expect(result).toMatchObject({ generatedBy: 'ai', attempts: 1, issues: [] });
    expect(result.narrative).toMatchObject({ presentation: 'story', generatedBy: 'ai', model: 'qwen3.8:27b' });
    expect(result.narrative.blocks.map((block) => block.kind)).toEqual(['text', 'tile']);
  });

  it('sends the problems back once, then accepts the corrected draft', async () => {
    const replies = [
      '{"blocks":[{"kind":"text","markdown":"Revenue is $130, up 10 dollars."},{"kind":"tile","tileId":"ghost"}]}',
      '{"blocks":[{"kind":"text","markdown":"Revenue is {{revenue.revenue}}."}]}',
    ];
    const seen: string[] = [];
    const result = await draftStoryNarrative(input, async (messages) => { seen.push(messages.at(-1)!.content); return replies.shift()!; });
    expect(result).toMatchObject({ generatedBy: 'ai', attempts: 2 });
    expect(seen[1]).toContain('"$130" is a number written into the text');
    expect(seen[1]).toContain('ghost is not a tile on this page');
  });

  it('falls back to a draft built from the bindings when the model keeps breaking the rules or is absent', async () => {
    const stubborn = await draftStoryNarrative(input, async () => '{"blocks":[{"kind":"text","markdown":"Revenue is 130."}]}');
    expect(stubborn.generatedBy).toBe('deterministic');
    expect(stubborn.attempts).toBe(2);
    expect(stubborn.issues.length).toBeGreaterThan(0);
    const offline = await draftStoryNarrative(input, null);
    expect(offline.generatedBy).toBe('deterministic');
    const text = deterministicStoryNarrative(input).blocks.find((block) => block.kind === 'text');
    expect(text && text.kind === 'text' && text.markdown).toBe('Revenue is {{revenue.revenue}}. Why revenue moved in March changed by {{why.change}} ({{why.change_percent}}) against the period before; the largest move was {{why.top_member}} ({{why.top_member_change}}) by {{why.top_dimension}}.');
  });
});

describe('a story drafted by a model outside the privacy boundary', () => {
  const grouped = buildStoryBindingCatalog([{
    tileId: 'claims-by-member', status: 'ok', title: 'Open claims by member',
    result: { columns: ['member_name', 'open_claims', 'paid'], rows: [{ member_name: 'Member-Name-Ana Ruiz', open_claims: 3, paid: 10 }, { member_name: 'Member-Name-Bo Lind', open_claims: 2, paid: 4 }] },
  }]);
  const outside: StoryDraftInput = { pageTitle: 'Claims', catalog: grouped, tiles: [{ tileId: 'claims-by-member', title: 'Open claims by member', kind: 'table' }], includeValues: false };

  it('names a grouped tile\'s members by position, never by member, in keys and labels', () => {
    const prompt = storyDraftUserPrompt(outside);
    expect(prompt).not.toContain('Member-Name');
    expect(prompt).toContain('{{claims-by-member.open_claims[group 1]}} — Open claims by member — open claims for group 1');
    expect(prompt).toContain('{{claims-by-member.paid[group 2]}}');
    // A model inside the boundary keeps the real keys and values.
    expect(storyDraftUserPrompt({ ...outside, includeValues: true })).toContain('Member-Name-Ana Ruiz');
    const shown = promptBindings(grouped, false);
    expect(Object.values(shown.catalog).every((binding) => !JSON.stringify(binding).includes('Member-Name'))).toBe(true);
    expect(shown.realKey('claims-by-member.open_claims[group 2]')).toBe('claims-by-member.open_claims[Member-Name-Bo Lind]');
  });

  it('keeps the real bindings in the draft it accepts, and checks the model against what it was shown', async () => {
    const seen: string[] = [];
    const replies = [
      '{"blocks":[{"kind":"text","markdown":"3 open claims for {{claims-by-member.leader}}."}]}',
      '{"blocks":[{"kind":"text","markdown":"The first group has {{claims-by-member.open_claims[group 1]}} open claims; the second {{claims-by-member.open_claims[group 2]}}."}]}',
    ];
    const result = await draftStoryNarrative(outside, async (messages) => { seen.push(messages.map((message) => message.content).join('\n')); return replies.shift()!; });
    expect(result).toMatchObject({ generatedBy: 'ai', attempts: 2 });
    for (const prompt of seen) expect(prompt).not.toContain('Member-Name');
    const text = result.narrative.blocks.find((block) => block.kind === 'text');
    expect(text && text.kind === 'text' && text.markdown).toBe('The first group has {{claims-by-member.open_claims[Member-Name-Ana Ruiz]}} open claims; the second {{claims-by-member.open_claims[Member-Name-Bo Lind]}}.');
  });
});
