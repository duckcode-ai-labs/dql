import type { DatabaseConnector, ConnectionConfig } from './connector.js';
import { SnowflakeConnector } from './drivers/snowflake.js';
import { DuckDBConnector } from './drivers/duckdb.js';
import { FileConnector } from './drivers/file.js';
import { DatabricksConnector } from './drivers/databricks.js';
import { SQLiteConnector } from './drivers/sqlite.js';
import { PostgreSQLConnector } from './drivers/postgresql.js';
import { RedshiftConnector } from './drivers/redshift.js';
import { MySQLConnector } from './drivers/mysql.js';
import { MSSQLConnector } from './drivers/mssql.js';
import { FabricConnector } from './drivers/fabric.js';
import { TrinoConnector } from './drivers/trino.js';
import { ClickHouseConnector } from './drivers/clickhouse.js';
import { AthenaConnector } from './drivers/athena.js';
import { BigQueryConnector } from './drivers/bigquery.js';
import { openSshTunnel } from './drivers/ssh-tunnel.js';
import { createHash } from 'node:crypto';

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableSerialize(v)).join(',')}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    entries.push(`${JSON.stringify(k)}:${stableSerialize(v)}`);
  }
  return `{${entries.join(',')}}`;
}

export function createConnectionConfigKey(config: ConnectionConfig): string {
  const normalized: Record<string, unknown> = {
    driver: config.driver,
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    token: config.token,
    ssl: config.ssl,
    sslMode: config.sslMode,
    trustServerCertificate: config.trustServerCertificate,
    tenantId: config.tenantId,
    sslRootCert: config.sslRootCert,
    clusterId: config.clusterId,
    sshTunnel: config.sshTunnel,
    tlsServername: config.tlsServername,
    filepath: config.filepath,
    projectId: config.projectId,
    account: config.account,
    warehouse: config.warehouse,
    workgroup: config.workgroup,
    connectionString: config.connectionString,
    schema: config.schema,
    role: config.role,
    region: config.region,
    outputLocation: config.outputLocation,
    httpPath: config.httpPath,
    catalog: config.catalog,
    accessUrl: config.accessUrl,
    application: config.application,
    browserActionTimeout: config.browserActionTimeout,
    clientRequestMFAToken: config.clientRequestMFAToken,
    clientStoreTemporaryCredential: config.clientStoreTemporaryCredential,
    clientSessionKeepAlive: config.clientSessionKeepAlive,
    clientSessionKeepAliveHeartbeatFrequency: config.clientSessionKeepAliveHeartbeatFrequency,
    credentialCacheDir: config.credentialCacheDir,
    keepAlive: config.keepAlive,
    noProxy: config.noProxy,
    oauthAuthorizationUrl: config.oauthAuthorizationUrl,
    oauthClientId: config.oauthClientId,
    oauthClientSecret: config.oauthClientSecret,
    oauthRedirectUri: config.oauthRedirectUri,
    oauthScope: config.oauthScope,
    oauthTokenRequestUrl: config.oauthTokenRequestUrl,
    passcode: config.passcode,
    passcodeInPassword: config.passcodeInPassword,
    proxyHost: config.proxyHost,
    proxyPassword: config.proxyPassword,
    proxyPort: config.proxyPort,
    proxyProtocol: config.proxyProtocol,
    proxyUser: config.proxyUser,
    queryTag: config.queryTag,
    timeout: config.timeout,
    workloadIdentityProvider: config.workloadIdentityProvider,
    workloadIdentityAzureClientId: config.workloadIdentityAzureClientId,
    workloadIdentityImpersonationPath: config.workloadIdentityImpersonationPath,
    waitTimeout: config.waitTimeout,
    byteLimit: config.byteLimit,
    privateKey: config.privateKey,
    privateKeyPath: config.privateKeyPath,
    privateKeyPassphrase: config.privateKeyPassphrase,
    authMethod: config.authMethod,
    authenticator: config.authenticator,
    keyFilename: config.keyFilename,
    serviceAccountJson: config.serviceAccountJson,
    credentials: config.credentials,
    location: config.location,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
    profile: config.profile,
    moduleSearchPaths: config.moduleSearchPaths,
  };
  const payload = stableSerialize(normalized);
  return createHash('sha1').update(payload).digest('hex');
}

export class ConnectionPoolManager {
  private connectors: Map<string, DatabaseConnector> = new Map();
  private pendingConnectors: Map<string, Promise<DatabaseConnector>> = new Map();

  async getConnector(config: ConnectionConfig): Promise<DatabaseConnector> {
    const key = this.configKey(config);
    const existing = this.connectors.get(key);
    if (existing) return existing;
    const pending = this.pendingConnectors.get(key);
    if (pending) return pending;

    const connectPromise = (async () => {
      const connector = this.createConnector(config);
      // A database in a private network is reached through an SSH bastion;
      // the tunnel lives exactly as long as the connector.
      const tunnel = config.sshTunnel ? await openSshTunnel(config) : null;
      if (tunnel) {
        const disconnect = connector.disconnect.bind(connector);
        connector.disconnect = async () => {
          try {
            await disconnect();
          } finally {
            await tunnel.close();
          }
        };
      }
      try {
        await connector.connect(tunnel ? tunnel.config : config);
        this.connectors.set(key, connector);
        return connector;
      } catch (error) {
        try {
          await connector.disconnect();
        } catch {
          // The original connection error remains authoritative.
        }
        throw error;
      } finally {
        this.pendingConnectors.delete(key);
      }
    })();
    this.pendingConnectors.set(key, connectPromise);
    return connectPromise;
  }

  async removeConnector(
    config: ConnectionConfig,
    expectedConnector?: DatabaseConnector,
  ): Promise<void> {
    const key = this.configKey(config);
    const connector = this.connectors.get(key);
    if (!connector || (expectedConnector && connector !== expectedConnector)) return;
    // Evict before disconnecting. A slow vendor disconnect must not delete a
    // replacement connector established concurrently by another query.
    this.connectors.delete(key);
    try {
      await connector.disconnect();
    } catch {
      // The stale connector is already evicted; reconnect remains available.
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(this.pendingConnectors.values());
    const promises = [...this.connectors.values()].map((c) => c.disconnect());
    await Promise.all(promises);
    this.connectors.clear();
    this.pendingConnectors.clear();
  }

  private createConnector(config: ConnectionConfig): DatabaseConnector {
    switch (config.driver) {
      case 'snowflake':
        return new SnowflakeConnector();
      case 'duckdb':
        return new DuckDBConnector();
      case 'file':
        return new FileConnector();
      case 'databricks':
        return new DatabricksConnector();
      case 'sqlite':
        return new SQLiteConnector();
      case 'postgresql':
        return new PostgreSQLConnector();
      case 'redshift':
        return new RedshiftConnector();
      case 'mysql':
        return new MySQLConnector();
      case 'mssql':
        return new MSSQLConnector();
      case 'fabric':
        return new FabricConnector();
      case 'trino':
        return new TrinoConnector();
      case 'clickhouse':
        return new ClickHouseConnector();
      case 'athena':
        return new AthenaConnector();
      case 'bigquery':
        return new BigQueryConnector();
      default:
        throw new Error(`Unsupported database driver: ${String((config as { driver?: unknown }).driver)}.`);
    }
  }

  private configKey(config: ConnectionConfig): string {
    return `${config.driver}:${createConnectionConfigKey(config)}`;
  }
}
