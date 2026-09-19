/**
 * A PostgreSQL connection through a real SSH tunnel: an in-process ssh2
 * server stands in for the bastion and forwards to the database named by
 * DQL_LIVE_POSTGRES. Skipped unless that database and the ssh2 package
 * (DQL_LIVE_MODULES) are available.
 */
import { createRequire } from 'node:module';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConnectionConfig } from '../connector.js';
import { ConnectionPoolManager } from '../connection-pool.js';

const modules = process.env.DQL_LIVE_MODULES;
const database = process.env.DQL_LIVE_POSTGRES;

describe.skipIf(!modules || !database)('SSH tunnel (live)', () => {
  it('reaches the database through the bastion, and closes the tunnel with the connection', async () => {
    const ssh2 = createRequire(join(modules!, 'package.json'))('ssh2') as any;
    const hostKey = ssh2.utils.generateKeyPairSync('ed25519').private;
    const forwarded: string[] = [];
    let open = 0;
    const server = new ssh2.Server({ hostKeys: [hostKey] }, (client: any) => {
      client.on('authentication', (ctx: any) => {
        if (ctx.method === 'password' && ctx.username === 'tunnel' && ctx.password === 'bastion-pass') ctx.accept();
        else ctx.reject(['password']);
      });
      client.on('ready', () => {
        client.on('tcpip', (accept: any, _reject: any, info: any) => {
          forwarded.push(`${info.destIP}:${info.destPort}`);
          const stream = accept();
          const socket = netConnect(info.destPort, info.destIP);
          open += 1;
          socket.on('close', () => { open -= 1; });
          stream.pipe(socket).pipe(stream);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        });
      });
      client.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const sshPort = (server.address() as AddressInfo).port;

    const target = JSON.parse(database!) as Record<string, unknown>;
    const config = {
      driver: 'postgresql',
      ...target,
      moduleSearchPaths: [modules],
      sshTunnel: { host: '127.0.0.1', port: sshPort, username: 'tunnel', password: 'bastion-pass' },
    } as ConnectionConfig;
    const pool = new ConnectionPoolManager();
    const connector = await pool.getConnector(config);
    const result = await connector.execute('SELECT 41 + 1 AS answer');
    expect(result.rows[0]).toEqual({ answer: 42 });
    expect(forwarded).toContain(`${target.host}:${target.port}`);

    await pool.disconnectAll();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(open).toBe(0);

    // A wrong bastion password fails the connection with the tunnel named.
    const wrong = { ...config, sshTunnel: { ...config.sshTunnel!, password: 'nope' } } as ConnectionConfig;
    await expect(new ConnectionPoolManager().getConnector(wrong)).rejects.toThrow(/SSH tunnel to 127\.0\.0\.1 failed/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 30_000);
});
