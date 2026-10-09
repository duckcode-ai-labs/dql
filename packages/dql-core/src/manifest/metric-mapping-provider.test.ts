import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from './builder.js';

const block = (outputs: string) => `block "Open Claims by Region" {
  domain = "claims"
  type = "custom"
  status = "certified"
${outputs}
  metricMappings {
    open_claims {
      metric = "claim_count"
      filter = "status = 'open'"
    }
  }
  query = """WITH c AS (SELECT * FROM claims WHERE status = 'open') SELECT region, COUNT(DISTINCT claim_id) AS open_claims FROM c GROUP BY region"""
}`;

describe('metricMappings with an external semantic provider', () => {
  let projectRoot: string;
  const errors = (config: object) => {
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'mapping', ...config }));
    return (buildManifest({ projectRoot, dqlVersion: 'test' }).diagnostics ?? []).filter((d) => d.severity === 'error' && /metricMappings/.test(d.message)).map((d) => d.message).join(' ');
  };

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-metric-mapping-provider-'));
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('a dbt-provider project does not fail a mapping for a metric it cannot load here', () => {
    writeFileSync(join(projectRoot, 'blocks', 'open_claims.dql'), block('  outputs = ["region", "open_claims"]'));
    expect(errors({ semanticLayer: { provider: 'dbt' } })).toBe('');
  });

  it('a dbt-first project does not fail it either', () => {
    writeFileSync(join(projectRoot, 'blocks', 'open_claims.dql'), block('  outputs = ["region", "open_claims"]'));
    expect(errors({ modeling: { mode: 'dbt-first' } })).toBe('');
  });

  it('the native provider still fails a mapping to a metric that does not exist', () => {
    writeFileSync(join(projectRoot, 'blocks', 'open_claims.dql'), block('  outputs = ["region", "open_claims"]'));
    expect(errors({ semanticLayer: { provider: 'dql' } })).toMatch(/which is not in the semantic layer/);
  });

  it('a mapped block with no declared outputs fails compile', () => {
    writeFileSync(join(projectRoot, 'blocks', 'open_claims.dql'), block(''));
    expect(errors({ semanticLayer: { provider: 'dbt' } })).toMatch(/must declare its outputs/);
  });
});
