import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

type ConnectTarget = 'codex' | 'claude-code' | 'claude-desktop' | 'cursor' | 'all';

interface ConnectResult {
  target: Exclude<ConnectTarget, 'all'>;
  path: string;
  changed: boolean;
  message: string;
  nextStep: string;
  extraPaths?: string[];
}

interface McpServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  alwaysLoad?: boolean;
}

const DQL_SERVER_NAME = 'dql';

export async function runConnect(targetArg: string | null, rest: string[], flags: CLIFlags): Promise<void> {
  const target = normalizeTarget(targetArg);
  if (!target) {
    throw new Error(
      'Usage: zlens connect <codex|claude-code|claude-desktop|cursor|all> [project-path] [--format json]',
    );
  }

  const projectRoot = findProjectRoot(resolve(rest[0] ?? process.cwd()));
  const targets = target === 'all'
    ? ['codex', 'claude-code', 'claude-desktop', 'cursor'] as const
    : [target] as const;
  const results = targets.map((item) => connectTarget(item, projectRoot));

  if (flags.format === 'json') {
    console.log(JSON.stringify({ ok: true, projectRoot, results }, null, 2));
    return;
  }

  console.log('\n  ZLens agent connection setup');
  console.log(`    Project: ${projectRoot}`);
  console.log('');
  for (const result of results) {
    console.log(`  ${result.changed ? '✓' : '•'} ${labelForTarget(result.target)}`);
    console.log(`    ${result.message}`);
    console.log(`    ${result.path}`);
    for (const extraPath of result.extraPaths ?? []) {
      console.log(`    ${extraPath}`);
    }
    console.log(`    Next: ${result.nextStep}`);
  }
  console.log('');
  console.log('  Verify before asking an agent: zlens mcp test');
  console.log('');
}

function connectTarget(target: Exclude<ConnectTarget, 'all'>, projectRoot: string): ConnectResult {
  switch (target) {
    case 'codex':
      return connectCodex(projectRoot);
    case 'claude-code':
      return connectClaudeCode(projectRoot);
    case 'claude-desktop':
      return connectClaudeDesktop(projectRoot);
    case 'cursor':
      return connectCursor(projectRoot);
  }
}

function connectCodex(projectRoot: string): ConnectResult {
  const path = join(projectRoot, '.codex', 'config.toml');
  const guidePath = join(projectRoot, 'AGENTS.md');
  const block = [
    '# BEGIN DQL MCP',
    `[mcp_servers.${DQL_SERVER_NAME}]`,
    'command = "npx"',
    `args = ${tomlStringArray(mcpServerArgs(projectRoot))}`,
    '# END DQL MCP',
    '',
  ].join('\n');
  const before = readTextIfExists(path);
  const after = replaceTomlMcpBlock(before, block);
  writeTextIfChanged(path, after);
  const guideChanged = upsertAgentGuide(guidePath, 'Codex');
  return {
    target: 'codex',
    path,
    changed: before !== after || guideChanged,
    message: 'Project Codex config and AGENTS.md now point at this ZLens project.',
    nextStep: 'Open this trusted project in Codex, then run zlens mcp test before asking analytics questions.',
    extraPaths: [guidePath],
  };
}

function connectClaudeCode(projectRoot: string): ConnectResult {
  const path = join(projectRoot, '.mcp.json');
  const guidePath = join(projectRoot, 'CLAUDE.md');
  const before = readTextIfExists(path);
  const after = upsertJsonMcpServer(before, {
    ...mcpServerConfig(projectRoot),
    alwaysLoad: true,
  });
  writeTextIfChanged(path, after);
  const guideChanged = upsertAgentGuide(guidePath, 'Claude Code');
  return {
    target: 'claude-code',
    path,
    changed: before !== after || guideChanged,
    message: 'Project .mcp.json and CLAUDE.md now point Claude Code at ZLens.',
    nextStep: 'Open Claude Code from this project and run /mcp to confirm the dql server is loaded.',
    extraPaths: [guidePath],
  };
}

function connectClaudeDesktop(projectRoot: string): ConnectResult {
  const path = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  const before = readTextIfExists(path);
  const after = upsertJsonMcpServer(before, mcpServerConfig(projectRoot));
  writeTextIfChanged(path, after);
  return {
    target: 'claude-desktop',
    path,
    changed: before !== after,
    message: 'Claude Desktop config includes this ZLens MCP server.',
    nextStep: 'Restart Claude Desktop and enable the dql tool.',
  };
}

