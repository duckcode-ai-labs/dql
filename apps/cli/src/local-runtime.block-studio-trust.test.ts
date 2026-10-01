import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from './local-runtime.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const currentPath = 'domains/finance/blocks/revenue.dql';
const certifiedSource = `block "Revenue" {
  status = "certified"
  domain = "finance"
  type = "custom"
  description = "Revenue."
  owner = "analytics"
  query = """SELECT 1 AS value"""
  tests {
    assert row_count > 10
  }
}`;
const metadata = { name: 'Revenue', path: currentPath, domain: 'finance', description: 'Revenue.', owner: 'analytics', tags: [], reviewStatus: 'certified' };

async function withProject(run: (base: string, projectRoot: string) => Promise<void>): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-trust-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'block_trust' }));
  mkdirSync(join(projectRoot, 'domains/finance/blocks'), { recursive: true });
  writeFileSync(join(projectRoot, currentPath), `${certifiedSource}\n`);
  const executor = {
    executeQuery: vi.fn(async () => ({ columns: ['value'], rows: [{ value: 1 }], rowCount: 1, executionTime: 1 })),
  } as unknown as QueryExecutor;
  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor,
      connection: { driver: 'file' },
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    await run(`http://127.0.0.1:${port}`, projectRoot);
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  }
}

