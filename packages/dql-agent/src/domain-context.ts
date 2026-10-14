import type { DQLManifest } from '@zlens/core';

export interface DomainContextEnvelope {
  /** CTX-001: server-validated request scope shared by UI, runtime, and agent. */
  activeDomain: string | null;
  ancestors: string[];
  /**
   * Sub-domains beneath `activeDomain`, at any depth.
   *
   * A sub-domain is inside its parent's boundary by construction — the registry
   * enforces that a child package lives physically under its parent's root — so
   * pinning a domain must see everything its descendants own. Scope used to walk
   * the parent chain UP only, which made every sub-domain and micro-domain
   * invisible to the domain that contains it.
   */
  descendants: string[];
  allowedImports: Array<{
    providerDomain: string;
    exportRef: string;
    purpose: string;
  }>;
  purpose?: string;
  /** Optional focused Model Area. It narrows ranking within activeDomain and is never an authorization boundary. */
  modelAreaId?: string;
  /** Optional product/user lens; eligibility checks still apply. */
  skillRefs?: string[];
  source: 'explicit_ui' | 'explicit_api' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
  snapshotId: string;
}

/** Immutable domain capsule and skill selection recorded for an Ask turn. */
export interface KnowledgeLens {
  mode: 'auto' | 'pinned';
  activeDomainId?: string;
  modelAreaId?: string;
  purpose?: string;
  skillRefs: string[];
  snapshotId: string;
  capsuleFingerprint?: string;
  skillFingerprints?: Record<string, string>;
}

export interface ResolveDomainContextInput {
  manifest: DQLManifest;
  activeDomain?: string | null;
  purpose?: string;
  modelAreaId?: string;
  skillRefs?: string[];
  source?: DomainContextEnvelope['source'];
  confidence?: DomainContextEnvelope['confidence'];
  snapshotId?: string;
}

/** Resolve ancestry and certified imports from server-owned manifest state. */
export function resolveDomainContextEnvelope(input: ResolveDomainContextInput): DomainContextEnvelope {
  const activeDomain = input.activeDomain?.trim() || null;
  const packages = input.manifest.modeling?.packages ?? {};
  if (activeDomain && !packages[activeDomain]) throw new Error(`Unknown domain: ${activeDomain}`);
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let parent = activeDomain ? packages[activeDomain]?.parent : undefined;
  while (parent) {
    if (visited.has(parent)) throw new Error(`Domain hierarchy cycle involving ${parent}`);
    visited.add(parent);
    ancestors.unshift(parent);
    parent = packages[parent]?.parent;
  }
  // Walk DOWN as well as up. Guarded by `seen` so a malformed parent cycle
  // among descendants terminates rather than spinning (the ancestor walk above
  // throws on a cycle, but that only covers the chain above activeDomain).
  const descendants: string[] = [];
  if (activeDomain) {
    const seen = new Set<string>([activeDomain]);
    let frontier = [activeDomain];
    while (frontier.length > 0) {
      const children = Object.values(packages)
        .filter((pkg) => pkg.parent && frontier.includes(pkg.parent) && !seen.has(pkg.id))
        .map((pkg) => pkg.id);
      for (const child of children) seen.add(child);
      descendants.push(...children);
      frontier = children;
    }
    descendants.sort();
  }
  const purpose = input.purpose?.trim() || undefined;
  const requestedModelAreaId = input.modelAreaId?.trim() || undefined;
  const requestedSkillRefs = [...new Set((input.skillRefs ?? []).map((value) => value.trim()).filter(Boolean))];
  let modelAreaId: string | undefined;
  if (requestedModelAreaId) {
    const areas = Object.values(input.manifest.modeling?.areas ?? {});
    const exact = input.manifest.modeling?.areas?.[requestedModelAreaId];
    const localMatches = areas.filter((candidate) => candidate.localId === requestedModelAreaId
      && (!activeDomain || candidate.domain === activeDomain));
    const area = exact ?? (localMatches.length === 1 ? localMatches[0] : undefined);
    if (!area) {
      if (localMatches.length > 1) throw new Error(`Ambiguous model area: ${requestedModelAreaId}`);
      throw new Error(`Unknown model area: ${requestedModelAreaId}`);
    }
    if (activeDomain && area.domain !== activeDomain) throw new Error(`Model area "${requestedModelAreaId}" does not belong to domain "${activeDomain}"`);
    modelAreaId = area.qualifiedId;
  }
  if (input.manifest.knowledgeGraph && requestedSkillRefs.length > 0) {
    const graph = input.manifest.knowledgeGraph;
    const skills = [...Object.values(graph.objects ?? {}), ...(graph.objectRefs ?? [])].filter((item) => item.kind === 'skill');
    const compiledRefs = new Set(Object.values(graph.domainCapsules).flatMap((capsule) => capsule.skillRefs));
    const unknown = requestedSkillRefs.filter((ref) => !compiledRefs.has(ref) && !skills.some((skill) => skill.id === ref || skill.localId === ref));
    if (unknown.length > 0) throw new Error(`Unknown knowledge skill: ${unknown.join(', ')}`);
  }
  const imports = Object.values(input.manifest.modeling?.interfaces?.imports ?? {});
  const exports = input.manifest.modeling?.interfaces?.exports ?? {};
  const contracts = Object.values(input.manifest.modeling?.contracts ?? {});
  const allowedImports = activeDomain ? imports.flatMap((imported) => {
    const exported = exports[imported.exportRef];
    const purposeAllowed = Boolean(purpose && imported.purpose === purpose);
    if (imported.domain !== activeDomain || imported.status !== 'certified' || exported?.status !== 'certified' || !purposeAllowed) return [];
    if (exported.consumerDomains.length > 0 && !exported.consumerDomains.includes(activeDomain)) return [];
    if (exported.purposes.length > 0 && !exported.purposes.includes(imported.purpose)) return [];
    const contract = exported.contract
      ? contracts.find((value) => value.qualifiedId === exported.contract
        || value.id === exported.contract
        || (value.domain === exported.domain && value.localId === exported.contract))
      : undefined;
    if (!contract || contract.status !== 'certified') return [];
    if (contract.purpose && contract.purpose !== imported.purpose) return [];
    if (exported.entity && !contract.entities.includes(exported.entity)) return [];
    return [{ providerDomain: exported.domain, exportRef: imported.exportRef, purpose: imported.purpose }];
  }) : [];
  return {
    activeDomain,
    ancestors,
    descendants,
    allowedImports,
    purpose,
    modelAreaId,
    skillRefs: requestedSkillRefs.length > 0 ? requestedSkillRefs : undefined,
    source: input.source ?? (activeDomain ? 'explicit_api' : 'inferred'),
    confidence: input.confidence ?? (activeDomain ? 'high' : 'low'),
    snapshotId: input.snapshotId ?? input.manifest.dbtProvenance?.manifestFingerprint ?? 'manifest-v2',
  };
}

