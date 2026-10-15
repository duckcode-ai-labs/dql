import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cliEntry } from '../support/server';
import { clip, expect } from './support/clip-test';
import { runCaptured, Terminal } from './support/terminal';

/**
 * Connect an AI agent: `zlens connect claude-code` in the sample project writes
 * the project's .mcp.json (and a CLAUDE.md guide) so Claude Code loads the ZLens
 * MCP server. Both commands are really run; `zlens` is this repo's build.
 */
clip('mcp-connect', async ({ page, sample, director }) => {
  const project = sample.freshProject();
  const bin = join(project, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'zlens'), `#!/bin/sh\nexec node ${JSON.stringify(cliEntry)} "$@"\n`);
  chmodSync(join(bin, 'zlens'), 0o755);
  const env = { ...sample.gitEnv, npm_config_update_notifier: 'false' };
  const terminal = new Terminal(page, director, [[dirname(project), '~']]);

  await terminal.open('jaffle-shop-duckdb — zsh');
  await director.recorder.begin();

  await terminal.prompt('~/jaffle-shop-duckdb');
  const connect = runCaptured('npx zlens connect claude-code', { cwd: project, env });
  expect(connect.status, connect.output).toBe(0);
  expect(connect.output).toContain('.mcp.json');
  await terminal.type('npx zlens connect claude-code');
  await terminal.print(connect.output, 2);
  await director.beat(2200);

  await terminal.prompt('~/jaffle-shop-duckdb');
  const config = runCaptured('cat .mcp.json', { cwd: project, env });
  expect(config.output).toContain('"mcpServers"');
  await terminal.type('cat .mcp.json');
  director.poster();
  await terminal.print(config.output, 2);
  await director.beat(3200);
  await terminal.prompt('~/jaffle-shop-duckdb');
  await director.beat(1200);
});
