import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Boxes, FileText, LayoutDashboard, MessageCircleQuestion, Sparkles } from 'lucide-react';
import { api, type ProviderSettings, type SetupLaunchResponse } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { ConnectionPanel } from '../panels/ConnectionPanel';
import { ConnectionRuntimeSettings } from '../settings/SettingsPage';
import { DbtProjectEditor, type DbtProjectConfigured } from '../settings/DbtProjectEditor';

type SetupState = 'missing' | 'configured' | 'passed';
type SetupTarget = 'domains' | 'ask' | 'notebook' | 'apps';

function hasRealConnection(connections: Record<string, unknown>): boolean {
  return Object.values(connections).some((value) => {
    if (!value || typeof value !== 'object') return false;
    const connection = value as Record<string, unknown>;
    const driver = String(connection.driver ?? connection.type ?? '').toLowerCase();
    if (driver !== 'duckdb') return Boolean(driver);
    const filepath = String(connection.filepath ?? connection.path ?? '').trim();
    return Boolean(filepath && filepath !== ':memory:');
  });
}

function providerSummary(provider: ProviderSettings | null): string {
  if (!provider) return 'No AI provider configured.';
  return `${provider.label}${provider.model ? ` · ${provider.model}` : ''}`;
}

export function SetupOnboarding({
  launch,
  onAcknowledged,
}: {
  launch?: SetupLaunchResponse;
  onAcknowledged?: () => void;
}) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [projectState, setProjectState] = useState<SetupState>('missing');
  const [databaseState, setDatabaseState] = useState<SetupState>('missing');
  const [aiState, setAiState] = useState<SetupState>('missing');
  const [projectDetail, setProjectDetail] = useState('Choose a local dbt project or Git repository.');
  const [databaseDetail, setDatabaseDetail] = useState('Import a dbt profile or enter warehouse credentials.');
  const [aiProvider, setAiProvider] = useState<ProviderSettings | null>(null);
  const [aiSkipped, setAiSkipped] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [upgradeReapplied, setUpgradeReapplied] = useState(!launch?.requiresDbtReapply);
  const [acknowledgeError, setAcknowledgeError] = useState<string | null>(null);
  // RFC 0007: a team without dbt models its warehouse's own tables.
  const [warehouseChosen, setWarehouseChosen] = useState(false);
  const [warehouseBusy, setWarehouseBusy] = useState(false);
  const [warehouseError, setWarehouseError] = useState<string | null>(null);
  const chooseWarehouse = async () => {
    setWarehouseBusy(true);
    setWarehouseError(null);
    try {
      await api.enableWarehouseModeling();
      setWarehouseChosen(true);
      setProjectState('configured');
      setProjectDetail('Warehouse modeling · no dbt project');
      setStep(2);
    } catch (error) {
      setWarehouseError(error instanceof Error ? error.message : String(error));
    } finally {
      setWarehouseBusy(false);
    }
  };

  const requiresUpgradeReapply = Boolean(
    launch?.reason === 'version_upgrade'
    && launch.requiresDbtReapply
    && !upgradeReapplied,
  );

  useEffect(() => {
    setUpgradeReapplied(!launch?.requiresDbtReapply);
    setAcknowledgeError(null);
    if (launch?.requiresDbtReapply) setStep(1);
  }, [launch?.requiresDbtReapply, launch?.version]);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      api.getOnboardingStatus().catch(() => null),
      api.getBlockStudioDbtStatus().catch(() => null),
      api.getConnections().catch(() => null),
      api.getProviderSettings().catch(() => null),
    ]).then(([onboarding, dbt, connectionInfo, providerInfo]) => {
      if (!alive) return;
      if (onboarding?.dbt?.configured || (dbt?.configured && dbt.artifacts.manifest.exists)) {
        setProjectState(onboarding?.modeling?.snapshotState === 'ready' ? 'passed' : 'configured');
        setProjectDetail(onboarding?.preparation?.message || onboarding?.dbt?.repoUrl || onboarding?.dbt?.projectDir || dbt?.projectPath || 'dbt project configured');
      }
      if (connectionInfo && hasRealConnection(connectionInfo.connections ?? {})) {
        setDatabaseState('configured');
        const active = connectionInfo.connections?.[connectionInfo.default];
        const driver = active && typeof active === 'object'
          ? String((active as Record<string, unknown>).driver ?? (active as Record<string, unknown>).type ?? 'Database')
          : 'Database';
        setDatabaseDetail(`${driver} configured — test to verify reachability.`);
      }
      const provider = providerInfo?.providers.find((candidate) => candidate.active && candidate.configured)
        ?? providerInfo?.providers.find((candidate) => candidate.enabled && candidate.configured)
        ?? null;
      if (provider) {
        setAiProvider(provider);
        setAiState('configured');
      }
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const acknowledge = async (): Promise<boolean> => {
    setAcknowledging(true);
    setAcknowledgeError(null);
    try {
      await api.acknowledgeSetupLaunch();
      onAcknowledged?.();
      return true;
    } catch (error) {
      setAcknowledgeError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setAcknowledging(false);
    }
  };
  const close = () => {
    if (acknowledging || requiresUpgradeReapply) return;
    void acknowledge().then((acknowledged) => {
      if (acknowledged) dispatch({ type: 'CLOSE_SETUP' });
    });
  };
  const finishTo = (target: SetupTarget) => {
    if (acknowledging || requiresUpgradeReapply) return;
    void acknowledge().then((acknowledged) => {
      if (!acknowledged) return;
      dispatch({ type: 'SET_MAIN_VIEW', view: target });
      if (target === 'notebook') dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' });
      dispatch({ type: 'CLOSE_SETUP' });
    });
  };
  const onProjectConfigured = (project: DbtProjectConfigured) => {
    setUpgradeReapplied(true);
    setProjectState(project.readiness === 'ready' ? 'passed' : 'configured');
    setProjectDetail(project.readinessDetail || `${project.name} · ${project.summary}`);
  };
  const onProviderConfigured = (provider: ProviderSettings) => {
    setAiSkipped(false);
    setAiState('passed');
    setAiProvider(provider);
  };

  const hint = useMemo(() => {
    if (loading) return 'Loading existing project-local configuration…';
    if (step === 1) return requiresUpgradeReapply
      ? `Required for DQL ${launch?.version}: Preview and Reapply the prefilled dbt project.`
      : projectState === 'missing'
      ? 'Preview before applying; existing dbt settings stay untouched.'
      : `${projectState === 'passed' ? 'Ready' : 'Configured'} · ${projectDetail}`;
    if (step === 2) return databaseState === 'passed' ? `Test passed · ${databaseDetail}` : databaseState === 'configured' ? databaseDetail : 'A failed test rolls back to the previous connection.';
    if (step === 3) return aiSkipped ? 'AI skipped · limited-AI mode remains available.' : aiState === 'missing' ? 'Optional · skip for now or configure a provider.' : `${aiState === 'passed' ? 'Test passed' : 'Configured'} · ${providerSummary(aiProvider)}`;
    return 'Setup complete';
  }, [aiProvider, aiSkipped, aiState, databaseDetail, databaseState, launch?.version, loading, projectDetail, projectState, requiresUpgradeReapply, step]);

  const supportingText = t.textSecondary;
  const primaryButton: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 16px',
    borderRadius: 8, border: 'none', background: t.accent, color: '#fff', fontSize: 12.5,
    fontWeight: 700, cursor: 'pointer', fontFamily: t.font,
  };
  const secondaryButton: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 14px',
    borderRadius: 8, border: `1px solid ${t.headerBorder}`, background: t.cellBg,
    color: t.textSecondary, fontSize: 12.5, fontWeight: 650, cursor: 'pointer', fontFamily: t.font,
  };
  const launchTitle = launch?.reason === 'version_upgrade'
    ? `DQL ${launch.version} update review`
    : launch?.reason === 'first_install'
      ? `Welcome to DQL ${launch.version}`
      : 'Guided Setup';
  const launchNotice = launch?.reason === 'version_upgrade'
    ? requiresUpgradeReapply
      ? `ZLens was updated${launch.acknowledgedVersion ? ` from ${launch.acknowledgedVersion}` : ''} to ${launch.version}. Reapply the prefilled dbt project to rebuild its OSS governed snapshot with this version. Saved paths and credentials remain unchanged until Apply succeeds.`
      : `ZLens was updated${launch.acknowledgedVersion ? ` from ${launch.acknowledgedVersion}` : ''} to ${launch.version}. The dbt project was reapplied with this version; review the remaining saved connections before finishing.`
    : launch?.reason === 'first_install'
      ? `DQL ${launch.version} is installed. Connect the project and database before entering the workspace; AI remains optional.`
      : null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Guided Setup" style={{ position: 'fixed', inset: 0, zIndex: 1000, background: t.appBg, color: t.textPrimary, display: 'flex', flexDirection: 'column', fontFamily: t.font }}>
      <header style={{ height: 54, flexShrink: 0, borderBottom: `1px solid ${t.headerBorder}`, background: t.headerBg, display: 'flex', alignItems: 'center', gap: 11, padding: '0 20px' }}>
        <span style={{ width: 29, height: 29, borderRadius: 7, background: '#0b7a75', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: t.fontMono, fontSize: 10, fontWeight: 800 }}>DQL</span>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>{launchTitle}</div>
          <div style={{ fontSize: 10.5, color: t.textMuted }}>Project → Database → optional AI → Finish</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11.5, color: t.textMuted }}>Step {step} of 4</span>
          <div style={{ display: 'flex', gap: 4 }} aria-hidden>
            {[1, 2, 3, 4].map((number) => <span key={number} style={{ width: 23, height: 4, borderRadius: 999, background: number <= step ? t.accent : t.pillBg }} />)}
          </div>
        </div>
      </header>

      <main style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ width: 'min(760px, calc(100% - 36px))', margin: '0 auto', padding: '26px 0 34px' }}>
          {launchNotice ? (
            <div style={{ marginBottom: 18, border: '1px solid var(--status-info-border)', background: 'var(--status-info-bg)', borderRadius: 10, padding: '11px 13px', color: supportingText, fontSize: 11.5, lineHeight: 1.55 }}>
              {launchNotice}
            </div>
          ) : null}
          {step === 1 ? (
            <SetupSection eyebrow="Step 1 of 4" title="Connect your dbt project" description="Preview a local project or Git repository, then apply it only after the manifest is valid." t={t}>
              <DbtProjectEditor compact reapplyRequired={requiresUpgradeReapply} onConfigured={onProjectConfigured} />
              {projectState === 'missing' && !requiresUpgradeReapply ? (
                <div style={{ border: `1px solid ${t.headerBorder}`, background: t.cellBg, borderRadius: 10, padding: '12px 13px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, fontSize: 11.5, color: supportingText, lineHeight: 1.55 }}>
                    <strong style={{ color: t.textPrimary }}>No dbt project?</strong> Model your warehouse directly. ZLens reads your tables' columns, keys and comments — never their rows — and drafts models and joins for you to review.
                    {warehouseError ? <div role="alert" style={{ color: 'var(--status-error)', marginTop: 6 }}>{warehouseError}</div> : null}
                  </div>
                  <button type="button" disabled={warehouseBusy} onClick={() => void chooseWarehouse()} style={{ ...secondaryButton, opacity: warehouseBusy ? 0.6 : 1 }}>
                    {warehouseBusy ? 'Setting up…' : 'Use my warehouse'}
                  </button>
                </div>
              ) : null}
            </SetupSection>
          ) : null}

          {step === 2 ? (
            <SetupSection eyebrow="Step 2 of 4" title="Connect your database" description={warehouseChosen ? 'Connect and test the warehouse, choose the schemas to model, then Apply and synchronize. ZLens reads their tables, columns, keys and comments.' : 'Use the same profile import, enterprise authentication fields, test, and rollback flow available in Settings.'} t={t}>
              <ConnectionPanel
                variant="setup"
                onConfigured={(detail) => {
                  setDatabaseState('passed');
                  setDatabaseDetail(detail);
                }}
              />
            </SetupSection>
          ) : null}

          {step === 3 ? (
            <SetupSection eyebrow="Step 3 of 4" title="Set up an AI provider" description="Optional. AI powers governed Ask and assisted authoring; deterministic queries and non-AI product paths remain available without it." badge="Optional" t={t}>
              <ConnectionRuntimeSettings embedded includeMemory={false} section="providers" editorMode="setup" onProviderConfigured={onProviderConfigured} />
              <div style={{ border: '1px solid var(--status-info-border)', background: 'var(--status-info-bg)', borderRadius: 10, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, fontSize: 11.5, color: supportingText, lineHeight: 1.5 }}>Continue in limited-AI mode and configure a provider later in Settings.</div>
                <button type="button" onClick={() => { setAiSkipped(true); setStep(4); }} style={secondaryButton}>Skip AI for now</button>
              </div>
            </SetupSection>
          ) : null}

          {step === 4 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, fontWeight: 750, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.accent }}>Step 4 of 4 · Setup complete</div>
                <h2 style={{ margin: '7px 0 0', fontSize: 22, color: t.textPrimary }}>Where do you want to start?</h2>
                {aiState === 'missing' || aiSkipped ? <div style={{ fontSize: 12, color: t.textMuted, marginTop: 7 }}>AI is not configured. Deterministic and non-AI workflows remain available; return to Settings when you want governed Ask.</div> : null}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 11 }}>
                <StartCard icon={<LayoutDashboard size={17} />} title="Build a dashboard" body="Pick a table from your database and publish a page with live, checked numbers." action="Build an App" onClick={() => finishTo('apps')} t={t} primary />
                <StartCard icon={<Boxes size={17} />} title="Build your domain" body="Add models, relationships, business terms, and skills." action="Open Modeling" onClick={() => finishTo('domains')} t={t} />
                <StartCard icon={<MessageCircleQuestion size={17} />} title="Ask" body={aiState === 'missing' || aiSkipped ? 'Open Ask in limited mode; configure AI before a governed model answer.' : 'Ask a business question grounded in your governed context.'} action="Open Ask" onClick={() => finishTo('ask')} t={t} />
                <StartCard icon={<FileText size={17} />} title="Research notebook" body="Work with SQL, DQL, and charts, then save reusable blocks." action="New notebook" onClick={() => finishTo('notebook')} t={t} />
              </div>
            </div>
          ) : null}
        </div>
      </main>

      <footer style={{ flexShrink: 0, minHeight: 58, borderTop: `1px solid ${t.headerBorder}`, background: t.headerBg, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 22px' }}>
        {step > 1 ? <button type="button" onClick={() => setStep((current) => Math.max(1, current - 1))} style={secondaryButton}><ArrowLeft size={13} /> Back</button> : null}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: t.textMuted, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hint}</span>
        {acknowledgeError ? <span role="alert" style={{ fontSize: 11, color: 'var(--status-error)', maxWidth: 320 }}>{acknowledgeError}</span> : null}
        <button type="button" disabled={acknowledging || requiresUpgradeReapply} onClick={close} style={{ ...secondaryButton, opacity: acknowledging || requiresUpgradeReapply ? 0.5 : 1, cursor: acknowledging || requiresUpgradeReapply ? 'not-allowed' : 'pointer' }}>
          {acknowledging
            ? 'Saving review…'
            : requiresUpgradeReapply
              ? 'Reapply required'
            : launch?.reason === 'version_upgrade'
              ? 'Close update review'
              : projectState === 'missing' && databaseState === 'missing'
                ? 'Skip setup'
                : 'Close setup'}
        </button>
        {step < 4 ? (
          <button type="button" disabled={step === 1 && requiresUpgradeReapply} onClick={() => setStep((current) => Math.min(4, current + 1))} style={{ ...primaryButton, opacity: step === 1 && requiresUpgradeReapply ? 0.5 : 1, cursor: step === 1 && requiresUpgradeReapply ? 'not-allowed' : 'pointer' }}>
            {step === 1 ? 'Continue to database' : step === 2 ? 'Continue to optional AI' : 'Continue to finish'} <ArrowRight size={13} />
          </button>
        ) : (
          <button type="button" disabled={acknowledging} onClick={() => finishTo(aiState === 'missing' || aiSkipped ? 'domains' : 'ask')} style={{ ...primaryButton, opacity: acknowledging ? 0.65 : 1 }}><Sparkles size={13} /> Finish setup</button>
        )}
      </footer>
    </div>
  );
}

