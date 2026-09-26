import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { authorizedFetch } from '../api/server-auth';

/**
 * When DQL runs inside a host (RFC 0010 HH-9), the host says who is signed
 * in, what they may do, and what it adds around DQL's screens: links to its
 * own pages, its sign-out, and actions on answers that need review. The
 * screens stay DQL's. Without a host (`dql notebook`) this is `{ host: false }`
 * and nothing in the app changes.
 */
export interface HostUi {
  host: true;
  person: { id: string; name: string; email?: string; kind: 'person' | 'service' };
  capabilities: Record<string, boolean>;
  signOutUrl?: string;
  environment?: string;
  links: HostLink[];
  answerActions: HostAnswerAction[];
}

export type HostIcon = 'inbox' | 'requests' | 'review' | 'work' | 'health' | 'admin' | 'people' | 'git' | 'link';
export interface HostLink { id: string; label: string; href: string; placement: 'menu' | 'nav'; badge?: number; icon?: HostIcon }

/** Where the host's review of one answer stands (HH-10), e.g. "Checked by Dan Kim". */
export interface HostAnswerStatus {
  state: 'requested' | 'in_progress' | 'checked' | 'certified' | 'declined';
  label: string;
  detail?: string;
  href?: string;
}

export interface HostAnswerAction { id: string; label: string; url: string; description?: string; on?: Array<'review' | 'unanswered' | 'answered'> }

export type HostUiState = HostUi | { host: false };

const HostUiContext = createContext<HostUiState>({ host: false });

/** The host page open in DQL's main area, if any. */
export interface HostPage { id: string; label: string; href: string }

/** Ask the host where each answer's review stands; answers it doesn't know are absent. */
export async function fetchHostAnswerStatuses(runIds: string[]): Promise<Record<string, HostAnswerStatus>> {
  if (!runIds.length) return {};
  const response = await authorizedFetch('/api/host/answer-status', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runIds }),
  });
  if (!response.ok) return {};
  const body = await response.json().catch(() => ({})) as { statuses?: Record<string, HostAnswerStatus> };
  return body.statuses ?? {};
}
const HostPageContext = createContext<{ page: HostPage | null; openPage: (page: HostPage) => void }>({ page: null, openPage: () => undefined });

export function HostUiProvider({ children, initial }: { children: ReactNode; initial?: HostUiState }) {
  const [state, setState] = useState<HostUiState>(initial ?? { host: false });
  const [page, setPage] = useState<HostPage | null>(null);
  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    const load = () => authorizedFetch('/api/host/ui', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { host: false }))
      .then((value: HostUiState) => { if (!cancelled && value && typeof value === 'object') setState(value.host === true ? value : { host: false }); })
      .catch(() => undefined);
    void load();
    // Counts on the host's links change as work moves: reload when a host page
    // says something changed, when the tab comes back, and once a minute.
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && isHostChange(event.data)) void load();
    };
    const onFocus = () => void load();
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [initial]);
  return (
    <HostUiContext.Provider value={state}>
      <HostPageContext.Provider value={{ page, openPage: setPage }}>{children}</HostPageContext.Provider>
    </HostUiContext.Provider>
  );
}

/** The message a host page inside DQL posts after changing something (HH-10). */
export const HOST_CHANGED_MESSAGE = 'dql-host:changed';
export function isHostChange(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { type?: unknown }).type === HOST_CHANGED_MESSAGE;
}

export function useHostPage() {
  return useContext(HostPageContext);
}

/** A host page inside DQL's main area: DQL's frame stays, the page fills it. */
export function hostPageSrc(href: string): string {
  return `${href}${href.includes('?') ? '&' : '?'}embed=1`;
}

export function useHostUi(): HostUiState {
  return useContext(HostUiContext);
}

/**
 * Whether this person may do an action. Without a host the local owner may
 * do everything, as before; with one, only what the host's rules allow.
 */
export function hostAllows(state: HostUiState, action: string): boolean {
  if (!state.host) return true;
  return state.capabilities[action] === true;
}

/** Which DQL action each navigation destination needs under a host. */
export const NAV_CAPABILITY: Record<string, string[]> = {
  ask: ['ask'],
  files: ['project.write'],
  block_library: ['dataset.author'],
  lineage: ['dataset.author'],
  domains: ['dataset.author'],
  ask_observability: ['hint.review'],
  git: ['git.review'],
  settings: ['settings.manage', 'connection.manage'],
};

export function navItemAllowed(state: HostUiState, key: string): boolean {
  const needs = NAV_CAPABILITY[key];
  if (!state.host || !needs) return true;
  return needs.some((action) => hostAllows(state, action));
}

/** Post an answer action to the host; returns the message to show. */
export async function runHostAnswerAction(action: HostUi['answerActions'][number], input: { runId: string; question: string; threadId?: string; trustState?: string }): Promise<string> {
  const response = await authorizedFetch(action.url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { message?: unknown; error?: unknown };
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `The request was not sent (${response.status}).`);
  return typeof body.message === 'string' ? body.message : 'Sent.';
}
