import React, { useEffect, useState } from 'react';
import { PanelFrame, PanelToolbar, PanelEmpty, StatusPill } from '@zlens/ui';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { AppSummary, NotebookFile } from '../../store/types';
import { authoredDomainIds, authoredDomainOptions } from '../domains/authored-domain-options';

interface AppsPanelProps {
  onOpenFile: (file: NotebookFile) => void;
}

export function AppsPanel(_props: AppsPanelProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = () => {
    setLoading(true);
    api.listApps()
      .then((next) => setApps(next))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const domainIds = authoredDomainIds(state.authoredDomains);
  const domains = authoredDomainOptions(state.authoredDomains);
  const hasUnassigned = apps.some((app) => !domainIds.has(app.domain?.trim() ?? ''));
  const filtered = apps.filter((a) => {
    const s = search.toLowerCase();
    if (s && !a.name.toLowerCase().includes(s) && !(a.description ?? '').toLowerCase().includes(s)) return false;
    if (domainFilter === 'uncategorized' && domainIds.has(a.domain?.trim() ?? '')) return false;
    if (domainFilter && domainFilter !== 'uncategorized' && (!domainIds.has(domainFilter) || a.domain !== domainFilter)) return false;
    return true;
  });

  const toggle = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const openDashboard = (app: AppSummary, dashboard: string) => {
    dispatch({ type: 'OPEN_APP', appId: app.id, dashboardId: dashboard });
  };

  const selectStyle: React.CSSProperties = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.font,
    padding: '4px 6px',
    outline: 'none',
  };

  const actions = (
    <button
      onClick={refresh}
      style={{
        background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 4,
        color: t.textSecondary, cursor: 'pointer', fontSize: 10, fontFamily: t.font, padding: '3px 8px',
      }}
    >
      Refresh
    </button>
  );

  const toolbar = (
    <PanelToolbar>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search apps..."
        style={{ ...selectStyle, flex: 1, minWidth: 100 }}
      />
      <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} style={selectStyle}>
        <option value="">All domains</option>
        {domains.map((domain) => <option key={domain.value} value={domain.value}>{domain.label}</option>)}
        {hasUnassigned ? <option value="uncategorized">Unassigned</option> : null}
      </select>
    </PanelToolbar>
  );

  return (
    <PanelFrame
      title="Apps"
      status={<span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>{filtered.length}</span>}
      actions={actions}
      toolbar={toolbar}
      bodyPadding={0}
    >
      {loading ? (
        <PanelEmpty title="Loading apps…" />
      ) : filtered.length === 0 ? (
        apps.length === 0 ? (
          <PanelEmpty
            title="No apps yet"
            description={
              <>
                Create one from the CLI:
                <br />
                <code style={{
                  display: 'inline-block', marginTop: 6, padding: '2px 6px',
                  background: t.inputBg, borderRadius: 3, fontSize: 10,
                }}>
                  zlens app new &lt;name&gt; --domain &lt;domain&gt;
                </code>
              </>
            }
          />
        ) : (
          <PanelEmpty title="No matches" description="No apps match your filters." />
        )
      ) : (
        filtered.map((app) => {
          const isOpen = expanded.has(app.id);
          return (
            <div key={app.id} style={{ borderBottom: `1px solid ${t.cellBorder}` }}>
              <button
                onClick={() => toggle(app.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'transparent', border: 'none',
                  cursor: 'pointer', padding: '10px 12px',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${t.accent}0a`; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, width: 10 }}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                    {app.name}
                  </span>
                  <StatusPill tone="accent">{app.domain}</StatusPill>
                </div>
                {app.description && (
                  <div style={{
                    fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.3,
                    marginBottom: 4, marginLeft: 16,
                  }}>
                    {app.description}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: t.textMuted, fontFamily: t.font, marginLeft: 16 }}>
                  {app.owners[0] && <span>by {app.owners[0]}</span>}
                  <span>{app.dashboards.length} dashboard{app.dashboards.length === 1 ? '' : 's'}</span>
                  <span>{app.members} member{app.members === 1 ? '' : 's'}</span>
                </div>
              </button>
              {isOpen && (
                <div style={{ padding: '4px 0 10px 28px', background: `${t.accent}04` }}>
                  {app.dashboards.length === 0 && (
                    <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, padding: '4px 0' }}>
                      (empty app scaffold)
                    </div>
                  )}
                  {app.dashboards.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => openDashboard(app, d.id)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        background: 'transparent', border: 'none',
                        padding: '3px 12px',
                        cursor: 'pointer', fontSize: 11, color: t.textSecondary, fontFamily: t.font,
                      }}
                    >
                      {d.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </PanelFrame>
  );
}
