import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIFlags } from '../args.js';
import { formatMcpTestReport, runMcp, summarizeMcpTest } from './mcp.js';

const dirs: string[] = [];
const servers: Server[] = [];
const originalRuntimeUrl = process.env.ZLENS_RUNTIME_URL;

afterEach(async () => {
  process.exitCode = undefined;
  if (originalRuntimeUrl === undefined) delete process.env.ZLENS_RUNTIME_URL;
  else process.env.ZLENS_RUNTIME_URL = originalRuntimeUrl;
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zlens-mcp-test-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'dql.config.json'), JSON.stringify({ project: 'mcp-test' }));
  return dir;
}

/** A stand-in workbench: `status` for each path it serves. */
async function runtime(status: Record<string, number>): Promise<string> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    res.writeHead(status[path] ?? 404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A port nothing listens on. */
async function deadUrl(): Promise<string> {
  const url = await runtime({});
  await new Promise<void>((done) => servers.pop()!.close(() => done()));
  return url;
}

async function mcpTest(dir: string, flags: Partial<CLIFlags> = {}): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  await runMcp('test', [dir], flags as CLIFlags);
  return lines.join('\n');
}

describe('zlens mcp test', () => {
  it('says Ready and exits 0 when every check passes, the workbench included', async () => {
    const dir = project();
    process.env.ZLENS_RUNTIME_URL = await runtime({ '/api/schema': 200, '/api/app-datasets': 200 });
    const output = await mcpTest(dir);
    expect(output).toContain('✓ ZLens runtime (governed generation + execution)');
    expect(output).toContain('✓ Dataset MCP runtime capability');
    expect(output).not.toContain('✗');
    expect(output).toContain('Ready: point Claude Code, Codex, Cursor, or Claude Desktop at this project with `zlens connect`.');
    expect(process.exitCode ?? 0).toBe(0);
  }, 30_000);

  it('never says Ready when the workbench is down, exits 1, and names the command that starts it', async () => {
    const dir = project();
    process.env.ZLENS_RUNTIME_URL = await deadUrl();
    const output = await mcpTest(dir);
    expect(output).not.toContain('Ready:');
    expect(output).toContain('✗ ZLens runtime (governed generation + execution)');
    expect(output).toContain('✗ Dataset MCP runtime capability');
    // One line per failed check says what to do, and it is the workbench, not `zlens serve`.
    const fixes = output.split('\n').filter((line) => line.trim().startsWith('Fix:'));
    expect(fixes).toHaveLength(2);
    for (const fix of fixes) {
      expect(fix).toContain(`zlens notebook ${dir}`);
      expect(fix).toContain('npm run notebook');
    }
    expect(output).not.toMatch(/zlens serve/);
    expect(output).toContain('Not ready: 2 checks failed (ZLens runtime (governed generation + execution), Dataset MCP runtime capability).');
    expect(process.exitCode).toBe(1);
  }, 30_000);

  it('fails the Dataset check when the address answers but is not a ZLens workbench', async () => {
    const dir = project();
    process.env.ZLENS_RUNTIME_URL = await runtime({ '/api/schema': 200 });
    const output = await mcpTest(dir);
    expect(output).toContain('✓ ZLens runtime (governed generation + execution)');
    expect(output).toContain('✗ Dataset MCP runtime capability');
    expect(output).toMatch(/Fix: the server at http:\/\/127\.0\.0\.1:\d+ is not this project's ZLens workbench/);
    expect(output).not.toContain('Ready:');
    expect(process.exitCode).toBe(1);
  }, 30_000);

  it('reports the same verdict and exit code as JSON', async () => {
    const dir = project();
    process.env.ZLENS_RUNTIME_URL = await deadUrl();
    const report = JSON.parse(await mcpTest(dir, { format: 'json' })) as { ok: boolean; failed: string[]; checks: Array<{ name: string; ok: boolean; fix?: string }> };
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual(['ZLens runtime (governed generation + execution)', 'Dataset MCP runtime capability']);
    expect(report.checks.find((check) => !check.ok)?.fix).toContain('zlens notebook');
    expect(process.exitCode).toBe(1);
  }, 30_000);

  it('fails without a ZLens project and says how to point at one', () => {
    const report = summarizeMcpTest('/nowhere', [
      { name: 'ZLens project', ok: false, detail: 'dql.config.json not found in /nowhere', fix: 'run this from your ZLens project folder, or pass its path: `zlens mcp test <path>`' },
      { name: 'MCP tool surface', ok: true, detail: 'available' },
    ]);
    const text = formatMcpTestReport(report);
    expect(report.ok).toBe(false);
    expect(text).toContain('✗ ZLens project');
    expect(text).toContain('Fix: run this from your ZLens project folder');
    expect(text).toContain('Not ready: 1 check failed (ZLens project).');
    expect(text).not.toContain('Ready:');
  });
});
