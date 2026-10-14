/**
 * Evidence-first domain/skill bootstrap. It deliberately drafts from the
 * compiled repository instead of asking a model to invent a taxonomy. A UI or
 * provider can enrich the prose later, but every candidate carries the exact
 * metrics, blocks, and terms that caused it to exist.
 */
import type { DQLManifest } from '@zlens/core';
import type { DomainInput } from '@zlens/core';
import { buildDomainReferenceSkills } from './domain-skills.js';
import type { WriteSkillInput } from './loader.js';

export interface DomainBootstrapCandidate {
  id: string;
  kind: 'domain' | 'skill';
  action: 'create' | 'update' | 'unchanged' | 'needs_attention';
  confidence: number;
  evidence: string[];
  /** Local-only notes from the optional AI enrichment pass. */
  notes?: string[];
  domain?: DomainInput;
  skill?: WriteSkillInput;
}

export interface DomainSkillBootstrapAiDraft {
  id: string;
  description?: string;
  boundedContext?: string;
  businessOutcome?: string;
  inScope?: string[];
  outOfScope?: string[];
  primaryTerms?: string[];
  tags?: string[];
  triggers?: string[];
  exclusions?: string[];
  clarifyWhen?: string[];
  examples?: string[];
  body?: string;
}

export interface DomainSkillBootstrapEnrichment {
  candidates: DomainBootstrapCandidate[];
  applied: string[];
  rejected: string[];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'domain';
}

/** Build reviewable candidates without writing tracked files. */
export function draftDomainSkillBootstrap(manifest: DQLManifest): DomainBootstrapCandidate[] {
  const candidates: DomainBootstrapCandidate[] = [];
  const declared = Object.values(manifest.domains ?? {});
  const declaredNames = new Set(declared.map((domain) => domain.name.toLowerCase()));
  const inferred = new Set<string>();
  for (const block of Object.values(manifest.blocks ?? {})) if (block.domain) inferred.add(block.domain);
  for (const metric of Object.values(manifest.metrics ?? {})) if (metric.domain) inferred.add(metric.domain);
  for (const term of Object.values(manifest.terms ?? {})) if (term.domain) inferred.add(term.domain);

  for (const domain of declared) {
    const metricCount = Object.values(manifest.metrics ?? {}).filter((metric) => metric.domain === domain.name).length;
    const blockCount = Object.values(manifest.blocks ?? {}).filter((block) => block.domain === domain.name).length;
    const termCount = Object.values(manifest.terms ?? {}).filter((term) => term.domain === domain.name).length;
    candidates.push({
      id: `domain:${slug(domain.name)}`,
      kind: 'domain',
      action: 'unchanged',
      confidence: 1,
      evidence: [`Declared in ${domain.filePath}`, `${metricCount} metrics`, `${blockCount} blocks`, `${termCount} terms`],
      domain: {
        name: domain.name,
        parent: domain.parent,
        owner: domain.owner,
        businessOwner: domain.businessOwner,
        boundedContext: domain.boundedContext,
        sourceSystems: domain.sourceSystems,
        primaryTerms: domain.primaryTerms,
        tags: domain.tags,
        businessOutcome: domain.businessOutcome,
        description: domain.description,
        reviewCadence: domain.reviewCadence,
        inScope: domain.inScope,
        outOfScope: domain.outOfScope,
        dbtGroups: domain.dbtGroups,
        dbtPaths: domain.dbtPaths,
        dbtTags: domain.dbtTags,
        semanticDomains: domain.semanticDomains,
        semanticTags: domain.semanticTags,
        sourcePath: domain.filePath,
      },
    });
  }

  for (const name of inferred) {
    if (declaredNames.has(name.toLowerCase())) continue;
    const metricCount = Object.values(manifest.metrics ?? {}).filter((metric) => metric.domain === name).length;
    const blockCount = Object.values(manifest.blocks ?? {}).filter((block) => block.domain === name).length;
    const termCount = Object.values(manifest.terms ?? {}).filter((term) => term.domain === name).length;
    candidates.push({
      id: `domain:${slug(name)}`,
      kind: 'domain',
      action: 'create',
      confidence: metricCount + blockCount + termCount >= 3 ? 0.9 : 0.55,
      evidence: ['Inferred from governed artifacts', `${metricCount} metrics`, `${blockCount} blocks`, `${termCount} terms`],
      domain: {
        name,
        boundedContext: `Governed analytics for ${name}. Review the generated scope before use.`,
        reviewCadence: 'quarterly',
      },
    });
  }

  for (const skill of buildDomainReferenceSkills({ ...manifest, domains: Object.fromEntries(
    candidates.filter((candidate) => candidate.kind === 'domain' && candidate.domain).map((candidate) => [candidate.domain!.name, {
      name: candidate.domain!.name,
      filePath: candidate.domain!.sourcePath ?? `domains/${slug(candidate.domain!.name)}/domain.dql`,
      ...candidate.domain,
    }]),
  ) })) {
    candidates.push({
      id: `skill:${skill.id}`,
      kind: 'skill',
      action: 'create',
      confidence: 0.85,
      evidence: [`Derived from domain ${skill.domain}`, `${skill.preferredMetrics?.length ?? 0} metrics`, `${skill.preferredBlocks?.length ?? 0} certified blocks`],
      skill: { ...skill, kind: 'domain_reference', status: 'draft', domains: skill.domain ? [skill.domain] : [] },
    });
  }

  return candidates.sort((a, b) => a.kind.localeCompare(b.kind) || b.confidence - a.confidence || a.id.localeCompare(b.id));
}

