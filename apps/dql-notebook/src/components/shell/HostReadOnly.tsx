import { useEffect, useState } from 'react';
import { HOST_REFUSAL_EVENT, type HostRefusalDetail } from '../../api/server-auth';
import { hostReadOnly, navKeyForView, readOnlyReason, useHostUi } from '../../host/host-ui';

/** One line above a screen the person may open but not edit (host with project.read and no write action). */
export function ReadOnlyStrip({ mainView }: { mainView: string }) {
  const hostUi = useHostUi();
  const key = navKeyForView(mainView);
  if (!key || !hostReadOnly(hostUi, key)) return null;
  return (
    <div
      role="status"
      data-testid="read-only-strip"
      style={{ padding: '6px 16px', fontSize: 12.5, lineHeight: 1.4, background: 'var(--bg-2)', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <strong style={{ color: 'var(--text-primary)' }}>Read-only.</strong> {readOnlyReason(hostUi, key)}
    </div>
  );
}

/** The host's refusal of a change: its sentence and, when it sent one, its next step. */
export function HostRefusalNoticeView({ refusal, onDismiss }: { refusal: HostRefusalDetail; onDismiss?: () => void }) {
  return (
    <div
      role="alert"
      data-testid="host-refusal"
      style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 14px', padding: '8px 16px', fontSize: 12.5, lineHeight: 1.4, background: 'var(--status-warning-bg, var(--accent-dim))', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-default)' }}
    >
      <span style={{ fontWeight: 600 }}>{refusal.message}</span>
      {refusal.next && (
        <a href={refusal.next.href} target="_top" style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'underline' }}>
          {refusal.next.label}
        </a>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>
          ×
        </button>
      )}
    </div>
  );
}

/** Shows the latest refusal the API client reported, until dismissed. */
export function HostRefusalNotice() {
  const [refusal, setRefusal] = useState<HostRefusalDetail | null>(null);
  useEffect(() => {
    const onRefusal = (event: Event) => setRefusal((event as CustomEvent<HostRefusalDetail>).detail ?? null);
    window.addEventListener(HOST_REFUSAL_EVENT, onRefusal);
    return () => window.removeEventListener(HOST_REFUSAL_EVENT, onRefusal);
  }, []);
  return refusal ? <HostRefusalNoticeView refusal={refusal} onDismiss={() => setRefusal(null)} /> : null;
}
