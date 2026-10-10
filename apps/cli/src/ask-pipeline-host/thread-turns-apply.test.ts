import { describe, expect, it } from 'vitest';
import { readsAsEditOfPriorTurn } from './host.js';

const complete = 'What is the total revenue by region for last quarter?';

describe('which questions are read as an edit of the last answer', () => {
  it('reads a complete question on its own, so the browser thread cannot turn it into an edit of the last answer', () => {
    expect(readsAsEditOfPriorTurn({ question: complete })).toBe(false);
    expect(readsAsEditOfPriorTurn({ question: complete, conversationContext: { conversationEnvelope: { topicRelation: 'continuation' } } })).toBe(false);
  });

  it('reads a question the thread calls a new topic on its own, even when it is short', () => {
    expect(readsAsEditOfPriorTurn({ question: 'revenue', conversationContext: { conversationEnvelope: { topicRelation: 'shift' } } })).toBe(false);
  });

  it('keeps the last answer for fragments and references to it', () => {
    expect(readsAsEditOfPriorTurn({ question: 'and by month?' })).toBe(true);
    expect(readsAsEditOfPriorTurn({ question: 'what about 2023' })).toBe(true);
    expect(readsAsEditOfPriorTurn({ question: 'show me that for the west region only' })).toBe(true);
  });

  it('keeps the last answer for a clicked option, a selected result or a clarification reply', () => {
    expect(readsAsEditOfPriorTurn({ question: complete, selectedEvidenceId: 'metric:revenue' })).toBe(true);
    expect(readsAsEditOfPriorTurn({ question: complete, clarificationSourceQuestion: 'total revenue' })).toBe(true);
    expect(readsAsEditOfPriorTurn({ question: complete, conversationContext: { conversationEnvelope: { pendingClarification: { question: 'Which revenue?' } } } })).toBe(true);
  });
});
