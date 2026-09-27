import { authorizedFetch } from '../../api/server-auth';

/**
 * A link to one Ask answer is `/ask?run=<runId>` (hosts, Slack and agents send
 * it). Before the app starts, it becomes the conversation the answer is in,
 * `/ask?thread=<id>`, or plain `/ask` when this person can't see it.
 */
export function askRunIdFromLocation(location: { pathname?: string; search?: string }): string | undefined {
  if (location.pathname !== '/ask') return undefined;
  const value = new URLSearchParams(location.search ?? '').get('run')?.trim();
  return value && /^[\w.:-]{1,200}$/.test(value) ? value : undefined;
}

export async function resolveAskRunLink(): Promise<void> {
  if (typeof window === 'undefined') return;
  const runId = askRunIdFromLocation(window.location);
  if (!runId) return;
  let threadId: string | undefined;
  try {
    const response = await authorizedFetch(`/api/agent-runs/${encodeURIComponent(runId)}/thread`, { credentials: 'same-origin' });
    if (response.ok) threadId = ((await response.json()) as { threadId?: string }).threadId;
  } catch {
    threadId = undefined;
  }
  window.history.replaceState(window.history.state, '', threadId ? `/ask?thread=${encodeURIComponent(threadId)}` : '/ask');
}
