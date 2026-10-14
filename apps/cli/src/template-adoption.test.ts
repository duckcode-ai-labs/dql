import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, buildManifest, parse } from '@zlens/core';
import { Certifier } from '@zlens/governance';
import type { BlockRecord, TestResultSummary } from '@zlens/project';

const repoRoot = resolve(process.cwd(), '../..');
const templatesRoot = join(repoRoot, 'packages/create-dql-app/templates');
const fixturesRoot = resolve(process.cwd(), 'test/fixtures');
const lineageFixture = join(fixturesRoot, 'lineage-app');

function collectFiles(dir: string, predicate: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) collectFiles(abs, predicate, out);
    else if (predicate(abs)) out.push(abs);
  }
  return out;
}

function copyProject(src: string, name: string): { root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), `dql-${name}-`));
  const root = join(base, name);
  cpSync(src, root, { recursive: true });
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('OSS adoption templates and fixtures', () => {
  it('all template and fixture .dql files parse and analyze with canonical block syntax', () => {
    const dqlFiles = [
      ...collectFiles(templatesRoot, (path) => path.endsWith('.dql')),
      ...collectFiles(fixturesRoot, (path) => path.endsWith('.dql')),
    ];
    expect(dqlFiles.length).toBeGreaterThan(0);

    for (const filePath of dqlFiles) {
      const source = readFileSync(filePath, 'utf-8');
      expect(source, `${filePath} should not use block-level lifecycle`).not.toMatch(/\blifecycle\s*=/);
      const ast = parse(source, filePath);
      const diagnostics = analyze(ast);
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      expect(errors, `${filePath} should parse/analyze cleanly`).toEqual([]);
    }
  });

  it('fixture project compiles source-to-block-to-dashboard-to-App lineage', () => {
    const { root, cleanup } = copyProject(lineageFixture, 'lineage-app');
    try {
      const manifest = buildManifest({ projectRoot: root, dqlVersion: '1.6.1' });
      const nodeTypes = new Set(manifest.lineage.nodes.map((node) => node.type));

      expect(Object.keys(manifest.blocks).length).toBeGreaterThan(0);
      expect(Object.keys(manifest.apps ?? {}).length).toBeGreaterThan(0);
      expect(Object.keys(manifest.dashboards ?? {}).length).toBeGreaterThan(0);
      expect(nodeTypes.has('source_table')).toBe(true);
      expect(nodeTypes.has('term')).toBe(true);
      expect(nodeTypes.has('block')).toBe(true);
      expect(nodeTypes.has('dashboard')).toBe(true);
      expect(nodeTypes.has('app')).toBe(true);

      expect(manifest.terms['Card Approval Rate']).toMatchObject({ domain: 'cards', termType: 'metric' });
      expect(manifest.lineage.edges.some((edge) => edge.type === 'defines' && edge.source === 'term:Card Approval Rate' && edge.target === 'block:card_approval_rate')).toBe(true);
      expect(manifest.lineage.edges.some((edge) => edge.type === 'reads_from' && edge.target.startsWith('block:'))).toBe(true);
      expect(manifest.lineage.edges.some((edge) => edge.type === 'contains' && edge.source.startsWith('block:') && edge.target.startsWith('dashboard:'))).toBe(true);
      expect(manifest.lineage.edges.some((edge) => edge.type === 'contains' && edge.source.startsWith('dashboard:') && edge.target.startsWith('app:'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('fixture card approval block is certifiable with passing local test results', () => {
    const filePath = join(lineageFixture, 'blocks/card_approval_rate.dql');
    const source = readFileSync(filePath, 'utf-8');
    const ast = parse(source, filePath);
    const block = ast.statements.find((statement: any) => statement.kind === 'BlockDecl') as any;
    expect(block).toBeTruthy();

    const record: BlockRecord = {
      id: 'block:card_approval_rate',
      name: block.name,
      domain: block.domain,
      type: block.blockType,
      version: '1.0.0',
      status: block.status,
      gitRepo: '',
      gitPath: 'blocks/card_approval_rate.dql',
      gitCommitSha: '',
      description: block.description,
      owner: block.owner,
      tags: block.tags ?? [],
      dependencies: [],
      usedInCount: 1,
      llmContext: block.llmContext,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const testResults: TestResultSummary = {
      passed: 1,
      failed: 0,
      skipped: 0,
      duration: 1,
      assertions: [{ name: 'assert row_count == 1', passed: true, actual: 1 }],
      runAt: new Date(),
    };

    const result = new Certifier().evaluate(record, testResults);
    expect(result.certified).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
