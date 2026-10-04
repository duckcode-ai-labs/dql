import type { AppDocumentSummary, DashboardDocumentResponse } from '../../api/client';

/** A host's refusal as the API client raises it (`DqlApiError` with status 403), read by shape so this stays DOM-free. */
function refusalOf(error: unknown): { message: string; next?: { label: string; href: string } } | null {
  if (!(error instanceof Error) || (error as { status?: unknown }).status !== 403) return null;
  const next = (error as { next?: { label?: unknown; href?: unknown } }).next;
  return typeof next?.label === 'string' && typeof next.href === 'string'
    ? { message: error.message, next: { label: next.label, href: next.href } }
    : { message: error.message };
}

export type WorkspaceDashboardSummary = {
  id: string;
  title: string;
  description?: string;
  /** Only full App metadata or the current loaded page can establish this. */
  itemCount?: number;
};

type WorkspaceLibraryApp = {
  id: string;
  dashboards: Array<{ id: string; title: string }>;
};

type PersistedAppWorkspaceLoad = {
  appId: string;
  dashboardId: string;
  loadApp: (appId: string) => Promise<AppDocumentSummary | null>;
  loadDashboard: (appId: string, dashboardId: string) => Promise<DashboardDocumentResponse | null>;
  onApp: (document: AppDocumentSummary | null) => void;
  onDashboard: (document: DashboardDocumentResponse) => void;
  /**
   * `refusal` when the host refused this person; `next` is where it sends them (HH-12). `notFound`: this project has
   * no such App or page (a host may say where it is instead, HH-9 `appNotFound`).
   */
  onDashboardError: (message: string, refusal?: { next?: { label: string; href: string } }, problem?: { notFound: true }) => void;
};

/**
 * Start the two persisted-document reads independently. The dashboard route
 * is sufficient to render the current App page; the app document is useful
 * metadata for tabs and navigation but must never keep a healthy page on a
 * loading screen. The returned cancellation function makes an older page
 * selection unable to overwrite the current one.
 */
export function beginPersistedAppWorkspaceLoad(input: PersistedAppWorkspaceLoad): () => void {
  let current = true;
  void input.loadApp(input.appId)
    .then((document) => {
      if (!current) return;
      // A stale App response is metadata only; never let it replace the
      // current page's identity or enable an unrelated App's write controls.
      input.onApp(document?.app.id === input.appId ? document : null);
    })
    .catch(() => { if (current) input.onApp(null); });
  void input.loadDashboard(input.appId, input.dashboardId)
    .then((document) => {
      if (!current) return;
      if (!document) {
        input.onDashboardError('This dashboard page could not be read from the local project. Check that the server is running, then retry.');
        return;
      }
      if (document.app.id !== input.appId) {
        input.onDashboardError('The loaded dashboard belongs to a different app. Reload the app and try again.');
        return;
      }
      if (document.dashboard.id !== input.dashboardId) {
        input.onDashboardError('The loaded dashboard does not match the page requested. Reload the app and try again.');
        return;
      }
      input.onDashboard(document);
    })
    .catch((error: unknown) => {
      if (!current) return;
      const refusal = refusalOf(error);
      if (refusal) {
        input.onDashboardError(refusal.message, refusal.next ? { next: refusal.next } : {});
        return;
      }
      const notFound = error instanceof Error && (error as { status?: unknown }).status === 404;
      input.onDashboardError('This dashboard page could not be read from the local project. Check that the server is running, then retry.', undefined, notFound ? { notFound: true } : undefined);
    });
  return () => { current = false; };
}

/**
 * The dashboard endpoint includes the App identity used to resolve that page.
 * It is therefore safe display metadata when the broader App summary endpoint
 * is delayed or unavailable. A library entry is only reusable for writes and
 * page navigation when it names that same App; this deliberately does not
 * manufacture a page list or edit authority from a dashboard response.
 */
export function resolvePersistedWorkspaceMetadata<TLibraryApp extends WorkspaceLibraryApp>(input: {
  dashboard: DashboardDocumentResponse | null;
  appDocument: AppDocumentSummary | null;
  libraryApp: TLibraryApp | null;
}): {
  app: AppDocumentSummary['app'] | null;
  dashboards: WorkspaceDashboardSummary[];
  writableLibraryApp: TLibraryApp | null;
} {
  const dashboardApp = input.dashboard?.app ?? null;
  const matchingAppDocument = input.appDocument
    && (!dashboardApp || input.appDocument.app.id === dashboardApp.id)
    ? input.appDocument
    : null;
  const app = dashboardApp ?? matchingAppDocument?.app ?? null;
  const writableLibraryApp = input.libraryApp && app && input.libraryApp.id === app.id
    ? input.libraryApp
    : null;
  const dashboards = matchingAppDocument?.dashboards
    ?? writableLibraryApp?.dashboards
    ?? (input.dashboard
      ? [{
          id: input.dashboard.dashboard.id,
          title: input.dashboard.dashboard.metadata.title,
          description: input.dashboard.dashboard.metadata.description,
          itemCount: input.dashboard.dashboard.layout.items.length,
        }]
      : []);
  return { app, dashboards, writableLibraryApp };
}
