import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import type { DqlAction, DqlResource, DqlRouteAction } from './route-actions.js';
import type { DqlCredentialsHook, DqlRowPolicy } from './row-policy.js';
import type { DqlAuditSink, DqlTraceSink } from './observability.js';

export type { DqlAction, DqlResource, DqlRouteAction } from './route-actions.js';

/**
 * WHO IS ASKING (RFC 0010, slice HH-1). A program that embeds DQL can tell
 * the server who made each request; DQL then takes every "who did this"
 * record — a review, a correction's author, the owner of new content — from
 * that person instead of from the request body or this machine's git user.
 *
 * With no host hooks nothing here is used: `dql notebook` keeps its one
 * local owner and behaves exactly as before.
 */
export interface DqlPrincipal {
  /** Stable id from the host's identity provider. */
  id: string;
  kind: 'person' | 'service';
  displayName?: string;
  email?: string;
  groups?: string[];
  /** Values row rules can read later (RFC 0010 HH-3), e.g. region. */
  attributes?: Record<string, string | number | boolean | string[]>;
  /**
   * HH-11: Apps the host gave this person beyond each App's own policies
   * (e.g. an approved request for one App), by App id. 'execute' runs its
   * tiles; 'read' only opens it. Absent: the App's policies decide alone.
   */
  appGrants?: Record<string, 'read' | 'execute'>;
  /**
   * 'host' when a hook supplied it; 'link' for a read-only page link, which
   * sees its one App as the owner publishes it; 'local' for the local owner.
   */
  source: 'local' | 'host' | 'link';
}

export interface DqlRequestContext {
  principal: DqlPrincipal;
  requestId: string;
  /**
   * The hooks of the server this request arrived at. Several servers can run
   * in one process (a host's Production and its previews); each request uses
   * its own server's hooks, and the process-wide ones are only a fallback.
   */
  hooks?: DqlHostHooks;
}

/** The hooks of the server handling the current request, if a host set them. */
export function currentHostHooks(): DqlHostHooks | undefined {
  return requestContext.getStore()?.hooks;
}

/** A certified source a person could read, as the host's `sourceAccess` sees it. */
export interface DqlSourceRef {
  id: string;
  kind: 'dataset' | 'block' | 'metric';
  name: string;
  domain?: string;
  /** Project-relative file, for blocks and block Datasets. */
  path?: string;
}

/**
 * The ids among `sources` this person may use, or null when no host decides
 * (all allowed). A host that errs allows none (fail closed).
 */
export async function hostAllowedSources(hooks: DqlHostHooks | undefined, principal: DqlPrincipal | null | undefined, sources: DqlSourceRef[]): Promise<Set<string> | null> {
  if (!hooks?.sourceAccess || !sources.length) return null;
  if (!principal) return new Set();
  try {
    return new Set(await hooks.sourceAccess(principal, sources));
  } catch {
    return new Set();
  }
}

/** A host's answer to "may this person do this?". */
export interface DqlDecision {
  allow: boolean;
  /** Shown to the person when refused. */
  reason?: string;
  /**
   * HH-12: where to go from a refusal, e.g. a page to ask for access. Only a
   * same-origin path (`/…`) is passed on; DQL opens it as a host page.
   */
  next?: { label: string; href: string };
}

/** A refusal's `next` link as DQL passes it on: a same-origin path only. */
export function safeNextLink(next: DqlDecision['next']): { label: string; href: string } | undefined {
  if (!next || typeof next.label !== 'string' || typeof next.href !== 'string') return undefined;
  if (!next.href.startsWith('/') || next.href.startsWith('//') || next.href.includes('\\')) return undefined;
  return { label: next.label.slice(0, 80), href: next.href };
}

