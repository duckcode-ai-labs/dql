/**
 * ONE ASK CONVERSATION PER APP PAGE.
 *
 * An Ask from an App reads that App's page (app-view-answer). Its
 * conversation must be that page's too: in the 0.1.0 re-test, a question on a
 * certified App was continued in the thread of a review-required App asked
 * earlier, so the certified App's panel opened on the other App's answer and
 * the earlier result was bound as "prior result" context for the new
 * question.
 *
 * The browser keeps one thread per App page. The server enforces it as well:
 * a conversation is bound to the App page of its first App question, and a
 * question from another App page never continues it.
 */

/** `app:<appId>:<pageId>` for a question asked from an App page; undefined otherwise. */
export function appAskScopeKey(workspaceContext: Record<string, unknown> | undefined): string | undefined {
  if (!workspaceContext || workspaceContext.surface !== 'apps') return undefined;
  const appId = typeof workspaceContext.appId === 'string' ? workspaceContext.appId.trim() : '';
  if (!appId) return undefined;
  const pageId = typeof workspaceContext.dashboardId === 'string' && workspaceContext.dashboardId.trim()
    ? workspaceContext.dashboardId.trim()
    : '';
  return `app:${appId}:${pageId}`;
}

/**
 * What to do with the requested conversation for this question.
 *
 * - `continue`: same App page (or not an App question): use its turns.
 * - `bind`: an unscoped conversation, now bound to this App page.
 * - `detach`: it belongs to another App page; answer without it, and do not
 *   save this answer into it.
 */
export function appAskThreadDecision(
  thread: { scopeKey?: string } | null | undefined,
  askScope: string | undefined,
): 'continue' | 'bind' | 'detach' {
  if (!thread || !askScope) return 'continue';
  if (!thread.scopeKey) return 'bind';
  return thread.scopeKey === askScope ? 'continue' : 'detach';
}
