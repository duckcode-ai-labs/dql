import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';

/**
 * A hosted runtime binds loopback behind its own proxy, so the explicit
 * allowedOrigins list must still decide which browser Origin may call /api.
 */
const TOKEN = 'server-token-for-origin-tests-01';
const HOSTED = 'https://dql.example.com';

describe('browser origins on /api', () => {
  const servers: Server[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function start(host: string, allowedOrigins?: string[]) {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-origins-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'origins' }));
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      host,
      authToken: TOKEN,
      ...(allowedOrigins ? { allowedOrigins } : {}),
      captureServer: (created) => { servers.push(created); },
    });
    return async (origin?: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(origin ? { Origin: origin } : {}) },
        body: '{}',
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      return { refused: response.status === 403 && body.error === 'Origin is not allowed.', status: response.status, echoed: response.headers.get('access-control-allow-origin') };
    };
  }

  it('bound to loopback with an allowlist: the listed origin and loopback origins pass, others are refused', async () => {
    const post = await start('127.0.0.1', [HOSTED]);
    expect(await post(HOSTED)).toMatchObject({ refused: false, echoed: HOSTED });
    expect(await post(`${HOSTED}/`)).toMatchObject({ refused: false, echoed: HOSTED });
    expect(await post('http://localhost:5173')).toMatchObject({ refused: false, echoed: 'http://localhost:5173' });
    expect(await post('https://evil.example')).toMatchObject({ refused: true, status: 403, echoed: null });
    expect(await post('https://dql.example.com.evil.example')).toMatchObject({ refused: true });
    expect((await post()).refused).toBe(false);
  });

  it('bound to loopback without an allowlist: only loopback origins pass', async () => {
    const post = await start('127.0.0.1');
    expect(await post('http://localhost:5173')).toMatchObject({ refused: false });
    expect(await post(HOSTED)).toMatchObject({ refused: true, echoed: null });
    expect((await post()).refused).toBe(false);
  });

  it('bound to 0.0.0.0 with an allowlist: only the listed origin passes, loopback origins are refused', async () => {
    const post = await start('0.0.0.0', [HOSTED]);
    expect(await post(HOSTED)).toMatchObject({ refused: false, echoed: HOSTED });
    expect(await post('http://localhost:5173')).toMatchObject({ refused: true, echoed: null });
    expect(await post('https://evil.example')).toMatchObject({ refused: true });
    expect((await post()).refused).toBe(false);
  });
});
