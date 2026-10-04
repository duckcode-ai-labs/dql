import { describe, expect, it } from 'vitest';
import type { AppDocumentSummary, DashboardDocumentResponse } from '../../api/client';
import { beginPersistedAppWorkspaceLoad, resolvePersistedWorkspaceMetadata } from './app-workspace-loader';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const persistedApp: AppDocumentSummary = {
  app: {
    id: 'm1-governed-commerce',
    name: 'M1 Governed Commerce',
    domain: 'commerce',
    owners: ['owner@local'],
    members: [],
    roles: [],
    policies: [],
  },
  dashboards: [{ id: 'overview', title: 'Overview', itemCount: 1 }],
};

const persistedDashboard: DashboardDocumentResponse = {
  app: persistedApp.app,
  dashboard: {
    version: 3,
    id: 'overview',
    metadata: { title: 'Overview', description: 'Persisted App page' },
    layout: { kind: 'grid', cols: 12, rowHeight: 32, items: [{ i: 'revenue', x: 0, y: 0, w: 3, h: 2, viz: { type: 'kpi' } }] },
  },
};

describe('persisted App workspace loader', () => {
  it('renders a persisted dashboard when metadata remains pending', async () => {
    const metadata = deferred<AppDocumentSummary | null>();
    const dashboard = deferred<DashboardDocumentResponse | null>();
    const events: string[] = [];
    const cancel = beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce',
      dashboardId: 'overview',
      loadApp: () => metadata.promise,
      loadDashboard: () => dashboard.promise,
      onApp: () => events.push('metadata'),
      onDashboard: (document) => events.push(`dashboard:${document.dashboard.id}`),
      onDashboardError: (message) => events.push(`error:${message}`),
    });

    dashboard.resolve(persistedDashboard);
    await settle();

    expect(events).toEqual(['dashboard:overview']);
    metadata.resolve(persistedApp);
    await settle();

    expect(events).toEqual(['dashboard:overview', 'metadata']);
    cancel();
  });

  it('uses a valid dashboard response as read-only metadata when the App document is unavailable', async () => {
    const events: string[] = [];
    beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce',
      dashboardId: 'overview',
      loadApp: async () => null,
      loadDashboard: async () => persistedDashboard,
      onApp: (document) => events.push(`metadata:${document?.app.id ?? 'none'}`),
      onDashboard: (document) => events.push(`dashboard:${document.dashboard.id}`),
      onDashboardError: (message) => events.push(`error:${message}`),
    });
    await settle();

    expect(events).toHaveLength(2);
    expect(events).toContain('metadata:none');
    expect(events).toContain('dashboard:overview');
    expect(resolvePersistedWorkspaceMetadata({
      dashboard: persistedDashboard,
      appDocument: null,
      libraryApp: null,
    })).toMatchObject({
      app: { id: 'm1-governed-commerce', name: 'M1 Governed Commerce' },
      dashboards: [{ id: 'overview', title: 'Overview', itemCount: 1 }],
      writableLibraryApp: null,
    });
  });

  it('keeps a valid dashboard current when the independent App document request rejects', async () => {
    const events: string[] = [];
    beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce',
      dashboardId: 'overview',
      loadApp: async () => { throw new Error('metadata endpoint unavailable'); },
      loadDashboard: async () => persistedDashboard,
      onApp: (document) => events.push(`metadata:${document?.app.id ?? 'none'}`),
      onDashboard: (document) => events.push(`dashboard:${document.dashboard.id}`),
      onDashboardError: (message) => events.push(`error:${message}`),
    });
    await settle();

    expect(events).toHaveLength(2);
    expect(events).toContain('metadata:none');
    expect(events).toContain('dashboard:overview');
  });

  it('reports a persisted dashboard load failure with an actionable retry message', async () => {
    const errors: string[] = [];
    beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce',
      dashboardId: 'overview',
      loadApp: async () => persistedApp,
      loadDashboard: async () => null,
      onApp: () => undefined,
      onDashboard: () => undefined,
      onDashboardError: (message) => errors.push(message),
    });
    await settle();

    expect(errors).toEqual(['This dashboard page could not be read from the local project. Check that the server is running, then retry.']);
  });

  it('accepts a fresh persisted dashboard response after a failed load is retried', async () => {
    const events: string[] = [];
    const reportError = (message: string) => events.push(`error:${message}`);

    beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce',
      dashboardId: 'overview',
      loadApp: async () => persistedApp,
      loadDashboard: async () => null,
      onApp: () => undefined,
      onDashboard: (document) => events.push(`dashboard:${document.dashboard.id}`),
      onDashboardError: reportError,
    });
    await settle();

    beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce',
      dashboardId: 'overview',
      loadApp: async () => persistedApp,
      loadDashboard: async () => persistedDashboard,
      onApp: () => undefined,
      onDashboard: (document) => events.push(`dashboard:${document.dashboard.id}`),
      onDashboardError: reportError,
    });
    await settle();

    expect(events).toEqual([
      'error:This dashboard page could not be read from the local project. Check that the server is running, then retry.',
      'dashboard:overview',
    ]);
  });

  it('ignores a stale page response after a current persisted page load starts', async () => {
    const oldDashboard = deferred<DashboardDocumentResponse | null>();
    const nextDashboard = deferred<DashboardDocumentResponse | null>();
    const events: string[] = [];
    const cancelOld = beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce', dashboardId: 'overview',
      loadApp: async () => persistedApp,
      loadDashboard: () => oldDashboard.promise,
      onApp: () => undefined,
      onDashboard: (document) => events.push(`old:${document.dashboard.id}`),
      onDashboardError: (message) => events.push(`old-error:${message}`),
    });
    cancelOld();
    beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce', dashboardId: 'page-2',
      loadApp: async () => persistedApp,
      loadDashboard: () => nextDashboard.promise,
      onApp: () => undefined,
      onDashboard: (document) => events.push(`current:${document.dashboard.id}`),
      onDashboardError: (message) => events.push(`current-error:${message}`),
    });

    oldDashboard.resolve(persistedDashboard);
    nextDashboard.resolve({ ...persistedDashboard, dashboard: { ...persistedDashboard.dashboard, id: 'page-2' } });
    await settle();

    expect(events).toEqual(['current:page-2']);
  });

  it('rejects a dashboard response for another App instead of using its metadata or page', async () => {
    const events: string[] = [];
    beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce',
      dashboardId: 'overview',
      loadApp: async () => persistedApp,
      loadDashboard: async () => ({
        ...persistedDashboard,
        app: { ...persistedDashboard.app, id: 'another-app' },
      }),
      onApp: () => undefined,
      onDashboard: (document) => events.push(`dashboard:${document.dashboard.id}`),
      onDashboardError: (message) => events.push(`error:${message}`),
    });
    await settle();

    expect(events).toEqual(['error:The loaded dashboard belongs to a different app. Reload the app and try again.']);
  });

  it('rejects a same-App dashboard response for a page other than the one requested', async () => {
    const events: string[] = [];
    beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce',
      dashboardId: 'page-2',
      loadApp: async () => persistedApp,
      loadDashboard: async () => persistedDashboard,
      onApp: () => undefined,
      onDashboard: (document) => events.push(`dashboard:${document.dashboard.id}`),
      onDashboardError: (message) => events.push(`error:${message}`),
    });
    await settle();

    expect(events).toEqual(['error:The loaded dashboard does not match the page requested. Reload the app and try again.']);
  });

  it('drops late App metadata for another identity without replacing the current dashboard', async () => {
    const lateMetadata = deferred<AppDocumentSummary | null>();
    const events: string[] = [];
    beginPersistedAppWorkspaceLoad({
      appId: 'm1-governed-commerce',
      dashboardId: 'overview',
      loadApp: () => lateMetadata.promise,
      loadDashboard: async () => persistedDashboard,
      onApp: (document) => events.push(`metadata:${document?.app.id ?? 'none'}`),
      onDashboard: (document) => events.push(`dashboard:${document.dashboard.id}`),
      onDashboardError: (message) => events.push(`error:${message}`),
    });
    await settle();

    lateMetadata.resolve({
      ...persistedApp,
      app: { ...persistedApp.app, id: 'another-app', name: 'Other App' },
      dashboards: [{ id: 'wrong-page', title: 'Wrong page', itemCount: 1 }],
    });
    await settle();

    expect(events).toEqual(['dashboard:overview', 'metadata:none']);
  });

  it('keeps a same-App library page list but never takes write authority from a mismatched one', () => {
    const matchingLibraryApp = {
      id: 'm1-governed-commerce',
      dashboards: [
        { id: 'overview', title: 'Overview' },
        { id: 'page-2', title: 'Details' },
      ],
    };
    const matching = resolvePersistedWorkspaceMetadata({
      dashboard: persistedDashboard,
      appDocument: null,
      libraryApp: matchingLibraryApp,
    });
    expect(matching.dashboards).toEqual(matchingLibraryApp.dashboards);
    expect(matching.writableLibraryApp).toBe(matchingLibraryApp);

    const mismatched = resolvePersistedWorkspaceMetadata({
      dashboard: persistedDashboard,
      appDocument: null,
      libraryApp: { id: 'another-app', dashboards: [{ id: 'wrong', title: 'Wrong page' }] },
    });
    expect(mismatched.dashboards).toEqual([{ id: 'overview', title: 'Overview', description: 'Persisted App page', itemCount: 1 }]);
    expect(mismatched.writableLibraryApp).toBeNull();
  });
});

