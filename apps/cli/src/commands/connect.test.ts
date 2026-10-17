import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { dqlToolNamesForSurface } from '@zlens/agent';
import { agentGuideBlock, claudeDesktopConfigPath, desktopServerConfig, runConnect } from './connect.js';
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
    // Codex allows 10 s to start a server and 60 s per tool by default: too
    // short for the first npx download and for answer_question.
    expect(config).toContain('startup_timeout_sec = 60');
    expect(config).toContain('tool_timeout_sec = 600');
    spy.mockRestore();
  });

  it('writes an agent guide that names only tools the default MCP profile serves', () => {
    const served = new Set<string>(dqlToolNamesForSurface('mcp_agentic'));
    const everyTool = new Set<string>(dqlToolNamesForSurface('mcp'));
    const guide = agentGuideBlock('Codex');
    const named = [...guide.matchAll(/`([a-z][a-z0-9_]+)`/g)].map((match) => match[1]!).filter((word) => everyTool.has(word));
    expect(named.length).toBeGreaterThan(15);
    for (const name of named) expect(served.has(name), `guide names ${name}, which the default profile does not serve`).toBe(true);
    // The old guide sent agents to these full-profile-only tools.
    expect(guide).not.toContain('build_dql_block');
    for (const label of ['Certified', 'AI-Generated', 'modelUnavailable']) expect(guide).toContain(label);
  });

  it('writes Claude Desktop config into the user config (temp HOME) with a launchable npx and PATH', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-connect-desktop-'));
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'test' }));
    const home = mkdtempSync(join(tmpdir(), 'dql-connect-home-'));
    const previous = { HOME: process.env.HOME, APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    process.env.APPDATA = join(home, 'AppData', 'Roaming');
    delete process.env.XDG_CONFIG_HOME;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const path = claudeDesktopConfigPath();
      expect(path.startsWith(home)).toBe(true);
      await runConnect('claude-desktop', [projectDir], flags());
      const config = JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };
      const server = config.mcpServers.dql!;
      expect(server.args).toEqual(['-y', '--package=@zlens/cli', 'zlens', 'mcp', projectDir]);
      if (existsSync(join(dirname(process.execPath), 'npx'))) {
        expect(server.command).toBe(join(dirname(process.execPath), 'npx'));
        expect(server.env?.PATH?.split(':')[0]).toBe(dirname(process.execPath));
        // Launched with the bare environment a desktop app has, npx and node still resolve.
        const launched = spawnSync(server.command, ['--version'], { env: { PATH: server.env!.PATH!, HOME: home }, encoding: 'utf-8' });
        expect(launched.status, launched.stderr).toBe(0);
      }
      // Running it again keeps other servers.
      const existing = JSON.parse(readFileSync(path, 'utf-8'));
      existing.mcpServers.other = { command: 'other' };
      writeFileSync(path, JSON.stringify(existing));
      await runConnect('claude-desktop', [projectDir], flags());
      expect(JSON.parse(readFileSync(path, 'utf-8')).mcpServers.other).toEqual({ command: 'other' });
    } finally {
      spy.mockRestore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('knows where Claude Desktop keeps its config on macOS, Windows and Linux', () => {
    expect(claudeDesktopConfigPath('darwin')).toMatch(/Library\/Application Support\/Claude\/claude_desktop_config\.json$/);
    expect(claudeDesktopConfigPath('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' })).toContain(join('C:\\Users\\a\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
    expect(claudeDesktopConfigPath('linux', { XDG_CONFIG_HOME: '/x/config' })).toBe(join('/x/config', 'Claude', 'claude_desktop_config.json'));
  });

  it('falls back to a bare npx when no npx sits next to node', () => {
    expect(desktopServerConfig('/p', '/nowhere/bin/node', 'darwin')).toEqual({ command: 'npx', args: ['-y', '--package=@zlens/cli', 'zlens', 'mcp', '/p'] });
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
