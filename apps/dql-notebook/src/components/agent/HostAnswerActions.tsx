import { useCallback, useEffect, useState } from 'react';
import type { AgentRun } from '../../api/client';
import { fetchHostAnswerStatuses, runHostAnswerAction, useHostPage, useHostUi, type HostAnswerAction, type HostAnswerStatus } from '../../host/host-ui';
import { useDispatch } from '../../store/NotebookStore';
import type { Theme } from '../../themes/notebook-theme';

/** Whether an answer needs a person's review before anyone relies on it. */
export function answerNeedsReview(run: Pick<AgentRun, 'status' | 'trustState'>): boolean {
  return run.status === 'needs_review' || run.trustState === 'review_required';
}

/** Which of the host's answer actions fit this answer: review ones, and those for questions DQL could not answer. */
export function actionsForAnswer(run: Pick<AgentRun, 'status' | 'trustState'>, actions: HostAnswerAction[]): { kind: 'review' | 'unanswered'; actions: HostAnswerAction[] } | null {
  const kind = answerNeedsReview(run) ? 'review' : run.status === 'blocked' ? 'unanswered' : null;
  if (!kind) return null;
  const fitting = actions.filter((action) => (action.on ?? ['review']).includes(kind));
  return fitting.length ? { kind, actions: fitting } : null;
}

/**
 * The host's part in an answer (RFC 0010 HH-9, HH-10). Once the host is
 * reviewing it — a request is open, an analyst checked it, it became certified
 * — that status shows here. Before that, an answer that needs review offers
 * the host's actions, e.g. "Ask an analyst to check this". Nothing without a
 * host.
 */
export function HostAnswerActions({ run, t }: { run: AgentRun; t: Theme }) {
  const hostUi = useHostUi();
  const [status, setStatus] = useState<HostAnswerStatus | null>(null);
  const refresh = useCallback(() => {
    fetchHostAnswerStatuses([run.id]).then((statuses) => setStatus(statuses[run.id] ?? null)).catch(() => undefined);
  }, [run.id]);
  useEffect(() => {
    if (hostUi.host) refresh();
  }, [hostUi.host, refresh]);

  if (!hostUi.host) return null;
  if (status) return <HostAnswerStatusView status={status} t={t} />;
  const fitting = actionsForAnswer(run, hostUi.answerActions);
  if (!fitting) return null;
  return <HostAnswerActionButtons run={run} kind={fitting.kind} actions={fitting.actions} onSent={refresh} t={t} />;
}

const STATUS_TONE: Record<HostAnswerStatus['state'], 'accent' | 'warning' | 'muted'> = {
  requested: 'warning',
  in_progress: 'warning',
  checked: 'accent',
  certified: 'accent',
  declined: 'muted',
};

export function HostAnswerStatusView({ status, t }: { status: HostAnswerStatus; t: Theme }) {
  const hostPage = useHostPage();
  const dispatch = useDispatch();
  const tone = STATUS_TONE[status.state];
  const color = tone === 'accent' ? t.accent : tone === 'warning' ? t.warning : t.textSecondary;
  return (
    <div data-testid="host-answer-status" data-state={status.state} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', border: `1px solid ${t.cellBorder}`, borderLeft: `3px solid ${color}`, borderRadius: 8, background: t.cellBg }}>
      <div style={{ display: 'grid', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: t.textPrimary }}>{status.label}</span>
        {status.detail ? <span style={{ fontSize: 12, color: t.textSecondary }}>{status.detail}</span> : null}
      </div>
      {status.href ? (
        <button
          type="button"
          className="dql-hover"
          onClick={() => { hostPage.openPage({ id: `answer-${status.href}`, label: status.label, href: status.href! }); dispatch({ type: 'SET_MAIN_VIEW', view: 'host_page' }); }}
          style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${t.cellBorder}`, background: 'transparent', color: t.textPrimary, fontSize: 12, fontFamily: t.font, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          Open
        </button>
      ) : null}
    </div>
  );
}

function HostAnswerActionButtons({ run, kind, actions, onSent, t }: {
  run: AgentRun;
  kind: 'review' | 'unanswered';
  actions: HostAnswerAction[];
  onSent: () => void;
  t: Theme;
}) {
  const [sending, setSending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  return (
    <div style={{ display: 'grid', gap: 6, padding: '8px 10px', border: `1px solid ${t.cellBorder}`, borderRadius: 8, background: t.cellBg }} data-testid="host-answer-actions">
      <span style={{ fontSize: 11.5, color: t.textSecondary }}>{kind === 'review' ? 'No certified source answers this yet.' : 'DQL could not answer this from your certified and governed sources.'}</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {actions.map((action, index) => (
          <button
            key={action.id}
            type="button"
            className="dql-hover"
            disabled={sending !== null}
            title={action.description}
            onClick={async () => {
              setSending(action.id);
              setMessage(null);
              try {
                const text = await runHostAnswerAction(action, { runId: run.id, question: run.question, ...(run.trustState ? { trustState: run.trustState } : {}) });
                setMessage({ text, failed: false });
                onSent();
              } catch (error) {
                setMessage({ text: error instanceof Error ? error.message : 'The request was not sent.', failed: true });
              } finally {
                setSending(null);
              }
            }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
              fontSize: 12, fontFamily: t.font, fontWeight: 600,
              border: `1px solid ${index === 0 ? t.accent : t.cellBorder}`,
              background: index === 0 ? t.accent : 'transparent',
              color: index === 0 ? '#fff' : t.textPrimary,
            }}
          >
            {sending === action.id ? 'Sending…' : action.label}
          </button>
        ))}
      </div>
      {message ? <span role="status" style={{ fontSize: 12, color: message.failed ? t.error : t.textSecondary }}>{message.text}</span> : null}
    </div>
  );
}
