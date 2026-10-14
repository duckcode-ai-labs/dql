import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import { dispatchNotifications, setDeliverySink } from '../schedule/notifiers/index.js';
import { signSnapshotWith, snapshotKeyId, verifySnapshot, type SnapshotInput, type SnapshotSigner } from '../snapshot/app-snapshot.js';
import { hostGitAuthor, withRequestContext, type DqlPrincipal } from './request-context.js';
import { issueRunPass, redeemRunPass, revokeRunPass } from './schedule-runs.js';

/**
 * RFC 0010 HH-8: schedules run as their owner, and delivery, signing and
 * review requests go through the host.
 */
const maria: DqlPrincipal = { id: 'u-maria', kind: 'person', email: 'maria@insurer.example', displayName: 'Maria Lopez', source: 'host' };

describe('scheduled runs carry their owner (RFC 0010 HH-8)', () => {
  it('lets a pass open only its App\'s page runs, until it expires or is revoked', () => {
    const now = Date.UTC(2026, 8, 25);
    const pass = issueRunPass(maria, 'claims ops', now);
    expect(redeemRunPass(pass, 'POST', '/api/apps/claims%20ops/dashboards/overview/run', now)).toEqual({ principal: maria });
    expect(redeemRunPass(pass, 'GET', '/api/apps/claims%20ops/dashboards/overview/run', now)).toBeNull();
    expect(redeemRunPass(pass, 'POST', '/api/apps/finance/dashboards/overview/run', now)).toBeNull();
    expect(redeemRunPass(pass, 'PUT', '/api/connections', now)).toBeNull();
    expect(redeemRunPass(pass, 'POST', '/api/apps/claims%20ops/dashboards/overview/run', now + 121_000)).toBeNull();
    const second = issueRunPass(null, 'claims', now);
    revokeRunPass(second);
    expect(redeemRunPass(second, 'POST', '/api/apps/claims/dashboards/overview/run', now)).toBeNull();
    expect(redeemRunPass('dqlrun.forged', 'POST', '/api/apps/claims/dashboards/overview/run', now)).toBeNull();
  });

  const servers: Server[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('runs a page as the pass\'s owner, refuses a pass off its path, and 404s an unknown schedule', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-schedule-run-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'schedule_run' }));
    const asked: Array<{ person: string; action: string }> = [];
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      hostHooks: {
        resolvePrincipal: (req) => (req.headers['x-test-person'] === 'maria' ? maria : null),
        authorize: (principal, action) => { asked.push({ person: principal.id, action }); return { allow: true }; },
      },
      captureServer: (created) => { servers.push(created); },
    });
    const base = `http://127.0.0.1:${port}`;
    const pass = issueRunPass(maria, 'claims');
    try {
      const run = await fetch(`${base}/api/apps/claims/dashboards/overview/run`, { method: 'POST', headers: { Authorization: `Bearer ${pass}`, 'Content-Type': 'application/json' }, body: '{}' });
      expect(run.status).not.toBe(401);
      expect(asked).toContainEqual({ person: 'u-maria', action: 'app.view' });
      const offPath = await fetch(`${base}/api/connections`, { headers: { Authorization: `Bearer ${pass}` } });
      expect(offPath.status).toBe(401);
    } finally {
      revokeRunPass(pass);
    }
    const unknown = await fetch(`${base}/api/apps/claims/schedules/daily/run`, { method: 'POST', headers: { 'x-test-person': 'maria' } });
    expect(unknown.status).toBe(404);
    expect(asked).toContainEqual({ person: 'u-maria', action: 'schedule.manage' });
  });
});

describe('delivery through the host (RFC 0010 HH-8)', () => {
  afterEach(() => setDeliverySink(null));
  const payload = { block: 'claims', path: 'apps/claims', startedAt: '2026-09-25T08:00:00Z', alerts: [], queries: [] } as never;

  it('hands every target to the host and reports what it said', async () => {
    const sent: Array<{ type: string; recipients: string[] }> = [];
    setDeliverySink(async ({ type, recipients }) => {
      sent.push({ type, recipients });
      return type === 'slack' ? { delivered: false, error: 'Channel archived.' } : { delivered: true };
    });
    const results = await dispatchNotifications([{ type: 'email', recipients: ['ops@insurer.example'] } as never, { type: 'slack', recipients: ['#claims'] } as never], payload, tmpdir());
    expect(sent).toEqual([{ type: 'email', recipients: ['ops@insurer.example'] }, { type: 'slack', recipients: ['#claims'] }]);
    expect(results).toEqual([
      { type: 'email', recipients: ['ops@insurer.example'], delivered: true },
      { type: 'slack', recipients: ['#claims'], delivered: false, error: 'Channel archived.' },
    ]);
  });
});

describe('signing with the host\'s key service (RFC 0010 HH-8)', () => {
  it('signs a snapshot a verifier accepts, naming who exported it, without the private key leaving the service', async () => {
    const pair = generateKeyPairSync('ed25519');
    const der = createPublicKey(pair.privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
    const calls: number[] = [];
    // Stands in for a KMS/HSM: ZLens only ever sees the public key and signatures.
    const kms: SnapshotSigner = { id: snapshotKeyId(der), publicKeyBase64: der.toString('base64'), sign: async (data) => { calls.push(data.length); return sign(null, data, pair.privateKey); } };
    const input: SnapshotInput & { signedBy: string } = {
      appId: 'claims', appTitle: 'Claims', pageId: 'overview', pageTitle: 'Overview',
      run: { id: 'run-1', snapshotId: 'snap-1', filterFingerprint: 'f', resultFingerprint: 'r' },
      filters: [], figures: [{ key: 'paid.total', label: 'Claims paid', display: '$4.2M', value: 4_200_000 }],
      trust: { certified: 1, total: 1 }, body: '<section><div class="dql-tile-kpi">$4.2M</div></section>',
      createdAt: '2026-09-25T10:00:00.000Z', signedBy: 'maria@insurer.example',
    };
    const { html, manifest } = await signSnapshotWith(input, kms);
    expect(calls).toHaveLength(1);
    expect(manifest).toMatchObject({ signedBy: 'maria@insurer.example', key: { id: kms.id, algorithm: 'ed25519' } });
    expect(verifySnapshot(html, [kms.publicKeyBase64])).toMatchObject({ ok: true, contentIntact: true, signatureValid: true });
    expect(verifySnapshot(html.replace('$4.2M', '$9.9M'), [kms.publicKeyBase64]).ok).toBe(false);
  });
});

describe('commits and review requests (RFC 0010 HH-8)', () => {
  it('authors commits as the signed-in person when they have an email, and not otherwise', () => {
    expect(hostGitAuthor()).toBeUndefined();
    expect(withRequestContext({ principal: maria, requestId: 'r' }, () => hostGitAuthor())).toBe('Maria Lopez <maria@insurer.example>');
    expect(withRequestContext({ principal: { id: 'u-x', kind: 'person', source: 'host' }, requestId: 'r' }, () => hostGitAuthor())).toBeUndefined();
    expect(withRequestContext({ principal: { ...maria, displayName: 'Evil <x@y>\nname' }, requestId: 'r' }, () => hostGitAuthor())).toBe('Evil x@yname <maria@insurer.example>');
  });
});