export interface DqlHostHooks {
  /**
   * Who made this request. Called for every `/api/` request except
   * `/api/health`. Return null to refuse it (401); a hook that throws is a
   * refusal too. When present it replaces the shared-token check.
   */
  resolvePrincipal?(req: IncomingMessage): Promise<DqlPrincipal | null> | DqlPrincipal | null;
  /**
   * May this person do this? Called for every `/api/` request the host
   * placed, with the route's action and resource (RFC 0010 HH-2). A refusal
   * or a hook that throws answers 403. Without it, every placed person may
   * do everything, as with the shared token.
   */
  authorize?(principal: DqlPrincipal, action: DqlAction, resource: DqlResource): Promise<DqlDecision> | DqlDecision;
  /**
   * What each statement may read (RFC 0010 HH-3). Every query the server
   * sends to a warehouse — Datasets, page tiles, AI-written SQL, notebook
   * cells, proofs — passes here first; return it, a narrowed rewrite, or a
   * refusal. See `row-policy.ts`.
   */
  rowPolicy?: DqlRowPolicy;
  /**
   * The connection as the person asking (RFC 0010 HH-4): their own warehouse
   * token or role, laid over the configured connection before any statement
   * runs. A refusal stops the query with "reconnect" — never a retry with the
   * service credential. See `row-policy.ts`.
   */
  credentials?: DqlCredentialsHook;
  /**
   * The model for this person (RFC 0010 HH-5), e.g. Claude through Amazon
   * Bedrock or Google Vertex in the customer's account
   * (`createBedrockClaudeProvider`, `createVertexClaudeProvider` in
   * dql-agent). Consulted before DQL's own provider settings; return
   * undefined to use them. `id` names the provider family for receipts.
   */
  modelProvider?(input: { principal: DqlPrincipal | null }): { id: string; provider: DqlModelProvider } | undefined;
  /**
   * Whether result values may reach this model — the privacy boundary.
   * Without it, only a model on this machine qualifies (Ollama on loopback).
   * The commercial host's approved rule: the model runs in the customer's
   * own cloud account, in a region their admin approved, with data
   * retention off.
   */
  isInBoundary?(model: { id: string; name: string; model?: string; baseUrl?: string }): boolean;
  /**
   * Audit (RFC 0010 HH-6): one event per API request that changed something
   * or was refused, and one per finished answer. No result values. Without
   * it nothing is recorded; central audit is the host's. See `observability.ts`.
   */
  audit?: DqlAuditSink;
  /**
   * Every tool an agent runs inside the server (HH-7) — catalog lookups,
   * governed queries, SQL runs, `finish_answer` — passes here with the person
   * asking. Call `next()` to run it; return something else to reshape the
   * result; throw to refuse. Queries a tool runs still pass `rowPolicy`.
   */
  tools?(call: { name: string; args: unknown; principal: DqlPrincipal | null }, next: () => Promise<unknown>): Promise<unknown>;
  /**
   * Delivery (HH-8): the host's mail, Slack app or signed webhooks in place
   * of DQL's senders for digests and alerts.
   */
  delivery?: import('../schedule/notifiers/index.js').DeliverySink;
  /**
   * Signing (HH-8): a key service that signs exported snapshots with an
   * Ed25519 key it never hands out; exports then name who exported them.
   */
  signing?: import('../snapshot/app-snapshot.js').SnapshotSigner;
  /**
   * Git (HH-8): commits are authored as the signed-in person (when they have
   * an email); `openPullRequest` replaces the GitHub CLI for review requests.
   */
  git?: {
    openPullRequest?(input: { gitRoot: string; branch: string; base: string; title: string; body: string; principal: DqlPrincipal | null }): Promise<{ url: string }>;
  };
  /**
   * Whom answers are written for: a stakeholder (consumption only, no SQL or
   * authoring handoffs) or an analyst. With this hook the host decides per
   * person and the request body's `audience` is ignored; a hook error means
   * stakeholder.
   */
  audience?(principal: DqlPrincipal): Promise<'stakeholder' | 'analyst' | undefined> | 'stakeholder' | 'analyst' | undefined;
  /**
   * What the DQL app shows around its own screens for this person (HH-9):
   * links to the host's own pages, the host's sign-out, and actions the host
   * offers on answers that need review (for example "Make this a certified
   * answer"). The app's screens stay DQL's; the host only adds to them.
   */
  ui?(principal: DqlPrincipal): Promise<DqlHostUi> | DqlHostUi;
  /**
   * Where the host's review of each answer stands, for answers this person
   * asked (HH-10): e.g. "Request R-142 · assigned to Sam" or "Checked by
   * Dan Kim". Shown beside the answer; the answer's own trust label stays.
   */
  answerStatus?(principal: DqlPrincipal, runIds: string[]): Promise<Record<string, DqlAnswerStatus>> | Record<string, DqlAnswerStatus>;
  /**
   * HH-13: which certified sources this person may use — App Datasets
   * (`app:block:…`, `app:semantic:…`), certified blocks and metrics. Returns
   * the ids allowed; the rest are left out of Ask and refused on App tiles.
   * An error allows none. Without it, every certified source is usable.
   */
  sourceAccess?(principal: DqlPrincipal, sources: DqlSourceRef[]): Promise<Iterable<string>> | Iterable<string>;
  /**
   * HH-14: whether this person sees the figures of an Ask answer that needs
   * review. `withhold_review` gives them — and stores for them — the answer
   * without any value (what it is built on, its SQL and trust), until someone
   * checks it; certified and governed answers are unchanged. An error withholds.
   */
  answerFigures?(principal: DqlPrincipal): 'show' | 'withhold_review' | Promise<'show' | 'withhold_review'>;
  /** Each finished Ask trace, strictly redacted, as a bundle and as OTLP (HH-6). */
  traces?: DqlTraceSink;
  /**
   * Where state lives (HH-6), for hosts that run several copies of DQL on
   * shared storage. Each defaults to today's SQLite file in the project.
   */
  stores?: {
    runs?: DqlRunStore;
    memory?: (projectRoot: string) => DqlMemoryStore;
    conversations?: (defaultPath: string) => DqlConversationStore;
  };
  /**
   * Certify with every enterprise gate required (grain, outputs, pattern,
   * lineage, cadence). With a host, the host decides this, not the request.
   */
  enterpriseCertification?: boolean;
}

