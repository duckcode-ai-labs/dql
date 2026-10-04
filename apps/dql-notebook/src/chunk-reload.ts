/**
 * A part of the app that is loaded later (a lazy chunk) and cannot be fetched — as when the person's session ended
 * and the host sends the request to sign-in — reloads the page once, which then lands on sign-in, instead of showing
 * an error. Nothing about the app's files changes; the server still serves them only to a signed-in person.
 *
 * At most one automatic reload, whatever the browser lets the page store:
 * - one per page: after it, this page never reloads itself again;
 * - the reload marks the address it reloads (`?dql-reloaded=<time>`), and a page that arrives with a mark from the
 *   last minute does not reload itself again; it reads the mark as it starts and takes it out of the address bar;
 * - session storage, when the browser allows it, keeps the same minute across pages too;
 * - when neither the address nor storage can be marked, the page does not reload itself at all.
 * Instead of a second reload the page says, in plain words, "DQL could not load part of the page. Reload the page."
 */
export const CHUNK_RELOAD_KEY = 'dql-chunk-reload-at';
export const CHUNK_RELOAD_MARK = 'dql-reloaded';
export const CHUNK_RELOAD_MESSAGE = 'DQL could not load part of the page. Reload the page.';
const CHUNK_FAILURE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;
const ONCE_WITHIN_MS = 60_000;

export function isChunkLoadFailure(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return CHUNK_FAILURE.test(message);
}

type ChunkWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  location: Pick<Location, 'reload'> & Partial<Pick<Location, 'href'>>;
  history?: Pick<History, 'replaceState'> & Partial<Pick<History, 'state'>>;
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  document?: Pick<Document, 'createElement' | 'body'>;
};

/** The page's address with the reload mark set to `at`, without it (`at` null), or null when it cannot be read. */
function markedAddress(win: ChunkWindow, at: number | null): string | null {
  try {
    if (typeof win.location.href !== 'string' || !win.history) return null;
    const url = new URL(win.location.href);
    if (at === null) url.searchParams.delete(CHUNK_RELOAD_MARK);
    else url.searchParams.set(CHUNK_RELOAD_MARK, String(at));
    return url.href;
  } catch {
    return null;
  }
}

/** When this page was reached through an automatic reload (the mark in its address), else null. */
function arrivedThroughReload(win: ChunkWindow): number | null {
  try {
    if (typeof win.location.href !== 'string') return null;
    const raw = new URL(win.location.href).searchParams.get(CHUNK_RELOAD_MARK);
    if (raw === null) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : 0;
  } catch {
    return null;
  }
}

function showReloadMessage(win: ChunkWindow, shown: { element?: unknown }): void {
  if (shown.element) return;
  try {
    const doc = win.document;
    if (!doc?.body) return;
    const note = doc.createElement('div');
    note.setAttribute('role', 'alert');
    note.textContent = CHUNK_RELOAD_MESSAGE;
    note.style.cssText = [
      'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)', 'z-index:2147483647',
      'max-width:calc(100vw - 32px)', 'padding:10px 14px', 'border-radius:8px', 'font:500 13px/1.4 system-ui,sans-serif',
      'background:var(--bg-2,#fff)', 'color:var(--text-primary,#1a1a1a)', 'border:1px solid var(--border-strong,#888)',
      'box-shadow:0 4px 16px rgba(0,0,0,.15)',
    ].join(';');
    doc.body.appendChild(note);
    shown.element = note;
  } catch { /* nothing to show it on: the browser's own error stays */ }
}

export function installChunkReload(win: ChunkWindow, now: () => number = () => Date.now()): () => void {
  // Read the mark as the page starts, then take it out of the address bar (a bookmark or a shared link never carries it).
  const arrivedAt = arrivedThroughReload(win);
  if (arrivedAt !== null) {
    const clean = markedAddress(win, null);
    try { if (clean) win.history!.replaceState(win.history!.state ?? null, '', clean); } catch { /* the mark stays in the address */ }
  }
  let reloaded = false;
  const shown: { element?: unknown } = {};

  const reloadOnce = (event: Event, reason: unknown, always: boolean) => {
    if (!always && !isChunkLoadFailure(reason)) return;
    // One automatic reload per page.
    if (reloaded) return;
    // This page is the automatic reload of a minute ago: say so instead of reloading again.
    if (arrivedAt !== null && now() - arrivedAt < ONCE_WITHIN_MS) { showReloadMessage(win, shown); return; }
    let last = 0;
    try { last = Number(win.sessionStorage?.getItem(CHUNK_RELOAD_KEY) ?? 0) || 0; } catch { /* storage refused: the address carries the mark */ }
    if (now() - last < ONCE_WITHIN_MS) { showReloadMessage(win, shown); return; }

    const at = now();
    let marked = false;
    try { win.sessionStorage?.setItem(CHUNK_RELOAD_KEY, String(at)); marked = Boolean(win.sessionStorage); } catch { /* storage refused */ }
    const address = markedAddress(win, at);
    if (address) {
      try { win.history!.replaceState(win.history!.state ?? null, '', address); marked = true; } catch { /* the address cannot carry the mark */ }
    }
    // Neither storage nor the address can say a reload already happened: a reload could repeat, so none.
    if (!marked) { showReloadMessage(win, shown); return; }
    reloaded = true;
    event.preventDefault();
    win.location.reload();
  };
  // Vite reports every chunk it could not load (or preload) here before the import fails.
  const onPreloadError = (event: Event) => reloadOnce(event, (event as Event & { payload?: unknown }).payload, true);
  const onRejection = (event: Event) => reloadOnce(event, (event as PromiseRejectionEvent).reason, false);
  win.addEventListener('vite:preloadError', onPreloadError);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    win.removeEventListener('vite:preloadError', onPreloadError);
    win.removeEventListener('unhandledrejection', onRejection);
  };
}
