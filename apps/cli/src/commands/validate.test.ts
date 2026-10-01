import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runValidate } from './validate.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dql-validate-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'dql.config.json'), JSON.stringify({ version: 1, name: 'validate-test' }));
  return dir;
}

function writeValidBlock(path: string): void {
  writeFileSync(path, `block "Monthly Revenue" {
    domain = "finance"
    type = "custom"
    status = "certified"
    query = """
      SELECT 1 AS revenue
    """
  }
`);
}

describe('runValidate', () => {
  it('recursively validates domain-scoped DQL files in a project folder', async () => {
    const root = tempProject();
    mkdirSync(join(root, 'blocks', 'finance'), { recursive: true });
    writeValidBlock(join(root, 'blocks', 'finance', 'monthly_revenue.dql'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runValidate(root, { format: 'text' } as any);

    expect(log.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('Validated 1 DQL file(s)');
    expect(process.exitCode).toBeUndefined();
  });

  it('validates blocks under domains/<id>/ when checking the whole project', async () => {
    const root = tempProject();
    mkdirSync(join(root, 'domains', 'finance', 'blocks'), { recursive: true });
    writeValidBlock(join(root, 'domains', 'finance', 'blocks', 'monthly_revenue.dql'));
    writeFileSync(join(root, 'domains', 'finance', 'blocks', 'broken.dql'), 'block "Broken" {');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runValidate(root, { format: 'json' } as any);

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(report.files).toBe(2);
    expect(report.diagnostics.some((diag: { file: string; severity: string }) => diag.file === 'domains/finance/blocks/broken.dql' && diag.severity === 'error')).toBe(true);
  });

  it('validates a nested single file while loading project-level context', async () => {
    const root = tempProject();
    mkdirSync(join(root, 'blocks', 'finance'), { recursive: true });
    const blockPath = join(root, 'blocks', 'finance', 'monthly_revenue.dql');
    writeValidBlock(blockPath);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runValidate(blockPath, { format: 'json' } as any);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(payload.files).toBe(1);
    expect(payload.diagnostics).toEqual([]);
  });

  it('uses configured DataLex manifest for datalex_contract validation', async () => {
    const root = tempProject();
    mkdirSync(join(root, 'blocks'), { recursive: true });
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({
      project: 'validate-test',
      datalex: { manifestPath: 'datalex-manifest.json' },
    }));
    writeFileSync(join(root, 'datalex-manifest.json'), JSON.stringify({
      manifestSpecVersion: '1.0.0',
      datalexVersion: '1.0.0',
      generatedAt: '2026-01-01T00:00:00Z',
      project: { name: 'validate-test' },
      domains: [
        {
          name: 'commerce',
          entities: [
            {
              name: 'Customer',
              contracts: [
                { id: 'commerce.Customer.monthly_active_customers', name: 'monthly_active_customers', version: 1 },
              ],
            },
          ],
        },
      ],
    }));
    writeFileSync(join(root, 'blocks', 'bad_contract.dql'), `block "Bad Contract" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  datalex_contract = "commerce.Customer.unknown_contract@1"
  query = """SELECT 1"""
}`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runValidate(root, { format: 'json' } as any);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(payload.diagnostics.some((d: any) =>
      d.severity === 'error' && d.message.includes('not found in the loaded DataLex manifest'),
    )).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('validates business-view references at the project level', async () => {
    const root = tempProject();
    mkdirSync(join(root, 'blocks'), { recursive: true });
    mkdirSync(join(root, 'business-views'), { recursive: true });
    writeValidBlock(join(root, 'blocks', 'monthly_revenue.dql'));
    writeFileSync(join(root, 'business-views', 'customer_360.dql'), `business_view "Customer 360" {
  domain = "Customer"
  includes {
    block "Missing Block"
    business_view "Missing View"
  }
}`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runValidate(root, { format: 'json' } as any);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(payload.files).toBe(2);
    expect(payload.diagnostics.some((d: any) =>
      d.severity === 'error' && d.message.includes('unresolved block refs: Missing Block'),
    )).toBe(true);
    expect(payload.diagnostics.some((d: any) =>
      d.severity === 'error' && d.message.includes('unresolved business_view refs: Missing View'),
    )).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('validates unresolved term references at the project level', async () => {
    const root = tempProject();
    mkdirSync(join(root, 'blocks'), { recursive: true });
    mkdirSync(join(root, 'business-views'), { recursive: true });
    writeFileSync(join(root, 'blocks', 'customer_identity.dql'), `block "Customer Identity" {
  domain = "Customer"
  type = "custom"
  terms = ["Missing Term"]
  query = """
    SELECT 1 AS customer_id
  """
}`);
    writeFileSync(join(root, 'business-views', 'customer_360.dql'), `business_view "Customer 360" {
  domain = "Customer"
  terms = ["Missing View Term"]
  includes {
    block "Customer Identity"
  }
}`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runValidate(root, { format: 'json' } as any);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(payload.diagnostics.some((d: any) =>
      d.severity === 'error' && d.message.includes('block "Customer Identity" has unresolved term refs: Missing Term'),
    )).toBe(true);
    expect(payload.diagnostics.some((d: any) =>
      d.severity === 'error' && d.message.includes('business_view "Customer 360" has unresolved term refs: Missing View Term'),
    )).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});

describe('runValidate retired blocks', () => {
  it('warns on blocks and App pages still using a deprecated block, and fails a replacement that is not a block', async () => {
    const root = tempProject();
    mkdirSync(join(root, 'blocks'), { recursive: true });
    writeValidBlock(join(root, 'blocks', 'monthly_revenue.dql'));
    writeFileSync(join(root, 'blocks', 'revenue_legacy.dql'), 'block "Revenue Legacy" {\n  domain = "finance"\n  type = "custom"\n  status = "deprecated"\n  replacedBy = "Monthly Revenue"\n  deprecatedOn = "2026-09-30"\n  query = """SELECT 1 AS revenue"""\n}\n');
    writeFileSync(join(root, 'blocks', 'revenue_by_month.dql'), 'block "Revenue By Month" {\n  domain = "finance"\n  type = "custom"\n  query = """SELECT * FROM ref("Revenue Legacy")"""\n}\n');
    const appDir = join(root, 'apps', 'finance');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });
    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({ version: 1, id: 'finance', name: 'Finance', domain: 'finance', owners: ['a@example.com'], members: [{ userId: 'a@example.com', roles: ['owner'] }], roles: [{ id: 'owner' }], policies: [] }));
    writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), JSON.stringify({
      version: 1, id: 'overview', metadata: { title: 'Overview', domain: 'finance' },
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'kpi', x: 0, y: 0, w: 3, h: 2, block: { blockId: 'Revenue Legacy' }, viz: { type: 'single_value' } }] },
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runValidate(root, { format: 'json' } as any);
    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { diagnostics: Array<{ severity: string; message: string }> };
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', message: 'Block "Revenue By Month" still references deprecated block "Revenue Legacy". Use "Monthly Revenue" instead.' }),
      expect.objectContaining({ severity: 'warning', message: 'App page "finance/overview" still uses deprecated block "Revenue Legacy". Use "Monthly Revenue" instead.' }),
    ]));
    expect(process.exitCode).toBeUndefined();

    writeFileSync(join(root, 'blocks', 'revenue_legacy.dql'), 'block "Revenue Legacy" {\n  domain = "finance"\n  type = "custom"\n  status = "deprecated"\n  replacedBy = "Nowhere"\n  query = """SELECT 1 AS revenue"""\n}\n');
    log.mockClear();
    await runValidate(root, { format: 'json' } as any);
    const failed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { diagnostics: Array<{ severity: string; message: string }> };
    expect(failed.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', message: 'Block "Revenue Legacy" is replaced by "Nowhere", which is not a block in this project.' }));
    expect(process.exitCode).toBe(1);
  });
});
