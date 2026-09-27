import { useHostUi } from '../../host/host-ui';

/**
 * The host's strip above DQL's screens (RFC 0010 HH-9), for something the
 * person must keep in mind everywhere — e.g. "Draft space — changes go to
 * review, not Production" — with its links (e.g. back to Production). They
 * open at the top level: they may take the person to another environment.
 * Renders nothing without a host or a banner.
 */
export function HostBanner() {
  const hostUi = useHostUi();
  if (!hostUi.host || !hostUi.banner) return null;
  const { text, tone, links } = hostUi.banner;
  const caution = tone === 'caution';
  return (
    <div
      role="status"
      data-testid="host-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '6px 14px',
        padding: '6px 16px',
        fontSize: 12.5,
        lineHeight: 1.4,
        background: caution ? 'var(--status-warning-bg, var(--accent-dim))' : 'var(--accent-dim)',
        color: 'var(--text-primary)',
        borderBottom: `1px solid ${caution ? 'var(--status-warning-border, var(--border-default))' : 'var(--border-subtle)'}`,
      }}
    >
      <span style={{ fontWeight: 600 }}>{text}</span>
      {(links ?? []).map((link) => (
        <a key={link.href} href={link.href} target="_top" style={{ color: caution ? 'var(--status-warning, var(--accent))' : 'var(--accent)', fontWeight: 600, textDecoration: 'underline' }}>
          {link.label}
        </a>
      ))}
    </div>
  );
}
