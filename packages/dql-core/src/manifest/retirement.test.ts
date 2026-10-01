import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../parser/parser.js';
import { NodeKind } from '../ast/nodes.js';
import { formatDQL } from '../formatter/formatter.js';
import { buildManifest } from './builder.js';
import { resolveBlockReference, resolveBlockReplacement, retirementNotice } from './retirement.js';
import { LineageGraph } from '../lineage/lineage-graph.js';
import { queryLineage } from '../lineage/query.js';

const RETIRED = `block "Claims Summary" {
  domain = "claims"
  type = "custom"
  status = "deprecated"
  replacedBy = "Claims Dataset"
  deprecatedOn = "2026-09-30"
  description = "Old claims rollup"
  query = """SELECT 1 AS claims"""
}`;

const ACTIVE = `block "Claims Dataset" {
  domain = "claims"
  type = "custom"
  status = "certified"
  query = """SELECT 1 AS claims"""
}`;

describe('replacedBy / deprecatedOn grammar', () => {
  it('parses the retirement fields onto the block', () => {
    const ast = parse(RETIRED);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind !== NodeKind.BlockDecl) return;
    expect(block.status).toBe('deprecated');
    expect(block.replacedBy).toBe('Claims Dataset');
    expect(block.deprecatedOn).toBe('2026-09-30');
  });

  it('formats the fields after status and round-trips idempotently', () => {
    const compact = RETIRED.replace(/\n\s*/g, ' ');
    const formatted = formatDQL(compact);
    expect(formatted).toContain('  status = "deprecated"\n  replacedBy = "Claims Dataset"\n  deprecatedOn = "2026-09-30"\n');
    expect(formatDQL(formatted)).toBe(formatted);
    const reparsed = parse(formatted).statements[0];
    if (reparsed.kind !== NodeKind.BlockDecl) throw new Error('expected block');
    expect(reparsed.replacedBy).toBe('Claims Dataset');
    expect(reparsed.deprecatedOn).toBe('2026-09-30');
  });
});

describe('block reference resolution', () => {
  const blocks = [
    { name: 'Claims Dataset', filePath: 'blocks/claims/claims_dataset.dql', status: 'certified' },
    { name: 'Claims Summary', filePath: 'blocks/claims/summary.dql', status: 'deprecated', replacedBy: 'Claims Interim' },
    { name: 'Claims Interim', filePath: 'blocks/claims/interim.dql', status: 'deprecated', replacedBy: 'blocks/claims/claims_dataset.dql' },
    { name: 'Loop A', status: 'deprecated', replacedBy: 'Loop B' },
    { name: 'Loop B', status: 'deprecated', replacedBy: 'Loop A' },
  ];

  it('resolves by name, case-insensitive name, and project-relative path', () => {
    expect(resolveBlockReference(blocks, 'Claims Dataset')?.name).toBe('Claims Dataset');
    expect(resolveBlockReference(blocks, 'claims dataset')?.name).toBe('Claims Dataset');
    expect(resolveBlockReference(blocks, './blocks/claims/claims_dataset.dql')?.name).toBe('Claims Dataset');
    expect(resolveBlockReference(blocks, 'blocks/claims/claims_dataset')?.name).toBe('Claims Dataset');
    expect(resolveBlockReference(blocks, 'Missing')).toBeUndefined();
  });

  it('follows a chain to the first active block and refuses cycles', () => {
    const summary = blocks[1];
    const chain = resolveBlockReplacement(blocks, summary)!;
    expect(chain.replacement?.name).toBe('Claims Dataset');
    expect(chain.chain.map((b) => b.name)).toEqual(['Claims Summary', 'Claims Interim']);
    expect(chain.cycle).toBe(false);

    const loop = resolveBlockReplacement(blocks, blocks[3])!;
    expect(loop.cycle).toBe(true);
    expect(loop.replacement).toBeUndefined();

    expect(resolveBlockReplacement(blocks, blocks[0])).toBeUndefined();
    expect(retirementNotice({ name: 'Claims Summary', deprecatedOn: '2026-09-30' }, blocks[0]))
      .toBe('Claims Summary was retired on 2026-09-30; use Claims Dataset instead.');
  });
});