export function domainContextSearchDomains(context: DomainContextEnvelope | undefined): string[] {
  if (!context?.activeDomain) return [];
  return [...new Set([
    context.activeDomain,
    ...context.ancestors,
    // Descendants are inside the pinned boundary; without them a question
    // answerable only from a sub-domain fails while its parent is pinned.
    ...(context.descendants ?? []),
    ...context.allowedImports.map((item) => item.providerDomain),
  ])];
}

/**
 * ONE SCOPE, EVERY SURFACE (CTX-001). The notebook, the CLI, the MCP server
 * and Slack all carry the same four selections in `workspaceContext`; the
 * server resolves them into an envelope, never the client. Anything else in
 * the workspace context is a client hint and is not a scope.
 */
export interface AskScopeSelectionV1 {
  domain?: string;
  purpose?: string;
  modelAreaId?: string;
  skillRefs?: string[];
}

/** Read the scope selection out of a request's `workspaceContext`; unset or malformed fields are simply absent. */
export function askScopeFromWorkspace(workspace: unknown): AskScopeSelectionV1 {
  const record = workspace && typeof workspace === 'object' ? workspace as Record<string, unknown> : {};
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const refs = Array.isArray(record.skillRefs)
    ? record.skillRefs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : text(record.skillRefs) ? [text(record.skillRefs)!] : undefined;
  return {
    ...(text(record.domain) ? { domain: text(record.domain) } : {}),
    ...(text(record.purpose) ? { purpose: text(record.purpose) } : {}),
    ...(text(record.modelAreaId) ? { modelAreaId: text(record.modelAreaId) } : {}),
    ...(refs?.length ? { skillRefs: refs } : {}),
  };
}

/** The `workspaceContext` fields a client sends for a scope selection (the inverse of `askScopeFromWorkspace`). */
export function workspaceContextForScope(scope: AskScopeSelectionV1): Record<string, unknown> {
  return {
    ...(scope.domain ? { domain: scope.domain } : {}),
    ...(scope.purpose ? { purpose: scope.purpose } : {}),
    ...(scope.modelAreaId ? { modelAreaId: scope.modelAreaId } : {}),
    ...(scope.skillRefs?.length ? { skillRefs: scope.skillRefs } : {}),
  };
}
