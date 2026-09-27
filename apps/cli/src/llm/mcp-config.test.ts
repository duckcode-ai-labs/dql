import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  anthropicMcpConfig,
  listRemoteMcpSettings,
  loadRemoteMcpServers,
  openAiMcpTools,
  remoteMcpConfigPath,
  saveRemoteMcpSettings,
} from './mcp-config.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.DQL_TEST_MCP_TOKEN;
});

describe('remote MCP config', () => {
  it('loads only enabled and trusted servers for the selected provider', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-mcp-config-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, '.dql'), { recursive: true });
    process.env.DQL_TEST_MCP_TOKEN = 'token-from-env';
    writeFileSync(remoteMcpConfigPath(projectRoot), JSON.stringify({
      servers: [
        {
          name: 'github remote',
          url: 'https://api.githubcopilot.com/mcp/',
          trusted: true,
          authorizationTokenEnv: 'DQL_TEST_MCP_TOKEN',
          allowedTools: ['search_issues'],
          providers: ['openai', 'anthropic'],
        },
        {
          name: 'untrusted',
          url: 'https://example.com/mcp',
        },
        {
          name: 'anthropic-only',
          url: 'https://example.com/anthropic',
          trusted: true,
          providers: ['anthropic'],
        },
      ],
      connectors: [
        {
          name: 'gdrive',
          connectorId: 'connector_googledrive',
          trusted: true,
          providers: ['openai'],
        },
      ],
    }, null, 2));

    const openai = loadRemoteMcpServers(projectRoot, 'openai');
    expect(openai.servers.map((server) => server.name)).toEqual(['github_remote', 'gdrive']);
    expect(openai.warnings.join('\n')).toContain('untrusted');

    const openaiTools = openAiMcpTools(openai.servers);
    expect(openaiTools[0]).toMatchObject({
      type: 'mcp',
      server_label: 'github_remote',
      server_url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer token-from-env' },
      allowed_tools: ['search_issues'],
      require_approval: 'never',
    });
    expect(openaiTools[1]).toMatchObject({
      type: 'mcp',
      server_label: 'gdrive',
      connector_id: 'connector_googledrive',
    });

    const anthropic = loadRemoteMcpServers(projectRoot, 'anthropic');
    expect(anthropic.servers.map((server) => server.name)).toEqual(['github_remote', 'anthropic-only']);
    const anthropicConfig = anthropicMcpConfig(anthropic.servers);
    expect(anthropicConfig.mcpServers[0]).toMatchObject({
      type: 'url',
      name: 'github_remote',
      authorization_token: 'token-from-env',
    });
    expect(anthropicConfig.toolsets[0]).toMatchObject({
      type: 'mcp_toolset',
      mcp_server_name: 'github_remote',
    });
  });

  it('saves UI entries and redacts stored tokens on readback', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-mcp-settings-save-'));
    tempDirs.push(projectRoot);

    const saved = saveRemoteMcpSettings(projectRoot, {
      entries: [
        {
          kind: 'server',
          name: 'internal analytics',
          url: 'https://analytics.example.com/mcp',
          trusted: true,
          enabled: true,
          authorizationToken: 'secret-token-1234',
          providers: ['openai', 'anthropic'],
        },
      ],
    });

    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]).toMatchObject({
      kind: 'server',
      name: 'internal_analytics',
      hasAuthorizationToken: true,
    });
    expect(saved.entries[0]).not.toHaveProperty('authorizationToken');

    const listed = listRemoteMcpSettings(projectRoot);
    expect(listed.entries[0].authorizationTokenPreview).toBe('secr...1234');

    const loaded = loadRemoteMcpServers(projectRoot, 'openai');
    expect(openAiMcpTools(loaded.servers)[0]).toMatchObject({
      headers: { Authorization: 'Bearer secret-token-1234' },
    });
  });

  it('keeps knowledge servers away from the chat cell and keeps their fields when Settings saves', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-mcp-config-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, '.dql'), { recursive: true });
    writeFileSync(remoteMcpConfigPath(projectRoot), JSON.stringify({
      servers: [
        { name: 'confluence', url: 'https://mcp.example/v1/mcp', use: ['knowledge'], label: 'Confluence', trusted: true, knowledge: { searchTool: 'search', fetchArgs: { cloudId: 'c1' } } },
        { name: 'notes', command: 'node', args: ['notes.mjs', '--x', '--x'], use: ['knowledge'], trusted: true },
        { name: 'both', url: 'https://both.example/mcp', use: ['chat', 'knowledge'], trusted: true },
      ],
    }));
    expect(loadRemoteMcpServers(projectRoot, 'anthropic').servers.map((server) => server.name)).toEqual(['both']);

    const listed = listRemoteMcpSettings(projectRoot);
    // Settings sends back only the fields it edits.
    saveRemoteMcpSettings(projectRoot, {
      entries: listed.entries.map((entry) => ({ kind: entry.kind, name: entry.name, url: entry.url, trusted: entry.trusted, enabled: entry.enabled })),
    });
    expect(listRemoteMcpSettings(projectRoot).entries).toEqual([
      expect.objectContaining({ name: 'confluence', use: ['knowledge'], label: 'Confluence', knowledge: { searchTool: 'search', fetchArgs: { cloudId: 'c1' } } }),
      expect.objectContaining({ name: 'notes', command: 'node', args: ['notes.mjs', '--x', '--x'], use: ['knowledge'] }),
      expect.objectContaining({ name: 'both', use: ['chat', 'knowledge'] }),
    ]);
  });
});