/**
 * A bounded, evidence-only prompt for enriching repository drafts. The model is
 * never asked to discover metrics, joins, or new taxonomy: it may only improve
 * prose and operational guidance for the candidate IDs supplied here.
 */
export function buildDomainSkillBootstrapPrompt(
  manifest: DQLManifest,
  candidates: DomainBootstrapCandidate[],
): { system: string; user: string } {
  const metricIndex = Object.values(manifest.metrics ?? {});
  const blockIndex = Object.values(manifest.blocks ?? {});
  const termIndex = Object.values(manifest.terms ?? {});
  const items = candidates.map((candidate) => {
    const domainName = candidate.domain?.name ?? candidate.skill?.domain ?? candidate.skill?.domains?.[0];
    const metrics = metricIndex.filter((metric) => metric.domain === domainName).slice(0, 24)
      .map((metric) => ({ id: metric.name, label: metric.label, description: truncate(metric.description, 180) }));
    const blocks = blockIndex.filter((block) => block.domain === domainName).slice(0, 16)
      .map((block) => ({ id: block.name, status: block.status, description: truncate(block.description, 180) }));
    const terms = termIndex.filter((term) => term.domain === domainName).slice(0, 24)
      .map((term) => ({ name: term.name, synonyms: (term.synonyms ?? []).slice(0, 8), caveats: (term.caveats ?? []).slice(0, 5) }));
    return {
      id: candidate.id,
      kind: candidate.kind,
      action: candidate.action,
      domain: candidate.domain ? {
        name: candidate.domain.name,
        parent: candidate.domain.parent,
        description: candidate.domain.description,
        boundedContext: candidate.domain.boundedContext,
        businessOutcome: candidate.domain.businessOutcome,
        primaryTerms: candidate.domain.primaryTerms,
        tags: candidate.domain.tags,
        inScope: candidate.domain.inScope,
        outOfScope: candidate.domain.outOfScope,
      } : undefined,
      skill: candidate.skill ? {
        id: candidate.skill.id,
        domain: candidate.skill.domain,
        domains: candidate.skill.domains,
        description: candidate.skill.description,
        preferredMetrics: candidate.skill.preferredMetrics,
        preferredBlocks: candidate.skill.preferredBlocks,
      } : undefined,
      evidence: candidate.evidence,
      governedArtifacts: { metrics, blocks, terms },
    };
  });
  return {
    system: [
      'You enrich governed analytics domain and skill drafts from repository evidence.',
      'Return JSON only. Do not use markdown fences.',
      'Never invent or rename domains, metrics, dimensions, blocks, models, joins, filters, owners, or source systems.',
      'Do not create candidate IDs. Return only IDs supplied by the user.',
      'If repository evidence is insufficient, add a concise clarification rule instead of assuming a business definition.',
      'For domains, improve only business description, bounded context, outcome, in/out scope, primary terms, and tags.',
      'For skills, improve only description, triggers, exclusions, clarification rules, examples, and a concise Markdown body.',
      'Skill bodies must use exactly these sections when useful: Purpose, Governed reuse, Vocabulary, Guardrails, Clarify.',
      'Treat listed metrics and certified blocks as references, not proof of an unstated calculation. Keep every field concise.',
      'Output shape: {"drafts":[{"id":"...","description":"...","boundedContext":"...","businessOutcome":"...","inScope":["..."],"outOfScope":["..."],"primaryTerms":["..."],"tags":["..."],"triggers":["..."],"exclusions":["..."],"clarifyWhen":["..."],"examples":["..."],"body":"..."}]}. Omit fields you cannot ground.',
    ].join('\n'),
    user: JSON.stringify({ candidates: items }, null, 2),
  };
}

/**
 * Apply only safe, textual AI improvements. This deliberately rejects model
 * attempts to add governed-object references or unknown candidate IDs.
 */
