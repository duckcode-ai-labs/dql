import { hostPageSrc, useHostPage } from '../../host/host-ui';

/**
 * A page the host adds (for example its requests or reviews),
 * shown in DQL's main area so DQL's header and navigation stay around it.
 * The page is the host's, on the same origin and the same theme.
 */
export function HostPageView() {
  const { page } = useHostPage();
  if (!page) return null;
  return (
    <iframe
      key={page.href}
      title={page.label}
      src={hostPageSrc(page.href)}
      style={{ flex: 1, width: '100%', height: '100%', border: 0, background: 'var(--bg-1)' }}
    />
  );
}