/** The host's additions to the DQL app for one person (HH-9). */
export type DqlHostIcon = 'inbox' | 'requests' | 'review' | 'work' | 'health' | 'admin' | 'people' | 'git' | 'link';

export interface DqlAnswerStatus {
  state: 'requested' | 'in_progress' | 'checked' | 'certified' | 'declined';
  label: string;
  detail?: string;
  /** A same-origin page with the whole story, opened inside the app. */
  href?: string;
}

export interface DqlHostUi {
  /** Where "Sign out" goes. */
  signOutUrl?: string;
  /** Links to the host's own pages, in the person menu or the navigation. */
  /** `badge` is a count shown beside the link, e.g. reviews waiting; `icon` is one of DQL's. */
  links?: Array<{ id: string; label: string; href: string; placement: 'menu' | 'nav'; badge?: number; icon?: DqlHostIcon }>;
  /**
   * Offered on an answer that needs review. DQL posts
   * `{ runId, question, threadId?, trustState }` to `url` (same origin) and
   * shows the `message` the host answers with.
   */
  /**
   * Buttons on an answer. `on` says which answers get it: `review` (an AI
   * answer no certified source backs; the default), `unanswered` (DQL could
   * not answer at all) and/or `answered` (a certified or governed answer —
   * e.g. "This looks wrong", shown quietly).
   */
  answerActions?: Array<{ id: string; label: string; url: string; description?: string; on?: Array<'review' | 'unanswered' | 'answered'> }>;
  /** A name for the environment, e.g. "Claims · Production". */
  environment?: string;
}

/** The run store surface the server uses (dql-agent's SQLite store satisfies it). */
export type DqlRunStore = Pick<import('@duckcodeailabs/dql-agent').SqliteAgentRunStore, 'save' | 'get' | 'list' | 'getProgress' | 'saveProgress' | 'claimRequest' | 'requestClaim' | 'count'>;
/** The memory store surface (dql-agent's MemoryStore satisfies it). */
export type DqlMemoryStore = Pick<import('@duckcodeailabs/dql-agent').MemoryStore, keyof import('@duckcodeailabs/dql-agent').MemoryStore>;
/** The conversation store surface (dql-agent's ConversationStore satisfies it). */
export type DqlConversationStore = Pick<import('@duckcodeailabs/dql-agent').ConversationStore, keyof import('@duckcodeailabs/dql-agent').ConversationStore>;

/** The generate/stream surface DQL needs from a model; dql-agent's AgentProvider satisfies it. */
export type DqlModelProvider = import('@duckcodeailabs/dql-agent').AgentProvider;

