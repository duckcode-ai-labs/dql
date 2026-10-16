import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routerExpectation, routerPass } from './eval-golden-router-compare.mjs';

test('a golden outcome maps to what the router must do', () => {
  assert.equal(routerExpectation('rows'), 'answer');
  assert.equal(routerExpectation(undefined), 'answer');
  assert.equal(routerExpectation('answered_with_caveat'), 'answer');
  assert.equal(routerExpectation('gap'), 'refuse');
  assert.equal(routerExpectation('clarify_or_rows'), 'either');
  assert.equal(routerExpectation('gap_or_caveat'), 'either');
  assert.equal(routerExpectation('conversation'), 'either');
});

test('an answerable case passes on any answering route; a gap only on a refusal', () => {
  for (const route of ['certified', 'generated', 'research']) assert.equal(routerPass('answer', route), true);
  assert.equal(routerPass('answer', 'missing_context'), false);
  assert.equal(routerPass('refuse', 'missing_context'), true);
  assert.equal(routerPass('refuse', 'generated'), false);
  assert.equal(routerPass('either', 'generated'), null);
});
