import { describe, expect, it } from 'vitest';
import { appAutopilotContextWithoutValues, renderConversationShapeForPrompt } from '../local-runtime.js';

/**
 * RFC 0010 HH-5: a prompt whose model is outside the privacy boundary is built
 * without values. These are the values-free forms of the conversation memory
 * and of App Autopilot's preview; which form a prompt gets is decided in one
 * place (`valuesMayReachProvider` in local-runtime.ts, guarded by the model
 * boundary source test).
 */
const FIGURE = 'CANARY-FIGURE-5521';
const MEMBER = 'CANARY-MEMBER-Ana Ruiz';

describe('values-free prompt context for a model outside the privacy boundary', () => {
  it('conversation memory: the questions and the result columns, never an answer, a row or a member', () => {
    const context = {
      sourceQuestion: 'Open claims by member?',
      sourceAnswerSummary: `${MEMBER} has ${FIGURE} open claims.`,
      resultColumns: ['member_name', 'open_claims'],
      resultDimensionValues: { member_name: [MEMBER] },
      resultRowsSample: [{ member_name: MEMBER, open_claims: FIGURE }],
      turns: [{ id: 't1', question: 'Open claims by member?', route: 'generated_answer', answer: `${MEMBER} leads with ${FIGURE}.`, result: { columns: ['member_name', 'open_claims'], rowsSample: [{ member_name: MEMBER, open_claims: FIGURE }], dimensionValues: { member_name: [MEMBER] } } }],
    };
    const text = renderConversationShapeForPrompt(context) ?? '';
    expect(text).toContain('"Open claims by member?"');
    expect(text).toContain('member_name, open_claims');
    expect(text).not.toContain(FIGURE);
    expect(text).not.toContain(MEMBER);
    expect(renderConversationShapeForPrompt(undefined)).toBeUndefined();
    expect(renderConversationShapeForPrompt({})).toBeUndefined();
  });

  it('App Autopilot: the preview\'s columns, row count and filter names, never its grouped facts or filter values', () => {
    const context = JSON.stringify({
      appContext: { draftId: 'd1' },
      currentPreview: {
        kind: 'fresh_server_held_result', runId: 'r1', source: { sourceId: 's1' }, rowCount: 2, columns: [{ name: 'member_name' }, { name: 'open_claims' }],
        effectiveFilters: { region: [MEMBER] }, summary: `${MEMBER} leads with ${FIGURE}.`, filterFingerprint: 'f', interactionFingerprint: 'i',
      },
    });
    const shaped = appAutopilotContextWithoutValues(context);
    expect(shaped).not.toContain(FIGURE);
    expect(shaped).not.toContain(MEMBER);
    expect(JSON.parse(shaped).currentPreview).toMatchObject({ rowCount: 2, filteredBy: ['region'], columns: [{ name: 'member_name' }, { name: 'open_claims' }] });
    // A failed-tile preview carries no result values; it passes as it is.
    const failed = JSON.stringify({ currentPreview: { kind: 'fresh_server_held_failed_tile', title: 'T', error: 'A column is missing.' } });
    expect(appAutopilotContextWithoutValues(failed)).toBe(failed);
  });
});