const requestContext = new AsyncLocalStorage<DqlRequestContext>();

/**
 * The host's model hooks, for code outside a request's closure (provider
 * selection is module-level). One host per process, set at server start.
 */
let hostModelHooks: Pick<DqlHostHooks, 'modelProvider' | 'isInBoundary'> = {};
export function setHostModelHooks(hooks: Pick<DqlHostHooks, 'modelProvider' | 'isInBoundary'> | undefined): void {
  hostModelHooks = { ...(hooks?.modelProvider ? { modelProvider: hooks.modelProvider } : {}), ...(hooks?.isInBoundary ? { isInBoundary: hooks.isInBoundary } : {}) };
}

let hostGitHooks: DqlHostHooks['git'] | undefined;
export function setHostGitHooks(hooks: DqlHostHooks['git'] | undefined): void {
  hostGitHooks = hooks;
}
export function currentHostGitHooks(): DqlHostHooks['git'] | undefined {
  const scoped = currentHostHooks();
  return scoped ? scoped.git : hostGitHooks;
}

/** The model hooks for the current request's server, else the process's. */
function modelHooks(): Pick<DqlHostHooks, 'modelProvider' | 'isInBoundary'> {
  const scoped = currentHostHooks();
  return scoped ? { ...(scoped.modelProvider ? { modelProvider: scoped.modelProvider } : {}), ...(scoped.isInBoundary ? { isInBoundary: scoped.isInBoundary } : {}) } : hostModelHooks;
}

/** `Name <email>` for the signed-in person, to author commits; undefined without an email. */
export function hostGitAuthor(): string | undefined {
  const principal = currentPrincipal();
  if (!principal || principal.source !== 'host' || !principal.email) return undefined;
  const name = (principal.displayName || principal.email).replace(/[<>\n]/g, '').trim();
  return `${name} <${principal.email.replace(/[<>\s]/g, '')}>`;
}

/** The host's model for the person asking, if the host supplies one. */
export function hostModelProvider(): { id: string; provider: DqlModelProvider } | undefined {
  try {
    return modelHooks().modelProvider?.({ principal: currentPrincipal() ?? null }) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether result values may reach this model. The host decides when it has
 * a boundary rule (an error means no); otherwise only a model on this
 * machine qualifies.
 */
export function resultValuesMayReachModel(model: { id: string; name: string; model?: string; baseUrl?: string }, isLocal: () => boolean): boolean {
  const hooks = modelHooks();
  if (hooks.isInBoundary) {
    try {
      return hooks.isInBoundary(model) === true;
    } catch {
      return false;
    }
  }
  return isLocal();
}

/** Run `work` as `context`; without a context, just run it. */
export function withRequestContext<T>(context: DqlRequestContext | undefined, work: () => T): T {
  return context ? requestContext.run(context, work) : work();
}

export function currentRequestContext(): DqlRequestContext | undefined {
  return requestContext.getStore();
}

/** The host-supplied person behind the current request, if any. */
export function currentPrincipal(): DqlPrincipal | undefined {
  return requestContext.getStore()?.principal;
}

/**
 * The name recorded for the person acting now, when a host said who that
 * is: their email, else their display name, else their id. Undefined when
 * no host is in charge, so callers keep their local behaviour.
 */
export function hostActor(): string | undefined {
  const principal = currentPrincipal();
  if (!principal || principal.source !== 'host') return undefined;
  return principal.email?.trim() || principal.displayName?.trim() || principal.id;
}

/**
 * Accept only a well-formed principal from a hook. Anything else — no id,
 * an unknown kind, a thrown error — refuses the request.
 */
export function normalizeHostPrincipal(value: unknown): DqlPrincipal | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const kind = raw.kind === 'service' ? 'service' : raw.kind === undefined || raw.kind === 'person' ? 'person' : null;
  if (!kind) return null;
  const text = (field: unknown) => (typeof field === 'string' && field.trim() ? field.trim() : undefined);
  const groups = Array.isArray(raw.groups) ? raw.groups.filter((group): group is string => typeof group === 'string' && group.trim().length > 0) : undefined;
  const attributes = raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes)
    ? raw.attributes as DqlPrincipal['attributes']
    : undefined;
  const email = text(raw.email);
  const displayName = text(raw.displayName);
  const appGrants = raw.appGrants && typeof raw.appGrants === 'object' && !Array.isArray(raw.appGrants)
    ? Object.fromEntries(Object.entries(raw.appGrants as Record<string, unknown>).filter((entry): entry is [string, 'read' | 'execute'] => entry[1] === 'read' || entry[1] === 'execute'))
    : undefined;
  return {
    id,
    kind,
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    ...(groups?.length ? { groups } : {}),
    ...(attributes ? { attributes } : {}),
    ...(appGrants && Object.keys(appGrants).length ? { appGrants } : {}),
    source: 'host',
  };
}

