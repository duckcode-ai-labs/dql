/**
 * WHAT A REQUEST DOES (RFC 0010, slice HH-2). Every API route maps to one
 * action and one resource, so a host's `authorize` hook can answer "may this
 * person do this?" without knowing DQL's routes. Specific rules come first;
 * anything not named reads as `project.read` (GET) or `project.write`, so a
 * new route is never more open than the project itself.
 */
export type DqlAction =
  | 'project.read'
  | 'project.write'
  | 'connection.manage'
  | 'settings.manage'
  | 'dataset.author'
  | 'dataset.certify'
  | 'hint.review'
  | 'app.view'
  | 'app.author'
  | 'app.publish'
  | 'ask'
  | 'research'
  | 'query.run'
  | 'export'
  | 'schedule.manage'
  | 'git.review'
  | `tool.${string}`;

export interface DqlResource {
  type: 'project' | 'app' | 'app-build' | 'hint' | 'connection';
  id?: string;
}

export interface DqlRouteAction {
  action: DqlAction;
  resource: DqlResource;
}

const AUTHORING_FAMILIES = [
  '/api/blocks', '/api/block-studio', '/api/modeling', '/api/semantic-layer', '/api/semantic-builder',
  '/api/domains', '/api/domain-workspaces', '/api/domain-packages', '/api/terms', '/api/propose',
  '/api/context-proposals', '/api/context-bootstrap', '/api/onboarding', '/api/skills', '/api/datasets',
  '/api/app-datasets', '/api/lineage',
];

function under(path: string, family: string): boolean {
  return path === family || path.startsWith(`${family}/`);
}

function segment(path: string, family: string): string | undefined {
  if (!path.startsWith(`${family}/`)) return undefined;
  const raw = path.slice(family.length + 1).split('/')[0];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function resourceFor(path: string): DqlResource {
  const app = segment(path, '/api/apps');
  if (app) return { type: 'app', id: app };
  const build = segment(path, '/api/app-builds');
  if (build) return { type: 'app-build', id: build };
  const hint = segment(path, '/api/agent/hints');
  if (hint) return { type: 'hint', id: hint };
  const connection = segment(path, '/api/connections');
  if (connection) return { type: 'connection', id: connection };
  return { type: 'project' };
}

function actionFor(method: string, path: string): DqlAction {
  const read = method === 'GET' || method === 'HEAD';

  if (path === '/api/health' || path === '/api/identity' || under(path, '/api/user-prefs')) return 'project.read';

  // Changing where data comes from, and the server's own settings.
  if (under(path, '/api/connections') || path === '/api/test-connection') return read ? 'project.read' : 'connection.manage';
  if (path === '/api/persona') return read ? 'project.read' : 'app.author';
  if (under(path, '/api/settings') || under(path, '/api/server') || under(path, '/api/semantic-runtime')) return read ? 'project.read' : 'settings.manage';
  if (under(path, '/api/git')) return read ? 'project.read' : 'git.review';

  // Trust decisions. Every route that can leave something certified is a
  // certification: the Block Studio job route, the older synchronous route,
  // saving a notebook cell (which certifies what it saves), creating a
  // Dataset from a table, and approving a semantic tile on an App page.
  if (!read && (
    /\/certify(\/|$)/.test(path)
    || /^\/api\/block-studio\/certifications(\/|$)/.test(path)
    || path === '/api/blocks/save-from-cell'
    || path === '/api/app-datasets/tables/create'
    || /^\/api\/apps\/[^/]+\/dashboards\/[^/]+\/approve-semantic$/.test(path)
  )) return 'dataset.certify';
  if (!read && /^\/api\/agent\/hints\/[^/]+(\/(review|lifecycle))?$/.test(path)) return 'hint.review';

  // Taking data out.
  if (/\/export$/.test(path) || /^\/api\/apps\/[^/]+\/dashboards\/[^/]+\/snapshot$/.test(path)) return 'export';
  if (!read && /\/monitors(\/|$)/.test(path)) return 'schedule.manage';
  if (!read && /^\/api\/apps\/[^/]+\/schedules\/[^/]+\/run$/.test(path)) return 'schedule.manage';

  // Apps: readers view and run pages; authors change them; publishing is its own step.
  if (under(path, '/api/apps')) {
    // The list of every App is the project's, not one App's.
    if (path === '/api/apps') return read ? 'project.read' : 'app.author';
    if (!read && /\/(promote|publish-to-project)$/.test(path)) return 'app.publish';
    if (!read && /^\/api\/apps\/[^/]+\/ask$/.test(path)) return 'ask';
    // Running a page, and its story drawn from that run, are reading it.
    if (read || /^\/api\/apps\/[^/]+\/dashboards\/[^/]+\/(run|story)$/.test(path)) return 'app.view';
    return 'app.author';
  }
  if (under(path, '/api/app-builds')) {
    if (!read && /\/(publish-to-project|commit)$/.test(path)) return 'app.publish';
    return read ? 'project.read' : 'app.author';
  }

  // What the app shows around its screens and one's own answers' facts (HH-9, HH-10): reading.
  if (under(path, '/api/host')) return 'project.read';

  // Asking and investigating. Asking for certification is part of asking:
  // the requester is whoever is signed in.
  if (!read && (under(path, '/api/agent-runs') || under(path, '/api/ask') || path === '/api/semantic-query'
    || path === '/api/llm/run' || under(path, '/api/ai') || path === '/api/agent/learnings/correction')) return 'ask';
  if (!read && (under(path, '/api/research-plan') || under(path, '/api/notebook/research'))) return 'research';
  if (!read && under(path, '/api/agent')) return 'ask';

  // SQL the person writes themselves.
  if (!read && (path === '/api/query' || path === '/api/notebook/execute' || path === '/api/dql/artifacts/execute')) return 'query.run';
  // Proving the keys certified content declares: read-only probes as the person, counts only (RFC 0010 key proofs).
  if (!read && path === '/api/keys/prove') return 'query.run';

  // A published page runs its Dataset tiles and filter lists through these.
  if (!read && (path === '/api/app-datasets/run' || path === '/api/app-datasets/field-values')) return 'app.view';
  if (!read && path === '/api/app-datasets/enable') return 'settings.manage';
  if (!read && path === '/api/app-datasets/tables/draft') return 'dataset.author';
  if (!read && AUTHORING_FAMILIES.some((family) => under(path, family))) return 'dataset.author';

  return read ? 'project.read' : 'project.write';
}

/** The action and resource of one API request. */
export function routeAction(method: string | undefined, path: string): DqlRouteAction {
  const verb = (method ?? 'GET').toUpperCase();
  return { action: actionFor(verb, path), resource: resourceFor(path) };
}
