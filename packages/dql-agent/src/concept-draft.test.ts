import { describe, expect, it } from 'vitest';
import type { DQLManifest } from '@zlens/core';
import { conceptDraftFromEvidence } from './concept-draft.js';

const entity = (localId: string, domain: string, keys: string[], grain?: string) => ({ id: `${domain}::entity::${localId}`, localId, qualifiedId: `${domain}::entity::${localId}`, domain, dbtUniqueId: `model.${domain}.${localId}`, keys, grain, sourcePath: 'x', identityFingerprint: localId });
const manifest = (over: Record<string, unknown> = {}) => ({
  manifestVersion: 3,
  terms: { Customer: { name: 'Customer', description: 'A person who bought from us.', identifiers: ['customer_id'], synonyms: ['buyer'] } },
  modeling: {
    mode: 'dbt-first', packages: {}, areas: {}, contracts: {}, conformance: {}, rules: {}, domainLineage: [],
    entities: {
      'commerce::entity::customer': entity('customer', 'commerce', ['customer_id'], 'customer_id'),
      'commerce::entity::order': entity('order', 'commerce', ['customer_id'], 'order_id'),
      'growth::entity::acquisition': entity('acquisition', 'growth', ['customer_id'], 'customer_id'),
      'finance::entity::invoice': entity('invoice', 'finance', ['customer_id'], 'invoice_id'),
    },
    relationships: {},
    interfaces: {
      exports: { 'commerce::export::customer_identity': { qualifiedId: 'commerce::export::customer_identity', domain: 'commerce', entity: 'customer' } },
      imports: { 'growth::import::customer_identity': { qualifiedId: 'growth::import::customer_identity', domain: 'growth', exportRef: 'commerce.customer_identity@1' } },
    },
    ...over,
  },
} as unknown as DQLManifest);

describe('a concept is drafted from evidence, on demand, never in bulk', () => {
  it('proposes one draft per shared key, canonical at the key grain, cross-domain only under a certified route, named by the term that identifies the key', () => {
    const drafts = conceptDraftFromEvidence({ manifest: manifest() });
    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft.kind).toBe('modeling_change');
    expect(draft.change.operation).toBe('upsert_concept');
    const value = draft.change.value as { id: string; domain: string; name: string; bindings: Array<{ entity: string; role: string }>; status: string; origin: string; synonyms?: string[] };
    expect(value).toMatchObject({ id: 'customer', domain: 'commerce', name: 'Customer', status: 'draft', origin: 'ai_draft', synonyms: ['buyer'] });
    // finance has no route to commerce, so invoice is not bound; growth does.
    expect(value.bindings).toEqual([
      { entity: 'customer', role: 'canonical', grain: 'customer_id' },
      { entity: 'order', role: 'conformed', grain: 'order_id' },
      { entity: 'growth:acquisition', role: 'conformed', grain: 'customer_id' },
    ]);
    expect(draft.evidence).toEqual(expect.arrayContaining([expect.stringContaining('shared key customer_id'), 'export commerce::export::customer_identity', 'import growth::import::customer_identity', 'term Customer identifies customer_id', expect.stringContaining('finance::entity::invoice left out')]));
  });
  it('a cross-domain pair with no certified route is not drafted, and an entity already bound to a concept is left alone', () => {
    const noRoute = manifest({ interfaces: { exports: {}, imports: {} } });
    // commerce still has two same-domain entities sharing customer_id; growth and finance are left out and the evidence says why.
    const [draft] = conceptDraftFromEvidence({ manifest: noRoute });
    expect((draft!.change.value as { bindings: Array<{ entity: string }> }).bindings.map((binding) => binding.entity)).toEqual(['customer', 'order']);
    expect(draft!.evidence).toEqual(expect.arrayContaining([expect.stringContaining('growth::entity::acquisition left out: no certified route')]));
    const bound = manifest({ concepts: { 'commerce::concept::customer': { bindings: [{ entity: 'commerce::entity::customer' }, { entity: 'commerce::entity::order' }, { entity: 'growth::entity::acquisition' }] } } });
    expect(conceptDraftFromEvidence({ manifest: bound })).toEqual([]);
  });
  it('a focus narrows the draft to the entities a gap named', () => {
    const drafts = conceptDraftFromEvidence({ manifest: manifest(), focusEntities: ['customer', 'order'] });
    expect((drafts[0]!.change.value as { bindings: unknown[] }).bindings).toHaveLength(2);
  });
});
