import { describe, expect, it } from 'vitest';
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_MARK, CHUNK_RELOAD_MESSAGE, installChunkReload, isChunkLoadFailure } from './chunk-reload';

function fakeWindow(stored = new Map<string, string>()) {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  let reloads = 0;
  const win = {
    addEventListener: (type: string, listener: (event: Event) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    removeEventListener: (type: string, listener: (event: Event) => void) => { listeners.set(type, (listeners.get(type) ?? []).filter((each) => each !== listener)); },
    location: { reload: () => { reloads += 1; } },
    sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } },
  };
  const fire = (type: string, extra: Record<string, unknown>) => {
    const event = Object.assign(new Event(type, { cancelable: true }), extra);
    for (const listener of listeners.get(type) ?? []) listener(event);
    return event;
  };
  return { win: win as unknown as Parameters<typeof installChunkReload>[0], fire, reloads: () => reloads, stored, listeners };
}

describe('a chunk that cannot be loaded (the session ended): reload once, which lands on sign-in', () => {
  it('reloads once on a chunk failure, then lets the error show; again a minute later', () => {
    const { win, fire, reloads, stored } = fakeWindow();
    let clock = 1_000_000;
    installChunkReload(win, () => clock);
    const first = fire('vite:preloadError', { payload: new TypeError('Failed to fetch dynamically imported module: https://dql.example/assets/AppStudioV2-1a2b.js') });
    expect(reloads()).toBe(1);
    expect(first.defaultPrevented).toBe(true);
    expect(stored.get(CHUNK_RELOAD_KEY)).toBe(String(clock));
    // The page came back and the chunk still fails: the error shows, no reload loop.
    clock += 5_000;
    const second = fire('vite:preloadError', { payload: new TypeError('Failed to fetch dynamically imported module') });
    expect(reloads()).toBe(1);
    expect(second.defaultPrevented).toBe(false);
    // A minute later, on the page the reload brought (the same tab, so the same session storage), a chunk that
    // cannot load reloads again.
    clock += 61_000;
    const next = fakeWindow(stored);
    installChunkReload(next.win, () => clock);
    next.fire('unhandledrejection', { reason: new TypeError('Failed to fetch dynamically imported module: x.js') });
    expect(reloads() + next.reloads()).toBe(2);
  });

  it('leaves every other failure alone, and can be taken off', () => {
    const { win, fire, reloads, listeners } = fakeWindow();
    const remove = installChunkReload(win, () => 5_000_000);
    const other = fire('unhandledrejection', { reason: new Error('The query failed') });
    expect(reloads()).toBe(0);
    expect(other.defaultPrevented).toBe(false);
    expect(isChunkLoadFailure(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadFailure('error loading dynamically imported module')).toBe(true);
    expect(isChunkLoadFailure(new Error('Request failed'))).toBe(false);
    remove();
    expect([...listeners.values()].flat()).toEqual([]);
  });
});

/**
 * A page in a browser that refuses session storage (every read and write throws). Its address can carry the reload
 * mark through history.replaceState unless `addressFixed`; `reload()` counts, and the next page is made from the
 * address the reload would load.
 */
function pageWithoutStorage(href: string, options: { addressFixed?: boolean } = {}) {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const shown: Array<{ role: string | null; text: string }> = [];
  let reloads = 0;
  const location = { href, reload: () => { reloads += 1; } };
  const refused = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
  const win = {
    addEventListener: (type: string, listener: (event: Event) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    removeEventListener: (type: string, listener: (event: Event) => void) => { listeners.set(type, (listeners.get(type) ?? []).filter((each) => each !== listener)); },
    location,
    ...(options.addressFixed ? {} : { history: { state: null, replaceState: (_state: unknown, _title: string, url: string) => { location.href = url; } } }),
    get sessionStorage(): Storage { return { getItem: refused, setItem: refused } as unknown as Storage; },
    document: {
      createElement: () => {
        const attributes = new Map<string, string>();
        return { setAttribute: (name: string, value: string) => attributes.set(name, value), getAttribute: (name: string) => attributes.get(name) ?? null, textContent: '', style: { cssText: '' } };
      },
      body: { appendChild: (node: { getAttribute: (name: string) => string | null; textContent: string }) => { shown.push({ role: node.getAttribute('role'), text: node.textContent }); return node; } },
    },
  };
  const fire = (type: string, extra: Record<string, unknown>) => {
    const event = Object.assign(new Event(type, { cancelable: true }), extra);
    for (const listener of listeners.get(type) ?? []) listener(event);
    return event;
  };
  return { win: win as unknown as Parameters<typeof installChunkReload>[0], fire, reloads: () => reloads, shown, address: () => location.href };
}

const chunkFailure = () => ({ payload: new TypeError('Failed to fetch dynamically imported module: https://dql.example/assets/AppStudioV2-1a2b.js') });

describe('a browser that refuses storage: still one automatic reload, never a loop', () => {
  it('the reload marks the address; the page it brings says so in plain words instead of reloading again', () => {
    let clock = 2_000_000;
    const first = pageWithoutStorage('https://dql.example/?app=claims&page=overview#top');
    installChunkReload(first.win, () => clock);
    const failed = first.fire('vite:preloadError', chunkFailure());
    expect(first.reloads()).toBe(1);
    expect(failed.defaultPrevented).toBe(true);
    const reloadedAddress = new URL(first.address());
    expect(reloadedAddress.searchParams.get(CHUNK_RELOAD_MARK)).toBe(String(clock));
    expect(reloadedAddress.searchParams.get('app')).toBe('claims');
    expect(reloadedAddress.hash).toBe('#top');

    // The page the reload brought: the chunk still cannot load, and storage still refuses.
    clock += 3_000;
    const second = pageWithoutStorage(first.address());
    installChunkReload(second.win, () => clock);
    expect(new URL(second.address()).searchParams.has(CHUNK_RELOAD_MARK), 'the mark leaves the address bar as the page starts').toBe(false);
    expect(second.address()).toBe('https://dql.example/?app=claims&page=overview#top');
    const again = second.fire('vite:preloadError', chunkFailure());
    second.fire('unhandledrejection', { reason: new TypeError('Failed to fetch dynamically imported module: x.js') });
    expect(second.reloads(), 'no second automatic reload').toBe(0);
    expect(again.defaultPrevented).toBe(false);
    expect(second.shown).toEqual([{ role: 'alert', text: CHUNK_RELOAD_MESSAGE }]);
    expect(CHUNK_RELOAD_MESSAGE).toBe('DQL could not load part of the page. Reload the page.');
  });

  it('one automatic reload per page, however many chunks fail on it', () => {
    let clock = 3_000_000;
    const page = pageWithoutStorage('https://dql.example/');
    installChunkReload(page.win, () => clock);
    page.fire('vite:preloadError', chunkFailure());
    clock += 120_000;
    page.fire('vite:preloadError', chunkFailure());
    page.fire('unhandledrejection', { reason: new TypeError('error loading dynamically imported module') });
    expect(page.reloads()).toBe(1);
  });

  it('when neither storage nor the address can say a reload happened, the page does not reload itself', () => {
    const page = pageWithoutStorage('https://dql.example/', { addressFixed: true });
    installChunkReload(page.win, () => 4_000_000);
    const failed = page.fire('vite:preloadError', chunkFailure());
    expect(page.reloads()).toBe(0);
    expect(failed.defaultPrevented).toBe(false);
    expect(page.shown).toEqual([{ role: 'alert', text: CHUNK_RELOAD_MESSAGE }]);
  });

  it('a mark older than a minute (the person came back from signing in later) does not stop the next reload', () => {
    const page = pageWithoutStorage(`https://dql.example/?${CHUNK_RELOAD_MARK}=1000`);
    installChunkReload(page.win, () => 1000 + 3_600_000);
    expect(page.address()).toBe('https://dql.example/');
    page.fire('vite:preloadError', chunkFailure());
    expect(page.reloads()).toBe(1);
    expect(page.shown).toEqual([]);
  });
});