async function waitForOperation(base: string, operationId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = await fetch(`${base}/api/operations/${encodeURIComponent(operationId)}`).then((response) => response.json()) as Record<string, unknown>;
    if (!['queued', 'running'].includes(String(operation.status))) return operation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Operation ${operationId} did not finish.`);
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const draftsIn = (projectRoot: string) => {
  const dir = join(projectRoot, 'domains/finance/blocks/_drafts');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.dql')) : [];
};

describe('Block Studio keeps a certified block certified until a new certification passes', () => {
  it('re-certifying the unchanged block checks it in place: a failed gate writes nothing and it stays certified', async () => {
    await withProject(async (base, projectRoot) => {
      const response = await post(base, '/api/block-studio/certifications', { path: currentPath, source: certifiedSource, metadata }, { 'Idempotency-Key': 'recheck-1' });
      const accepted = await response.json() as { operation: { id: string }; draft: { path: string } };
      expect(response.status).toBe(202);
      expect(accepted.draft.path).toBe(currentPath);
      const completed = await waitForOperation(base, accepted.operation.id);
      expect(completed).toMatchObject({ status: 'succeeded', result: { outcome: 'certified_unchanged_with_blockers', draftPath: currentPath } });
      expect(readFileSync(join(projectRoot, currentPath), 'utf-8')).toBe(`${certifiedSource}\n`);
      expect(draftsIn(projectRoot)).toEqual([]);

      const repeated = await post(base, '/api/block-studio/certifications', { path: currentPath, source: certifiedSource, metadata }, { 'Idempotency-Key': 'recheck-1' });
      expect(await repeated.json()).toMatchObject({ deduplicated: true, draft: { path: currentPath } });
    });
  });

  it('certifying edits checks them as one draft beside the certified block, which stays untouched', async () => {
    await withProject(async (base, projectRoot) => {
      const edited = certifiedSource.replace('SELECT 1 AS value', 'SELECT 1 AS value, 2 AS other').replace('status = "certified"', 'status = "draft"');
      const first = await post(base, '/api/block-studio/certifications', { path: currentPath, source: edited, metadata }, { 'Idempotency-Key': 'edit-1' });
      const accepted = await first.json() as { operation: { id: string }; draft: { path: string } };
      expect(accepted.draft.path).toMatch(/^domains\/finance\/blocks\/_drafts\/revenue-[0-9a-f]+\.dql$/);
      expect(await waitForOperation(base, accepted.operation.id)).toMatchObject({ result: { outcome: 'draft_saved_with_blockers', draftPath: accepted.draft.path } });
      expect(readFileSync(join(projectRoot, currentPath), 'utf-8')).toBe(`${certifiedSource}\n`);

      // Opening the certified block again and retrying reuses the same draft.
      const second = await post(base, '/api/block-studio/certifications', { path: currentPath, source: edited, metadata }, { 'Idempotency-Key': 'edit-2' });
      const secondAccepted = await second.json() as { operation: { id: string }; draft: { path: string } };
      expect(secondAccepted.draft.path).toBe(accepted.draft.path);
      await waitForOperation(base, secondAccepted.operation.id);
      expect(draftsIn(projectRoot)).toHaveLength(1);
    });
  });

  it('saving edits to a certified block writes its draft beside it; saving it unchanged keeps it certified', async () => {
    await withProject(async (base, projectRoot) => {
      const edited = certifiedSource.replace('Revenue."', 'Revenue, edited."');
      const saved = await post(base, '/api/block-studio/save', { path: currentPath, source: edited, metadata });
      const savedBody = await saved.json() as { path: string; source: string };
      expect(saved.status).toBe(200);
      expect(savedBody.path).toMatch(/_drafts\/revenue-[0-9a-f]+\.dql$/);
      expect(readFileSync(join(projectRoot, savedBody.path), 'utf-8')).toContain('status = "draft"');
      expect(readFileSync(join(projectRoot, currentPath), 'utf-8')).toBe(`${certifiedSource}\n`);

      const again = await post(base, '/api/block-studio/save', { path: currentPath, source: edited, metadata }).then((response) => response.json()) as { path: string };
      expect(again.path).toBe(savedBody.path);
      expect(draftsIn(projectRoot)).toHaveLength(1);

      const unchanged = await post(base, '/api/block-studio/save', { path: currentPath, source: certifiedSource, metadata }).then((response) => response.json()) as { path: string };
      expect(unchanged.path).toBe(currentPath);
      expect(readFileSync(join(projectRoot, currentPath), 'utf-8')).toContain('status = "certified"');
    });
  });
});

describe('Block Studio library, validation and block body', () => {
  it('reads status and domain from their own lines, not from a longer field that ends with the same word', async () => {
    await withProject(async (base, projectRoot) => {
      writeFileSync(join(projectRoot, 'domains/finance/blocks/costs.dql'), `block "Costs" {
  review_status = "certified"
  semantic_domain = "marketing"
  status = "draft"
  domain = "finance"
  type = "custom"
  query = """SELECT 1 AS value"""
}
`);
      const library = await fetch(`${base}/api/blocks/library`).then((response) => response.json()) as { blocks: Array<{ name: string; status: string; domain: string }> };
      expect(library.blocks.find((block) => block.name === 'Costs')).toMatchObject({ status: 'draft', domain: 'finance' });
    });
  });

  it('a retired block names its replacement in the library and when opened', async () => {
    await withProject(async (base, projectRoot) => {
      writeFileSync(join(projectRoot, 'domains/finance/blocks/revenue_legacy.dql'), `block "Revenue Legacy" {
  status = "deprecated"
  replacedBy = "domains/finance/blocks/revenue.dql"
  deprecatedOn = "2026-09-30"
  domain = "finance"
  type = "custom"
  query = """SELECT 1 AS value"""
}
`);
      const library = await fetch(`${base}/api/blocks/library`).then((response) => response.json()) as { blocks: Array<Record<string, unknown>> };
      expect(library.blocks.find((block) => block.name === 'Revenue Legacy')).toMatchObject({
        status: 'deprecated',
        replacedBy: 'domains/finance/blocks/revenue.dql',
        deprecatedOn: '2026-09-30',
        replacement: { name: 'Revenue', path: currentPath },
      });
      expect(library.blocks.find((block) => block.name === 'Revenue')).not.toHaveProperty('replacement');

      const opened = await fetch(`${base}/api/block-studio/open?path=${encodeURIComponent('domains/finance/blocks/revenue_legacy.dql')}`).then((response) => response.json()) as { metadata: Record<string, unknown> };
      expect(opened.metadata).toMatchObject({
        reviewStatus: 'deprecated',
        replacedBy: 'domains/finance/blocks/revenue.dql',
        deprecatedOn: '2026-09-30',
        replacement: { name: 'Revenue', path: currentPath },
      });
    });
  });

  it('a syntax error names its line and column', async () => {
    await withProject(async (base) => {
      const broken = certifiedSource.replace('  owner = "analytics"', '  owner = "analytics",....');
      const validation = await post(base, '/api/block-studio/validate', { source: broken }).then((response) => response.json()) as { diagnostics: Array<{ severity: string; message: string }> };
      const syntax = validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      expect(syntax.length).toBeGreaterThan(0);
      expect(syntax[0]!.message).toMatch(/^Line 6, column \d+: /);
    });
  });

  it('reads a block body without running its path through a shell', async () => {
    await withProject(async (base, projectRoot) => {
      mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
      const hostile = 'blocks/$(touch pwned).dql';
      writeFileSync(join(projectRoot, hostile), 'block "Hostile" {\n  query = """SELECT 1"""\n}\n');
      const response = await fetch(`${base}/api/blocks/body?path=${encodeURIComponent(hostile)}`);
      expect(response.status).toBe(200);
      expect(existsSync(join(projectRoot, 'pwned'))).toBe(false);
    });
  });
});
