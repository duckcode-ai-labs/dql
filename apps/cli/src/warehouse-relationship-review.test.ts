/**
 * What two authoring agents hit modeling the Spider 2.0-Lite f1 and IPL
 * SQLite databases, end to end on a real SQLite warehouse shaped like f1:
 * discovery proposed joins only a column name suggested (two tables that
 * number their rows separately; a key column with placeholder zeros),
 * proposed them again after a reviewer removed them, and there was no command
 * to check a relationship written by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import { buildManifest } from '@zlens/core';
import { QueryExecutor } from '@zlens/connectors';
import type { CLIFlags } from './args.js';
import { runModel } from './commands/model.js';
import { applyProjectWarehouseDiscovery, discoverProjectWarehouseModel, rejectDiscoveredRelationship, syncProjectWarehouse } from './local-runtime.js';
import { DISCOVERY_LEDGER_PATH, discoverWarehouseModel, readDiscoveryLedger } from './warehouse-model-discovery.js';

const F1 = `
  CREATE TABLE races (race_id INTEGER PRIMARY KEY, year INTEGER);
  CREATE TABLE drivers (driver_id INTEGER PRIMARY KEY, nationality_code TEXT);
  CREATE TABLE drivers_ext (driver_id INTEGER PRIMARY KEY, nationality_code TEXT, code TEXT);
  CREATE TABLE results (result_id INTEGER PRIMARY KEY, race_id INTEGER, driver_id INTEGER, points REAL);
  CREATE TABLE sprint_results (result_id INTEGER PRIMARY KEY, race_id INTEGER, driver_id INTEGER, points REAL);
  CREATE TABLE driver_standings (driver_standings_id INTEGER PRIMARY KEY, race_id INTEGER, driver_id INTEGER);
  CREATE TABLE driver_standings_ext (driver_standings_id INTEGER, race_id INTEGER, driver_id INTEGER);
  INSERT INTO races VALUES (1, 1950), (2, 1950), (3, 2021), (4, 2021);
  INSERT INTO drivers VALUES (1, 'GB'), (2, 'DE'), (3, 'FR'), (4, 'IT');
  INSERT INTO drivers_ext VALUES (1, 'GB', 'HAM'), (2, 'DE', 'VET'), (3, 'FR', 'GAS'), (4, 'IT', 'GIO');
  -- 1950: driver 1 shared a car, so race 1 holds two results for driver 1.
  INSERT INTO results VALUES (1, 1, 1, 4), (2, 1, 1, 4), (3, 1, 2, 6), (4, 2, 3, 8), (5, 3, 1, 25), (6, 3, 2, 18), (7, 4, 1, 25), (8, 4, 2, 18);
  -- Sprint results number their own rows 1, 2, 3: the values exist in results by coincidence.
  INSERT INTO sprint_results VALUES (1, 3, 1, 8), (2, 3, 2, 7), (3, 4, 1, 8);
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
  INSERT INTO driver_standings SELECT i, 1 + (i % 4), 1 + (i % 3) FROM n;
  -- The extension copies the standings and adds two rows whose id is 0.
  INSERT INTO driver_standings_ext SELECT driver_standings_id, race_id, driver_id FROM driver_standings;
  INSERT INTO driver_standings_ext VALUES (0, 4, 4), (0, 4, 3);
`;

describe('reviewing joins on a warehouse shaped like f1', () => {
  const roots: string[] = [];
  const executors: QueryExecutor[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const executor of executors.splice(0)) await executor.disconnect().catch(() => undefined);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const project = async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-f1-review-'));
    roots.push(projectRoot);
    const db = new Database(join(projectRoot, 'f1.sqlite'));
    db.exec(F1);
    db.close();
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'f1', manifestVersion: 3, modeling: { mode: 'warehouse-first' },
      connections: { default: { driver: 'sqlite', filepath: './f1.sqlite' } },
    }));
    const executor = new QueryExecutor();
    executors.push(executor);
    await syncProjectWarehouse(projectRoot, { executor });
    return { projectRoot, executor };
  };

  it('proposes only joins the data backs, says why the rest are held back, and never proposes a removed or rejected join again', async () => {
    const { projectRoot, executor } = await project();
    const report = await discoverProjectWarehouseModel(projectRoot, { validate: true, executor });
    const proposed = report.relationships.map((item) => `${item.from}.${item.keys.map((pair) => pair.from).join('+')} -> ${item.to}`).sort();
    // The references discovery should draft are still drafted, and pass.
    expect(proposed).toEqual(expect.arrayContaining(['result.race_id -> race', 'result.driver_id -> driver', 'sprint_result.race_id -> race', 'drivers_ext.driver_id -> driver']));
    expect(report.relationships.find((item) => item.from === 'drivers_ext')).toMatchObject({ cardinality: 'one_to_one', validation: { status: 'passed' } });
    // The two f1 false joins are not.
    expect(proposed).not.toContain('sprint_result.result_id -> result');
    expect(proposed).not.toContain('driver_standings_ext.driver_standings_id -> driver_standing');
    const withheld = Object.fromEntries((report.withheld ?? []).map((item) => [`${item.from}.${item.keys[0]!.from}`, item.reason]));
    expect(withheld['sprint_result.result_id']).toMatch(/3 of 3 joined rows disagree on race_id, driver_id: the two tables number their rows separately/);
    expect(withheld['driver_standings_ext.driver_standings_id']).toMatch(/2 driver_standings_ext rows hold one driver_standings_id value that is nowhere in driver_standings, a placeholder/);

    // Apply every draft, then a reviewer removes one and rejects another.
    const applied = applyProjectWarehouseDiscovery(projectRoot, report);
    expect(applied.changes).toBeGreaterThan(0);
    expect(readDiscoveryLedger(projectRoot).relationships.filter((item) => item.decision === 'applied')).toHaveLength(report.relationships.length);
    const modelPath = join(projectRoot, applied.paths.find((path) => path.includes('modeling'))!);
    const document = yaml.load(readFileSync(modelPath, 'utf8')) as { relationships: Array<{ id: string }> };
    const removedId = report.relationships.find((item) => item.from === 'drivers_ext')!.id;
    document.relationships = document.relationships.filter((item) => item.id !== removedId);
    writeFileSync(modelPath, yaml.dump(document));
    const rejectedId = report.relationships.find((item) => item.from === 'sprint_result' && item.to === 'race')!.id;
    rejectDiscoveredRelationship(projectRoot, rejectedId, { reason: 'sprints join through results' });
    document.relationships = document.relationships.filter((item) => item.id !== rejectedId);
    writeFileSync(modelPath, yaml.dump(document));

    const again = await discoverProjectWarehouseModel(projectRoot, { validate: true, executor });
    expect(again.relationships).toEqual([]);
    expect(again.dismissed?.map((item) => `${item.from} -> ${item.to}: ${item.reason}`).sort()).toEqual([
      'drivers_ext -> driver: removed by a reviewer after discovery drafted it',
      'sprint_result -> race: rejected by a reviewer: sprints join through results',
    ]);
    // The decisions are shared in git, beside the catalog snapshot.
    expect(JSON.parse(readFileSync(join(projectRoot, DISCOVERY_LEDGER_PATH), 'utf8')).version).toBe(1);
  }, 60_000);

  it('a rejected join is dismissed by the pure drafter, and its signature handed to the data-proven pass', () => {
    const snapshot = readWarehouseCatalogFixture();
    const report = discoverWarehouseModel({
      snapshot,
      projectName: 'f1',
      decisions: [{ from: 'warehouse.main.sprint_results', to: 'warehouse.main.results', keys: [{ from: 'result_id', to: 'result_id' }], decision: 'rejected', at: '2026-09-23T00:00:00.000Z' }],
    });
    expect(report.relationships.some((item) => item.from === 'sprint_result' && item.to === 'result')).toBe(false);
    expect(report.dismissed).toEqual([expect.objectContaining({ from: 'sprint_result', to: 'result', reason: 'rejected by a reviewer' })]);
    expect(report.dismissedJoins).toContain('warehouse.main.sprint_results|warehouse.main.results|result_id=result_id');
  });

  it('`zlens model validate-relationship` checks a hand-written join, records the evidence, and certifies only on request', async () => {
    const { projectRoot } = await project();
    const area = (extra: string) => `entities:
  - id: sprint_result
    relation: sprint_results
    grain: result_id
    keys: [result_id]
    status: reviewed
  - id: result
    relation: results
    grain: result_id
    keys: [result_id]
relationships:
  - id: sprint_result_to_result
    from: sprint_result
    to: result
    keys:
      - { from: race_id, to: race_id }
      - { from: driver_id, to: driver_id }
    cardinality: many_to_one
    fanout: safe
    status: draft
${extra}`;
    const modelPath = join(projectRoot, 'domains', 'f1', 'modeling', 'model.dql.yaml');
    mkdirSync(join(projectRoot, 'domains', 'f1', 'modeling'), { recursive: true });
    writeFileSync(join(projectRoot, 'domains', 'f1', 'domain.dql'), 'domain "F1" {\n  id = "f1"\n  owner = "f1@example.test"\n}\n');
    writeFileSync(modelPath, area(''));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    const flags = { format: 'json' } as CLIFlags;

    // Whole table: 1950 race 1 holds two results for driver 1, so it fails,
    // and says the join holds over the keys it reaches.
    await runModel('validate-relationship', ['sprint_result_to_result', projectRoot], flags);
    expect(process.exitCode).toBe(1);
    const first = JSON.parse(logs.pop()!) as { results: Array<{ evidence: { status: string; message: string; maxToPerKey: number; maxToPerReferencedKey: number }; written: boolean }> };
    expect(first.results[0]).toMatchObject({ written: true, evidence: { status: 'failed', maxToPerKey: 2, maxToPerReferencedKey: 1 } });
    expect(first.results[0]!.evidence.message).toMatch(/validation_scope: referenced_keys/);
    expect(readFileSync(modelPath, 'utf8')).toMatch(/status: failed/);
    // Only the evidence was added; the authored relationship is otherwise as written.
    expect(readFileSync(modelPath, 'utf8')).toMatch(/from: sprint_result\n/);

    // The author scopes the check to the keys the join reaches, and certifies.
    process.exitCode = undefined;
    writeFileSync(modelPath, area('    validation_scope: referenced_keys\n'));
    await runModel('validate-relationship', ['sprint_result_to_result', projectRoot, '--certify'], flags);
    expect(process.exitCode).toBeUndefined();
    const second = JSON.parse(logs.pop()!) as { results: Array<{ certified: boolean; evidence: { status: string; scope: string } }> };
    expect(second.results[0]).toMatchObject({ certified: true, evidence: { status: 'passed', scope: 'referenced_keys' } });
    const manifest = buildManifest({ projectRoot });
    const relationship = manifest.modeling?.relationships['f1::relationship::sprint_result_to_result'];
    expect(relationship).toMatchObject({ status: 'certified', validationScope: 'referenced_keys', automaticJoinAllowed: true, staleCertification: false });
    expect((manifest.diagnostics ?? []).filter((item) => item.kind === 'modeling')).toEqual([]);
    // `status: reviewed` on an entity stays reviewed.
    expect(manifest.modeling?.entities['f1::entity::sprint_result']?.status).toBe('reviewed');

    // A dry run reports and writes nothing.
    const before = readFileSync(modelPath, 'utf8');
    await runModel('validate-relationship', ['--all', projectRoot], { ...flags, dryRun: true });
    const dry = JSON.parse(logs.pop()!) as { results: Array<{ written: boolean }>; paths: string[] };
    expect(dry).toMatchObject({ paths: [], results: [{ written: false }] });
    expect(readFileSync(modelPath, 'utf8')).toBe(before);

    // An unknown id is named, not guessed.
    await runModel('validate-relationship', ['no_such_join', projectRoot], flags);
    expect(JSON.parse(logs.pop()!)).toMatchObject({ code: 'RELATIONSHIP_NOT_FOUND' });
  }, 60_000);

  function readWarehouseCatalogFixture() {
    // The drafter is pure: a catalog shaped like the synced one is enough.
    const relation = (name: string, columns: string[], primaryKey: string[]) => ({
      id: `warehouse.main.${name}`, schema: 'main', name, relation: `main.${name}`, kind: 'table' as const,
      columns: columns.map((column) => ({ name: column, type: 'INTEGER' })), primaryKey,
    });
    return {
      version: 1 as const, driver: 'sqlite', connectionId: 'default', scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }],
      capturedAt: '2026-09-23T00:00:00.000Z', fingerprint: 'fixture',
      relations: [
        relation('results', ['result_id', 'race_id', 'driver_id'], ['result_id']),
        relation('sprint_results', ['result_id', 'race_id', 'driver_id'], ['result_id']),
      ],
    };
  }
});
