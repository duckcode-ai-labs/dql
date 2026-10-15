import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as RailModule from './GlobalAiRail';
import type * as PanelModule from './UnifiedAgentRunPanel';

let globalAiThreadScope: typeof RailModule.globalAiThreadScope;
let followLatestTurnAction: typeof PanelModule.followLatestTurnAction;
let toAiGeneratedWording: typeof PanelModule.toAiGeneratedWording;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  ({ globalAiThreadScope } = await import('./GlobalAiRail'));
  ({ followLatestTurnAction, toAiGeneratedWording } = await import('./UnifiedAgentRunPanel'));
});

describe('one Ask conversation per App page (0.1.0 re-test #2)', () => {
  const appContext = (appId: string, dashboardId = 'overview') => ({
    workspaceContext: { surface: 'apps', appId, dashboardId, dashboardRunId: 'run-1' },
  });

  it('gives each App page its own thread, and the same thread when you come back', () => {
    const first = globalAiThreadScope(appContext('give-me-top-5-players-who'));
    const certified = globalAiThreadScope(appContext('nba-player-performance-stakeholders-using-certified'));
    expect(first).not.toBe(certified);
    expect(globalAiThreadScope(appContext('give-me-top-5-players-who'))).toBe(first);
    // Another page of the same App is another conversation.
    expect(globalAiThreadScope(appContext('give-me-top-5-players-who', 'details'))).not.toBe(first);
    // A tile question on the page continues the page's conversation (the run id does not matter).
    expect(globalAiThreadScope({ workspaceContext: { surface: 'apps', appId: 'give-me-top-5-players-who', dashboardId: 'overview', blockId: 'b1' } })).toBe(first);
  });

  it('keeps the shared rail conversation for questions that are not from an App', () => {
    expect(globalAiThreadScope(undefined)).toBe('global-rail');
    expect(globalAiThreadScope({})).toBe('global-rail');
    expect(globalAiThreadScope({ workspaceContext: { surface: 'lineage' } })).toBe('global-rail');
  });
});

describe('the Ask thread follows its latest turn (0.1.0 re-test #4)', () => {
  it('scrolls to a new question, and to its answer when it arrives', () => {
    expect(followLatestTurnAction({ previousCount: 2, previousUserTurnId: 'u1', readingEarlier: false }, { latestUserTurnId: 'u2', count: 3 })).toBe('scroll');
    expect(followLatestTurnAction({ previousCount: 3, previousUserTurnId: 'u2', readingEarlier: false }, { latestUserTurnId: 'u2', count: 4 })).toBe('scroll');
  });

  it('scrolls to the latest turn when a saved thread loads', () => {
    expect(followLatestTurnAction({ previousCount: 0, readingEarlier: false }, { latestUserTurnId: 't3-q', count: 6 })).toBe('scroll');
  });

  it('leaves a reader who scrolled up to an earlier turn where they are when an answer arrives', () => {
    expect(followLatestTurnAction({ previousCount: 3, previousUserTurnId: 'u2', readingEarlier: true }, { latestUserTurnId: 'u2', count: 4 })).toBe('stay');
    // Asking again always brings the new turn into view.
    expect(followLatestTurnAction({ previousCount: 4, previousUserTurnId: 'u2', readingEarlier: true }, { latestUserTurnId: 'u3', count: 5 })).toBe('scroll');
  });

  it('does not move when nothing was added', () => {
    expect(followLatestTurnAction({ previousCount: 4, previousUserTurnId: 'u2', readingEarlier: false }, { latestUserTurnId: 'u2', count: 4 })).toBe('stay');
    // A reload of the same turns under server ids.
    expect(followLatestTurnAction({ previousCount: 4, previousUserTurnId: 'u2', readingEarlier: true }, { latestUserTurnId: 't2-q', count: 4 })).toBe('stay');
    expect(followLatestTurnAction({ previousCount: 0, readingEarlier: false }, { count: 0 })).toBe('stay');
  });
});

describe('stakeholder wording (0.1.0 re-test #8)', () => {
  it('says "an AI-generated answer", never "a AI-generated answer"', () => {
    expect(toAiGeneratedWording('Ask within what the block declares, or explore the tables for a review-required answer.'))
      .toBe('Ask within what the block declares, or explore the tables for an AI-generated answer.');
    expect(toAiGeneratedWording('A review-required draft was saved.')).toBe('An AI-generated draft was saved.');
    expect(toAiGeneratedWording('This is an review-required result')).toBe('This is an AI-generated result');
    expect(toAiGeneratedWording('The answer is review-required.')).toBe('The answer is AI-generated.');
    expect(toAiGeneratedWording('data review-required')).toBe('data AI-generated');
  });
});
