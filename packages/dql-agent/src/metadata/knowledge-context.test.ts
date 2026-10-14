import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '@zlens/core';
import { resolveDomainContextEnvelope } from '../domain-context.js';
import { materializeKnowledgeLensSkills } from '../answer-loop.js';
import { loadSkills } from '../skills/loader.js';
import { activeMetadataSnapshotPath, buildLocalContextPack, readIndexedDomainKnowledge } from './catalog.js';

const sourceFixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/cli/test/fixtures/dbt-first-commerce',
);

describe('canonical knowledge graph context projection (CTX-006 / SKILL-003 / REL-003)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-knowledge-context-'));
    cpSync(sourceFixture, projectRoot, {
      recursive: true,
      filter: (source) => !source.includes(`${join(sourceFixture, '.dql')}`),
    });
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('uses one snapshot for the capsule, pinned skill, and governed route state', async () => {
    const dbtManifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = buildManifest({ projectRoot, dbtManifestPath });
    const domainContext = resolveDomainContextEnvelope({
      manifest,
      activeDomain: 'growth',
      purpose: 'growth_attribution',
      skillRefs: ['growth::skill::acquisition_analysis'],
      source: 'explicit_api',
      snapshotId: 'snapshot-test',
    });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show acquisition channel performance',
      domainContext,
    });

    expect(pack.knowledgeLens).toMatchObject({
      mode: 'pinned',
      activeDomainId: 'growth',
      snapshotId: pack.freshness.fingerprint,
      skillRefs: ['growth::skill::acquisition_analysis'],
      capsuleFingerprint: expect.any(String),
      skillFingerprints: { 'growth::skill::acquisition_analysis': expect.any(String) },
    });
    expect(pack.knowledgeLens.snapshotId).not.toBe('snapshot-test');
    expect(pack.skills.map((skill) => skill.qualifiedId)).toContain('growth::skill::acquisition_analysis');
    const materialized = materializeKnowledgeLensSkills(
      pack,
      loadSkills(projectRoot).skills.map((skill) => ({ ...skill, body: 'newer mutable disk body' })),
    );
    expect(materialized.map((skill) => skill.qualifiedId)).toEqual(pack.knowledgeLens.skillRefs);
    expect(materialized[0]?.body).toBe(pack.skills[0]?.guidance);
    expect(materialized[0]?.body).not.toBe('newer mutable disk body');
    expect(pack.objects.filter((object) => object.objectType === 'cross_domain_route')).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: 'growth', status: 'authorized' }),
      expect.objectContaining({ domain: 'growth', status: 'blocked' }),
    ]));
    const snapshotPath = activeMetadataSnapshotPath(projectRoot);
    expect(snapshotPath).toBeTruthy();
    expect(existsSync(snapshotPath!)).toBe(true);
    const indexed = readIndexedDomainKnowledge(projectRoot, 'growth');
    expect(indexed).toMatchObject({
      schemaVersion: 2,
      domainId: 'growth',
      counts: { routeStates: { authorized: 1, blocked: 1 } },
      capsule: { skillRefs: ['growth::skill::acquisition_analysis'] },
    });
    expect(indexed?.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'growth::relationship::acquisition_to_customer',
        kind: 'relationship',
        payload: expect.objectContaining({ automaticJoinAllowed: true }),
      }),
    ]));
    expect(indexed?.edges.some((edge) => edge.kind === 'proves_join')).toBe(true);
    expect(indexed?.objects.some((object) => object.id === 'Growth')).toBe(false);
    expect(indexed?.objects.some((object) => object.id === 'Growth Revenue')).toBe(false);
  });
});
