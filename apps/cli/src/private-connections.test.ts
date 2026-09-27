import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { privateConnectionsPath, readPrivateConnections } from './connection-secrets.js';
import { loadProjectConfig } from './local-runtime.js';

/**
 * A person's own connections, outside git (RFC 0010 HH-16: a host's command
 * line writes the development copy an admin named, so a laptop never needs
 * Production's credentials).
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = (config: Record<string, unknown>) => {
  const root = mkdtempSync(join(tmpdir(), 'dql-private-connections-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify(config));
  return root;
};
const shared = { project: 'claims', defaultConnectionName: 'prod', connections: { prod: { driver: 'snowflake', account: 'acme', database: 'CLAIMS', password: '${secret:prod.password}' } } };

describe('a person\'s own connections', () => {
  it('changes nothing without the private file', () => {
    const root = project(shared);
    expect(readPrivateConnections(root)).toBeUndefined();
    expect(loadProjectConfig(root)).toMatchObject({ defaultConnectionName: 'prod', defaultConnection: { driver: 'snowflake', database: 'CLAIMS' } });
  });

  it('uses the private default connection, and replaces a shared one of the same name', () => {
    const root = project(shared);
    mkdirSync(join(root, '.dql', 'local', 'private'), { recursive: true });
    writeFileSync(privateConnectionsPath(root), JSON.stringify({ defaultConnection: 'dev', connections: { dev: { driver: 'snowflake', account: 'acme', database: 'CLAIMS_DEV', authMethod: 'external_browser' } } }));
    expect(loadProjectConfig(root)).toMatchObject({ defaultConnectionName: 'dev', defaultConnection: { driver: 'snowflake', database: 'CLAIMS_DEV' } });
    writeFileSync(privateConnectionsPath(root), JSON.stringify({ connections: { prod: { driver: 'duckdb', filepath: 'local.duckdb' } } }));
    expect(loadProjectConfig(root)).toMatchObject({ defaultConnectionName: 'prod', defaultConnection: { driver: 'duckdb' } });
    writeFileSync(privateConnectionsPath(root), '{ not json');
    expect(loadProjectConfig(root)).toMatchObject({ defaultConnectionName: 'prod', defaultConnection: { driver: 'snowflake' } });
  });
});
