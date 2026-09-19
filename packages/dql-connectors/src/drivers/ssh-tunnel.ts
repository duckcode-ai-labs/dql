import { createServer, type AddressInfo, type Server } from 'node:net';
import { readFileSync } from 'node:fs';
import type { ConnectionConfig } from '../connector.js';
import { loadDependency } from './shared.js';

/** The part of `ssh2` this uses; the package is loaded only when a tunnel is configured. */
interface SshStream extends NodeJS.ReadWriteStream { destroy(): void }
interface SshClient {
  on(event: 'ready', listener: () => void): SshClient;
  on(event: 'error', listener: (error: Error) => void): SshClient;
  on(event: 'close', listener: () => void): SshClient;
  connect(config: Record<string, unknown>): void;
  forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number, callback: (error: Error | undefined, stream: SshStream) => void): void;
  end(): void;
}

export const TUNNEL_DRIVERS = new Set(['postgresql', 'redshift', 'mysql', 'mssql', 'fabric']);

const DEFAULT_PORTS: Record<string, number> = { postgresql: 5432, redshift: 5439, mysql: 3306, mssql: 1433, fabric: 1433 };

export interface OpenTunnel {
  /** The connection config rewritten to go through the tunnel's local port. */
  config: ConnectionConfig;
  close(): Promise<void>;
}

/**
 * Forward a local port through an SSH bastion to the database host. The
 * database still sees its real host name for TLS (`tlsServername`), so a
 * `verify-full` connection checks the right certificate.
 */
export async function openSshTunnel(config: ConnectionConfig): Promise<OpenTunnel> {
  const tunnel = config.sshTunnel!;
  if (!TUNNEL_DRIVERS.has(config.driver)) {
    throw new Error(`SSH tunnels are supported for PostgreSQL, Redshift, MySQL and SQL Server, not ${config.driver}.`);
  }
  if (config.connectionString) throw new Error('An SSH tunnel needs host and port fields rather than a connection string.');
  const ssh = await loadDependency<{ Client: new () => SshClient }>('ssh2', config);
  const targetHost = config.host ?? 'localhost';
  const targetPort = config.port ?? DEFAULT_PORTS[config.driver] ?? 5432;
  const client = new ssh.Client();
  const privateKey = tunnel.privateKey ?? (tunnel.privateKeyPath ? readFileSync(tunnel.privateKeyPath.replace(/^~(?=\/)/, process.env.HOME ?? '~')) : undefined);
  await new Promise<void>((resolve, reject) => {
    client.on('ready', () => resolve()).on('error', (error) => reject(new Error(`SSH tunnel to ${tunnel.host} failed: ${error.message}`)));
    client.connect({
      host: tunnel.host,
      port: tunnel.port ?? 22,
      username: tunnel.username,
      ...(tunnel.password ? { password: tunnel.password } : {}),
      ...(privateKey ? { privateKey } : {}),
      ...(tunnel.passphrase ? { passphrase: tunnel.passphrase } : {}),
      readyTimeout: 20_000,
      keepaliveInterval: 30_000,
    });
  });
  const server: Server = createServer((socket) => {
    client.forwardOut('127.0.0.1', socket.remotePort ?? 0, targetHost, targetPort, (error, stream) => {
      if (error) {
        socket.destroy(error);
        return;
      }
      socket.pipe(stream).pipe(socket);
      socket.on('error', () => stream.destroy());
      stream.on('error', () => socket.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const localPort = (server.address() as AddressInfo).port;
  client.on('close', () => server.close());
  return {
    config: { ...config, host: '127.0.0.1', port: localPort, tlsServername: config.tlsServername ?? targetHost, sshTunnel: undefined },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client.end();
    },
  };
}
