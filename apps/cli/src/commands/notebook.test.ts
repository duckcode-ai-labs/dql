import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAskAgentRuntimeMode } from '../local-runtime.js';
import { networkAccessUrls, resolveNotebookConnection, startProjectRuntime, withAccessToken } from './notebook.js';

describe('network access links', () => {
  const interfaces = {
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
    en0: [
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6' as const, mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: 'fe80::1/64', scopeid: 4 },
      { address: '10.0.0.31', netmask: '255.255.255.0', family: 'IPv4' as const, mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '10.0.0.31/24' },
    ],
  };

  it('a server on every interface prints one link per network address, carrying the token in the fragment', () => {
    expect(networkAccessUrls({ host: '0.0.0.0', port: 3630, token: 'abc123def456', interfaces }))
      .toEqual(['http://10.0.0.31:3630/#dql_token=abc123def456']);
    expect(networkAccessUrls({ host: '192.168.1.20', port: 3474, interfaces })).toEqual(['http://192.168.1.20:3474']);
    expect(withAccessToken('http://127.0.0.1:3630', 'abc123def456')).toBe('http://127.0.0.1:3630/#dql_token=abc123def456');
  });

  it('a loopback server prints no network links', () => {
    expect(networkAccessUrls({ host: '127.0.0.1', port: 3474, token: 'abc123def456', interfaces })).toEqual([]);
  });
});

describe('resolveNotebookConnection', () => {
  it('does not invent a DuckDB/file fallback when no default connection is configured', () => {
    expect(resolveNotebookConnection({ project: 'starter' }, '/tmp/dql-project')).toBeNull();
  });

  it('normalizes a configured default connection', () => {
    expect(resolveNotebookConnection(
      { defaultConnection: { driver: 'duckdb', filepath: './local.duckdb' } },
      '/tmp/dql-project',
    )).toMatchObject({
      driver: 'duckdb',
      filepath: '/tmp/dql-project/local.duckdb',
    });
  });

  it('uses the Ask pipeline by default, passes the explicit notebook mode to the server, and rejects invalid modes', async () => {
    expect(resolveAskAgentRuntimeMode(undefined)).toBe('pipeline_v3');
    // The deleted kernel's name is accepted for old configs and served by the pipeline.
    expect(resolveAskAgentRuntimeMode('authoritative_v2')).toBe('pipeline_v3');
    expect(() => resolveAskAgentRuntimeMode('experimental')).toThrow(/Invalid Ask runtime mode/i);

    const root = mkdtempSync(join(tmpdir(), 'dql-notebook-runtime-mode-'));
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'runtime-mode-test' }));
    const shadow = await startProjectRuntime(root, { preferredPort: 0 });
    try {
      const health = await fetch(`${shadow.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ askRuntimeMode: 'pipeline_v3' });
    } finally {
      await shadow.close();
    }

    const authoritative = await startProjectRuntime(root, { preferredPort: 0, askAgentRuntimeMode: 'pipeline_v3' });
    try {
      const health = await fetch(`${authoritative.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ askRuntimeMode: 'pipeline_v3' });
    } finally {
      await authoritative.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('closes while a browser still holds DQL\'s event streams open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-notebook-close-'));
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'close-test' }));
    const runtime = await startProjectRuntime(root, { preferredPort: 0 });
    const controller = new AbortController();
    try {
      const stream = await fetch(`${runtime.url}/api/operations/events`, { signal: controller.signal });
      expect(stream.status).toBe(200);
      const closed = await Promise.race([runtime.close().then(() => 'closed'), new Promise((done) => setTimeout(() => done('stuck'), 5_000))]);
      expect(closed).toBe('closed');
    } finally {
      controller.abort();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
