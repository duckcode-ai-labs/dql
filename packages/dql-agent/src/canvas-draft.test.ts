import { describe, expect, it } from 'vitest';
import { buildStoryBindingCatalog, checkCanvasHtml } from '@duckcodeailabs/dql-core';
import { canvasDraftUserPrompt, deterministicCanvasPage, draftCanvasPage, type CanvasDraftInput } from './canvas-draft.js';

const input: CanvasDraftInput = {
  pageTitle: 'Overview',
  goal: 'Help the sales lead see revenue',
  catalog: buildStoryBindingCatalog([
    { tileId: 'revenue', status: 'ok', result: { columns: ['revenue'], rows: [{ revenue: 145 }], columnsMeta: [{ name: 'revenue', kind: 'currency', unit: 'USD' }] } },
    { tileId: 'trend', status: 'ok', result: { columns: ['month', 'revenue'], rows: [{ month: '2026-02-01', revenue: 30 }, { month: '2026-03-01', revenue: 55 }] } },
  ], { revenue: 'Revenue', trend: 'Revenue by month' }),
  tiles: [{ tileId: 'revenue', title: 'Revenue', kind: 'kpi' }, { tileId: 'trend', title: 'Revenue by month', kind: 'line' }],
  includeValues: false,
};

describe('governed HTML drafting (RFC 0008 step 9)', () => {
  it('describes the page with bindings and never values for a hosted model', () => {
    const prompt = canvasDraftUserPrompt(input);
    expect(prompt).toContain('revenue.revenue — Revenue — revenue');
    expect(prompt).toContain('- trend: Revenue by month (line)');
    expect(prompt).not.toContain('$145');
  });

  it('accepts a checked page from the model, fenced or not', async () => {
    const reply = '```html\n<style>.h{font-size:32px}</style><section class="h"><h1>Revenue <dql-value bind="revenue.revenue"></dql-value></h1><dql-tile tile="trend"></dql-tile></section>\n```';
    const result = await draftCanvasPage(input, async () => reply, { model: 'qwen3.8:27b' });
    expect(result).toMatchObject({ generatedBy: 'ai', attempts: 1, issues: [] });
    expect(result.canvas.html).toContain('<dql-tile tile="trend"></dql-tile>');
    expect(result.canvas.model).toBe('qwen3.8:27b');
  });

  it('sends unsafe markup back once, then accepts the corrected page', async () => {
    const replies = [
      '<div onclick="x()"><script>fetch("/api")</script>Revenue is $145</div>',
      '<p>Revenue <dql-value bind="revenue.revenue"></dql-value></p>',
    ];
    const seen: string[] = [];
    const result = await draftCanvasPage(input, async (messages) => { seen.push(messages.at(-1)!.content); return replies.shift()!; });
    expect(result).toMatchObject({ generatedBy: 'ai', attempts: 2 });
    expect(seen[1]).toContain('<script> is not allowed');
    expect(seen[1]).toContain('pages cannot run code');
    expect(seen[1]).toContain('"$145" is a number written into the text');
  });

  it('falls back to a clean template that passes the same checker', async () => {
    const result = await draftCanvasPage(input, async () => '<img src="x">');
    expect(result.generatedBy).toBe('deterministic');
    const template = deterministicCanvasPage(input);
    expect(checkCanvasHtml(template.html, { catalog: input.catalog, tileIds: new Set(['revenue', 'trend']) }).issues).toEqual([]);
    expect(template.html).toContain('<dql-value bind="revenue.revenue"></dql-value>');
    expect(template.html).toContain('<dql-tile tile="trend"></dql-tile>');
  });
});

describe('a governed page drafted by a model outside the privacy boundary', () => {
  it('shows a grouped tile\'s members by position only, and places the real bindings in the page it accepts', async () => {
    const outside: CanvasDraftInput = {
      pageTitle: 'Claims',
      catalog: buildStoryBindingCatalog([{ tileId: 'by-member', status: 'ok', result: { columns: ['member_name', 'open_claims'], rows: [{ member_name: 'Member-Name-Ana Ruiz', open_claims: 3 }, { member_name: 'Member-Name-Bo Lind', open_claims: 2 }] } }], { 'by-member': 'Open claims by member' }),
      tiles: [{ tileId: 'by-member', title: 'Open claims by member', kind: 'table' }],
      includeValues: false,
    };
    const prompt = canvasDraftUserPrompt(outside);
    expect(prompt).not.toContain('Member-Name');
    expect(prompt).toContain('by-member.open_claims[group 2] — Open claims by member — open claims for group 2');
    const result = await draftCanvasPage(outside, async () => '<p>Second group <dql-value bind="by-member.open_claims[group 2]"></dql-value></p>');
    expect(result.generatedBy).toBe('ai');
    expect(result.canvas.html).toContain('<dql-value bind="by-member.open_claims[Member-Name-Bo Lind]"></dql-value>');
    expect(checkCanvasHtml(result.canvas.html, { catalog: outside.catalog, tileIds: new Set(['by-member']) }).issues).toEqual([]);
  });
});