function connectCursor(projectRoot: string): ConnectResult {
  const path = join(projectRoot, '.cursor', 'mcp.json');
  const before = readTextIfExists(path);
  const after = upsertJsonMcpServer(before, mcpServerConfig(projectRoot));
  writeTextIfChanged(path, after);
  return {
    target: 'cursor',
    path,
    changed: before !== after,
    message: 'Project Cursor MCP config includes this ZLens server.',
    nextStep: 'Open Cursor settings, enable MCP, and reload the project if needed.',
  };
}

function mcpServerConfig(projectRoot: string): McpServerConfig {
  return {
    command: 'npx',
    args: mcpServerArgs(projectRoot),
  };
}

function mcpServerArgs(projectRoot: string): string[] {
  return ['-y', '--package=@zlens/cli', 'zlens', 'mcp', projectRoot];
}

function normalizeTarget(value: string | null): ConnectTarget | null {
  const normalized = value?.trim().toLowerCase().replaceAll('_', '-') ?? '';
  if (
    normalized === 'codex' ||
    normalized === 'claude-code' ||
    normalized === 'claude-desktop' ||
    normalized === 'cursor' ||
    normalized === 'all'
  ) {
    return normalized;
  }
  return null;
}

function labelForTarget(target: Exclude<ConnectTarget, 'all'>): string {
  switch (target) {
    case 'codex':
      return 'Codex';
    case 'claude-code':
      return 'Claude Code';
    case 'claude-desktop':
      return 'Claude Desktop';
    case 'cursor':
      return 'Cursor';
  }
}

function readTextIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function writeTextIfChanged(path: string, contents: string): void {
  if (readTextIfExists(path) === contents) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

function upsertJsonMcpServer(existing: string, server: McpServerConfig): string {
  let parsed: Record<string, unknown> = {};
  if (existing.trim()) {
    try {
      parsed = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const current = parsed.mcpServers && typeof parsed.mcpServers === 'object'
    ? parsed.mcpServers as Record<string, unknown>
    : {};
  return JSON.stringify({
    ...parsed,
    mcpServers: {
      ...current,
      [DQL_SERVER_NAME]: server,
    },
  }, null, 2) + '\n';
}

function upsertAgentGuide(path: string, clientName: string): boolean {
  const before = readTextIfExists(path);
  const after = replaceMarkedBlock(before, agentGuideBlock(clientName));
  writeTextIfChanged(path, after);
  return before !== after;
}

function agentGuideBlock(clientName: string): string {
  return [
    '<!-- BEGIN DQL AGENT GUIDE -->',
    '## ZLens Agent Guide',
    '',
    `When using ${clientName} with this project, use the ZLens MCP server for analytics work.`,
    '',
    '- Start each session with `inspect_dql_project` so the agent sees the current manifest, metadata catalog, and agent index.',
    '- Route every analytics question through `ask_dql` before writing SQL.',
    '- If `ask_dql.route` is `certified`, use `query_via_block` only when the certified block grain exactly answers the question.',
    '- If `ask_dql.route` is `generated_sql`, use the returned allowed SQL context and call `query_via_metadata` with one read-only `SELECT` or `WITH` query. Show the `uncertified` status and draft path.',
    '- Use `build_dql_block` for reusable draft blocks and `build_dql_app` for governed app drafts.',
    '- Do not label generated SQL, draft blocks, or app review placeholders as certified.',
    '<!-- END DQL AGENT GUIDE -->',
    '',
  ].join('\n');
}

function replaceMarkedBlock(existing: string, block: string): string {
  const pattern = /<!-- BEGIN DQL AGENT GUIDE -->[\s\S]*?<!-- END DQL AGENT GUIDE -->\n?/;
  if (pattern.test(existing)) {
    return `${existing.replace(pattern, block).trimEnd()}\n`;
  }
  const next = existing.trimEnd();
  return `${next ? `${next}\n\n` : ''}${block}`;
}

function replaceTomlMcpBlock(existing: string, block: string): string {
  let next = existing
    .replace(/\n?# BEGIN DQL MCP\n[\s\S]*?# END DQL MCP\n?/g, '\n')
    .replace(/\n?\[mcp_servers\.dql\]\n[\s\S]*?(?=\n\[[^\]]+\]|\s*$)/g, '\n');
  next = next.trimEnd();
  return `${next ? `${next}\n\n` : ''}${block}`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}