export function mergeDomainSkillBootstrapEnrichment(
  candidates: DomainBootstrapCandidate[],
  response: string,
): DomainSkillBootstrapEnrichment {
  const parsed = parseBootstrapResponse(response);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const applied: string[] = [];
  const rejected: string[] = [];
  const next = candidates.map((candidate) => ({ ...candidate }));
  const nextById = new Map(next.map((candidate) => [candidate.id, candidate]));

  for (const draft of parsed) {
    const original = byId.get(draft.id);
    const candidate = nextById.get(draft.id);
    if (!original || !candidate) {
      rejected.push(`Ignored unknown candidate ${draft.id || '(missing id)'}.`);
      continue;
    }
    if (candidate.kind === 'domain' && candidate.domain) {
      const domain = { ...candidate.domain };
      const allowedTerms = new Set((original.domain?.primaryTerms ?? []).map(normalize));
      const safeTerms = filterKnown(draft.primaryTerms, allowedTerms);
      if ((draft.primaryTerms?.length ?? 0) !== safeTerms.length) rejected.push(`Ignored ungrounded primary terms for ${draft.id}.`);
      let changed = false;
      changed = assignText(domain, 'description', draft.description) || changed;
      changed = assignText(domain, 'boundedContext', draft.boundedContext) || changed;
      changed = assignText(domain, 'businessOutcome', draft.businessOutcome) || changed;
      changed = assignStrings(domain, 'inScope', draft.inScope) || changed;
      changed = assignStrings(domain, 'outOfScope', draft.outOfScope) || changed;
      changed = assignStrings(domain, 'tags', draft.tags) || changed;
      if (safeTerms.length) changed = assignStrings(domain, 'primaryTerms', safeTerms) || changed;
      candidate.domain = domain;
      if (changed) {
        candidate.action = candidate.action === 'unchanged' ? 'update' : candidate.action;
        candidate.notes = [...(candidate.notes ?? []), 'AI enrichment was constrained to repository evidence.'];
        applied.push(draft.id);
      }
      continue;
    }
    if (candidate.kind === 'skill' && candidate.skill) {
      const skill = { ...candidate.skill };
      let changed = false;
      changed = assignText(skill, 'description', draft.description) || changed;
      changed = assignStrings(skill, 'triggers', draft.triggers) || changed;
      changed = assignStrings(skill, 'exclusions', draft.exclusions) || changed;
      changed = assignStrings(skill, 'clarifyWhen', draft.clarifyWhen) || changed;
      changed = assignStrings(skill, 'examples', draft.examples) || changed;
      changed = assignText(skill, 'body', draft.body, 8000) || changed;
      candidate.skill = skill;
      if (changed) {
        candidate.action = candidate.action === 'unchanged' ? 'update' : candidate.action;
        candidate.notes = [...(candidate.notes ?? []), 'AI enrichment was constrained to repository evidence.'];
        applied.push(draft.id);
      }
    }
  }
  return { candidates: next, applied, rejected };
}

function parseBootstrapResponse(response: string): DomainSkillBootstrapAiDraft[] {
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const value = JSON.parse(match[0]) as { drafts?: unknown };
    if (!Array.isArray(value.drafts)) return [];
    return value.drafts.flatMap((entry): DomainSkillBootstrapAiDraft[] => {
      if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string') return [];
      const raw = entry as Record<string, unknown>;
      return [{
        id: raw.id as string,
        description: safeText(raw.description), boundedContext: safeText(raw.boundedContext), businessOutcome: safeText(raw.businessOutcome),
        inScope: safeList(raw.inScope), outOfScope: safeList(raw.outOfScope), primaryTerms: safeList(raw.primaryTerms), tags: safeList(raw.tags),
        triggers: safeList(raw.triggers), exclusions: safeList(raw.exclusions), clarifyWhen: safeList(raw.clarifyWhen), examples: safeList(raw.examples), body: safeText(raw.body, 8000),
      }];
    });
  } catch {
    return [];
  }
}

function safeText(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function safeList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 240)).filter(Boolean).slice(0, 20);
  return values.length ? values : undefined;
}

function normalize(value: string): string { return value.trim().toLowerCase(); }
function filterKnown(values: string[] | undefined, allowed: Set<string>): string[] {
  return (values ?? []).filter((value) => allowed.has(normalize(value)));
}
function truncate(value: string | undefined, max: number): string | undefined { return value?.trim().slice(0, max); }
function assignText(target: object, key: string, value: string | undefined, max = 500): boolean {
  const record = target as Record<string, unknown>;
  if (!value || value.length > max || record[key] === value) return false;
  record[key] = value;
  return true;
}
function assignStrings(target: object, key: string, value: string[] | undefined): boolean {
  const record = target as Record<string, unknown>;
  if (!value?.length || JSON.stringify(record[key] ?? []) === JSON.stringify(value)) return false;
  record[key] = value;
  return true;
}
