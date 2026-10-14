import { join } from 'node:path';
import {
  findAppDocuments,
  findDashboardsForApp,
  loadAppDocument,
  loadDashboardDocument,
  type DashboardFilter,
} from '@zlens/core';

/**
 * What an App's copilot question is scoped to. Resolved on the server from
 * the App's own files: the browser names the App, the page and the reader's
 * current filter values, but never the domain or the filter definitions.
 */
export interface AppCopilotScope {
  appId: string;
  /** The App's owner domain, applied only when the project declares it. */
  domain?: string;
  pageId?: string;
  pageTitle?: string;
  /** Filters with a value the reader currently sees, in page order. */
  filters: Array<{ id: string; label: string; value: string }>;
  /** The question as the reader typed it, before the view clause. */
  originalQuestion: string;
}

export interface AppCopilotScopeOptions {
  /** True when the project's manifest declares this domain. */
  knownDomain: (domain: string) => boolean;
}

type ScopableRequest = { question: string; workspaceContext?: Record<string, unknown> };

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/**
 * Scope an App copilot run to its App: the owner domain becomes the Ask
 * domain unless the reader chose one, and the filters on screen become an
 * explicit clause of the question. Ask applies each stated restriction or says
 * it could not, so an answer is never silently wider than the view it was
 * asked from. Requests from other surfaces are returned unchanged.
 */
export function scopeAppCopilotRequest(
  projectRoot: string,
  request: ScopableRequest,
  options: AppCopilotScopeOptions,
): AppCopilotScope | undefined {
  const workspace = request.workspaceContext;
  if (!workspace || workspace.surface !== 'apps') return undefined;
  const appId = text(workspace.appId);
  if (!appId) return undefined;
  const appPath = findAppDocuments(projectRoot).find((path) => path.endsWith(join(appId, 'dql.app.json')));
  const app = appPath ? loadAppDocument(appPath).document : null;
  if (!app || app.id !== appId) return undefined;

  const domain = text(app.domain) && options.knownDomain(app.domain) ? app.domain : undefined;
  const pageId = text(workspace.dashboardId);
  const page = pageId
    ? findDashboardsForApp(join(appPath!, '..'))
      .map((path) => loadDashboardDocument(path).document)
      .find((document) => document?.id === pageId) ?? null
    : null;
  const values = workspace.dashboardFilters && typeof workspace.dashboardFilters === 'object'
    ? workspace.dashboardFilters as Record<string, unknown>
    : {};
  const filters = (page?.filters ?? []).flatMap((filter) => {
    const value = describeFilterValue(filter, values[filter.id]);
    return value ? [{ id: filter.id, label: filter.label?.trim() || humanize(filter.id), value }] : [];
  });

  const scope: AppCopilotScope = {
    appId,
    ...(domain ? { domain } : {}),
    ...(page ? { pageId: page.id, pageTitle: page.metadata.title } : {}),
    filters,
    originalQuestion: request.question,
  };
  if (domain && !text(workspace.domain)) workspace.domain = domain;
  const clause = appViewClause(scope);
  if (clause) request.question = `${request.question.trim()}\n\n${clause}`;
  workspace.appScope = scope;
  return scope;
}

/** The sentence added to a question so Ask answers within the reader's view. */
export function appViewClause(scope: Pick<AppCopilotScope, 'filters'>): string | undefined {
  if (scope.filters.length === 0) return undefined;
  return `Answer for this app's current view only: ${scope.filters.map((filter) => `${filter.label} is ${filter.value}`).join('; ')}.`;
}

/** A filter value as words, or undefined when the filter restricts nothing. */
export function describeFilterValue(filter: DashboardFilter, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => (typeof item === 'string' || typeof item === 'number' ? String(item).trim() : '')).filter(Boolean);
    if (items.length === 0) return undefined;
    return items.length === 1 ? items[0] : `one of ${items.join(', ')}`;
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'object') {
    const range = value as Record<string, unknown>;
    const from = text(range.from) ?? text(range.start) ?? (typeof range.min === 'number' ? String(range.min) : undefined);
    const to = text(range.to) ?? text(range.end) ?? (typeof range.max === 'number' ? String(range.max) : undefined);
    if (from && to) return `from ${from} to ${to}`;
    if (from) return `from ${from}`;
    if (to) return `up to ${to}`;
    const preset = text(range.preset) ?? text(range.value);
    return preset ? humanize(preset) : undefined;
  }
  const raw = String(value).trim();
  if (!raw) return undefined;
  return filter.type === 'relative_date' ? humanize(raw) : raw;
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
