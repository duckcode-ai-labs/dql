import type { Cell } from '../store/types';

const BLOCKED_FAILURE_CODES = new Set([
  'AMBIGUOUS_NOTEBOOK_DEPENDENCY',
  // No connection yet: the next step is Connections, not a rewrite of this cell.
  'CONNECTION_NOT_CONFIGURED',
  'CROSS_ENGINE_JOIN_REQUIRED',
  'EXECUTION_TARGET_MISMATCH',
  'SEMANTIC_SOURCE_DRIFT',
  'STALE_CELL_EXECUTION',
  'UPSTREAM_RESULT_UNAVAILABLE',
  'UNAUTHORIZED',
]);

const USER_ACTION_FAILURE = /(?:permission|not authorized|unauthori[sz]ed|access denied|authentication|credential|policy|unsafe|read[- ]only|cancel(?:led|ed)|required parameters?|provide required|cross[- ]engine|upstream (?:cell|result)|notebook dependency|target mismatch|source drift|matched more than one schema)/i;

/**
 * Keep the quiet repair action to failures where changing only this cell can be
 * safe. Dependency, target, access, policy, and semantic-DQL failures remain
 * explicit user decisions. Acceptance: UI-012, UI-013, UI-015, SEC-004.
 */
export function canBackgroundRepairNotebookCell(cell: Cell): boolean {
  if (!cell.error || (cell.type !== 'sql' && cell.type !== 'dql')) return false;
  const code = cell.execution?.error?.code?.trim().toUpperCase();
  if (code && BLOCKED_FAILURE_CODES.has(code)) return false;
  if (USER_ACTION_FAILURE.test(cell.error)) return false;

  if (cell.type === 'sql') {
    return !/\{\{[^}]+\}\}/.test(cell.content);
  }

  if (/^\s*@block\(/i.test(cell.content)) return false;
  return /\bblock\b/i.test(cell.content)
    && /\bquery\b/i.test(cell.content)
    && !/\btype\s*=\s*"semantic"/i.test(cell.content);
}

export function notebookRepairErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return 'Automatic repair could not finish safely. Edit this cell and run again.';
  return compact.length > 420 ? `${compact.slice(0, 419)}…` : compact;
}
