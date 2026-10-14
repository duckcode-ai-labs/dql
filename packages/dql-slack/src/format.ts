/**
 * Format an `AgentAnswer` as a Slack response body.
 *
 * Returns Block Kit JSON for rich rendering when possible, with a `text`
 * fallback for clients that don't honor blocks. Citations and the
 * Certified/Uncertified badge are always present.
 */

import type { AgentAnswer } from '@zlens/agent';

interface SlackResponse {
  response_type: 'in_channel' | 'ephemeral';
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export function formatAnswerForSlack(
  answer: AgentAnswer,
  options: { question: string; ephemeral?: boolean } = { question: '' },
): SlackResponse {
  const { question, ephemeral } = options;
  const badge =
    answer.kind === 'certified'
      ? ':white_check_mark: *Certified*'
      : answer.kind === 'uncertified'
        ? ':warning: *AI-generated · uncertified*'
        : ':grey_question: *No answer*';

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${badge} — _${question}_` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: answer.text || '_(no body)_' },
    },
  ];

  if (answer.proposedSql) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Proposed SQL* (review before saving):' },
    });
    blocks.push({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_preformatted',
          elements: [{ type: 'text', text: answer.proposedSql }],
        },
      ],
    });
  }

  if (answer.citations.length > 0) {
    const cite = answer.citations
      .map((c) => `• \`${c.kind}:${c.name}\`${c.gitSha ? ` _(${c.gitSha.slice(0, 8)})_` : ''}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Citations*\n${cite}` },
    });
  }

  // Feedback action row
  blocks.push({
    type: 'actions',
    block_id: 'dql_feedback',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: ':+1: Helpful' },
        value: JSON.stringify({ rating: 'up', question, blockId: answer.block?.nodeId }),
        action_id: 'feedback_up',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: ':-1: Not helpful' },
        value: JSON.stringify({ rating: 'down', question, blockId: answer.block?.nodeId }),
        action_id: 'feedback_down',
      },
    ],
  });

  return {
    response_type: ephemeral ? 'ephemeral' : 'in_channel',
    text: `${badge} ${answer.text}`.slice(0, 3000),
    blocks,
  };
}
