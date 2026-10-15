import { useEffect, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { UnifiedAgentRunPanel, usePersistedAgentThreadId } from './UnifiedAgentRunPanel';
import { api, type AgentRunSelectedObject } from '../../api/client';
import { AiSidePanel, AI_SIDE_PANEL_EXPANDED_WIDTH, AI_SIDE_PANEL_WIDTH } from './AiSidePanel';
import type { GlobalAiContext } from '../../store/types';

/**
 * Which conversation the rail continues.
 *
 * Asked from an App, it is that App page's own conversation: a question asked
 * on one App never shows up in, or becomes context for, another App's thread,
 * and coming back to an App resumes its thread. Anything else shares one
 * rolling rail conversation.
 */
export function globalAiThreadScope(context: GlobalAiContext | undefined): string {
  const workspace = context?.workspaceContext;
  const appId = typeof workspace?.appId === 'string' && workspace.appId.trim() ? workspace.appId : undefined;
  if (workspace?.surface === 'apps' && appId) {
    const dashboardId = typeof workspace.dashboardId === 'string' && workspace.dashboardId.trim() ? workspace.dashboardId : 'app';
    return `app-ask:${appId}:${dashboardId}`;
  }
  return 'global-rail';
}

/**
 * Questions the rail already asked. The conversation view remounts when the
 * rail switches to another App's thread (or reopens); the question that
 * opened an earlier one must not be asked again there.
 */
const consumedAutoRunNonces = new Set<number>();

/**
 * The global, context-aware stakeholder copilot rail. Mounted once at the shell
 * so follow-ups work across Apps and Research; opened with the active object's
 * context (e.g. a selected dashboard tile) via the OPEN_GLOBAL_AI action.
 */
export function GlobalAiRail() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const { audience, context } = state.globalAi;
  const selectedObject = context.selectedObject as AgentRunSelectedObject | undefined;
  // One server-persisted conversation per App page (one rolling one
  // elsewhere); a page refresh resumes the same thread.
  const threadScope = globalAiThreadScope(context);
  const agentThread = usePersistedAgentThreadId(threadScope);
  const autoRun = state.globalAi.autoRun && !consumedAutoRunNonces.has(state.globalAi.autoRun.nonce)
    ? state.globalAi.autoRun
    : undefined;
  useEffect(() => {
    if (autoRun) consumedAutoRunNonces.add(autoRun.nonce);
  }, [autoRun]);
  const [expanded, setExpanded] = useState(false);
  const openApp = (appId: string, dashboardId?: string, draftId?: string) => {
    if (draftId) dispatch({ type: 'OPEN_APP_DRAFT', draftId, appId, dashboardId });
    else dispatch({ type: 'OPEN_APP', appId, dashboardId, experience: 'view', section: 'dashboards' });
    dispatch({ type: 'CLOSE_GLOBAL_AI' });
    // A newly created App is not in the shell catalog yet. Refresh it in the
    // background so the destination title/navigation resolves immediately.
    void api.listApps().then((apps) => dispatch({ type: 'SET_APPS', apps })).catch(() => undefined);
  };

  return (
    <AiSidePanel
      t={t}
      title={context.title ?? 'AI copilot'}
      subtitle={context.scopeHint ?? 'Ask a follow-up about what you are viewing'}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((value) => !value)}
      resizable
      minResizeWidth={360}
      maxResizeWidth={1200}
      onClose={() => dispatch({ type: 'CLOSE_GLOBAL_AI' })}
      ariaLabel="App AI"
      style={{
        position: 'relative',
        width: expanded
          ? `min(${AI_SIDE_PANEL_EXPANDED_WIDTH}px, calc(100vw - 96px))`
          : `min(${AI_SIDE_PANEL_WIDTH}px, calc(100vw - 64px))`,
        maxWidth: expanded ? '62vw' : '46vw',
        minWidth: 320,
        flex: '0 0 auto',
      }}
    >
      <UnifiedAgentRunPanel
        // A different App's conversation is a different thread: start from
        // its own turns, never from the previous App's.
        key={threadScope}
        themeMode={state.themeMode}
        title={context.title ?? 'AI copilot'}
        scopeHint={context.scopeHint ?? 'Ask a follow-up about what you are viewing'}
        audience={audience}
        selectedObject={selectedObject}
        workspaceContext={context.workspaceContext}
        examplePrompts={Array.isArray(context.suggestedQuestions) && context.suggestedQuestions.length > 0
          ? context.suggestedQuestions
              .filter((question): question is string => typeof question === 'string')
              .slice(0, 4)
              .map((question) => ({ label: question, prompt: question }))
          : undefined}
        autoRun={autoRun
          ? { text: autoRun.text, mode: autoRun.mode as never, nonce: autoRun.nonce }
          : undefined}
        threadId={agentThread.threadId}
        onThreadIdChange={agentThread.onThreadIdChange}
        initialMode="auto"
        onOpenApp={openApp}
      />
    </AiSidePanel>
  );
}
