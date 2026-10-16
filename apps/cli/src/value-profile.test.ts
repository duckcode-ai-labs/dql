import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { QueryExecutor } from '@zlens/connectors';
import type { WarehouseCatalogSnapshotV1 } from '@zlens/core';
import { VALUE_PROFILE_PATH, isSensitiveColumn, isSensitiveValue, profileWarehouseValues, readValueProfile, refreshValueProfile, removeValueProfile, renderColumnProfile, resolveValueProfilePolicy, valueProfileAllowed, writeValueProfile } from './value-profile.js';

describe('the value profile', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  const warehouse = () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-value-profile-'));
    roots.push(root);
    const file = join(root, 'shop.sqlite');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE orders (order_id INTEGER PRIMARY KEY, status TEXT, delivered_at TEXT, amount REAL, customer_email TEXT, note TEXT);
      INSERT INTO orders VALUES
        (1, 'delivered', '12/31/2021 11:45 PM', 20.5, 'ann@example.com', 'call ann@example.com'),
        (2, 'delivered', '01/02/2022 09:10 AM', 7.0, 'bo@example.com', 'call ann@example.com'),
        (3, 'canceled', NULL, 99.0, 'cy@example.com', 'gift');
    `);
    db.close();
    const snapshot: WarehouseCatalogSnapshotV1 = {
      version: 1, driver: 'sqlite', connectionId: 'default', scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }], capturedAt: '2026-09-22T00:00:00.000Z', fingerprint: 'sha256:catalog-a',
      relations: [{ id: 'warehouse.main.orders', schema: 'main', name: 'orders', relation: 'main.orders', kind: 'table', columns: [
        { name: 'order_id', type: 'INTEGER' }, { name: 'status', type: 'TEXT' }, { name: 'delivered_at', type: 'TEXT' }, { name: 'amount', type: 'REAL' }, { name: 'customer_email', type: 'TEXT' }, { name: 'note', type: 'TEXT' },
      ] }],
    } as WarehouseCatalogSnapshotV1;
    // The CLI's own better-sqlite3, as a project's .dql/connectors would provide it.
    return { root, connection: { driver: 'sqlite', filepath: file, moduleSearchPaths: [process.cwd()] } as never, snapshot };
  };

  it('is off unless the project opts in', () => {
    expect(resolveValueProfilePolicy(undefined).mode).toBe('off');
    expect(resolveValueProfilePolicy({}).mode).toBe('off');
    expect(resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'yes' } } }).mode).toBe('off');
    expect(resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled' } } }).mode).toBe('sampled');
    // Ask may show it only while opted in, and never under a host.
    expect(valueProfileAllowed(undefined, false)).toBe(false);
    expect(valueProfileAllowed({ agent: { valueProfile: { mode: 'off' } } }, false)).toBe(false);
    expect(valueProfileAllowed({ agent: { valueProfile: { mode: 'sampled' } } }, false)).toBe(true);
    expect(valueProfileAllowed({ agent: { valueProfile: { mode: 'sampled' } } }, true)).toBe(false);
  });

  it('never reads a column whose name marks it sensitive, and honours the project exclusions', () => {
    const policy = resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled', exclude: ['^internal_', '(invalid'] } } });
    for (const name of ['customer_email', 'phone_number', 'ssn', 'api_key', 'date_of_birth', 'home_address', 'internal_notes', 'first_name', 'last_name', 'username', 'annual_salary']) expect(isSensitiveColumn(name, policy), name).toBe(true);
    for (const name of ['status', 'product_name', 'location_name', 'order_moment_delivered', 'country']) expect(isSensitiveColumn(name, policy), name).toBe(false);
    // A name column of a table of people is a person's name; of a product, a store or a team it is not.
    for (const [column, relation] of [['name', 'main.customers'], ['customer_name', 'dev.customers'], ['display_name', '"app"."users"']]) expect(isSensitiveColumn(column!, policy, relation), `${relation}.${column}`).toBe(true);
    for (const [column, relation] of [['name', 'main.products'], ['location_name', 'dev.locations'], ['team_name', 'main.teams']]) expect(isSensitiveColumn(column!, policy, relation), `${relation}.${column}`).toBe(false);
  });

  it('drops a sampled value that is itself personal data or a secret', () => {
    // Credential shapes are assembled here so the secret scanner does not read the test as a leak.
    const stripeLike = ['sk', 'live', 'abcdef123456'].join('_');
    const awsLike = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    for (const value of ['ann@example.com', '123-45-6789', '+1 (555) 010-2030', 'https://x.example/a', stripeLike, awsLike]) expect(isSensitiveValue(value), value).toBe(true);
    for (const value of ['555-010-2030', '(555) 010-2030']) expect(isSensitiveValue(value), value).toBe(true);
    for (const value of ['delivered', '12/31/2021 11:45 PM', '2021-12-31', '2021-12-31 23:45:00', '20210', 'Philadelphia', 'jaffle']) expect(isSensitiveValue(value), value).toBe(false);
  });

  it('records the most frequent stored values of text columns and the range of numbers, and stores them outside git', async () => {
    const { root, connection, snapshot } = warehouse();
    const profile = await profileWarehouseValues({ executor: new QueryExecutor(), connection, snapshot, policy: resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled' } } }) });
    const orders = profile.relations['main.orders']!;
    expect(orders.status).toEqual({ examples: ['delivered', 'canceled'] });
    expect(orders.delivered_at!.examples).toContain('12/31/2021 11:45 PM');
    expect(orders.amount).toEqual({ min: '7', max: '99' });
    expect(orders.customer_email).toBeUndefined();
    // A free-text column keeps its plain values and loses the email address in it.
    expect(orders.note).toEqual({ examples: ['gift'] });
    expect(profile.skippedSensitive).toBe(1);

    const path = writeValueProfile(root, profile);
    expect(path).toContain(join('.dql', 'cache'));
    expect(readValueProfile(root, 'sha256:catalog-a')?.relations['main.orders']?.status).toEqual({ examples: ['delivered', 'canceled'] });
    // A profile of another catalog, or of no known catalog, is not evidence about this one.
    expect(readValueProfile(root, 'sha256:catalog-b')).toBeUndefined();
    expect(readValueProfile(root, undefined)).toBeUndefined();
    expect(renderColumnProfile(orders.status)).toBe(" holds 'delivered', 'canceled'");
    expect(renderColumnProfile(orders.amount)).toBe(' ranges 7 to 99');
    // Switched off: the profile goes, and nothing reads it again.
    removeValueProfile(root);
    expect(readValueProfile(root, 'sha256:catalog-a')).toBeUndefined();
  });

  it('a sync reads values only when opted in and not under a host; otherwise it removes what was read before', async () => {
    const { root, connection, snapshot } = warehouse();
    const executor = new QueryExecutor();
    const sync = (config: Parameters<typeof resolveValueProfilePolicy>[0], hosted = false) => refreshValueProfile({ projectRoot: root, config, executor, connection, snapshot, hosted });

    expect(await sync({ agent: { valueProfile: { mode: 'sampled' } } })).toMatchObject({ relations: 1, skippedSensitive: 1 });
    expect(existsSync(join(root, VALUE_PROFILE_PATH))).toBe(true);
    // Switched off (or never on): nothing read, the earlier profile removed.
    expect(await sync(undefined)).toBeUndefined();
    expect(existsSync(join(root, VALUE_PROFILE_PATH))).toBe(false);

    writeValueProfile(root, { version: 1, catalogFingerprint: 'sha256:catalog-a', capturedAt: 'x', relations: {}, skippedSensitive: 0 });
    // Under a host: each reader's row and column policies decide; nothing is read, the earlier profile goes.
    const hosted = await sync({ agent: { valueProfile: { mode: 'sampled' } } }, true);
    expect(hosted).toMatchObject({ skipped: expect.stringContaining('host') });
    expect(existsSync(join(root, VALUE_PROFILE_PATH))).toBe(false);
  });
});
