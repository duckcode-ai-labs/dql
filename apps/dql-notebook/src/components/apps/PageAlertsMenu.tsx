import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Bell, Trash2 } from 'lucide-react';
import { figureLabel, type StoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import { api, type AppScheduleDeliveryV1, type PageMonitorScheduleV1 } from '../../api/client';
import { ALERT_RULES, alertCondition, alertFigures, describeCondition, describeCron, describeDelivery, type AlertRule } from './page-alerts';

type Delivery = 'none' | 'webhook' | 'slack' | 'email';

/**
 * Alerts on a page's figures (RFC 0008 step 10). An alert watches one bound
 * figure and is checked each time the page runs on its schedule; it is
 * saved in the App's dql.app.json, so it is shared through git like the page.
 */
export function PageAlertsMenu({
  appId,
  dashboardId,
  runId,
  catalog,
}: {
  appId: string;
  dashboardId: string;
  /** The current complete run; alerts can only watch figures it returned. */
  runId: string | null;
  catalog: StoryBindingCatalog;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [schedules, setSchedules] = useState<PageMonitorScheduleV1[] | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const figures = useMemo(() => alertFigures(catalog), [catalog]);
  const [figure, setFigure] = useState('');
  const [rule, setRule] = useState<AlertRule>('below');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [delivery, setDelivery] = useState<Delivery>('none');
  const [target, setTarget] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const formId = useId();

  const load = useCallback(async () => {
    try {
      const result = await api.getPageMonitors(appId, dashboardId);
      setSchedules(result.schedules ?? []);
    } catch (cause) {
      setSchedules([]);
      setStatus({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [appId, dashboardId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  useEffect(() => {
    if (!figure && figures[0]) setFigure(figures[0].key);
  }, [figure, figures]);

  const alerts = (schedules ?? []).flatMap((schedule) => schedule.monitors.map((monitor) => ({ schedule, monitor })));
  const firing = alerts.filter(({ schedule, monitor }) => schedule.firingSince[monitor.id]).length;
  const selected = figures.find((entry) => entry.key === figure);
  const ruleInfo = ALERT_RULES.find((entry) => entry.rule === rule)!;
  const needsDelivery = (schedules ?? []).length === 0;
  const unit = ruleInfo.unit === 'percent' ? '%' : selected?.display.trim().startsWith('$') ? '$' : selected?.display.trim().endsWith('%') ? '%' : '';

  const add = async () => {
    const value = Number(amount);
    if (!runId) { setStatus({ tone: 'error', text: 'Wait for the whole page to load, then add the alert.' }); return; }
    if (!selected) { setStatus({ tone: 'error', text: 'Choose a figure to watch.' }); return; }
    if (!amount.trim() || !Number.isFinite(value) || (ruleInfo.unit === 'percent' && value <= 0)) {
      setStatus({ tone: 'error', text: ruleInfo.unit === 'percent' ? 'Enter a percentage above 0.' : 'Enter a number.' });
      return;
    }
    let deliver: AppScheduleDeliveryV1[] | undefined;
    if (needsDelivery && delivery !== 'none') {
      const text = target.trim();
      if (!text) { setStatus({ tone: 'error', text: 'Enter where to send alerts, or choose the run log.' }); return; }
      deliver = delivery === 'webhook' ? [{ kind: 'webhook', url: text }]
        : delivery === 'slack' ? [{ kind: 'slack', channel: text }]
          : [{ kind: 'email', to: text.split(/[,\s]+/).filter(Boolean) }];
    }
    setBusy(true);
    setStatus(null);
    try {
      const result = await api.addPageMonitor(appId, dashboardId, {
        runId,
        binding: selected.key,
        when: alertCondition(rule, value),
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(deliver ? { deliver } : {}),
      });
      setSchedules(result.schedules);
      setAmount('');
      setLabel('');
      setStatus({ tone: 'ok', text: `Saved in ${result.path ?? 'dql.app.json'}${result.createdSchedule ? ' with a new alerts-only schedule' : ''}. Commit the change to share it.` });
    } catch (cause) {
      setStatus({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (scheduleId: string, monitorId: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await api.removePageMonitor(appId, dashboardId, scheduleId, monitorId);
      setSchedules(result.schedules);
      setStatus({ tone: 'ok', text: `Removed from ${result.path ?? 'dql.app.json'}.` });
    } catch (cause) {
      setStatus({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const labelFor = (binding: string) => (catalog[binding] ? figureLabel(catalog[binding]!.label) : binding);
  const displayFor = (binding: string) => catalog[binding]?.display;

  return (
    <div className="dql-alerts" ref={rootRef}>
      <button
        type="button"
        className={`dql-export-button ${firing ? 'firing' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setStatus(null); setOpen((current) => !current); }}
        title="Alerts on this page's figures"
      >
        <Bell size={13} aria-hidden="true" /> Alerts{alerts.length ? ` · ${alerts.length}` : ''}{firing ? <span className="dql-alerts-firing">{firing} firing</span> : null}
      </button>
      {open ? (
        <div className="dql-alerts-panel" role="dialog" aria-label="Alerts on this page">
          <h3>Alerts on this page</h3>
          {schedules === null ? <p className="dql-alerts-note">Loading…</p> : alerts.length === 0 ? (
            <p className="dql-alerts-note">No alerts yet. An alert watches one figure and is checked each time the page runs on its schedule.</p>
          ) : (
            <ul className="dql-alerts-list">
              {alerts.map(({ schedule, monitor }) => {
                const since = schedule.firingSince[monitor.id];
                return (
                  <li key={`${schedule.id}:${monitor.id}`}>
                    <div>
                      <strong>{monitor.label ?? labelFor(monitor.binding)}</strong> {describeCondition(monitor.when, displayFor(monitor.binding))}
                      {since ? <span className="dql-alerts-firing">Firing since {new Date(since).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span> : null}
                      <small>Checked {describeCron(schedule.cron)} · {describeDelivery(schedule.deliver)}{schedule.enabled ? '' : ' · schedule off'}</small>
                    </div>
                    <button type="button" className="dql-alerts-remove" aria-label={`Remove alert on ${monitor.label ?? labelFor(monitor.binding)}`} disabled={busy} onClick={() => void remove(schedule.id, monitor.id)}>
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <form className="dql-alerts-form" onSubmit={(event) => { event.preventDefault(); void add(); }} aria-label="Add an alert">
            <label htmlFor={`${formId}-figure`}>Alert me when</label>
            <select id={`${formId}-figure`} value={figure} onChange={(event) => setFigure(event.target.value)} disabled={!figures.length}>
              {figures.length ? figures.map((entry) => <option key={entry.key} value={entry.key}>{entry.label} (now {entry.display})</option>) : <option value="">No figures yet: wait for the page to load</option>}
            </select>
            <div className="dql-alerts-row">
              <select aria-label="Condition" value={rule} onChange={(event) => setRule(event.target.value as AlertRule)}>
                {ALERT_RULES.map((entry) => <option key={entry.rule} value={entry.rule}>{entry.label}</option>)}
              </select>
              <span className="dql-alerts-amount">
                {unit === '$' ? <span aria-hidden="true">$</span> : null}
                <input id={`${formId}-amount`} aria-label={ruleInfo.unit === 'percent' ? 'Percent' : 'Value'} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={ruleInfo.unit === 'percent' ? '20' : '100'} />
                {unit === '%' ? <span aria-hidden="true">%</span> : null}
              </span>
            </div>
            <input aria-label="Name (optional)" placeholder="Name, e.g. Revenue below plan (optional)" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={120} />
            {needsDelivery ? (
              <>
                <label htmlFor={`${formId}-delivery`}>Send alerts to</label>
                <div className="dql-alerts-row">
                  <select id={`${formId}-delivery`} value={delivery} onChange={(event) => setDelivery(event.target.value as Delivery)}>
                    <option value="none">The run log only</option>
                    <option value="webhook">A webhook</option>
                    <option value="slack">A Slack channel</option>
                    <option value="email">Email</option>
                  </select>
                  {delivery !== 'none' ? (
                    <input aria-label="Where to send" value={target} onChange={(event) => setTarget(event.target.value)} placeholder={delivery === 'webhook' ? 'https://…' : delivery === 'slack' ? '#channel' : 'name@company.com'} />
                  ) : null}
                </div>
                <small className="dql-alerts-note">This page has no schedule yet, so the alert gets one that runs daily at 08:00 and speaks only when an alert fires.</small>
              </>
            ) : null}
            <button type="submit" className="dql-alerts-add" disabled={busy || !figures.length}>{busy ? 'Saving…' : 'Add alert'}</button>
          </form>
          {status ? <p className={`dql-alerts-status ${status.tone}`} role={status.tone === 'error' ? 'alert' : 'status'}>{status.text}</p> : null}
          <p className="dql-alerts-note">Alerts are saved in the App's <code>dql.app.json</code> and checked by <code>zlens schedule start</code>. Every alert reads the governed page run; none runs its own query.</p>
        </div>
      ) : null}
    </div>
  );
}
