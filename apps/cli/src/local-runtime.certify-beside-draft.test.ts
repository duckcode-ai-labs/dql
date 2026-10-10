import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalForDraftBeside,
  deleteBlockStudioArtifacts,
  draftBesideCanonical,
  nameDraftEditBesideCertified,
  saveBlockStudioArtifacts,
  saveBlockStudioDraftArtifacts,
  stripDraftEditName,
} from './local-runtime.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const CERTIFIED_PATH = 'domains/claims/blocks/open-claims-by-region.dql';
const certifiedSource = 'block "Open claims by region" {\n  status = "certified"\n  domain = "claims"\n  type = "custom"\n  query = """SELECT 1 AS open_claims"""\n}\n';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-certify-beside-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'beside' }));
  mkdirSync(join(root, 'domains/claims/blocks'), { recursive: true });
  writeFileSync(join(root, CERTIFIED_PATH), certifiedSource);
  return root;
}

function blockFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(dir, entry.name));
      else if (entry.name.endsWith('.dql')) out.push(join(dir, entry.name));
    }
  };
  visit(join(root, 'domains'));
  return out;
}

describe('certifying a copy saved beside a certified block', () => {
  it('finds the certified file again from the copy\'s path', () => {
    const root = project();
    const { stableSuffix } = draftBesideCanonical(root, CERTIFIED_PATH);
    const draftPath = saveBlockStudioDraftArtifacts(root, {
      source: nameDraftEditBesideCertified(certifiedSource.replace('"certified"', '"draft"').replace('SELECT 1', 'SELECT 2')),
      name: 'Open claims by region',
      domain: 'claims',
      stableSuffix,
    });
    expect(canonicalForDraftBeside(root, draftPath)).toBe(CERTIFIED_PATH);
  });

  it('does not resolve an ordinary draft, or a copy whose certified file is gone', () => {
    const root = project();
    const plain = saveBlockStudioDraftArtifacts(root, { source: 'block "Other" {\n  status = "draft"\n  domain = "claims"\n}\n', name: 'Other', domain: 'claims', stableSuffix: 'cand123' });
    expect(canonicalForDraftBeside(root, plain)).toBeUndefined();
    const { stableSuffix } = draftBesideCanonical(root, CERTIFIED_PATH);
    const draftPath = saveBlockStudioDraftArtifacts(root, { source: nameDraftEditBesideCertified(certifiedSource), name: 'Open claims by region', domain: 'claims', stableSuffix });
    rmSync(join(root, CERTIFIED_PATH));
    expect(canonicalForDraftBeside(root, draftPath)).toBeUndefined();
  });

  it('removes the marker and leaves one certified block with its original name', () => {
    const root = project();
    const { stableSuffix } = draftBesideCanonical(root, CERTIFIED_PATH);
    const draftSource = nameDraftEditBesideCertified(certifiedSource.replace('"certified"', '"draft"').replace('SELECT 1', 'SELECT 2'));
    const draftPath = saveBlockStudioDraftArtifacts(root, { source: draftSource, name: 'Open claims by region', domain: 'claims', stableSuffix });
    expect(blockFiles(root)).toHaveLength(2);

    // The publish step of POST /api/block-studio/certifications.
    const canonical = canonicalForDraftBeside(root, draftPath)!;
    const published = stripDraftEditName(draftSource.replace('"draft"', '"certified"'));
    expect(published).toContain('block "Open claims by region" {');
    const savedPath = saveBlockStudioArtifacts(root, { currentPath: canonical, source: published, name: 'Open claims by region', domain: 'claims' });
    deleteBlockStudioArtifacts(root, draftPath);

    expect(savedPath).toBe(CERTIFIED_PATH);
    expect(existsSync(join(root, draftPath))).toBe(false);
    expect(blockFiles(root)).toEqual([join(root, CERTIFIED_PATH)]);
    const onDisk = readFileSync(join(root, CERTIFIED_PATH), 'utf-8');
    expect(onDisk).toContain('SELECT 2');
    expect(onDisk).not.toContain('(draft edit)');
  });
});
