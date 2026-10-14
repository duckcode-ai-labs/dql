import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { runConnect } from './connect.js';
import type { CLIFlags } from '../args.js';

describe('runConnect', () => {
  it('writes project-local Cursor MCP config', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-connect-cursor-'));
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'test' }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConnect('cursor', [projectDir], flags());

    const config = JSON.parse(readFileSync(join(projectDir, '.cursor', 'mcp.json'), 'utf-8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    expect(config.mcpServers?.dql?.command).toBe('npx');
    expect(config.mcpServers?.dql?.args).toEqual(['-y', '--package=@zlens/cli', 'zlens', 'mcp', projectDir]);
    spy.mockRestore();
  });

  it('writes Claude Code project MCP config and instructions', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-connect-claude-'));
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'test' }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConnect('claude-code', [projectDir], flags());

    const config = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf-8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; alwaysLoad?: boolean }>;
    };
    expect(config.mcpServers?.dql?.command).toBe('npx');
    expect(config.mcpServers?.dql?.args).toEqual(['-y', '--package=@zlens/cli', 'zlens', 'mcp', projectDir]);
    expect(config.mcpServers?.dql?.alwaysLoad).toBe(true);
    expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf-8')).toContain('ask_dql');
    spy.mockRestore();
  });

  it('writes Codex project config and instructions', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-connect-codex-'));
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'test' }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConnect('codex', [projectDir], flags());

    const config = readFileSync(join(projectDir, '.codex', 'config.toml'), 'utf-8');
    expect(config).toContain('[mcp_servers.dql]');
    expect(config).toContain(JSON.stringify(projectDir));
    expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf-8')).toContain('inspect_dql_project');
    spy.mockRestore();
  });
});

function flags(): CLIFlags {
  return {
    check: false,
    chart: '',
    domain: '',
    format: 'text',
    help: false,
    open: null,
    input: '',
    outDir: '',
    owner: '',
    port: null,
    queryOnly: false,
    template: '',
    connection: '',
    verbose: false,
    skipTests: false,
    version: false,
  };
}
