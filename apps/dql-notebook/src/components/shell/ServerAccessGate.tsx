import React, { useEffect, useState } from 'react';
import {
  hasServerToken,
  isViewerLink,
  rememberServerToken,
  SERVER_AUTH_REQUIRED_EVENT,
  serverTokenFromAccessInput,
  wasServerAuthRejected,
} from '../../api/server-auth';
import { useNotebookStore } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';

/**
 * Shown when the server refuses this tab's API calls: a ZLens server shared on
 * the network answers only a browser that holds its access token, and a tab
 * opened without the full link has none. Asks for the link instead of leaving
 * every page loading.
 */
export function ServerAccessGate() {
  const themeMode = useNotebookStore((state) => state.themeMode);
  const t = themes[themeMode];
  const [required, setRequired] = useState(wasServerAuthRejected);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const show = () => setRequired(true);
    window.addEventListener(SERVER_AUTH_REQUIRED_EVENT, show);
    if (wasServerAuthRejected()) setRequired(true);
    return () => window.removeEventListener(SERVER_AUTH_REQUIRED_EVENT, show);
  }, []);

  if (!required) return null;

  const connect = () => {
    const token = serverTokenFromAccessInput(value);
    if (!token) {
      setError('That has no access token in it. Paste the full link, including the part after #dql_token=, or the token alone.');
      return;
    }
    rememberServerToken(token);
    window.location.reload();
  };

  const hadToken = hasServerToken();
  // A read-only page link that stopped working has nothing to paste: only
  // the person who shared it can make a new one.
  if (isViewerLink()) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: t.modalOverlay }}>
        <div role="dialog" aria-modal="true" aria-labelledby="dql-viewer-link-title" style={{ width: '100%', maxWidth: 440, background: t.modalBg, border: `1px solid ${t.cellBorder}`, borderRadius: 10, padding: 20, fontFamily: t.font, color: t.textPrimary, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 id="dql-viewer-link-title" style={{ fontSize: 16, fontWeight: 600 }}>This link no longer works</h2>
          <p style={{ fontSize: 13, lineHeight: 1.5, color: t.textSecondary }}>
            Read-only links last 14 days, and all of them end when the server's access token changes. Ask the person who shared this page for a new link.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: t.modalOverlay }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dql-server-access-title"
        style={{ width: '100%', maxWidth: 480, background: t.modalBg, border: `1px solid ${t.cellBorder}`, borderRadius: 10, padding: 20, fontFamily: t.font, color: t.textPrimary, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <h2 id="dql-server-access-title" style={{ fontSize: 16, fontWeight: 600 }}>This ZLens server needs its access link</h2>
        <p style={{ fontSize: 13, lineHeight: 1.5, color: t.textSecondary }}>
          {hadToken
            ? 'The server did not accept the access token this tab has. It may have been restarted with a new token: paste the link it printed.'
            : 'This server is shared on the network and answers only a browser that has its access token. Open the full link printed by zlens notebook (it ends in #dql_token=…) in this tab, or paste the link or the token here.'}
        </p>
        <input
          autoFocus
          aria-label="Access link or token"
          placeholder="http://…/#dql_token=…"
          value={value}
          onChange={(event) => { setValue(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === 'Enter') connect(); }}
          style={{ fontSize: 13, padding: '8px 10px', borderRadius: 6, border: `1px solid ${t.inputBorder}`, background: t.inputBg, color: t.textPrimary, fontFamily: t.fontMono }}
        />
        {error ? <p role="alert" style={{ fontSize: 12, color: t.error }}>{error}</p> : null}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 12, color: t.textMuted }}>Access lasts until this tab is closed.</span>
          <button
            type="button"
            onClick={connect}
            disabled={!value.trim()}
            style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: 'none', background: t.accent, color: '#fff', cursor: value.trim() ? 'pointer' : 'default', opacity: value.trim() ? 1 : 0.6 }}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
