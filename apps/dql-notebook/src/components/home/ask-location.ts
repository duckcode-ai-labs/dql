/**
 * A browser tab's Ask identity lives in its URL: `/ask?thread=<id>` names the
 * chat the tab has open, so a reload reopens that chat and never the newest
 * one. Browser storage stays a fallback for a chat that has no thread yet.
 */
export const ASK_THREAD_PARAM = 'thread';

/** The href Ask writes for the active chat (no thread → plain `/ask`). */
export function askLocationHref(threadId: string | undefined, hash = ''): string {
  return threadId ? `/ask?${ASK_THREAD_PARAM}=${encodeURIComponent(threadId)}${hash}` : `/ask${hash}`;
}

/** The thread a URL names, if any. */
export function askThreadIdFromLocation(location: { pathname?: string; search?: string } | undefined): string | undefined {
  if (!location || location.pathname !== '/ask') return undefined;
  const value = new URLSearchParams(location.search ?? '').get(ASK_THREAD_PARAM)?.trim();
  return value ? value : undefined;
}

/** `/ask?thread=…` becomes `/` once Ask is no longer the open view. */
export function withoutAskLocationHref(href: string): string {
  const url = new URL(href);
  if (url.pathname !== '/ask') return `${url.pathname}${url.search}${url.hash}`;
  url.pathname = '/';
  url.searchParams.delete(ASK_THREAD_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * `/ask/traces` and `/ask/traces/<run>` belong to the Ask observability pages. Once another page is
 * open they become `/`, so the address bar names the page the person is on.
 */
export function withoutAskTraceLocationHref(href: string): string {
  const url = new URL(href);
  if (url.pathname === '/ask/traces' || url.pathname.startsWith('/ask/traces/')) url.pathname = '/';
  return `${url.pathname}${url.search}${url.hash}`;
}
