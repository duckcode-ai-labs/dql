import { useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { fetchDirectoryGroups, saveAppAudience, type ApiRefusal, type DirectoryGroups } from '../../api/home-api';

/**
 * WHO THIS APP IS FOR (RFC 0010, HH-16). The author names identity-provider
 * groups; they are saved in `dql.app.json` (`audienceGroups`). With a host
 * the groups come from the host's directory, and only those groups, the App's
 * owners and people the host gave it open the App. Without a host the author
 * types them, as a note that carries over when the project is hosted.
 *
 * Where the host keeps Production to reviewed changes, saving here is refused
 * with a link to where the change can be made (e.g. a draft space).
 */
export function AppAudienceEditor({ appId, audience, groups, onOpenLink }: {
  appId: string;
  audience?: string;
  groups: string[];
  onOpenLink?: (label: string, href: string) => void;
}): JSX.Element {
  const [directory, setDirectory] = useState<DirectoryGroups | null>(null);
  const [selected, setSelected] = useState<string[]>(groups);
  const [typed, setTyped] = useState(groups.join(', '));
  const [text, setText] = useState(audience ?? '');
  const [filter, setFilter] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'saving' } | { kind: 'saved'; path: string } | { kind: 'refused'; refusal: ApiRefusal }>({ kind: 'idle' });
  useEffect(() => {
    let cancelled = false;
    void fetchDirectoryGroups().then((value) => { if (!cancelled) setDirectory(value); });
    return () => { cancelled = true; };
  }, []);
  const fromHost = directory?.source === 'host' ? directory.groups : null;
  const shown = useMemo(() => (fromHost ?? []).filter((group) => !filter || `${group.id} ${group.label ?? ''}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 40), [fromHost, filter]);
  const chosen = fromHost ? selected : typed.split(',').map((group) => group.trim()).filter(Boolean);
  const save = async () => {
    setState({ kind: 'saving' });
    const result = await saveAppAudience(appId, { groups: chosen, text });
    setState(result.ok ? { kind: 'saved', path: result.path } : { kind: 'refused', refusal: result.refusal });
  };
  const toggle = (id: string) => setSelected((current) => (current.includes(id) ? current.filter((group) => group !== id) : [...current, id]));
  return (
    <section className="dql-app-audience" aria-label="Audience" style={{ display: 'grid', gap: 10, padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'var(--bg-2)', gridColumn: '1 / -1' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Users size={16} aria-hidden="true" />
        <b>Audience</b>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {fromHost ? 'Only these groups, the owners and people given access open this App.' : 'Groups from your sign-in; with a host that signs people in, only they open this App.'}
        </span>
      </div>
      <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
        In words
        <input value={text} onChange={(event) => setText(event.target.value)} maxLength={120} placeholder="e.g. Claims leadership" />
      </label>
      {directory === null ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading groups…</span> : fromHost ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find a group" aria-label="Find a group" />
          <div role="group" aria-label="Groups" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {fromHost.length === 0 ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Your directory has no groups to offer.</span> : null}
            {shown.map((group) => (
              <label key={group.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 999, border: '1px solid var(--border-default)', fontSize: 12, cursor: 'pointer', background: selected.includes(group.id) ? 'var(--accent-dim)' : 'transparent' }}>
                <input type="checkbox" checked={selected.includes(group.id)} onChange={() => toggle(group.id)} />
                {group.label ?? group.id}{group.members !== undefined ? <span style={{ color: 'var(--text-muted)' }}> · {group.members}</span> : null}
              </label>
            ))}
          </div>
        </div>
      ) : (
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          Groups (comma-separated)
          <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="claims-leaders, finance-leaders" />
        </label>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" className="dql-apps-btn dql-apps-btn-primary" disabled={state.kind === 'saving' || directory === null} onClick={() => void save()}>
          {state.kind === 'saving' ? 'Saving…' : 'Save audience'}
        </button>
        {state.kind === 'saved' ? <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Saved to {state.path}.</span> : null}
      </div>
      {state.kind === 'refused' ? (
        <div role="alert" style={{ display: 'grid', gap: 6, fontSize: 12 }}>
          <span>{state.refusal.error}</span>
          {state.refusal.next && onOpenLink ? (
            <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => onOpenLink(state.refusal.next!.label, state.refusal.next!.href)}>{state.refusal.next.label}</button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
