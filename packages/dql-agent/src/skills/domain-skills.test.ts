import { describe, expect, it } from 'vitest';
import { buildDomainReferenceSkills } from './domain-skills.js';
import type { DQLManifest } from '@zlens/core';

function manifest(): DQLManifest {
  return {
    domains: [{ name: 'sales' }, { name: 'growth' }],
    metrics: [
      { name: 'revenue', label: 'Revenue', domain: 'sales', description: 'Net revenue.' },
      { name: 'arr', label: 'ARR', domain: 'growth' },
    ],
    blocks: {
      a: { name: 'revenue_by_region', domain: 'sales', status: 'certified' },
      b: { name: 'draft_block', domain: 'sales', status: 'draft' },
    },
    terms: [
      { name: 'GMV', domain: 'sales', synonyms: ['gross merchandise value'], caveats: ['excludes returns'] },
    ],
  } as unknown as DQLManifest;
}

describe('buildDomainReferenceSkills (W4.5)', () => {
  it('drafts one reference skill per domain from the manifest', () => {
    const skills = buildDomainReferenceSkills(manifest());
    expect(skills.map((s) => s.id).sort()).toEqual(['domain-growth', 'domain-sales']);
  });

  it('includes the domain preferred metrics and certified blocks only', () => {
    const sales = buildDomainReferenceSkills(manifest()).find((s) => s.id === 'domain-sales')!;
    expect(sales.preferredMetrics).toEqual(['revenue']);
    expect(sales.preferredBlocks).toEqual(['revenue_by_region']); // draft_block excluded
    expect(sales.body).toContain('excludes returns'); // caveat surfaced as a gotcha
    expect(sales.body).toContain('`revenue`');
  });

  it('maps glossary terms + synonyms into the skill vocabulary', () => {
    const sales = buildDomainReferenceSkills(manifest()).find((s) => s.id === 'domain-sales')!;
    expect(sales.vocabulary).toEqual({ GMV: 'term:GMV', 'gross merchandise value': 'term:GMV' });
    expect(sales.isStarter).toBe(true);
  });
});