/** Ask the host who is asking; null when it refuses, errs or answers with something malformed. */
export async function resolveHostPrincipal(hooks: DqlHostHooks, req: IncomingMessage): Promise<DqlPrincipal | null> {
  if (!hooks.resolvePrincipal) return null;
  try {
    return normalizeHostPrincipal(await hooks.resolvePrincipal(req));
  } catch {
    return null;
  }
}

/** Ask the host whether this request may go ahead; an error is a refusal. */
export async function authorizeHostRequest(hooks: DqlHostHooks, principal: DqlPrincipal, route: DqlRouteAction): Promise<DqlDecision> {
  if (!hooks.authorize) return { allow: true };
  try {
    const decision = await hooks.authorize(principal, route.action, route.resource);
    if (decision && decision.allow === true) return { allow: true };
    const reason = decision && typeof decision.reason === 'string' && decision.reason.trim() ? decision.reason.trim() : undefined;
    const next = decision ? safeNextLink(decision.next) : undefined;
    return { allow: false, ...(reason ? { reason } : {}), ...(next ? { next } : {}) };
  } catch {
    return { allow: false };
  }
}

/**
 * ONE PERSONA PER PERSON. "View as" (the App persona) is kept per signed-in
 * person, so a steward previewing an App as a member never changes what
 * anyone else sees. Requests without a host principal keep the one
 * process-wide persona, as before.
 */
const personaSlots = new Map<string, { value: unknown }>();
export function installHostPersonaSlots(registry: { useSlots(resolver: (() => { value: any } | undefined) | null): void }): void {
  registry.useSlots(() => {
    const principal = currentPrincipal();
    if (!principal || principal.source === 'local') return undefined;
    let slot = personaSlots.get(principal.id);
    if (!slot) {
      slot = { value: null };
      personaSlots.set(principal.id, slot);
    }
    return slot;
  });
}

/**
 * The person as App policies see them when they have not chosen an App
 * persona: their own groups and department, never the owner's full access.
 */
export function hostUserContext(): { userId: string; roles: string[]; department?: string } | undefined {
  const principal = currentPrincipal();
  const actor = hostActor();
  if (!principal || !actor) return undefined;
  const department = principal.attributes?.department;
  return {
    userId: actor,
    roles: [...(principal.groups ?? [])],
    ...(typeof department === 'string' ? { department } : {}),
  };
}

/**
 * Row-rule values for the signed-in person: `{user.id}`, `{user.email}`,
 * `{user.roles}` and each attribute as `{user.<name>}`. The person's values
 * win over anything a request passes, so nobody widens their own rows.
 */
export function hostPrincipalVariables(): Record<string, unknown> | undefined {
  const principal = currentPrincipal();
  const actor = hostActor();
  if (!principal || !actor) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(principal.attributes ?? {})) {
    out[`user.${key}`] = value;
    out[key] = value;
  }
  out['user.id'] = actor;
  out['user.userId'] = actor;
  if (principal.email) out['user.email'] = principal.email;
  out['user.roles'] = [...(principal.groups ?? [])];
  return out;
}

/** What about the signed-in person can change query results, for cache and proof keys. */
export function hostPrincipalPolicyIdentity(): Record<string, unknown> | undefined {
  const principal = currentPrincipal();
  if (!principal || principal.source !== 'host') return undefined;
  const attributes = Object.fromEntries(Object.entries(principal.attributes ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  return { id: principal.id, groups: [...(principal.groups ?? [])].sort(), attributes };
}
