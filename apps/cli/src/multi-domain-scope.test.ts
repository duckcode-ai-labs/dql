import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, type DQLManifest } from '@zlens/core';
import {
  applySkillPolicies, buildMetadataSnapshot, buildVocabularyIndex, domainContextSearchDomains, loadSkills, openMetadataCatalog,
  projectVocabularySource, resolveDomainContextEnvelope, upsertMetadataSnapshot, type VocabularySource,
} from '@zlens/agent';
import { joinScopeDecision, modelingJoinGraph, projectionScopeFor } from './ask-pipeline-host/host.js';
import { buildVocabularySource } from './ask-pipeline-host/vocabulary-source.js';

/**
 * THE MULTI-DOMAIN FIXTURE WITH A DECOY. `commerce` has a child `returns` and
 * a sibling `finance` that defines "Revenue" differently, shares perfect keys
 * with commerce, and has no export/import route. Scoping is tested here, not
 * assumed: what a pinned domain admits, what never joins, what never applies.
 */
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/dbt-first-commerce');
const manifest = buildManifest({ projectRoot: fixture, dbtManifestPath: join(fixture, 'target/manifest.json') });
const quote = (relation: string) => relation.split('.').map((part) => `"${part}"`).join('.');
const envelope = (activeDomain: string | null, purpose?: string) => resolveDomainContextEnvelope({ manifest, activeDomain, purpose, source: 'explicit_api' });
const tmp = mkdtempSync(join(tmpdir(), 'dql-multi-domain-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the fixture compiles the way the tests assume', () => {
  it('has a child domain, a sibling decoy, a stale certified relationship and two unexported drafts', () => {
    expect(manifest.modeling?.packages.returns).toMatchObject({ parent: 'commerce' });
    expect(manifest.modeling?.packages.finance).toBeDefined();
    const stale = manifest.modeling?.relationships['returns::relationship::return_to_reason'];
    expect(stale).toMatchObject({ status: 'certified', staleCertification: true, automaticJoinAllowed: false });
    expect(manifest.modeling?.relationships['returns::relationship::return_to_order']).toMatchObject({ status: 'draft', crossDomain: true, automaticJoinAllowed: false });
    expect(manifest.modeling?.relationships['finance::relationship::invoice_to_order']).toMatchObject({ status: 'draft', crossDomain: true, automaticJoinAllowed: false });
    expect(manifest.modeling?.relationships['growth::relationship::acquisition_to_customer']?.automaticJoinAllowed).toBe(true);
    expect(Object.values(manifest.terms).filter((term) => term.name === 'Revenue').map((term) => term.domain).sort()).toEqual(['commerce', 'finance']);
  });
});

describe('a pinned domain admits its descendants and excludes its siblings (CTX-008, CTX-010)', () => {
  const snapshot = buildMetadataSnapshot(tmp, manifest, undefined, loadSkills(fixture).skills);
  upsertMetadataSnapshot(tmp, snapshot);
  const eligible = (activeDomain: string | null, objectTypes: string[]) => {
    const catalog = openMetadataCatalog(tmp);
    try { return catalog.listEligibleObjects({ objectTypes, domains: domainContextSearchDomains(envelope(activeDomain)), payloadTypes: new Set(['dql_term']) }); } finally { catalog.close(); }
  };
  it('commerce sees returns and growth-imported customer identity, never finance', () => {
    const entities = eligible('commerce', ['dql_entity']).map((object) => object.objectKey);
    expect(entities.some((key) => key.includes('returns::entity::return'))).toBe(true);
    expect(entities.some((key) => key.includes('commerce::entity::order'))).toBe(true);
    expect(entities.some((key) => key.includes('finance::entity::invoice'))).toBe(false);
    const terms = eligible('commerce', ['dql_term']);
    const revenue = terms.filter((object) => object.name === 'Revenue');
    expect(revenue.map((object) => object.domain)).toEqual(['commerce']);
    expect(revenue[0]?.description).toContain('Order revenue');
  });
  it('finance sees its own Revenue and nothing of commerce; no pin sees everything', () => {
    const revenue = eligible('finance', ['dql_term']).filter((object) => object.name === 'Revenue');
    expect(revenue.map((object) => object.domain)).toEqual(['finance']);
    expect(revenue[0]?.description).toContain('Invoiced revenue');
    expect(eligible('finance', ['dql_entity']).some((object) => object.objectKey.includes('commerce::entity::order'))).toBe(false);
    expect(eligible(null, ['dql_term']).filter((object) => object.name === 'Revenue')).toHaveLength(2);
  });
});

describe('what never joins (REL-002 as amended)', () => {
  const graph = modelingJoinGraph(manifest, quote);
  it('a certified, validated relationship joins; a stale certification, a draft and a cross-domain inferred key never do', () => {
    expect(graph.path('growth.dim_customer_acquisition', 'commerce.dim_customers')?.[0]?.authority).toMatchObject({ authority: 'certified', scope: 'cross_domain_certified' });
    expect(graph.path('commerce.fct_returns', 'commerce.dim_return_reasons')).toBeUndefined();
    expect(graph.unproven('commerce.fct_returns', 'commerce.dim_return_reasons')[0]?.reason).toContain('stale');
    expect(graph.path('commerce.fct_returns', 'commerce.fct_orders')).toBeUndefined();
    expect(graph.path('finance.fct_invoices', 'commerce.fct_orders')).toBeUndefined();
    expect(graph.unproven('finance.fct_invoices', 'commerce.fct_orders')[0]).toMatchObject({ relationshipId: 'finance::relationship::invoice_to_order', status: 'draft' });
  });
  it('a warehouse proof is allowed only within one domain: a parent is not the child, a sibling is refused before any probe, an unmodeled relation is a gap', () => {
    expect(joinScopeDecision('commerce.fct_orders', 'commerce.dim_customers', graph.domainsOf('commerce.fct_orders'), graph.domainsOf('commerce.dim_customers'), graph.hasDomains)).toEqual({ scope: 'within_domain' });
    const child = joinScopeDecision('commerce.fct_returns', 'commerce.fct_orders', graph.domainsOf('commerce.fct_returns'), graph.domainsOf('commerce.fct_orders'), graph.hasDomains);
    expect(child).toMatchObject({ refusal: { code: 'join_requires_domain_contract' } });
    const sibling = joinScopeDecision('finance.fct_invoices', 'commerce.fct_orders', graph.domainsOf('finance.fct_invoices'), graph.domainsOf('commerce.fct_orders'), graph.hasDomains);
    expect(sibling).toMatchObject({ refusal: { code: 'join_requires_domain_contract' } });
    if ('refusal' in sibling) expect(sibling.refusal.message).toContain('certified export');
    expect(joinScopeDecision('commerce.fct_orders', 'commerce.unmodeled', graph.domainsOf('commerce.fct_orders'), graph.domainsOf('commerce.unmodeled'), graph.hasDomains)).toMatchObject({ refusal: { code: 'relationship_domain_unknown' } });
    expect(joinScopeDecision('a.x', 'a.y', [], [], false)).toEqual({ scope: 'no_domains' });
  });
});

describe('a skill applies only when selected, and its policy is enforced, not read (SKILL-004)', () => {
  const skills = loadSkills(fixture).skills;
  const finance = skills.find((skill) => skill.id === 'fiscal_reporting')!;
  const closed = skills.find((skill) => skill.id === 'closed_months')!;
  const base: VocabularySource = {
    metrics: [{ name: 'invoice_total', model: 'fct_invoices', label: 'Invoice total', aggregation: 'sum' }],
    dimensions: [{ name: 'is_test', model: 'fct_invoices', dataType: 'boolean' }, { name: 'invoice_date', model: 'fct_invoices', dataType: 'date', isTime: true, timeGrains: ['month'] }],
    terms: [{ name: 'Revenue', description: 'Invoiced revenue.', domain: 'finance' }],
  };
  const pack = (selected: typeof skills) => ({ objects: [], skills: selected as never[], appliedHints: [] });
  it('an unselected skill supplies no alias and no policy', () => {
    const projected = projectVocabularySource(base, pack([]));
    expect(projected.source.skills).toEqual([]);
    const vocabulary = buildVocabularyIndex(projected.source);
    expect(vocabulary.entries.filter((entry) => entry.kind === 'skill')).toEqual([]);
    const intent = { version: 1 as const, kind: 'analytics' as const, reading: 'invoiced revenue', measures: [{ ref: 'metric:fct_invoices.invoice_total' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar' as const, unresolved: [], provenance: {} };
    expect(applySkillPolicies(intent, vocabulary).applied).toEqual([]);
    expect(intent.filters).toEqual([]);
  });
  it('the selected finance skill binds its required filter and records its fiscal alignment; the commerce skill does not apply to finance', () => {
    const projected = projectVocabularySource(base, pack([finance]));
    expect(projected.source.skills?.map((skill) => skill.id)).toEqual(['fiscal_reporting']);
    const vocabulary = buildVocabularyIndex(projected.source);
    const intent = { version: 1 as const, kind: 'analytics' as const, reading: 'invoiced revenue', measures: [{ ref: 'metric:fct_invoices.invoice_total' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar' as const, unresolved: [], provenance: {} };
    const outcome = applySkillPolicies(intent, vocabulary, { now: () => Date.parse('2026-09-20T00:00:00Z') });
    expect(outcome.refusal).toBeUndefined();
    expect(intent.filters).toEqual([{ ref: 'dimension:fct_invoices.is_test', op: 'eq', values: [false], source: 'question' }]);
    expect(outcome.applied.some((effect) => effect.field === 'comparisonAlignment' && effect.effect.includes('fiscal_period'))).toBe(true);
    expect(outcome.applied.some((effect) => effect.field === 'calendarId')).toBe(true);
    const commerceOnly = projectVocabularySource(base, pack([closed]));
    const outcome2 = applySkillPolicies({ ...intent, filters: [] }, buildVocabularyIndex(commerceOnly.source), { now: () => Date.parse('2026-09-20T00:00:00Z') });
    expect(outcome2.requiredFilters).toEqual([]);
  });
});

describe('physical context follows the entity that binds it (A-003, item 3 of the NBA validation)', () => {
  const base = buildVocabularySource({ manifest });
  const relationKeys = (relations: NonNullable<VocabularySource['relations']>) => relations.map((relation) => `${relation.schema}.${relation.name}`).sort();
  it('every modeled entity\'s relation is a base relation carrying its owning domain, before any cube or probe', () => {
    const byKey = new Map((base.relations ?? []).map((relation) => [`${relation.schema}.${relation.name}`, relation]));
    expect(byKey.get('finance.fct_invoices')?.domain).toBe('finance');
    expect(byKey.get('commerce.fct_returns')?.domain).toBe('returns');
    expect(byKey.get('commerce.fct_orders')?.domain).toBe('commerce');
    expect(byKey.get('commerce.fct_orders')?.description).toContain('purchase');
  });
  it('a relation two domains bind is owned by both, whichever entity was compiled first', () => {
    const shared = (order: 'commerce-first' | 'finance-first') => {
      const entities = Object.fromEntries((order === 'commerce-first' ? ['commerce', 'finance'] : ['finance', 'commerce']).map((domain) => [`${domain}::entity::shared`, { id: `${domain}::entity::shared`, localId: 'shared', qualifiedId: `${domain}::entity::shared`, dbtUniqueId: 'model.pkg.shared_facts', domain, grain: 'row', keys: ['id'], sourcePath: 'entities.dql.yaml', identityFingerprint: 'shared' }]));
      const two = { modeling: { ...manifest.modeling, entities }, dbtProvenance: { nodes: { 'model.pkg.shared_facts': { relation: 'main.shared_facts' } } } } as unknown as DQLManifest;
      return buildVocabularySource({ manifest: two }).relations!.find((relation) => relation.name === 'shared_facts')!;
    };
    expect(shared('commerce-first').domains).toEqual(['commerce', 'finance']);
    expect(shared('finance-first').domains).toEqual(['commerce', 'finance']);
    const relations = [{ schema: 'main', name: 'shared_facts', columns: [], domain: 'finance', domains: ['commerce', 'finance'] }];
    for (const pin of ['commerce', 'finance'] as const) {
      const kept = projectVocabularySource({ relations }, { objects: [], skills: [], appliedHints: [] }, { own: [pin], imports: [] }).source.relations ?? [];
      expect(kept.map((relation) => relation.name)).toEqual(['shared_facts']);
    }
    expect(projectVocabularySource({ relations }, { objects: [], skills: [], appliedHints: [] }, { own: ['growth'], imports: [] }).source.relations).toEqual([]);
  });
  it('a pinned domain keeps its own relations, an import admits only the exported entity\'s relation, and a sibling\'s relations are not physical context here', () => {
    const scope = projectionScopeFor(envelope('growth', 'growth_attribution'), manifest)!;
    expect(scope.own).toEqual(['growth']);
    expect(scope.imports.map((item) => item.providerDomain)).toEqual(['commerce', 'commerce']);
    const projected = projectVocabularySource(base, { objects: [], skills: [], appliedHints: [] }, scope);
    const kept = relationKeys(projected.source.relations ?? []);
    expect(kept).toContain('growth.dim_customer_acquisition');
    expect(kept).toContain('commerce.dim_customers'); // exported as customer_identity
    expect(kept).toContain('commerce.fct_orders');    // exported as order_analytics
    expect(kept).not.toContain('commerce.fct_returns'); // returns exports nothing to growth
    expect(kept).not.toContain('finance.fct_invoices');
    expect(projected.dropped.relation).toBeGreaterThanOrEqual(2);
    // Pinned finance with no imports: finance only.
    const finance = projectVocabularySource(base, { objects: [], skills: [], appliedHints: [] }, projectionScopeFor(envelope('finance'), manifest));
    expect(relationKeys(finance.source.relations ?? [])).toEqual(['finance.fct_invoices']);
    // No pin: nothing is dropped.
    expect(projectVocabularySource(base, { objects: [], skills: [], appliedHints: [] }, projectionScopeFor(envelope(null), manifest)).dropped.relation).toBeUndefined();
  });
});
