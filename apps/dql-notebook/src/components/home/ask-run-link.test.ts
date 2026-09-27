import { describe, expect, it } from 'vitest';
import { askRunIdFromLocation } from './ask-run-link';

describe('a link to one Ask answer', () => {
  it('reads the answer id from /ask?run=, and nothing else', () => {
    expect(askRunIdFromLocation({ pathname: '/ask', search: '?run=run_mujbp1wl' })).toBe('run_mujbp1wl');
    expect(askRunIdFromLocation({ pathname: '/', search: '?run=run_1' })).toBeUndefined();
    expect(askRunIdFromLocation({ pathname: '/ask', search: '?thread=thr_1' })).toBeUndefined();
    expect(askRunIdFromLocation({ pathname: '/ask', search: '?run=../../x' })).toBeUndefined();
  });
});
