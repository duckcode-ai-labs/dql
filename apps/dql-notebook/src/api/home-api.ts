import { authorizedFetch } from './server-auth';

/**
 * A HOME THAT SUMMARISES (RFC 0010, HH-16). The server answers each call for
 * the person asking: the Apps they may open, what moved on the pages they
 * follow or opened (from their own runs), and — with a host — the cards the
 * host adds (for example their open requests). Without a host the same calls
 * answer for the one local person, and the host parts are empty.
 */
export interface HomeApp {
  id: string;
  name: string;
  domain: string;
  description?: string;
  homePageId?: string;
  pages: Array<{ id: string; title: string }>;
  following: boolean;
  lastOpenedAt?: string;
}

export interface HomeMovedFigure { label: string; from: string; to: string; change: string; direction: 'up' | 'down' }

export interface HomeMovedPage {
  appId: string;
  pageId: string;
  appName: string;
  pageTitle: string;
  at: string;
  since?: string;
  changes: HomeMovedFigure[];
  unchanged: number;
  newEditionAt?: string;
  following: boolean;
}

export interface HomeFollow { appId: string; pageId?: string; title?: string; followedAt?: string }

export interface HomeSummary { apps: HomeApp[]; moved: HomeMovedPage[]; follows: HomeFollow[] }

export interface HomeCard {
  id: string;
  title: string;
  items: Array<{ id: string; title: string; status?: string; detail?: string; href?: string; tone?: 'info' | 'caution' | 'done' }>;
  emptyText?: string;
  more?: { label: string; href: string };
}

export type DirectoryGroups = { source: 'host'; groups: Array<{ id: string; label?: string; members?: number }> } | { source: 'free_text' };

/** A refusal as the server gives it, with the host's "where to go" link (HH-12). */
export interface ApiRefusal { error: string; next?: { label: string; href: string } }

async function json<T>(path: string, init?: RequestInit): Promise<{ ok: true; body: T } | { ok: false; status: number; refusal: ApiRefusal }> {
  let response: Response;
  try {
    response = await authorizedFetch(path, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  } catch (error) {
    return { ok: false, status: 0, refusal: { error: error instanceof Error ? error.message : String(error) } };
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok && body.ok !== false) return { ok: true, body: body as T };
  const next = body.next && typeof body.next === 'object' ? body.next as ApiRefusal['next'] : undefined;
  return { ok: false, status: response.status, refusal: { error: typeof body.error === 'string' ? body.error : `The request failed (${response.status}).`, ...(next ? { next } : {}) } };
}

export async function fetchHome(): Promise<HomeSummary | null> {
  const result = await json<HomeSummary>('/api/home');
  return result.ok ? { apps: result.body.apps ?? [], moved: result.body.moved ?? [], follows: result.body.follows ?? [] } : null;
}

export async function fetchHomeCards(): Promise<HomeCard[]> {
  const result = await json<{ cards?: HomeCard[] }>('/api/host/home-cards');
  return result.ok && Array.isArray(result.body.cards) ? result.body.cards : [];
}

export async function fetchFollowing(appId: string, pageId: string): Promise<boolean | null> {
  const result = await json<{ following?: boolean }>(`/api/apps/${encodeURIComponent(appId)}/follow?page=${encodeURIComponent(pageId)}`);
  return result.ok ? result.body.following === true : null;
}

export async function saveFollowing(appId: string, pageId: string, following: boolean): Promise<{ ok: true; following: boolean } | { ok: false; refusal: ApiRefusal }> {
  const result = await json<{ following?: boolean }>(`/api/apps/${encodeURIComponent(appId)}/follow`, { method: 'POST', body: JSON.stringify({ pageId, following }) });
  return result.ok ? { ok: true, following: result.body.following === true } : { ok: false, refusal: result.refusal };
}

export async function fetchDirectoryGroups(): Promise<DirectoryGroups> {
  const result = await json<DirectoryGroups>('/api/host/groups');
  return result.ok ? result.body : { source: 'free_text' };
}

export async function saveAppAudience(appId: string, input: { groups: string[]; text?: string }): Promise<{ ok: true; audienceGroups: string[]; audience: string | null; path: string } | { ok: false; refusal: ApiRefusal }> {
  const result = await json<{ audienceGroups: string[]; audience: string | null; path: string }>(`/api/apps/${encodeURIComponent(appId)}/audience`, { method: 'PUT', body: JSON.stringify(input) });
  return result.ok ? { ok: true, ...result.body } : { ok: false, refusal: result.refusal };
}

/** Who a published App is for, as its file says; null when the App is not published (or not yours to read). */
export async function fetchAppAudience(appId: string): Promise<{ audience?: string; audienceGroups: string[] } | null> {
  const result = await json<{ app?: { audience?: string; audienceGroups?: string[] } }>(`/api/apps/${encodeURIComponent(appId)}`);
  if (!result.ok || !result.body.app) return null;
  return { ...(result.body.app.audience ? { audience: result.body.app.audience } : {}), audienceGroups: result.body.app.audienceGroups ?? [] };
}