function SetupSection({
  eyebrow,
  title,
  description,
  badge,
  children,
  t,
}: {
  eyebrow: string;
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
  t: (typeof themes)[keyof typeof themes];
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 17 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 750, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.accent }}>{eyebrow}</div>
        <h2 style={{ margin: '6px 0 0', fontSize: 21, fontWeight: 750, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 8 }}>
          {title}
          {badge ? <span style={{ border: `1px solid ${t.headerBorder}`, color: t.textMuted, borderRadius: 999, padding: '2px 9px', fontSize: 10, fontWeight: 750 }}>{badge}</span> : null}
        </h2>
        <div style={{ marginTop: 6, fontSize: 12.5, color: t.textSecondary, lineHeight: 1.55 }}>{description}</div>
      </div>
      {children}
    </div>
  );
}

function StartCard({
  icon,
  title,
  body,
  action,
  onClick,
  primary = false,
  t,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: string;
  onClick: () => void;
  primary?: boolean;
  t: (typeof themes)[keyof typeof themes];
}) {
  return (
    <button type="button" onClick={onClick} style={{ border: `1.5px solid ${primary ? t.accent : t.headerBorder}`, borderRadius: 12, background: primary ? 'var(--accent-dim)' : t.cellBg, padding: 17, textAlign: 'left', cursor: 'pointer', fontFamily: t.font, minHeight: 170, display: 'flex', flexDirection: 'column' }}>
      <span style={{ width: 34, height: 34, borderRadius: 9, color: primary ? t.accent : t.textSecondary, background: primary ? t.cellBg : t.appBg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
      <span style={{ marginTop: 12, fontSize: 13.5, fontWeight: 750, color: t.textPrimary }}>{title}</span>
      <span style={{ marginTop: 6, fontSize: 11.5, color: t.textSecondary, lineHeight: 1.5 }}>{body}</span>
      <span style={{ marginTop: 'auto', paddingTop: 12, fontSize: 11.5, fontWeight: 700, color: primary ? t.accent : t.textSecondary }}>{action} →</span>
    </button>
  );
}
