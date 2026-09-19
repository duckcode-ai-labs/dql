/**
 * Athena, BigQuery and SQL Server against stand-in client modules: the connector's own
 * logic — credentials, parameters, the header row, type restoration, the row
 * cap, cancellation — without a cloud account.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AthenaConnector } from './athena.js';
import { BigQueryConnector } from './bigquery.js';
import { FabricConnector } from './fabric.js';
import { MSSQLConnector } from './mssql.js';

function stubModule(name: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-stub-'));
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), source);
  writeFileSync(join(root, 'package.json'), '{}');
  return root;
}

const ATHENA_STUB = `
const log = [];
class Command { constructor(input) { this.input = input; this.name = this.constructor.name; } }
class StartQueryExecutionCommand extends Command {}
class GetQueryExecutionCommand extends Command {}
class GetQueryResultsCommand extends Command {}
class StopQueryExecutionCommand extends Command {}
let polls = 0;
class AthenaClient {
  constructor(config) { log.push({ client: config }); }
  async send(command) {
    log.push({ command: command.name, input: command.input });
    if (command.name === 'StartQueryExecutionCommand') {
      if (/pg_sleep|slow/.test(command.input.QueryString)) return { QueryExecutionId: 'slow' };
      polls = 0;
      return { QueryExecutionId: 'q1' };
    }
    if (command.name === 'GetQueryExecutionCommand') {
      if (command.input.QueryExecutionId === 'slow') return { QueryExecution: { Status: { State: 'RUNNING' }, StatementType: 'DML' } };
      polls += 1;
      return { QueryExecution: { Status: { State: polls < 2 ? 'RUNNING' : 'SUCCEEDED' }, StatementType: 'DML' } };
    }
    if (command.name === 'GetQueryResultsCommand') {
      const info = [{ Name: 'id', Type: 'bigint' }, { Name: 'amount', Type: 'decimal' }, { Name: 'day', Type: 'date' }, { Name: 'paid', Type: 'boolean' }];
      const row = (n) => ({ Data: [{ VarCharValue: String(n) }, { VarCharValue: (n * 1.5).toFixed(2) }, { VarCharValue: '2024-01-31' }, { VarCharValue: n % 2 ? 'true' : 'false' }] });
      if (!command.input.NextToken) {
        return { ResultSet: { ResultSetMetadata: { ColumnInfo: info }, Rows: [{ Data: info.map((c) => ({ VarCharValue: c.Name })) }, row(1), row(2)] }, NextToken: 'p2' };
      }
      return { ResultSet: { ResultSetMetadata: { ColumnInfo: info }, Rows: [row(3), { Data: [{}, {}, {}, {}] }] } };
    }
    return {};
  }
}
module.exports = { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand, StopQueryExecutionCommand, log };
`;

describe('Athena connector (stub SDK)', () => {
  const root = stubModule('@aws-sdk/client-athena', ATHENA_STUB);
  const stub = () => require(join(root, 'node_modules', '@aws-sdk', 'client-athena', 'index.js')) as { log: Array<Record<string, any>> };

  it('signs in with a named profile, skips the header row and restores types', async () => {
    const connector = new AthenaConnector();
    await connector.connect({ driver: 'athena', region: 'us-west-2', authMethod: 'aws_profile', profile: 'analytics', database: 'sales', workgroup: 'wg', outputLocation: 's3://r/', moduleSearchPaths: [root] });
    expect(stub().log.find((entry) => entry.client)?.client).toEqual({ region: 'us-west-2', profile: 'analytics' });
    const result = await connector.execute('SELECT * FROM orders WHERE status = ?', ["o'pen"]);
    const start = stub().log.filter((entry) => entry.command === 'StartQueryExecutionCommand').at(-1)!.input;
    expect(start.QueryString).toBe("SELECT * FROM orders WHERE status = 'o''pen'");
    expect(start).toMatchObject({ QueryExecutionContext: { Database: 'sales' }, WorkGroup: 'wg', ResultConfiguration: { OutputLocation: 's3://r/' } });
    expect(result.rows).toEqual([
      { id: 1, amount: 1.5, day: '2024-01-31', paid: true },
      { id: 2, amount: 3, day: '2024-01-31', paid: false },
      { id: 3, amount: 4.5, day: '2024-01-31', paid: true },
      { id: null, amount: null, day: null, paid: null },
    ]);
    expect(result.columns.map((column) => column.type)).toEqual(['number', 'number', 'date', 'boolean']);
  });

  it('stops reading pages once the row cap is proven', async () => {
    const connector = new AthenaConnector();
    await connector.connect({ driver: 'athena', region: 'us-east-1', moduleSearchPaths: [root] });
    const before = stub().log.filter((entry) => entry.command === 'GetQueryResultsCommand').length;
    const result = await connector.execute('SELECT 1', undefined, { maxRows: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(stub().log.filter((entry) => entry.command === 'GetQueryResultsCommand').length - before).toBe(1);
  });

  it('stops the query on the server when the deadline passes', async () => {
    const connector = new AthenaConnector();
    await connector.connect({ driver: 'athena', region: 'us-east-1', moduleSearchPaths: [root] });
    await expect(connector.execute('SELECT slow', undefined, { deadlineMs: 300 })).rejects.toThrow(/deadline/);
    expect(stub().log.some((entry) => entry.command === 'StopQueryExecutionCommand' && entry.input.QueryExecutionId === 'slow')).toBe(true);
  });

  it('refuses an access-key sign-in with no secret', async () => {
    const connector = new AthenaConnector();
    await expect(connector.connect({ driver: 'athena', authMethod: 'aws_access_key', accessKeyId: 'AKIA', moduleSearchPaths: [root] })).rejects.toThrow(/secret access key/);
  });
});

const BIGQUERY_STUB = `
const log = [];
class Big { constructor(v) { this.v = v; } toString() { return this.v; } }
class BigQuery {
  constructor(options) { log.push({ options }); }
  async createQueryJob(request) {
    log.push({ request });
    let cancelled = false;
    return [{
      id: 'job-1',
      cancel: async () => { cancelled = true; log.push({ cancelled: true }); },
      getQueryResults: async (options) => {
        log.push({ read: options });
        if (/slow/.test(request.query)) await new Promise((r) => setTimeout(r, 5000));
        const rows = [1, 2, 3].map((n) => ({ id: n, amount: new Big(String(n * 1.5)), day: { value: '2024-01-31' }, at: { value: '2024-01-31T23:30:00Z' } }));
        const max = options.maxResults ?? rows.length;
        return [rows.slice(0, max), null, { schema: { fields: [{ name: 'id', type: 'INTEGER' }, { name: 'amount', type: 'NUMERIC' }, { name: 'day', type: 'DATE' }, { name: 'at', type: 'TIMESTAMP' }] }, totalRows: '3', ...(max < rows.length ? { pageToken: 't' } : {}) }];
      },
    }];
  }
  async getDatasets() { return [[{ id: 'sales' }]]; }
}
module.exports = { BigQuery, log };
`;

describe('BigQuery connector (stub SDK)', () => {
  const root = stubModule('@google-cloud/bigquery', BIGQUERY_STUB);
  const stub = () => require(join(root, 'node_modules', '@google-cloud', 'bigquery', 'index.js')) as { log: Array<Record<string, any>> };

  it('takes the project from pasted key JSON and caps bytes billed', async () => {
    const connector = new BigQueryConnector();
    await connector.connect({
      driver: 'bigquery',
      authMethod: 'service_account_json',
      serviceAccountJson: JSON.stringify({ project_id: 'acme', client_email: 'x@acme.iam', private_key: 'k' }),
      location: 'EU',
      byteLimit: 1_000_000,
      moduleSearchPaths: [root],
    });
    expect(stub().log[0]!.options).toMatchObject({ projectId: 'acme', credentials: { client_email: 'x@acme.iam' } });
    const result = await connector.execute('SELECT * FROM sales.orders WHERE status = ? AND note = ?', ['open', null]);
    const request = stub().log.filter((entry) => entry.request).at(-1)!.request;
    expect(request).toMatchObject({ location: 'EU', maximumBytesBilled: '1000000', params: ['open', null], types: [undefined, 'STRING'] });
    expect(result.rows[0]).toEqual({ id: 1, amount: 1.5, day: '2024-01-31', at: '2024-01-31T23:30:00Z' });
    expect(result.columns.map((column) => column.type)).toEqual(['number', 'number', 'date', 'datetime']);
  });

  it('reads one row past the cap and reports the cut', async () => {
    const connector = new BigQueryConnector();
    await connector.connect({ driver: 'bigquery', projectId: 'acme', moduleSearchPaths: [root] });
    const result = await connector.execute('SELECT 1', undefined, { maxRows: 1 });
    expect(stub().log.filter((entry) => entry.read).at(-1)!.read).toMatchObject({ maxResults: 2, autoPaginate: false });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('cancels the job at the deadline', async () => {
    const connector = new BigQueryConnector();
    await connector.connect({ driver: 'bigquery', projectId: 'acme', moduleSearchPaths: [root] });
    await expect(connector.execute('SELECT slow', undefined, { deadlineMs: 200 })).rejects.toThrow(/deadline/);
    expect(stub().log.some((entry) => entry.cancelled)).toBe(true);
  });

  it('refuses malformed key JSON without echoing it', async () => {
    const connector = new BigQueryConnector();
    await expect(connector.connect({ driver: 'bigquery', authMethod: 'service_account_json', serviceAccountJson: '{"private_key": "secret-9f3"', moduleSearchPaths: [root] }))
      .rejects.toSatisfy((error: Error) => /not valid JSON/.test(error.message) && !error.message.includes('secret-9f3'));
  });
});

const MSSQL_STUB = `
const { EventEmitter } = require('node:events');
const log = [];
class Request extends EventEmitter {
  constructor() { super(); this.stream = false; this.inputs = {}; this.cancelled = false; }
  input(name, value) { this.inputs[name] = value; return this; }
  cancel() { this.cancelled = true; log.push({ cancel: true }); }
  query(sql) {
    log.push({ sql, inputs: this.inputs });
    const slow = /WAITFOR/.test(sql);
    setTimeout(() => {
      if (slow) return;
      this.emit('recordset', {
        day: { index: 2, name: 'day', type: { declaration: 'date' } },
        id: { index: 0, name: 'id', type: { declaration: 'bigint' } },
        amount: { index: 1, name: 'amount', type: { declaration: 'decimal' } },
      });
      for (let n = 1; n <= 5 && !this.cancelled; n += 1) this.emit('row', { id: n, amount: n * 1.5, day: new Date(Date.UTC(2024, 0, 31)) });
      if (!this.cancelled) {
        this.emit('recordset', { other: { index: 0, name: 'other', type: { declaration: 'int' } } });
        this.emit('row', { other: 99 });
        this.emit('done', { rowsAffected: [5] });
      }
    }, 5);
  }
}
class ConnectionPool {
  constructor(config) { log.push({ config }); }
  async connect() { return this; }
  request() { return new Request(); }
  on() {}
  async close() {}
}
module.exports = { ConnectionPool, log };
`;

describe('SQL Server connector (stub mssql)', () => {
  const root = stubModule('mssql', MSSQL_STUB);
  const stub = () => require(join(root, 'node_modules', 'mssql', 'index.js')) as { log: Array<Record<string, any>> };

  it('owns its pool, verifies TLS by default, and signs in with a service principal', async () => {
    const connector = new MSSQLConnector();
    await connector.connect({ driver: 'mssql', host: 'db.example.com', database: 'sales', authMethod: 'azure_service_principal', oauthClientId: 'app', oauthClientSecret: 's3cret', tenantId: 't1', moduleSearchPaths: [root] });
    const config = stub().log.find((entry) => entry.config)!.config;
    expect(config).toMatchObject({
      server: 'db.example.com', database: 'sales',
      authentication: { type: 'azure-active-directory-service-principal-secret', options: { clientId: 'app', clientSecret: 's3cret', tenantId: 't1' } },
      options: { encrypt: true, trustServerCertificate: false },
    });
  });

  it('keeps the first result set in column order, binds $N as @pN, and returns calendar days', async () => {
    const connector = new MSSQLConnector();
    await connector.connect({ driver: 'mssql', host: 'h', database: 'd', username: 'u', password: 'p', moduleSearchPaths: [root] });
    const result = await connector.execute('SELECT * FROM t WHERE a = $1 AND b = $2', ['x', 2]);
    const query = stub().log.filter((entry) => entry.sql).at(-1)!;
    expect(query.sql).toBe('SELECT * FROM t WHERE a = @p1 AND b = @p2');
    expect(query.inputs).toEqual({ p1: 'x', p2: 2 });
    expect(result.columns.map((column) => column.name)).toEqual(['id', 'amount', 'day']);
    expect(result.rows[0]).toEqual({ id: 1, amount: 1.5, day: '2024-01-31' });
    expect(result.rows).toHaveLength(5);
  });

  it('cancels the stream one row past the cap and reports the cut', async () => {
    const connector = new MSSQLConnector();
    await connector.connect({ driver: 'mssql', host: 'h', database: 'd', moduleSearchPaths: [root] });
    const result = await connector.execute('SELECT * FROM t', undefined, { maxRows: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(stub().log.at(-1)).toEqual({ cancel: true });
  });

  it('cancels at the deadline', async () => {
    const connector = new MSSQLConnector();
    await connector.connect({ driver: 'mssql', host: 'h', database: 'd', moduleSearchPaths: [root] });
    await expect(connector.execute("WAITFOR DELAY '00:00:10'", undefined, { deadlineMs: 100 })).rejects.toThrow(/deadline/);
    expect(stub().log.at(-1)).toEqual({ cancel: true });
  });

  it('Fabric always encrypts and signs in with Entra ID by default', async () => {
    const connector = new FabricConnector();
    await connector.connect({ driver: 'fabric', host: 'x.datawarehouse.fabric.microsoft.com', database: 'wh', sslMode: 'disable', moduleSearchPaths: [root] });
    const config = stub().log.filter((entry) => entry.config).at(-1)!.config;
    expect(config.options.encrypt).toBe(true);
    expect(config.authentication.type).toBe('azure-active-directory-default');
  });
});
