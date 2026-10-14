import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import { routeAction } from './route-actions.js';
import { isViewerToken, mintViewerToken, readViewerToken, viewerDecision, viewerLinkBlockedReason } from './viewer-links.js';

/**
 * RFC 0010 HH-2: a page shared on the network opens read-only — one App,
 * for a limited time — and never carries the server's own token.
 */
const SERVER_TOKEN = 'server-token-for-tests-0001';
const NOW = Date.UTC(2026, 8, 25, 12);

describe('viewer tokens', () => {
  it('open the App they name until they expire', () => {
    const { token, expiresAt } = mintViewerToken(SERVER_TOKEN, 'claims ops', NOW);
    expect(isViewerToken(token)).toBe(true);
    expect(token).not.toContain(SERVER_TOKEN);
    expect(expiresAt).toBe('2026-10-09T12:00:00.000Z');
    expect(readViewerToken(SERVER_TOKEN, token, NOW)).toEqual({ appId: 'claims ops', expiresAt });
    expect(readViewerToken(SERVER_TOKEN, token, Date.parse(expiresAt))).toBeNull();
  });

  it('cannot open an App that shows each member only their own rows, or one that does not exist', () => {
    expect(viewerLinkBlockedReason({ rlsBindings: [] })).toBeNull();
    expect(viewerLinkBlockedReason({ rlsBindings: [{ role: 'viewer', variable: 'user.region', from: 'region' }] })).toMatch(/own rows/);
    expect(viewerLinkBlockedReason(null)).toMatch(/not found/);
  });

  it('are refused when altered, signed with another server token, or malformed', () => {
    const { token } = mintViewerToken(SERVER_TOKEN, 'claims', NOW);
    const [prefix, , sig] = token.split('.');
    const otherApp = Buffer.from(JSON.stringify({ a: 'finance', e: Math.floor(NOW / 1000) + 3600 })).toString('base64url');
    expect(readViewerToken(SERVER_TOKEN, `${prefix}.${otherApp}.${sig}`, NOW)).toBeNull();
    expect(readViewerToken('a-different-server-token', token, NOW)).toBeNull();
    for (const bad of ['', 'dqlv1', 'dqlv1..', `${token}.extra`, SERVER_TOKEN]) expect(readViewerToken(SERVER_TOKEN, bad, NOW)).toBeNull();
  });

  it('let a link view, run and export its own App, and nothing else', () => {
    const allowed = (method: string, path: string) => viewerDecision('claims', routeAction(method, path), method, path).allow;
    expect(allowed('GET', '/api/apps/claims')).toBe(true);
    expect(allowed('GET', '/api/apps/claims/dashboards/overview')).toBe(true);
    expect(allowed('POST', '/api/apps/claims/dashboards/overview/run')).toBe(true);
    expect(allowed('POST', '/api/apps/claims/dashboards/overview/story')).toBe(true);
    expect(allowed('GET', '/api/apps/claims/dashboards/overview/snapshot')).toBe(true);
    expect(allowed('POST', '/api/app-datasets/run')).toBe(true);
    expect(allowed('GET', '/api/identity')).toBe(true);

    expect(allowed('GET', '/api/apps/finance')).toBe(false);
    expect(allowed('GET', '/api/apps')).toBe(false);
    expect(allowed('PUT', '/api/apps/claims/dashboards/overview')).toBe(false);
    expect(allowed('POST', '/api/apps/claims/promote')).toBe(false);
    expect(allowed('POST', '/api/apps/claims/dashboards/overview/monitors')).toBe(false);
    expect(allowed('GET', '/api/notebooks')).toBe(false);
    expect(allowed('GET', '/api/connections')).toBe(false);
    expect(allowed('GET', '/api/server/share')).toBe(false);
    expect(allowed('POST', '/api/query')).toBe(false);
    expect(allowed('POST', '/api/agent-runs')).toBe(false);
    expect(allowed('POST', '/api/apps/claims/ask')).toBe(false);
  });
});

describe('a server shared on the network', () => {
  const servers: Server[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('shares read-only links instead of its own token, and holds each link to its App', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-viewer-links-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'viewer_links' }));
    const app = (id: string, extra: Record<string, unknown> = {}) => {
      mkdirSync(join(projectRoot, 'apps', id, 'dashboards'), { recursive: true });
      writeFileSync(join(projectRoot, 'apps', id, 'dql.app.json'), JSON.stringify({
        version: 1, id, name: id, description: id, visibility: 'shared', domain: 'd', lifecycle: 'draft', owners: ['t@example.com'],
        homepage: { type: 'dashboard', id: 'overview' }, ...extra,
      }));
    };
    app('claims');
    app('by-member', { roles: [{ id: 'viewer', displayName: 'Viewer' }], rlsBindings: [{ role: 'viewer', variable: 'user.region', from: 'region' }] });
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      host: '0.0.0.0',
      authToken: SERVER_TOKEN,
      allowedOrigins: ['http://dql.lan:3474'],
      captureServer: (created) => { servers.push(created); },
    });
    const base = `http://127.0.0.1:${port}`;
    const as = (token: string) => ({ Authorization: `Bearer ${token}` });

    const share = await fetch(`${base}/api/server/share?app=claims`, { headers: as(SERVER_TOKEN) }).then((response) => response.json()) as {
      network: boolean; origins: string[]; token?: string; viewer?: { token: string; expiresAt: string };
    };
    expect(share).toMatchObject({ network: true, origins: ['http://dql.lan:3474'] });
    expect(share.token).toBeUndefined();
    expect(JSON.stringify(share)).not.toContain(SERVER_TOKEN);
    const viewer = share.viewer!.token;
    const perMember = await fetch(`${base}/api/server/share?app=by-member`, { headers: as(SERVER_TOKEN) }).then((response) => response.json()) as { viewer?: unknown; viewerBlocked?: string };
    expect(perMember.viewer).toBeUndefined();
    expect(perMember.viewerBlocked).toMatch(/own rows/);
    const forged = mintViewerToken(SERVER_TOKEN, 'by-member').token;
    expect((await fetch(`${base}/api/apps/by-member`, { headers: as(forged) })).status).toBe(403);

    const identity = await fetch(`${base}/api/identity`, { headers: as(viewer) });
    expect(identity.status).toBe(200);
    expect(await identity.json()).toMatchObject({ owner: 'Viewer', viewer: { appId: 'claims' } });

    expect((await fetch(`${base}/api/apps/claims`, { headers: as(viewer) })).status).toBe(200);
    for (const [method, path] of [['GET', '/api/apps/finance'], ['GET', '/api/notebooks'], ['GET', '/api/server/share?app=finance'], ['PUT', '/api/connections'], ['POST', '/api/query']] as const) {
      const refused = await fetch(`${base}${path}`, { method, headers: { ...as(viewer), 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) });
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'PERMISSION_DENIED' });
    }

    const [prefix, body, sig] = viewer.split('.');
    const altered = await fetch(`${base}/api/identity`, { headers: as(`${prefix}.${body}x.${sig}`) });
    expect(altered.status).toBe(401);
    expect(await altered.json()).toEqual({ error: 'This link has expired or was changed. Ask for a new link.' });

    expect((await fetch(`${base}/api/notebooks`, { headers: as(SERVER_TOKEN) })).status).toBe(200);
  });
});
