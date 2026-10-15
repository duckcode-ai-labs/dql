import { describe, expect, it } from 'vitest';
import { appAskScopeKey, appAskThreadDecision } from './app-ask-scope.js';

describe('one Ask conversation per App page (0.1.0 re-test #2)', () => {
  it('names the App page a question was asked from', () => {
    expect(appAskScopeKey({ surface: 'apps', appId: 'give-me-top-5-players-who', dashboardId: 'overview', dashboardRunId: 'r1' }))
      .toBe('app:give-me-top-5-players-who:overview');
    expect(appAskScopeKey({ surface: 'apps', appId: 'a' })).toBe('app:a:');
    expect(appAskScopeKey({ surface: 'ask', appId: 'a' })).toBeUndefined();
    expect(appAskScopeKey({ surface: 'apps' })).toBeUndefined();
    expect(appAskScopeKey(undefined)).toBeUndefined();
  });

  it('never continues another App page’s conversation', () => {
    const first = 'app:give-me-top-5-players-who:overview';
    const certified = 'app:nba-player-performance-stakeholders-using-certified:overview';
    // The re-test: the certified App's question arrived on the first App's thread.
    expect(appAskThreadDecision({ scopeKey: first }, certified)).toBe('detach');
    expect(appAskThreadDecision({ scopeKey: first }, first)).toBe('continue');
    // A new (or older, unscoped) conversation is bound by its first App question.
    expect(appAskThreadDecision({}, first)).toBe('bind');
    // Questions not asked from an App, and requests with no thread, are unaffected.
    expect(appAskThreadDecision({ scopeKey: first }, undefined)).toBe('continue');
    expect(appAskThreadDecision(null, first)).toBe('continue');
  });
});
