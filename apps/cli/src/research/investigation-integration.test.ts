import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAskNarration, type InvestigationReportV1 } from '@zlens/agent';
import { startLocalServer } from '../local-runtime.js';
import { createSeededSqliteExecutor, type GoldenSeed, type SeededSqliteExecutor } from '../testkit/seeded-sqlite-executor.js';

/**
 * RESEARCH OVER REAL DATA. The jaffle-golden fixture served by the local
 * server over the seeded engine, with a drop planted in the seed: the customer
 * who spent most in August 2025 loses every August order. "revenue by month"
 * is asked (a recorded reading, replayed), then Research deeper starts from
 * that answer — no AI call — and every figure it reports is checked against
 * SQL run on the same seed. (Every seed order is at one location and nearly
 * every one includes a drink, so those breakdowns are rightly ruled out.)
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../test/fixtures/jaffle-golden');

type Row = Record<string, unknown>;
const seed = JSON.parse(readFileSync(join(fixtureDir, 'seeds', 'seed.json'), 'utf8')) as GoldenSeed;
const ordersTable = seed.tables['dev.orders'] as unknown as { rows: Row[] };
const inAugust = (row: Row) => String(row.ordered_at) >= '2025-08-01' && String(row.ordered_at) < '2025-09-01';
const spend = new Map<string, number>();
for (const row of ordersTable.rows.filter(inAugust)) spend.set(String(row.customer_id), (spend.get(String(row.customer_id)) ?? 0) + Number(row.order_total));
const planted = [...spend.entries()].sort((left, right) => right[1] - left[1])[0]![0];
ordersTable.rows = ordersTable.rows.filter((row) => !(inAugust(row) && String(row.customer_id) === planted));

let executor: SeededSqliteExecutor;
let server: Server | undefined;
let base = '';
let root = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dql-investigation-integration-'));
  cpSync(fixtureDir, root, { recursive: true });
  rmSync(join(root, '.dql'), { recursive: true, force: true });
  rmSync(join(root, 'test-cassettes'), { recursive: true, force: true });
  process.env.ZLENS_EVAL_CASSETTE_DIR = join(fixtureDir, 'test-cassettes', 'golden');
  process.env.ZLENS_EVAL_CASSETTE_MODE = 'replay';
  executor = createSeededSqliteExecutor(seed);
  const port = await startLocalServer({
    rootDir: root, projectRoot: root, executor, connection: { driver: 'sqlite', filepath: ':memory:' }, preferredPort: 0,
    captureServer: (created) => { server = created; },
  });
  base = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  rmSync(root, { recursive: true, force: true });
});

async function run(body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${base}/api/agent-runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return ((await response.json()) as { run: unknown }).run;
}

describe('Research investigates a planted drop in real data', () => {
  it('finds the customer whose orders stopped, with the exact share of the change, from governed queries and no AI call', async () => {
    const asked = await run({ question: 'revenue by month', requestedMode: 'ask' });
    expect(asked.status).toBe('completed');
    const researched = await run({ question: 'Research deeper: revenue by month', requestedMode: 'research', workspaceContext: { researchSource: { runId: asked.id } } });
    const report = researched.artifacts.find((artifact: any) => artifact.kind === 'research_run').payload.investigation as InvestigationReportV1;
    const ledger = researched.diagnosticReceiptV9.investigation;

    // The oracle: order totals by customer in both months, on the same seed.
    const oracle = executor.query(`
      SELECT c.customer_name AS customer,
        SUM(CASE WHEN o.ordered_at >= '2025-08-01' AND o.ordered_at < '2025-09-01' THEN o.order_total ELSE 0 END) AS august,
        SUM(CASE WHEN o.ordered_at >= '2025-07-01' AND o.ordered_at < '2025-08-01' THEN o.order_total ELSE 0 END) AS july
      FROM dev.orders o JOIN dev.customers c ON c.customer_id = o.customer_id
      GROUP BY c.customer_name`);
    const august = oracle.reduce((sum, row) => sum + Number(row.august), 0);
    const july = oracle.reduce((sum, row) => sum + Number(row.july), 0);
    const plantedName = String(executor.query(`SELECT customer_name FROM dev.customers WHERE customer_id = '${planted}'`)[0]!.customer_name);
    const plantedRow = oracle.find((row) => row.customer === plantedName)!;

    expect(report.frame).toMatchObject({ metric: { ref: 'metric:orders.order_total' }, windows: { current: { label: 'August 2025' }, prior: { label: 'July 2025' } } });
    expect(Number(report.headline.current!.value)).toBeCloseTo(august, 6);
    expect(Number(report.headline.prior!.value)).toBeCloseTo(july, 6);

    const customer = report.drivers.find((driver) => driver.path.length === 1 && driver.path[0]!.member.label === plantedName);
    expect(customer, report.text).toBeDefined();
    expect(['supported', 'partial']).toContain(customer!.verdict);
    expect(Number(customer!.delta.value)).toBeCloseTo(-Number(plantedRow.july), 6);
    expect(Number(customer!.share)).toBeCloseTo((Number(plantedRow.august) - Number(plantedRow.july)) / (august - july), 6);
    // Location and drink orders are one member each in this seed: in line with their size.
    expect(report.ruledOut.map((entry) => entry.dimension.label)).toEqual(expect.arrayContaining(['location name', 'is drink order']));

    expect(ledger.budget.aiCalls).toBe(0);
    expect(ledger.budget.statementsUsed).toBeLessThanOrEqual(20);
    expect(report.queries.filter((query) => query.purpose === 'contribution' && query.outcome === 'answered').every((query) => query.tier === 'semantic' || query.tier === 'relational')).toBe(true);
    const verification = verifyAskNarration({ text: report.text, factSet: report.facts });
    expect({ failures: verification.failures, unverified: verification.unverified }, report.text).toEqual({ failures: [], unverified: [] });
  }, 120_000);
});
