import { afterEach, describe, expect, it, vi } from 'vitest';

// What the app's entry point loads besides the reload: stand-ins, so the entry point itself runs here.
vi.mock('@duckcodeailabs/dql-ui/styles', () => ({}));
vi.mock('./components/home/ask-run-link', () => ({ resolveAskRunLink: () => Promise.resolve() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: () => undefined }) }));
vi.mock('./App', () => ({ App: () => null }));

/**
 * A lazy part of the app that cannot load once the session ended reloads the page once (to sign-in): the app's
 * entry point (main.tsx) installs that on the page as it starts. This runs the entry point on a stand-in page and
 * fails when the entry point does not install it (chunk-reload.test.ts tests the reload itself).
 */
describe('the app\'s entry point', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('installs the reload on the page: a chunk that cannot load reloads the page once', async () => {
    const listeners = new Map<string, Array<(event: Event) => void>>();
    const stored = new Map<string, string>();
    let reloads = 0;
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: Event) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
      removeEventListener: (type: string, listener: (event: Event) => void) => { listeners.set(type, (listeners.get(type) ?? []).filter((each) => each !== listener)); },
      location: { reload: () => { reloads += 1; } },
      sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } },
    });
    vi.stubGlobal('document', { getElementById: () => ({}) });

    await import('./main');

    expect(listeners.get('vite:preloadError')?.length, 'the entry point installs a handler for chunks that cannot load').toBe(1);
    const failed = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: new TypeError('Failed to fetch dynamically imported module: https://dql.example/assets/AppStudioV2-1a2b.js') });
    for (const listener of listeners.get('vite:preloadError') ?? []) listener(failed);
    expect(reloads).toBe(1);
    expect(failed.defaultPrevented).toBe(true);
  });
});
