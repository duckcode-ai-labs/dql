import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlAuditEvent } from './observability.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * A creator in a draft space may not change the Git setup (`git.review` is refused). Every such refusal
 * writes a refused audit row naming who, which route and the refusal.
 */
const cole: DqlPrincipal = { id: 'u-cole', kind: 'person', email: 'cole@harbor.example', source: 'host' };

const servers: Server[] = [];
const events: DqlAuditEvent[] = [];
let projectRoot = '';
let base = '';

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-git-refusal-audit-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'git-refusal-audit' }));
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    hostHooks: {
      resolvePrincipal: () => cole,
      authorize: (_principal, action) => ({ allow: action !== 'git.review', reason: 'Production owns the Git setup.' }),
      audit: (event) => { events.push(event); },
    },
    captureServer: (created) => { servers.push(created); },
  });
  base = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

describe('refused Git changes are audited', () => {
  it.each(['/api/git/checkout', '/api/git/branch', '/api/git/remote'])('%s writes a refused row', async (path) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', branch: 'x', url: 'https://example.invalid/x.git' }) });
    expect(response.status).toBe(403);
    const row = events.find((event) => event.kind === 'request' && event.path === path);
    expect(row).toMatchObject({ kind: 'request', outcome: 'refused', status: 403, method: 'POST', action: 'git.review', actor: 'cole@harbor.example' });
  });
});
