/**
 * The Trino connector against a stand-in coordinator that speaks the client
 * REST protocol: paging through nextUri, typed columns, retry on 503, an
 * error payload, a row cap that stops the query, and DELETE on cancel.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrinoConnector } from './trino.js';

interface Seen { method: string; path: string; body: string; headers: IncomingMessage['headers'] }

describe('Trino connector (protocol stand-in)', () => {
  let server: Server;
  let base: string;
  const seen: Seen[] = [];
  let busyOnce = true;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({ method: req.method ?? '', path: req.url ?? '', body, headers: req.headers });
        const send = (payload: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
        const columns = [
          { name: 'id', type: 'bigint' }, { name: 'amount', type: 'decimal(12,2)' },
          { name: 'day', type: 'date' }, { name: 'at', type: 'timestamp(3)' }, { name: 'paid', type: 'boolean' },
        ];
        const row = (n: number) => [n, (n * 1.5).toFixed(2), '2024-01-31', '2024-01-31 23:30:00.000', n % 2 === 1];
        if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
        if (req.method === 'POST' && req.url === '/v1/statement') {
          if (/fail/.test(body)) return send({ id: 'q-err', error: { message: 'line 1:8: Column \'nope\' cannot be resolved', errorName: 'COLUMN_NOT_FOUND' } });
          if (/slow/.test(body)) return send({ id: 'q-slow', nextUri: `${base}/v1/statement/q-slow/1` });
          if (/many/.test(body)) return send({ id: 'q-many', columns, data: [row(1), row(2)], nextUri: `${base}/v1/statement/q-many/1` });
          return send({ id: 'q1', nextUri: `${base}/v1/statement/q1/1` });
        }
        if (req.url === '/v1/statement/q1/1') {
          if (busyOnce) { busyOnce = false; res.writeHead(503); res.end(); return; }
          return send({ id: 'q1', columns, data: [row(1), row(2)], nextUri: `${base}/v1/statement/q1/2` });
        }
        if (req.url === '/v1/statement/q1/2') return send({ id: 'q1', columns, data: [row(3)] });
        if (req.url?.startsWith('/v1/statement/q-many/')) return send({ id: 'q-many', columns, data: [row(3), row(4)], nextUri: `${base}/v1/statement/q-many/9` });
        if (req.url?.startsWith('/v1/statement/q-slow/')) { setTimeout(() => send({ id: 'q-slow', nextUri: `${base}/v1/statement/q-slow/2` }), 400); return; }
        res.writeHead(404); res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const connect = async (extra: Record<string, unknown> = {}) => {
    const connector = new TrinoConnector();
    await connector.connect({ driver: 'trino', host: '127.0.0.1', port: Number(new URL(base).port), catalog: 'hive', schema: 'sales', username: 'analyst', ...extra });
    return connector;
  };

  it('pages through the result, retries a busy coordinator, and keeps values exact', async () => {
    const connector = await connect();
    const result = await connector.execute('SELECT * FROM orders WHERE status = ?', ["o'pen"]);
    const post = seen.filter((request) => request.method === 'POST').at(-1)!;
    expect(post.body).toBe("SELECT * FROM orders WHERE status = 'o''pen'");
    expect(post.headers).toMatchObject({ 'x-trino-user': 'analyst', 'x-trino-catalog': 'hive', 'x-trino-schema': 'sales', 'x-trino-source': 'dql' });
    expect(result.rows).toEqual([
      { id: 1, amount: 1.5, day: '2024-01-31', at: '2024-01-31 23:30:00.000', paid: true },
      { id: 2, amount: 3, day: '2024-01-31', at: '2024-01-31 23:30:00.000', paid: false },
      { id: 3, amount: 4.5, day: '2024-01-31', at: '2024-01-31 23:30:00.000', paid: true },
    ]);
    expect(result.columns.map((column) => column.type)).toEqual(['number', 'number', 'date', 'datetime', 'boolean']);
    expect(result.queryId).toBe('q1');
  });

  it('stops the query once the row cap is proven', async () => {
    const connector = await connect();
    const result = await connector.execute('SELECT many', undefined, { maxRows: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(seen.some((request) => request.method === 'DELETE' && request.path.startsWith('/v1/statement/q-many/'))).toBe(true);
  });

  it('reports the engine error', async () => {
    const connector = await connect();
    await expect(connector.execute('SELECT fail')).rejects.toThrow(/Column 'nope' cannot be resolved/);
  });

  it('cancels on the coordinator at the deadline', async () => {
    const connector = await connect();
    await expect(connector.execute('SELECT slow', undefined, { deadlineMs: 250 })).rejects.toThrow(/deadline/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.some((request) => request.method === 'DELETE' && request.path.startsWith('/v1/statement/q-slow/'))).toBe(true);
  });

  it('refuses to send a password over plain HTTP, and sends a bearer token', async () => {
    await expect(connect({ password: 'hunter22' })).rejects.toThrow(/only over HTTPS/);
    await connect({ authMethod: 'token', token: 'jwt-abc' });
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer jwt-abc');
  });
});
