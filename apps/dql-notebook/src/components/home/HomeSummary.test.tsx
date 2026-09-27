import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomeSummaryView } from './HomeSummary';
import { fetchDirectoryGroups, fetchFollowing, fetchHome, fetchHomeCards, saveAppAudience, saveFollowing } from '../../api/home-api';
import type { HomeCard, HomeSummary } from '../../api/home-api';

/** RFC 0010 HH-16: the Home above Ask, and the calls behind it. */
const summary: HomeSummary = {
  apps: [
    { id: 'claims-weekly', name: 'Claims Weekly', domain: 'claims', homePageId: 'overview', pages: [{ id: 'overview', title: 'Claims this week' }], following: true, lastOpenedAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
    { id: 'finance', name: 'Finance Monthly', domain: 'finance', pages: [], following: false },
  ],
  moved: [{
    appId: 'claims-weekly', pageId: 'overview', appName: 'Claims Weekly', pageTitle: 'Claims this week', at: new Date().toISOString(), since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    changes: [{ label: 'Claims filed', from: '41', to: '47', change: '+6', direction: 'up' }, { label: 'Claims paid', from: '$9,100', to: '$8,700', change: '−$400', direction: 'down' }],
    unchanged: 1, following: true,
  }],
  follows: [{ appId: 'claims-weekly', pageId: 'overview' }],
};
const cards: HomeCard[] = [{ id: 'requests', title: 'Open requests', items: [{ id: 'R-12', title: 'Which adjusters have the most open claims?', status: 'Waiting for a steward', href: '/e/requests/R-12' }], more: { label: 'All my requests', href: '/e/requests' } }];

const render = (value: HomeSummary | null, extra: HomeCard[] = []) => renderToStaticMarkup(<HomeSummaryView summary={value} cards={extra} onOpenApp={() => undefined} onOpenLink={() => undefined} />);

afterEach(() => { vi.unstubAllGlobals(); });

describe('Home summary (HH-16)', () => {
  it('shows nothing when there is nothing to show, so a project without Apps looks as before', () => {
    expect(render(null)).toBe('');
    expect(render({ apps: [], moved: [], follows: [] })).toBe('');
  });

  it('lists my Apps (followed first), what moved in my own figures, and the host\'s cards', () => {
    const html = render(summary, cards);
    expect(html).toContain('My Apps');
    expect(html.indexOf('Claims Weekly')).toBeLessThan(html.indexOf('Finance Monthly'));
    expect(html).toContain('aria-label="Following"');
    expect(html).toContain('What moved');
    expect(html).toContain('Claims filed');
    expect(html).toContain('41 → <b>47</b>');
    expect(html).toContain('(−$400)');
    expect(html).toContain('Open requests');
    expect(html).toContain('Waiting for a steward');
    expect(html).toContain('All my requests');
    // Only the host's cards appear when there are no Apps.
    expect(render({ apps: [], moved: [], follows: [] }, cards)).toContain('Open requests');
  });

  it('says a newer edition exists without showing its figures', () => {
    const html = render({ ...summary, moved: [{ ...summary.moved[0]!, changes: [], newEditionAt: new Date(Date.now() - 3600_000).toISOString() }] });
    expect(html).toContain('New edition 1h ago — open it to see your figures');
  });
});

describe('Home calls', () => {
  it('reads Home, host cards, follows and groups, and passes on a refusal with its link', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url === '/api/home') return reply(200, summary);
      if (url === '/api/host/home-cards') return reply(200, { cards });
      if (url.startsWith('/api/apps/claims-weekly/follow?')) return reply(200, { following: true, follows: [] });
      if (url === '/api/apps/claims-weekly/follow') return reply(200, { following: false, follows: [] });
      if (url === '/api/host/groups') return reply(200, { source: 'host', groups: [{ id: 'claims-leaders' }] });
      if (url === '/api/apps/claims-weekly/audience') return reply(403, { error: 'Production follows main.', code: 'PERMISSION_DENIED', next: { label: 'Open my draft space', href: '/e/drafts' } });
      return reply(404, {});
    }));
    expect((await fetchHome())?.apps.map((app) => app.id)).toEqual(['claims-weekly', 'finance']);
    expect(await fetchHomeCards()).toEqual(cards);
    expect(await fetchFollowing('claims-weekly', 'overview')).toBe(true);
    expect(await saveFollowing('claims-weekly', 'overview', false)).toEqual({ ok: true, following: false });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ pageId: 'overview', following: false });
    expect(await fetchDirectoryGroups()).toEqual({ source: 'host', groups: [{ id: 'claims-leaders' }] });
    expect(await saveAppAudience('claims-weekly', { groups: ['claims-leaders'] })).toEqual({ ok: false, refusal: { error: 'Production follows main.', next: { label: 'Open my draft space', href: '/e/drafts' } } });
    expect(calls.at(-1)).toMatchObject({ method: 'PUT' });
  });

  it('fails soft: no Home, no cards, and free-text groups when the server cannot answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchHome()).toBeNull();
    expect(await fetchHomeCards()).toEqual([]);
    expect(await fetchFollowing('a', 'b')).toBeNull();
    expect(await fetchDirectoryGroups()).toEqual({ source: 'free_text' });
  });
});
