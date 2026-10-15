import { useCallback, useState } from 'react';

/**
 * Persist one server conversation id per AI surface so a page refresh resumes
 * that surface without pulling the full agent-rendering bundle into unrelated
 * pages.
 *
 * When the scope changes (the rail moves from one App to another), the id for
 * the new scope is returned on that same render. Returning the previous
 * scope's id for even one render would let a freshly mounted conversation
 * load, and then write into, the other scope's thread.
 */
export function usePersistedAgentThreadId(scope: string): {
  threadId: string | undefined;
  onThreadIdChange: (id: string) => void;
  resetThreadId: () => void;
} {
  const storageKey = `dql.agent.threadId.${scope}`;
  const [entry, setEntry] = useState<{ key: string; id: string | undefined }>(() => ({ key: storageKey, id: readStoredThreadId(storageKey) }));
  const current = entry.key === storageKey ? entry : { key: storageKey, id: readStoredThreadId(storageKey) };
  // Derived-state update during render: React re-renders immediately with it.
  if (current !== entry) setEntry(current);
  const onThreadIdChange = useCallback((id: string) => {
    setEntry({ key: storageKey, id });
    try { window.localStorage.setItem(storageKey, id); } catch { /* best-effort */ }
  }, [storageKey]);
  const resetThreadId = useCallback(() => {
    setEntry({ key: storageKey, id: undefined });
    try { window.localStorage.removeItem(storageKey); } catch { /* best-effort */ }
  }, [storageKey]);
  return { threadId: current.id, onThreadIdChange, resetThreadId };
}

function readStoredThreadId(storageKey: string): string | undefined {
  try {
    return window.localStorage.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
}
