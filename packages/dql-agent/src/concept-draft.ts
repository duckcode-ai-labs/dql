import type { ContextAuthoringOperation } from './context-authoring.js';
import type { DQLManifest } from '@zlens/core';

/**
 * DEMAND-DRIVEN CONCEPT DRAFTS (A-005). A concept is never bulk-generated: a
 * draft is proposed only when something asked for it — an inspector button, an
 * unmet display-label obligation, a cross-domain join gap, an unresolved
 * `concept_refs` — and only from evidence the project already holds: a term
 * whose identifiers name an entity key, entities in different domains that
 * share a key name under a certified export/import route, or a same-domain
 * pair sharing a key name. Every proposal is `status: draft`,
 * `origin: ai_draft`, carries its evidence, and goes through the review flow;
 * nothing here certifies anything.
 */

export interface ConceptDraftEvidenceInput {
  manifest: DQLManifest;
  /** Narrow the draft to these entities (qualified ids or local ids) when a gap named them; otherwise every candidate pair is considered. */
  focusEntities?: string[];
  /** Only this domain's concepts are drafted when set. */
  domain?: string;
  maxDrafts?: number;
}

interface Candidate {
  key: string;
  entities: Array<{ qualifiedId: string; localId: string; domain: string; grain?: string }>;
  evidence: string[];
  termName?: string;
  termDescription?: string;
  termSynonyms?: string[];
}

export function conceptDraftFromEvidence(input: ConceptDraftEvidenceInput): ContextAuthoringOperation[] {
  const modeling = input.manifest.modeling;
  if (!modeling) return [];
  const entities = Object.values(modeling.entities);
  const focus = new Set((input.focusEntities ?? []).map((value) => value.toLowerCase()));
  const inFocus = (entity: { qualifiedId: string; localId: string }) => focus.size === 0 || focus.has(entity.qualifiedId.toLowerCase()) || focus.has(entity.localId.toLowerCase());
  const existing = new Set(Object.values(modeling.concepts ?? {}).flatMap((concept) => concept.bindings.map((binding) => binding.entity)));
  const exportsOf = Object.values(modeling.interfaces?.exports ?? {});
  const importsOf = Object.values(modeling.interfaces?.imports ?? {});
  const routed = (producer: string, consumer: string): string[] => {
    const evidence: string[] = [];
    for (const exported of exportsOf) {
      if (exported.domain !== producer) continue;
      const matched = importsOf.find((imported) => imported.domain === consumer && imported.exportRef.split('.')[0] === producer);
      if (matched) evidence.push(`export ${exported.qualifiedId}`, `import ${matched.qualifiedId}`);
    }
    return evidence;
  };
  // Group entities by key name: a shared key is the evidence that two
  // entities may be one thing.
  const byKey = new Map<string, Candidate['entities']>();
  for (const entity of entities) {
    if (!inFocus(entity) || existing.has(entity.qualifiedId)) continue;
    if (input.domain && entity.domain !== input.domain) continue;
    for (const key of new Set([...(entity.keys ?? []), ...(entity.grain ? [entity.grain] : [])].map((value) => value.toLowerCase()))) {
      const list = byKey.get(key) ?? [];
      list.push({ qualifiedId: entity.qualifiedId, localId: entity.localId, domain: entity.domain, ...(entity.grain ? { grain: entity.grain } : {}) });
      byKey.set(key, list);
    }
  }
  const terms = Object.values(input.manifest.terms ?? {});
  const candidates: Candidate[] = [];
  for (const [key, all] of byKey) {
    if (all.length < 2) continue;
    // The canonical binding is the entity AT the key's grain; the rest are
    // conformed. A member in another domain stays only under a certified
    // route to the canonical's domain — missing route information never
    // widens a concept across a boundary.
    const canonical = all.find((entity) => entity.grain?.toLowerCase() === key) ?? all[0]!;
    const evidence = [`shared key ${key} on ${all.map((member) => member.qualifiedId).join(', ')}`];
    const members = all.filter((member) => {
      if (member.domain === canonical.domain) return true;
      const route = [...routed(canonical.domain, member.domain), ...routed(member.domain, canonical.domain)];
      if (route.length === 0) { evidence.push(`${member.qualifiedId} left out: no certified route between ${canonical.domain} and ${member.domain}`); return false; }
      evidence.push(...route);
      return true;
    });
    if (members.length < 2) continue;
    const term = terms.find((item) => (item.identifiers ?? []).some((identifier) => identifier.toLowerCase() === key));
    if (term) evidence.push(`term ${term.name} identifies ${key}`);
    candidates.push({ key, entities: [canonical, ...members.filter((member) => member !== canonical)], evidence, ...(term ? { termName: term.name, termDescription: term.description, termSynonyms: term.synonyms } : {}) });
  }
  candidates.sort((left, right) => right.evidence.length - left.evidence.length || left.key.localeCompare(right.key));
  return candidates.slice(0, input.maxDrafts ?? 3).map((candidate) => {
    const canonical = candidate.entities[0]!;
    const domain = input.domain ?? canonical.domain;
    const localId = (candidate.termName ?? candidate.key.replace(/_id$/, '')).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || candidate.key;
    return {
      id: `concept-draft:${domain}:${localId}`,
      kind: 'modeling_change',
      evidence: candidate.evidence,
      change: {
        operation: 'upsert_concept',
        value: {
          id: localId, domain,
          name: candidate.termName ?? localId.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
          ...(candidate.termDescription ? { description: candidate.termDescription } : {}),
          ...(candidate.termSynonyms?.length ? { synonyms: candidate.termSynonyms } : {}),
          bindings: candidate.entities.map((entity) => ({
            entity: entity.domain === domain ? entity.localId : `${entity.domain}:${entity.localId}`,
            role: entity.qualifiedId === canonical.qualifiedId ? 'canonical' as const : 'conformed' as const,
            ...(entity.grain ? { grain: entity.grain } : {}),
          })),
          rule: `Reconcile on ${candidate.key}; ${canonical.localId} is the canonical identity. Drafted from evidence — review before certifying.`,
          status: 'draft', origin: 'ai_draft',
        },
      },
    };
  });
}
