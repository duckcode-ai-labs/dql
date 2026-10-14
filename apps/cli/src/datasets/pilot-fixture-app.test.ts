import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest } from '@zlens/core';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
let projectRoot: string | undefined;

afterEach(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  projectRoot = undefined;
});

/**
 * The committed commerce-pilot App is the M1 slice kept in git: two prepared
 * Datasets (block and semantic), field tiles, one shared filter bound to both,
 * a cross-filter mapping, and navigation to an order-line detail page that
 * carries the region filter. Its source revisions and contract fingerprints are
 * exact, so any edit to the Dataset block without rebinding the App fails here
 * as compile drift, which is the behaviour an author would see.
 */
describe('committed commerce-pilot App', () => {
  it('compiles into dataset tile lineage with no source drift', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-pilot-fixture-app-'));
    cpSync(fixtureRoot, projectRoot, { recursive: true });
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });

    const drift = (manifest.diagnostics ?? []).filter((diagnostic) => /APP_DATASET|drift/i.test(`${diagnostic.kind} ${diagnostic.message}`));
    expect(drift).toEqual([]);

    const overview = manifest.dashboards?.['commerce-pilot/overview'];
    const detail = manifest.dashboards?.['commerce-pilot/order-detail'];
    expect(overview?.datasetTiles?.map((tile) => tile.sourceKind).sort()).toEqual([
      'block_dataset', 'block_dataset', 'block_dataset', 'block_dataset', 'block_dataset', 'semantic_dataset',
    ]);
    expect(detail?.datasetTiles).toEqual([expect.objectContaining({ sourceKind: 'block_dataset' })]);

    for (const tile of overview?.datasetTiles ?? []) {
      const tileNode = `app_tile:commerce-pilot/overview:${tile.id}`;
      const sourceNode = `dataset_source:${tile.sourceFingerprint}`;
      expect(manifest.lineage.nodes.some((node) => node.id === tileNode)).toBe(true);
      expect(manifest.lineage.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: sourceNode, target: tileNode, type: 'feeds' }),
        expect.objectContaining({ source: tileNode, target: 'dashboard:commerce-pilot/overview', type: 'contains' }),
      ]));
    }
    const blockTile = overview?.datasetTiles?.find((tile) => tile.sourceKind === 'block_dataset');
    expect(manifest.lineage.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'block:Order lines Dataset', target: `dataset_source:${blockTile?.sourceFingerprint}`, type: 'contains' }),
    ]));
  });
});
