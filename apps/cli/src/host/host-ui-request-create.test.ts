import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';

/**
 * Home shows "Open requests" only to a person the host lets make requests, so
 * `request.create` must reach the app through the real GET /api/host/ui map.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const vic: DqlPrincipal = { id: 'u-vic', kind: 'person', email: 'vic@harbor.example', source: 'host' };

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function capabilitiesOf(person: string, hooks: Partial<DqlHostHooks>): Promise<Record<string, boolean>> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-request-create-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'request_create' }));
  const people: Record<string, DqlPrincipal> = { priya, vic };
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    hostHooks: { resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null, ...hooks },
    captureServer: (created) => { servers.push(created); },
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/host/ui`, { headers: { 'x-test-person': person } });
  return (await response.json()).capabilities;
}

describe('GET /api/host/ui request.create', () => {
  it('is in the capability map, from the host decision for that person', async () => {
    const hooks: Partial<DqlHostHooks> = {
      authorize: (principal, action) => ({ allow: action !== 'request.create' || principal.id === 'u-priya' }),
    };
    expect((await capabilitiesOf('priya', hooks))['request.create']).toBe(true);
    expect((await capabilitiesOf('vic', hooks))['request.create']).toBe(false);
  });
});
