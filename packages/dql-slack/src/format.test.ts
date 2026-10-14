import { describe, it, expect } from 'vitest';
import { formatAnswerForSlack } from './format.js';
import type { AgentAnswer } from '@zlens/agent';

describe('formatAnswerForSlack', () => {
  it('emits a Certified badge + citations + feedback row for certified answers', () => {
    const answer: AgentAnswer = {
      kind: 'certified',
      text: 'Revenue total: $1.2M',
      block: {
        nodeId: 'block:revenue_total',
        kind: 'block',
        name: 'revenue_total',
        status: 'certified',
        gitSha: 'abc12345',
      },
      citations: [
        { nodeId: 'block:revenue_total', kind: 'block', name: 'revenue_total', gitSha: 'abc12345' },
      ],
      considered: [],
    };
    const reply = formatAnswerForSlack(answer, { question: 'revenue?' });
    expect(reply.text).toContain('Certified');
    expect(reply.blocks.some((b) => (b as { type: string }).type === 'actions')).toBe(true);
    const cite = reply.blocks.find((b) => (b as { text?: { text?: string } }).text?.text?.includes('Citations'));
    expect(cite).toBeDefined();
  });

  it('marks Uncertified answers with the warning badge and includes the SQL preview', () => {
    const answer: AgentAnswer = {
      kind: 'uncertified',
      text: 'Median order value by region',
      proposedSql: 'SELECT region, MEDIAN(amount) FROM orders GROUP BY 1',
      suggestedViz: 'bar',
      citations: [],
      considered: [],
    };
    const reply = formatAnswerForSlack(answer, { question: 'median?' });
    expect(reply.text).toContain('uncertified');
    const sqlBlock = reply.blocks.find((b) =>
      (b as { type: string }).type === 'rich_text',
    );
    expect(sqlBlock).toBeDefined();
  });

  it('includes feedback action buttons with rating + question + blockId', () => {
    const answer: AgentAnswer = {
      kind: 'certified',
      text: 'x',
      block: { nodeId: 'block:r', kind: 'block', name: 'r' },
      citations: [],
      considered: [],
    };
    const reply = formatAnswerForSlack(answer, { question: 'q' });
    const actions = reply.blocks.find((b) => (b as { type: string }).type === 'actions') as
      { elements: Array<{ value: string; action_id: string }> } | undefined;
    expect(actions?.elements.map((e) => e.action_id)).toEqual(['feedback_up', 'feedback_down']);
    const upValue = JSON.parse(actions!.elements[0].value);
    expect(upValue.rating).toBe('up');
    expect(upValue.blockId).toBe('block:r');
    expect(upValue.question).toBe('q');
  });
});