describe('buildManifest retirement checks', () => {
  let projectRoot: string;

  function write(rel: string, body: string): void {
    const path = join(projectRoot, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body, 'utf-8');
  }

  function retirementDiagnostics() {
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    return {
      manifest,
      diagnostics: (manifest.diagnostics ?? []).filter((d) => d.kind === 'retirement'),
    };
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-retirement-'));
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'retirement' }));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('carries the fields into the manifest and links old → new in lineage', () => {
    write('blocks/claims_summary.dql', RETIRED);
    write('blocks/claims_dataset.dql', ACTIVE);
    const { manifest, diagnostics } = retirementDiagnostics();

    expect(diagnostics).toEqual([]);
    expect(manifest.blocks['Claims Summary']).toMatchObject({
      status: 'deprecated',
      replacedBy: 'Claims Dataset',
      deprecatedOn: '2026-09-30',
    });
    const edge = manifest.lineage.edges.find((e) => e.type === 'replaced_by');
    expect(edge).toMatchObject({
      source: 'block:Claims Summary',
      target: 'block:Claims Dataset',
    });

    // Not a data-flow edge: the replacement is not "downstream" of the old block.
    const graph = LineageGraph.fromJSON(manifest.lineage);
    expect(graph.descendants('block:Claims Summary').map((n) => n.id)).not.toContain('block:Claims Dataset');

    // Focused lineage shows both, and the replacement history names it.
    const result = queryLineage(graph, { focus: 'Claims Summary' });
    expect(result.graph.nodes.map((n) => n.id)).toContain('block:Claims Dataset');
    expect(result.graph.edges.some((e) => e.type === 'replaced_by')).toBe(true);
  });

  it('refuses a missing replacement and a cycle, warns on chains and non-deprecated use', () => {
    write('blocks/a.dql', `block "A" { type = "custom" status = "deprecated" replacedBy = "Nowhere" query = """SELECT 1""" }`);
    write('blocks/b.dql', `block "B" { type = "custom" status = "deprecated" replacedBy = "C" query = """SELECT 1""" }`);
    write('blocks/c.dql', `block "C" { type = "custom" status = "deprecated" replacedBy = "B" query = """SELECT 1""" }`);
    write('blocks/d.dql', `block "D" { type = "custom" status = "deprecated" replacedBy = "E" query = """SELECT 1""" }`);
    write('blocks/e.dql', `block "E" { type = "custom" status = "deprecated" replacedBy = "F" query = """SELECT 1""" }`);
    write('blocks/f.dql', `block "F" { type = "custom" status = "certified" query = """SELECT 1""" }`);
    write('blocks/g.dql', `block "G" { type = "custom" status = "certified" replacedBy = "F" deprecatedOn = "2026-01-01" query = """SELECT 1""" }`);
    const { diagnostics } = retirementDiagnostics();
    const messages = diagnostics.map((d) => `${d.severity}: ${d.message}`);

    expect(messages).toContainEqual(expect.stringMatching(/^error: Block "A" is replaced by "Nowhere", which is not a block/));
    expect(messages).toContainEqual(expect.stringMatching(/^error: Block "B" is part of a replacement cycle/));
    expect(messages).toContainEqual(expect.stringMatching(/^error: Block "C" is part of a replacement cycle/));
    expect(messages).toContainEqual(expect.stringMatching(/^warning: Block "D" is replaced by "E", which is itself deprecated; DQL follows the chain to "F"/));
    expect(messages).toContainEqual(expect.stringMatching(/^warning: Block "G" sets replacedBy and deprecatedOn but its status is "certified"/));
    expect(messages.some((m) => m.includes('Block "E"'))).toBe(false);
  });

  it('warns when blocks and App pages still use a deprecated block', () => {
    write('blocks/claims_summary.dql', RETIRED);
    write('blocks/claims_dataset.dql', ACTIVE);
    write('blocks/claims_by_region.dql', `block "Claims By Region" {
  type = "custom"
  query = """SELECT * FROM ref("Claims Summary")"""
}`);
    const appDir = join(projectRoot, 'apps', 'claims-ops');
    write('apps/claims-ops/dql.app.json', JSON.stringify({
      version: 1,
      id: 'claims-ops',
      name: 'Claims Ops',
      domain: 'claims',
      owners: ['a@example.com'],
      members: [{ userId: 'a@example.com', roles: ['owner'] }],
      roles: [{ id: 'owner' }],
      policies: [],
    }));
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });
    write('apps/claims-ops/dashboards/overview.dqld', JSON.stringify({
      version: 1,
      id: 'overview',
      metadata: { title: 'Overview', domain: 'claims' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{ i: 'kpi', x: 0, y: 0, w: 3, h: 2, block: { blockId: 'Claims Summary' }, viz: { type: 'single_value' } }],
      },
    }));

    const { diagnostics } = retirementDiagnostics();
    const messages = diagnostics.map((d) => d.message);
    expect(messages).toContain('Block "Claims By Region" still references deprecated block "Claims Summary". Use "Claims Dataset" instead.');
    expect(messages).toContain('App page "claims-ops/overview" still uses deprecated block "Claims Summary". Use "Claims Dataset" instead.');
    expect(diagnostics.every((d) => d.severity === 'warning')).toBe(true);
  });
});
