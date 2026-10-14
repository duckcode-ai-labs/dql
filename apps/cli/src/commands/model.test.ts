import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runModel } from './model.js';

const baseFlags = {
  format: 'text' as const,
  verbose: false,
  help: false,
  version: false,
  check: false,
  open: null,
  input: '',
  outDir: '',
  port: null,
  host: null,
  chart: '',
  domain: '',
  owner: '',
  queryOnly: false,
  template: '',
  connection: '',
  skipTests: false,
};

describe('zlens model discovery commands (AGT-002, API-001)', () => {
  let projectRoot: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-model-discover-'));
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'demo', manifestVersion: 3, modeling: { mode: 'dbt-first' },
    }));
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'demo' },
      nodes: {
        'model.demo.orders': {
          resource_type: 'model', name: 'orders', alias: 'orders',
          original_file_path: 'models/commerce/orders.sql',
          meta: { dql: { domain: 'commerce' } },
          tags: [], depends_on: { nodes: [] },
        },
      },
      sources: {}, exposures: {}, semantic_models: {}, groups: {},
    }, null, 2));
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = 0;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('prints machine-readable discovery without writing project files', async () => {
    const before = projectFiles(projectRoot);
    await runModel('discover', [projectRoot], { ...baseFlags, format: 'json' });
    const output = JSON.parse(String(log.mock.calls[0]?.[0]));

    expect(output).toMatchObject({
      version: 1,
      generator: 'deterministic',
      proposals: [{ id: 'commerce', matchedDbtUniqueIds: ['model.demo.orders'] }],
      memberships: [{ dbtUniqueId: 'model.demo.orders', proposedDomain: 'commerce' }],
    });
    expect(projectFiles(projectRoot)).toEqual(before);
    expect(existsSync(join(projectRoot, 'domains'))).toBe(false);
  });

  it('renders a concise human preview with explicit draft trust state', async () => {
    await runModel('discover', [projectRoot], baseFlags);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('deterministic, draft only');
    expect(output).toContain('commerce: 1 models');
    expect(output).toContain('none are certified');
  });

  it('keeps apply-discovery preview-only unless --apply is explicit', async () => {
    await runModel('apply-discovery', [projectRoot], { ...baseFlags, domain: 'commerce' });
    expect(existsSync(join(projectRoot, 'domains'))).toBe(false);
    expect(log.mock.calls.flat().join('\n')).toContain('No files written');
  });

  it('writes only a sparse domain boundary when apply is explicit', async () => {
    await runModel('apply-discovery', [projectRoot], { ...baseFlags, domain: 'commerce', apply: true });
    const declaration = readFileSync(join(projectRoot, 'domains', 'commerce', 'domain.dql'), 'utf8');
    expect(declaration).toContain('id = "commerce"');
    expect(declaration).toContain('dbtPaths = ["models/commerce/orders.sql"]');
    expect(declaration).not.toContain('column');
    expect(declaration).not.toContain('certified');
    expect(log.mock.calls.flat().join('\n')).toContain('review-only drafts');
  });

  it('returns a stable code when the dbt manifest is missing', async () => {
    rmSync(join(projectRoot, 'target', 'manifest.json'));
    await runModel('discover', [projectRoot], { ...baseFlags, format: 'json' });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      code: 'DBT_MANIFEST_MISSING', recoverable: true,
    });
    expect(process.exitCode).toBe(1);
  });
});

function projectFiles(root: string): Array<{ path: string; content: string }> {
  const output: Array<{ path: string; content: string }> = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else output.push({ path: relative(root, path), content: readFileSync(path, 'utf8') });
    }
  };
  visit(root);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}
