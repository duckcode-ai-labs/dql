import { describe, expect, it } from 'vitest';
import { resolveResultReviewMode, resultReviewEnabled } from './result-review-setting.js';

describe('the result review setting', () => {
  it('is off unless the project turns it on', () => {
    expect(resolveResultReviewMode(undefined)).toBe('off');
    expect(resolveResultReviewMode({})).toBe('off');
    expect(resolveResultReviewMode({ agent: { resultReview: { mode: 'yes' } } })).toBe('off');
    expect(resolveResultReviewMode({ agent: { resultReview: { mode: 'off' } } })).toBe('off');
    expect(resolveResultReviewMode({ agent: { resultReview: { mode: 'on' } } })).toBe('on');
  });

  it('ZLENS_ASK_RESULT_REVIEW=1 turns it on and =0 off, whatever the project says; anything else leaves the project setting', () => {
    expect(resultReviewEnabled(false, undefined)).toBe(false);
    expect(resultReviewEnabled(true, undefined)).toBe(true);
    expect(resultReviewEnabled(false, '1')).toBe(true);
    expect(resultReviewEnabled(true, '0')).toBe(false);
    expect(resultReviewEnabled(true, 'maybe')).toBe(true);
    expect(resultReviewEnabled(false, 'maybe')).toBe(false);
  });
});
