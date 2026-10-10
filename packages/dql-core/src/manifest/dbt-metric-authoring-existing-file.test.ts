import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDbtMetricPatch, previewDbtMetricPatch, type DbtMetricAuthoringInput } from './dbt-metric-authoring.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// A new semantic model is written to <dir>/<name>_semantic.yml. When a file is already there that the scan could not
// load, it must be refused, never overwritten.
function projectWithUnreadableFile(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'dql-dbt-metric-existing-'));
  roots.push(root);
  mkdirSync(join(root, 'models', 'claims'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'dbt_project.yml'), 'name: harbor\nversion: 1\n');
  writeFileSync(join(root, 'models', 'claims', 'claims.sql'), 'select 1 as claim_id');
  writeFileSync(join(root, 'models', 'claims', 'claims_semantic.yml'), content);
  const manifestPath = join(root, 'target', 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    nodes: { 'model.harbor.claims': { unique_id: 'model.harbor.claims', resource_type: 'model', name: 'claims', original_file_path: 'models/claims/claims.sql', columns: { claim_id: { name: 'claim_id' }, claimed_amount: { name: 'claimed_amount' }, reported_date: { name: 'reported_date' } } } },
    sources: {}, metrics: {}, semantic_models: {}, child_map: {},
  }));
  return { root, manifestPath, file: join(root, 'models', 'claims', 'claims_semantic.yml') };
}

const createClaims: DbtMetricAuthoringInput = {
  mode: 'add',
  semanticModel: 'claims',
  modelUniqueId: 'model.harbor.claims',
  primaryEntity: { name: 'claim', column: 'claim_id' },
  timeDimension: { name: 'reported_date', column: 'reported_date' },
  metric: { name: 'average_claimed_amount', aggregation: 'average', column: 'claimed_amount' },
};

describe('dbt metric authoring never overwrites a file it could not read', () => {
  it('refuses to create a semantic model over an unparsable YAML file and leaves it untouched', () => {
    const content = 'semantic_models:\n  - name: claims\n    bad: [unclosed\n';
    const { root, manifestPath, file } = projectWithUnreadableFile(content);
    expect(() => previewDbtMetricPatch(root, manifestPath, createClaims)).toThrow(/models\/claims\/claims_semantic\.yml already exists.*will not overwrite/);
    expect(() => applyDbtMetricPatch(root, manifestPath, createClaims, 'any')).toThrow(/will not overwrite/);
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  it('refuses over a YAML file too large to scan', () => {
    const content = `# ${'x'.repeat(2_000_100)}\nsemantic_models: []\n`;
    const { root, manifestPath, file } = projectWithUnreadableFile(content);
    expect(() => previewDbtMetricPatch(root, manifestPath, createClaims)).toThrow(/will not overwrite/);
    expect(readFileSync(file, 'utf8')).toBe(content);
  });
});
