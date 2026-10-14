import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import { LocalOperationCoordinator } from './local-operation-coordinator.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('local background operation API (PERF-001, API-001)', () => {
  it('returns an older active certification beyond terminal history and preserves exact-id recovery', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-operation-list-recovery-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'operation_list_recovery' }));
    let server: Server | undefined;
    let seeder: LocalOperationCoordinator | undefined;

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      seeder = new LocalOperationCoordinator(join(projectRoot, '.dql', 'cache', 'operations.sqlite'));
      const olderActive = seeder.create({
        type: 'block_certification',
        scope: 'block:blocks/_drafts/older-active.dql',
        resourceRevision: 'older-active-revision',
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
      for (let index = 0; index < 55; index += 1) {
        const terminal = seeder.create({ type: 'project_refresh', scope: `project:${index}` });
        await seeder.run(terminal.id, async () => ({ index }));
      }

      const listedResponse = await fetch(`${base}/api/operations?limit=50`);
      const listed = await listedResponse.json() as { operations: Array<{ id: string; status: string }> };
      expect(listedResponse.status).toBe(200);
      expect(listed.operations.find((operation) => operation.id === olderActive.id)).toMatchObject({ status: 'queued' });
      expect(listed.operations.filter((operation) => !['queued', 'running'].includes(operation.status))).toHaveLength(50);
      expect(listed.operations).toHaveLength(51);

      const exactResponse = await fetch(`${base}/api/operations/${encodeURIComponent(olderActive.id)}`);
      expect(exactResponse.status).toBe(200);
      expect(await exactResponse.json()).toMatchObject({
        id: olderActive.id,
        status: 'queued',
        resourceRevision: 'older-active-revision',
      });
    } finally {
      seeder?.close();
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }
  });

  it('acknowledges certification before execution finishes and executes the warehouse query once', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-operation-api-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'operation_api' }));

    let releaseQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const executeQuery = vi.fn(async () => {
      await queryGate;
      return {
        columns: ['value'],
        rows: [{ value: 1 }],
        rowCount: 1,
        executionTime: 1,
      };
    });
    const executor = { executeQuery } as unknown as QueryExecutor;
    let server: Server | undefined;
    const sseController = new AbortController();
    const operationEvents: string[] = [];
    let readEvents: Promise<void> | undefined;

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const eventResponse = await fetch(`${base}/api/operations/events`, { signal: sseController.signal });
      const eventReader = eventResponse.body?.getReader();
      const decoder = new TextDecoder();
      readEvents = (async () => {
        if (!eventReader) return;
        try {
          while (true) {
            const frame = await eventReader.read();
            if (frame.done) return;
            operationEvents.push(decoder.decode(frame.value, { stream: true }));
          }
        } catch {
          // The test aborts the open SSE recovery stream after terminal state.
        }
      })();
      const source = `block "Async Revenue" {
  status = "draft"
  domain = "finance"
  type = "custom"
  description = "Revenue certification operation."
  owner = "analytics"
  query = """SELECT 1 AS value"""
  tests {
    assert row_count > 0
  }
}`;
      const requestBody = {
        source,
        metadata: {
          name: 'Async Revenue',
          path: null,
          domain: 'finance',
          description: 'Revenue certification operation.',
          owner: 'analytics',
          tags: [],
          reviewStatus: 'draft',
        },
        clientRevision: 'revision-1',
      };
      const acceptedResponse = await fetch(`${base}/api/block-studio/certifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'certification-1' },
        body: JSON.stringify(requestBody),
      });
      const accepted = await acceptedResponse.json() as {
        operation: { id: string; status: string; phase: string; progress: number };
        draft: { path: string };
      };

      expect(acceptedResponse.status).toBe(202);
      expect(accepted.operation).toMatchObject({ status: 'running', phase: 'previewing', progress: 30 });
      expect(accepted.draft.path).toContain('/_drafts/');
      expect(executeQuery).toHaveBeenCalledTimes(1);

      const duplicate = await fetch(`${base}/api/block-studio/certifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'certification-1' },
        body: JSON.stringify(requestBody),
      }).then((response) => response.json()) as { operation: { id: string }; deduplicated: boolean };
      expect(duplicate).toMatchObject({ operation: { id: accepted.operation.id }, deduplicated: true });
      expect(executeQuery).toHaveBeenCalledTimes(1);

      releaseQuery();
      const completed = await waitForOperation(base, accepted.operation.id);
      expect(completed).toMatchObject({
        status: 'succeeded',
        result: { outcome: 'certified' },
      });
      expect(executeQuery).toHaveBeenCalledTimes(1);
      const certifiedPath = String((completed.result as { newPath?: string }).newPath);
      expect(readFileSync(join(projectRoot, certifiedPath), 'utf-8')).toContain('status = "certified"');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const progressEvents = operationEvents.join('');
      expect(progressEvents).toContain('"phase":"validating","progress":10');
      expect(progressEvents).toContain('"phase":"previewing","progress":30');
      expect(progressEvents).toContain('"phase":"testing","progress":60');
      expect(progressEvents).toContain('"phase":"publishing","progress":82');
      expect(progressEvents).toContain('"phase":"indexing","progress":92');
    } finally {
      releaseQuery();
      sseController.abort();
      await readEvents;
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }
  });

  it('returns field-targeted certification issues while preserving the saved draft', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-operation-issues-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'operation_issues' }));

    const executor = {
      executeQuery: vi.fn(async () => ({
        columns: ['value'],
        rows: [{ value: 1 }],
        rowCount: 1,
        executionTime: 1,
      })),
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
      const base = `http://127.0.0.1:${port}`;
      const source = `block "Ownerless Revenue" {
  status = "draft"
  domain = "finance"
  type = "custom"
  description = "Revenue awaiting an accountable owner."
  owner = ""
  query = """SELECT 1 AS value"""
}`;
      const accepted = await fetch(`${base}/api/block-studio/certifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'certification-ownerless' },
        body: JSON.stringify({
          source,
          metadata: { name: 'Ownerless Revenue', domain: 'finance', description: 'Revenue awaiting an accountable owner.', owner: '', tags: [] },
          clientRevision: 'ownerless-1',
        }),
      }).then((response) => response.json()) as { operation: { id: string }; draft: { path: string } };

      const completed = await waitForOperation(base, accepted.operation.id);
      expect(completed).toMatchObject({
        status: 'succeeded',
        result: {
          outcome: 'draft_saved_with_blockers',
          checklist: {
            issues: expect.arrayContaining([
              expect.objectContaining({
                code: 'owner_missing',
                title: 'Add an owner',
                field: 'Metadata',
              }),
            ]),
          },
        },
      });
      expect(readFileSync(join(projectRoot, accepted.draft.path), 'utf-8')).toContain('status = "draft"');
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }
  });

  it('keeps a failed certification on the existing saved draft identity', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-operation-existing-draft-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'operation_existing_draft' }));
    const currentPath = 'domains/finance/blocks/existing-revenue.dql';
    mkdirSync(join(projectRoot, 'domains/finance/blocks'), { recursive: true });
    const source = `block "Existing Revenue" {
  status = "draft"
  domain = "finance"
  type = "custom"
  description = "One durable draft identity."
  owner = "analytics"
  query = """SELECT 1 AS value"""
  tests {
    assert row_count > 10
  }
}`;
    writeFileSync(join(projectRoot, currentPath), `${source}\n`);

    const executor = {
      executeQuery: vi.fn(async () => ({
        columns: ['value'],
        rows: [{ value: 1 }],
        rowCount: 1,
        executionTime: 1,
      })),
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
      const base = `http://127.0.0.1:${port}`;
      const assessment = await fetch(`${base}/api/block-studio/certification-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      }).then((response) => response.json()) as {
        ok: boolean;
        blockers: string[];
        checklist: { tests: boolean; issues?: Array<{ code?: string }> };
      };
      expect(assessment).toMatchObject({
        ok: false,
        checklist: {
          tests: false,
          issues: expect.arrayContaining([expect.objectContaining({ code: 'tests_failed' })]),
        },
      });
      expect(readFileSync(join(projectRoot, currentPath), 'utf-8')).toBe(`${source}\n`);

      const acceptedResponse = await fetch(`${base}/api/block-studio/certifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'certification-existing-draft' },
        body: JSON.stringify({
          path: currentPath,
          source,
          metadata: {
            name: 'Existing Revenue',
            path: currentPath,
            domain: 'finance',
            description: 'One durable draft identity.',
            owner: 'analytics',
            tags: [],
            reviewStatus: 'draft',
          },
          clientRevision: 'existing-draft-1',
        }),
      });
      const accepted = await acceptedResponse.json() as { operation: { id: string }; draft: { path: string } };
      expect(acceptedResponse.status).toBe(202);
      expect(accepted.draft.path).toBe(currentPath);

      const completed = await waitForOperation(base, accepted.operation.id);
      expect(completed).toMatchObject({
        status: 'succeeded',
        result: {
          outcome: 'draft_saved_with_blockers',
          oldPath: currentPath,
          draftPath: currentPath,
        },
      });
      expect(readFileSync(join(projectRoot, currentPath), 'utf-8')).toContain('status = "draft"');
      expect(existsSync(join(projectRoot, 'domains/finance/blocks/_drafts'))).toBe(false);
      const reopened = await fetch(`${base}/api/block-studio/open?path=${encodeURIComponent(currentPath)}`)
        .then((response) => response.json()) as { lastRun?: { rowCount: number; columns: string[] } };
      expect(reopened.lastRun).toMatchObject({ rowCount: 1, columns: ['value'] });

      writeFileSync(join(projectRoot, currentPath), `${source.replace('SELECT 1 AS value', 'SELECT 2 AS value')}\n`);
      const reopenedAfterSourceDrift = await fetch(`${base}/api/block-studio/open?path=${encodeURIComponent(currentPath)}`)
        .then((response) => response.json()) as { lastRun?: unknown };
      expect(reopenedAfterSourceDrift.lastRun).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }
  });

  it('keeps preview failures concise while retaining collapsed technical evidence', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-preview-error-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'preview_error' }));
    const rawFailure = 'Warehouse could not resolve column customer_tier.\nCompiler trace: relation path customer -> segment -> tier was unavailable.';
    const executor = {
      executeQuery: vi.fn(async () => { throw new Error(rawFailure); }),
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
      const response = await fetch(`http://127.0.0.1:${port}/api/block-studio/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: `block "Customer Tier" {
  type = "custom"
  query = """SELECT customer_tier FROM customers"""
}`,
        }),
      });
      const body = await response.json() as {
        friendlyMessage: string;
        error: string;
        details: { technicalDetails: string };
      };

      expect(response.status).toBe(500);
      expect(body.friendlyMessage).toBe('Warehouse could not resolve column customer_tier.');
      expect(body.friendlyMessage).not.toContain('Compiler trace');
      expect(body.details.technicalDetails).toBe(rawFailure);
      expect(body.error).toBe(rawFailure);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }
  });
});

async function waitForOperation(base: string, operationId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await fetch(`${base}/api/operations/${encodeURIComponent(operationId)}`)
      .then((response) => response.json()) as Record<string, unknown>;
    if (!['queued', 'running'].includes(String(operation.status))) return operation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Operation ${operationId} did not finish.`);
}
