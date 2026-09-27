import { afterEach, describe, expect, it } from 'vitest';
import { dispatchNotifications, setDeliverySink } from '../schedule/notifiers/index.js';
import { currentHostGitHooks, hostModelProvider, resultValuesMayReachModel, setHostGitHooks, setHostModelHooks, withRequestContext, type DqlHostHooks, type DqlPrincipal } from './request-context.js';

/**
 * RFC 0010: a host can run several servers in one process (its Production and
 * each pull request's preview). Starting one must never change another's
 * hooks: each request uses the hooks of the server it arrived at.
 */
const maria: DqlPrincipal = { id: 'u-maria', kind: 'person', source: 'host' };

afterEach(() => {
  setHostGitHooks(undefined);
  setHostModelHooks(undefined);
  setDeliverySink(null);
});

describe('hooks per server, not per process', () => {
  it('keeps Production\'s git, model and delivery hooks for its requests after a preview starts', async () => {
    const sent: string[] = [];
    const production: DqlHostHooks = {
      git: { openPullRequest: async () => ({ url: 'https://github.com/harbor/claims/pull/1' }) },
      modelProvider: () => ({ id: 'bedrock', provider: {} as never }),
      isInBoundary: () => true,
      delivery: async () => { sent.push('production'); return { delivered: true }; },
    };
    // A preview starts later in the same process, with no git, no model and no delivery.
    setHostGitHooks(undefined);
    setHostModelHooks({});
    setDeliverySink(null);

    await withRequestContext({ principal: maria, requestId: 'r-1', hooks: production }, async () => {
      expect(currentHostGitHooks()?.openPullRequest).toBe(production.git!.openPullRequest);
      expect(hostModelProvider()?.id).toBe('bedrock');
      expect(resultValuesMayReachModel({ id: 'x', name: 'x' }, () => false)).toBe(true);
      const results = await dispatchNotifications([{ type: 'email', recipients: ['ops@harbor.example'] } as never], { block: 'b', path: 'p', startedAt: 't', alerts: [], queries: [], trigger: 'cron' }, '/tmp');
      expect(results).toEqual([expect.objectContaining({ delivered: true })]);
    });
    expect(sent).toEqual(['production']);

    // And a preview's own request sees the preview's (absent) hooks, not Production's.
    await withRequestContext({ principal: maria, requestId: 'r-2', hooks: {} }, async () => {
      expect(currentHostGitHooks()).toBeUndefined();
      expect(hostModelProvider()).toBeUndefined();
      expect(resultValuesMayReachModel({ id: 'x', name: 'x' }, () => false)).toBe(false);
    });
  });
});
