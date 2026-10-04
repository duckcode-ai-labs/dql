import { createHash } from 'node:crypto';

import {
  loadAppDocument,
  findAppDocuments,
  type AppDocument,
} from '@duckcodeailabs/dql-core';
import { PolicyEngine, type AccessLevel, type AccessPolicy, type DataClassification } from '@duckcodeailabs/dql-governance';
import {
  OWNER_DEFAULT,
  defaultPersonaRegistry,
  mergePersonaVariables,
} from '@duckcodeailabs/dql-project';
import { currentPrincipal, hostPrincipalPolicyIdentity, hostPrincipalRunOwner, hostPrincipalVariables, hostUserContext, type DqlPrincipal } from './host/request-context.js';

export class DQLAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DQLAccessDeniedError';
  }
}

export function runtimeVariables(base: Record<string, unknown> | undefined): Record<string, unknown> {
  const persona = defaultPersonaRegistry.active;
  // A signed-in person with no App persona still narrows by their own values
  // (RFC 0010 HH-2); without a host this is today's behaviour exactly.
  const host = persona ? undefined : hostPrincipalVariables();
  return host ? { ...(base ?? {}), ...host } : mergePersonaVariables(base ?? {}, persona);
}

export function activePersonaAppId(): string | undefined {
  return defaultPersonaRegistry.active?.appId;
}

/**
 * Identity of everything about the active persona that can change query
 * results: the App it is scoped to, who it is, its roles, and the RLS context
 * and attributes substituted into governed SQL. Two personas of the same App
 * with different RLS values must never share a cached or proven result.
 */
export function activePersonaPolicyFingerprint(): string {
  return personaFingerprint(hostPrincipalPolicyIdentity());
}

/**
 * Who ran something, to find that run again later (a chart a person asks
 * about): the same as `activePersonaPolicyFingerprint` for the App persona,
 * but with the signed-in person's identity alone, not where this request's
 * values go (RFC 0010 `purposeAttributes`). Without a host the two are equal.
 * Never a cache or proof key.
 */
export function activePersonaRunOwnerFingerprint(): string {
  return personaFingerprint(hostPrincipalRunOwner());
}

function personaFingerprint(host: Record<string, unknown> | undefined): string {
  const persona = defaultPersonaRegistry.active;
  const sorted = (record: Record<string, unknown> | undefined) => Object.fromEntries(
    Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    appId: persona?.appId ?? 'global',
    userId: persona?.userId ?? null,
    roles: [...(persona?.roles ?? [])].sort(),
    rlsContext: sorted(persona?.rlsContext),
    attributes: sorted(persona?.attributes),
    // Only with a host, so a local project's existing keys stay the same.
    ...(host ? { principal: host } : {}),
  })).digest('hex');
}

/**
 * WHO AN APP IS FOR (RFC 0010, HH-16). An App's `audienceGroups` name the
 * identity-provider groups it is written for. With a host that signs people
 * in, only members of those groups, the App's owners and people the host gave
 * the App (HH-11) open it. Without a host, or with no audience groups, this
 * allows everything and the App's policies decide, as before.
 */
export function appAudienceDecision(
  app: Pick<AppDocument, 'id' | 'name' | 'owners' | 'audienceGroups'> | null | undefined,
  principal: DqlPrincipal | null | undefined = currentPrincipal(),
): { allow: true } | { allow: false; reason: string } {
  const groups = app?.audienceGroups ?? [];
  if (!app || !groups.length || !principal || principal.source !== 'host') return { allow: true };
  if (principal.appGrants?.[app.id]) return { allow: true };
  const email = principal.email?.toLowerCase();
  if (app.owners.some((owner) => owner === principal.id || (!!email && owner.toLowerCase() === email))) return { allow: true };
  if ((principal.groups ?? []).some((group) => groups.includes(group))) return { allow: true };
  const named = groups.length === 1 ? groups[0] : `${groups.slice(0, -1).join(', ')} or ${groups.at(-1)}`;
  return { allow: false, reason: `${app.name} is for ${named}. Ask its owner for access.` };
}

export function loadRuntimeApp(projectRoot: string, appId: string | undefined | null): AppDocument | null {
  if (!appId) return null;
  for (const p of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(p);
    if (document?.id === appId) return document;
  }
  return null;
}

export function assertAppAccess(opts: {
  app: AppDocument | null;
  domain?: string | null;
  classification?: DataClassification | null;
  level?: AccessLevel;
}): void {
  const app = opts.app;
  if (!app) return;
  // HH-11: a host's grant for this App opens it (read) or also runs it (execute).
  const principal = currentPrincipal();
  const grant = principal?.source === 'host' ? principal.appGrants?.[app.id] : undefined;
  if (grant === 'execute' || (grant === 'read' && opts.level === 'read')) return;
  const user = defaultPersonaRegistry.toUserContext(hostUserContext() ?? OWNER_DEFAULT);
  const engine = new PolicyEngine(app.policies.map(toAccessPolicy));
  const result = engine.checkAccess(
    user,
    opts.domain ?? app.domain,
    opts.classification ?? 'internal',
    opts.level ?? 'execute',
  );
  if (!result.allowed) {
    throw new DQLAccessDeniedError(result.reason ?? 'Not authorized');
  }
}

function toAccessPolicy(policy: AppDocument['policies'][number]): AccessPolicy {
  return {
    id: policy.id,
    name: policy.id,
    description: policy.description ?? policy.id,
    domain: policy.domain,
    minClassification: policy.minClassification,
    allowedRoles: policy.allowedRoles,
    allowedUsers: policy.allowedUsers ?? [],
    accessLevel: policy.accessLevel,
    enabled: policy.enabled !== false,
  };
}
