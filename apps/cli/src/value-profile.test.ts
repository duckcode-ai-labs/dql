import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { WarehouseCatalogSnapshotV1 } from '@duckcodeailabs/dql-core';
import { isSensitiveColumn, profileWarehouseValues, readValueProfile, renderColumnProfile, resolveValueProfilePolicy, writeValueProfile } from './value-profile.js';

describe('the value profile', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  const warehouse = () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-value-profile-'));
    roots.push(root);
    const file = join(root, 'shop.sqlite');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE orders (order_id INTEGER PRIMARY KEY, status TEXT, delivered_at TEXT, amount REAL, customer_email TEXT);
      INSERT INTO orders VALUES
        (1, 'delivered', '12/31/2021 11:45 PM', 20.5, 'ann@example.com'),
        (2, 'delivered', '01/02/2022 09:10 AM', 7.0, 'bo@example.com'),
        (3, 'canceled', NULL, 99.0, 'cy@example.com');
    `);
    db.close();
    const snapshot: WarehouseCatalogSnapshotV1 = {
      version: 1, driver: 'sqlite', connectionId: 'default', scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }], capturedAt: '2026-09-22T00:00:00.000Z', fingerprint: 'sha256:catalog-a',
      relations: [{ id: 'warehouse.main.orders', schema: 'main', name: 'orders', relation: 'main.orders', kind: 'table', columns: [
        { name: 'order_id', type: 'INTEGER' }, { name: 'status', type: 'TEXT' }, { name: 'delivered_at', type: 'TEXT' }, { name: 'amount', type: 'REAL' }, { name: 'customer_email', type: 'TEXT' },
      ] }],
    } as WarehouseCatalogSnapshotV1;
    // The CLI's own better-sqlite3, as a project's .dql/connectors would provide it.
    return { root, connection: { driver: 'sqlite', filepath: file, moduleSearchPaths: [process.cwd()] } as never, snapshot };
  };

  it('is off unless the project opts in', () => {
    expect(resolveValueProfilePolicy(undefined).mode).toBe('off');
    expect(resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'yes' } } }).mode).toBe('off');
    expect(resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled' } } }).mode).toBe('sampled');
  });

  it('never reads a column whose name marks it sensitive, and honours the project exclusions', () => {
    const policy = resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled', exclude: ['^internal_'] } } });
    for (const name of ['customer_email', 'phone_number', 'ssn', 'api_key', 'date_of_birth', 'home_address', 'internal_notes']) expect(isSensitiveColumn(name, policy)).toBe(true);
    for (const name of ['status', 'player_name', 'order_moment_delivered', 'country']) expect(isSensitiveColumn(name, policy)).toBe(false);
  });

  it('records the most frequent stored values of text columns and the range of numbers, and stores them outside git', async () => {
    const { root, connection, snapshot } = warehouse();
    const profile = await profileWarehouseValues({ executor: new QueryExecutor(), connection, snapshot, policy: resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled' } } }) });
    const orders = profile.relations['main.orders']!;
    expect(orders.status).toEqual({ examples: ['delivered', 'canceled'] });
    expect(orders.delivered_at!.examples).toContain('12/31/2021 11:45 PM');
    expect(orders.amount).toEqual({ min: '7', max: '99' });
    expect(orders.customer_email).toBeUndefined();
    expect(profile.skippedSensitive).toBe(1);

    const path = writeValueProfile(root, profile);
    expect(path).toContain(join('.dql', 'cache'));
    expect(readValueProfile(root, 'sha256:catalog-a')?.relations['main.orders']?.status).toEqual({ examples: ['delivered', 'canceled'] });
    // A profile of another catalog is not evidence about this one.
    expect(readValueProfile(root, 'sha256:catalog-b')).toBeUndefined();
    expect(renderColumnProfile(orders.status)).toBe(" holds 'delivered', 'canceled'");
    expect(renderColumnProfile(orders.amount)).toBe(' ranges 7 to 99');
  });
});
