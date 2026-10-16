import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, AgentProvider, AgentRunRequest } from '@zlens/agent';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { createAskPipelineRouteExecutor } from './host.js';

/**
 * A warehouse-first project (no dbt): the synced catalog is the whole account
 * of the data. The drafter reads every table of it when it fits, with the keys
 * the warehouse declares.
 */
type Table = { columns: string[]; primaryKey?: string[]; foreignKeys?: Array<{ columns: string[]; references: { relation: string; columns: string[] } }> };

// Six tables; the question names one. A plain text-to-SQL prompt shows all
// six with their keys, and so must the drafter when they fit.
const TABLES: Record<string, Table> = {
  customers: { columns: ['customer_id', 'name', 'country'], primaryKey: ['customer_id'] },
  invoices: { columns: ['invoice_id', 'customer_id', 'total'], primaryKey: ['invoice_id'], foreignKeys: [{ columns: ['customer_id'], references: { relation: 'main.customers', columns: ['customer_id'] } }] },
  invoice_lines: { columns: ['invoice_id', 'line_no', 'track_id', 'unit_price'], primaryKey: ['invoice_id', 'line_no'], foreignKeys: [{ columns: ['invoice_id'], references: { relation: 'main.invoices', columns: ['invoice_id'] } }] },
  tracks: { columns: ['track_id', 'album_id', 'title'], primaryKey: ['track_id'] },
  albums: { columns: ['album_id', 'artist_id', 'title'], primaryKey: ['album_id'] },
  artists: { columns: ['artist_id', 'name'], primaryKey: ['artist_id'] },
};

interface Setup {
  tables?: Record<string, Table>;
  /** `dbt`: a dbt manifest beside the catalog; `hybrid`: modeling.mode hybrid with no readable dbt manifest. */
  project?: 'warehouse-first' | 'dbt' | 'hybrid';
  database?: string;
  driver?: string;
  blocks?: Array<{ name: string; description: string; sql: string; certified: boolean }>;
}

function project(setup: Setup) {
  const tables = setup.tables ?? TABLES;
  const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-warehouse-first-'));
  mkdirSync(join(projectRoot, '.dql'), { recursive: true });
  const prefix = setup.database ? `${setup.database}.main` : 'main';
  const relations = Object.entries(tables).map(([name, table]) => ({
    id: `warehouse.main.${name}`, ...(setup.database ? { database: setup.database } : {}), schema: 'main', name, relation: `${prefix}.${name}`, kind: 'table',
    columns: table.columns.map((column) => ({ name: column, type: column.endsWith('_id') || column === 'line_no' ? 'INTEGER' : 'TEXT' })),
    ...(table.primaryKey ? { primaryKey: table.primaryKey } : {}), ...(table.foreignKeys ? { foreignKeys: table.foreignKeys } : {}),
  }));
  writeFileSync(join(projectRoot, '.dql', 'warehouse-catalog.json'), JSON.stringify({ version: 1, driver: setup.driver ?? 'sqlite', connectionId: 'default', scopes: [{ catalogOrDatabase: setup.database ?? 'main', schemas: ['main'] }], relations, capturedAt: '2026-09-22T00:00:00.000Z', fingerprint: 'sha256:test' }));
  const blocks = Object.fromEntries((setup.blocks ?? []).map((block) => [block.name, {
    name: block.name, description: block.description, sql: block.sql, filePath: `blocks/${block.name}.dql`, domain: 'shop', owner: 'analytics@shop.test',
    status: block.certified ? 'certified' : 'draft', tags: [], certification: block.certified ? { status: 'certified' } : undefined,
  }]));
  const manifest = {
    sources: {},
    ...(setup.blocks ? { blocks } : {}),
    ...(setup.project === 'hybrid' ? { modeling: { mode: 'hybrid', packages: {}, areas: {} } } : {}),
    dbtProvenance: {
      // A dbt project has a dbt manifest beside the catalog: dbt owns its
      // prompts, so the warehouse keys are not added to them.
      manifestPath: setup.project === 'dbt' ? 'target/manifest.json' : '', manifestFingerprint: 'none', metricFlow: {},
      warehouseCatalogPath: '.dql/warehouse-catalog.json', warehouseCatalogFingerprint: 'sha256:test',
      nodes: Object.fromEntries(relations.map((relation) => [relation.id, { uniqueId: relation.id, resourceType: 'warehouse', name: relation.name, relation: relation.relation, identityFingerprint: relation.id, available: { description: false, columns: true, tests: false, catalogTypes: true, dqlMeta: false } }])),
    },
  };
  return { projectRoot, manifest };
}