describe('a refused App (RFC 0010 HH-12)', () => {
  it('passes the host\'s reason and where to ask to the reader, not a generic load failure', async () => {
    const refused = Object.assign(new Error('You don\'t have access to Claims.'), { status: 403, code: 'PERMISSION_DENIED', next: { label: 'Ask for access', href: '/e/apps/claims/access' } });
    const errors: Array<{ message: string; refusal?: unknown }> = [];
    beginPersistedAppWorkspaceLoad({
      appId: 'claims',
      dashboardId: 'overview',
      loadApp: async () => null,
      loadDashboard: async () => { throw refused; },
      onApp: () => undefined,
      onDashboard: () => undefined,
      onDashboardError: (message, refusal) => { errors.push({ message, refusal }); },
    });
    await settle();
    await settle();
    expect(errors).toEqual([{ message: 'You don\'t have access to Claims.', refusal: { next: { label: 'Ask for access', href: '/e/apps/claims/access' } } }]);
  });

  it('says when the project has no such App or page (404), apart from a page that could not be read', async () => {
    const seen: Array<{ message: string; problem?: unknown }> = [];
    for (const failure of [Object.assign(new Error('App not found'), { status: 404 }), Object.assign(new Error('boom'), { status: 500 }), new Error('Failed to fetch')]) {
      beginPersistedAppWorkspaceLoad({
        appId: 'claims-weekly',
        dashboardId: 'overview',
        loadApp: async () => null,
        loadDashboard: async () => { throw failure; },
        onApp: () => undefined,
        onDashboard: () => undefined,
        onDashboardError: (message, _refusal, problem) => { seen.push({ message, problem }); },
      });
      await settle();
      await settle();
    }
    // Without a host the words are as before; the flag lets a host say where the App is (HH-9 `appNotFound`).
    const unchanged = 'This dashboard page could not be read from the local project. Check that the server is running, then retry.';
    expect(seen).toEqual([{ message: unchanged, problem: { notFound: true } }, { message: unchanged, problem: undefined }, { message: unchanged, problem: undefined }]);
  });
});