const READING = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Invoice totals by country.', measures: [{ ref: 'metric:shop.invoice_total' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' });
const isDraft = (messages: AgentMessage[]) => messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement');

async function ask(setup: Setup, question: string, draft: (prompt: string) => string, rows: Array<Record<string, unknown>> = []) {
  const { projectRoot, manifest } = project(setup);
  const prompts: string[] = [];
  let readings = 0;
  const executed: string[] = [];
  const route = createAskPipelineRouteExecutor({
    projectRoot,
    executor: { executeQuery: vi.fn(async (sql: string) => {
      executed.push(sql);
      // Key probes (GROUP BY … HAVING COUNT(*) > 1) find no repeats.
      if (/HAVING COUNT\(\*\) > 1/.test(sql)) return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      return { columns: Object.keys(rows[0] ?? {}), rowCount: rows.length, executionTimeMs: 1, rows };
    }) } as unknown as QueryExecutor,
    resolveConnection: async () => ({ driver: setup.driver ?? 'sqlite' } as ConnectionConfig),
    getSemanticLayer: () => undefined,
    getManifest: () => ({ snapshotId: `snapshot:${projectRoot}`, manifest: manifest as never }),
    selectProvider: async () => ({
      name: 'ollama', available: async () => true,
      generate: async (messages: AgentMessage[]) => {
        if (!isDraft(messages)) { readings += 1; return READING; }
        const prompt = messages.map((message) => message.content).join('\n');
        prompts.push(prompt);
        return draft(prompt);
      },
    }) as AgentProvider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
  try {
    const result = await route({ runId: `run:${question}`, request: { question, requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {} });
    return { result, prompts, readings, executed };
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

const declined = () => 'NO_SQL: nothing to draft in this test.';

describe('a warehouse-first draft reads the whole schema with its declared keys', () => {
  it('shows every table once, the primary keys and the foreign keys the warehouse declares', async () => {
    const { prompts } = await ask({}, 'Total invoice amount for each customer country', declined);
    expect(prompts.length).toBeGreaterThan(0);
    const prompt = prompts[0]!;
    for (const name of Object.keys(TABLES)) expect(prompt.match(new RegExp(`executable relation:[^\\n]*\\b${name}\\b`, 'g'))).toHaveLength(1);
    expect(prompt).toContain('primary key (invoice_id, line_no): one row per invoice_id, line_no');
    expect(prompt).toContain('foreign key (customer_id) references main.customers (customer_id)');
    expect(prompt).toContain('DIALECT NOTES (sqlite): there is no MEDIAN');
  });

  it('an engine without notes gets none; a dbt or hybrid project gets no warehouse keys and is not shown whole', async () => {
    expect((await ask({ driver: 'duckdb' }, 'Total invoice amount for each customer country', declined)).prompts[0]).not.toContain('DIALECT NOTES');
    for (const kind of ['dbt', 'hybrid'] as const) {
      const prompt = (await ask({ project: kind }, 'Total invoice amount for each customer country', declined)).prompts[0] ?? '';
      expect(prompt).not.toContain('primary key (');
      expect(prompt).not.toContain('foreign key (');
      expect(prompt).not.toContain('DIALECT NOTES');
      expect(prompt).not.toContain('executable relation:main.artists');
    }
  });

  it('a schema too large for the budget is chosen from as before', async () => {
    const wide: Record<string, Table> = {};
    for (let index = 0; index < 60; index += 1) wide[`ledger_${index}`] = { columns: Array.from({ length: 40 }, (_, column) => `measure_${column}_of_a_long_ledger_column_name`), primaryKey: ['measure_0_of_a_long_ledger_column_name'] };
    wide.customers = TABLES.customers!;
    const { prompts } = await ask({ tables: wide }, 'How many customers are there in each country', declined);
    const prompt = prompts[0] ?? '';
    expect((prompt.match(/executable relation:/g) ?? []).length).toBeLessThanOrEqual(8);
    expect(prompt).toContain('executable relation:main.customers');
  });
});
