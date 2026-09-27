import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { closeKnowledgeConnections, createMcpKnowledgeSource, parseHits, parseDocument } from '../client/knowledge-client.js';
import { startFakeKnowledgeServer, type FakeKnowledgeServer } from '../testing/fake-knowledge-server.js';

const PAGES = [
  { id: 'claims-handbook', title: 'Claims handbook', url: 'https://harbor.example/wiki/claims-handbook', text: 'A paid claim is a claim with at least one cleared payment.', readers: ['priya-token'] },
  { id: 'regions', title: 'Region glossary', url: 'https://harbor.example/wiki/regions', text: 'West covers CA, OR and WA.' },
];

let server: FakeKnowledgeServer;
beforeAll(async () => {
  server = await startFakeKnowledgeServer({ pages: PAGES, tokens: ['priya-token', 'omar-token'] });
});
afterEach(async () => { await closeKnowledgeConnections(); });
afterAll(async () => { await server.close(); });

describe('DQL MCP knowledge client', () => {
  it('searches and reads a page over streamable HTTP with the person\'s own token', async () => {
    const source = createMcpKnowledgeSource({ id: 'confluence', label: 'Confluence', url: server.url, headers: { Authorization: 'Bearer priya-token' } });
    const hits = await source.search('paid claim');
    expect(hits[0]).toMatchObject({ id: 'claims-handbook', title: 'Claims handbook', url: 'https://harbor.example/wiki/claims-handbook' });
    const page = await source.fetch('claims-handbook');
    expect(page).toEqual({ id: 'claims-handbook', title: 'Claims handbook', url: 'https://harbor.example/wiki/claims-handbook', text: PAGES[0].text });
    expect(server.calls.slice(-2).map((entry) => [entry.tool, entry.authorization])).toEqual([['search', 'Bearer priya-token'], ['fetch', 'Bearer priya-token']]);
  });

  it('sees only what that person may see', async () => {
    const source = createMcpKnowledgeSource({ id: 'confluence', url: server.url, headers: { Authorization: 'Bearer omar-token' } });
    expect((await source.search('paid claim')).map((hit) => hit.id)).toEqual([]);
    await expect(source.fetch('claims-handbook')).rejects.toThrow(/could not read the page/);
  });

  it('is unavailable without an accepted token', async () => {
    const source = createMcpKnowledgeSource({ id: 'confluence', url: server.url });
    await expect(source.search('paid claim')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('refuses a server whose search tool says it writes', async () => {
    const writable = await startFakeKnowledgeServer({ pages: PAGES, writableSearch: true });
    try {
      const source = createMcpKnowledgeSource({ id: 'wiki', url: writable.url });
      await expect(source.search('paid')).rejects.toMatchObject({ code: 'refused' });
      expect(writable.calls).toEqual([]);
    } finally {
      await writable.close();
    }
  });

  it('never calls a tool outside the allowlist', async () => {
    const source = createMcpKnowledgeSource({ id: 'wiki', url: server.url, headers: { Authorization: 'Bearer priya-token' }, allowedTools: ['search'] });
    await expect(source.fetch('regions')).rejects.toMatchObject({ code: 'refused' });
  });

  it('refuses plain http off this machine', () => {
    expect(() => createMcpKnowledgeSource({ id: 'wiki', url: 'http://wiki.example/mcp' })).toThrow(/https/);
    expect(() => createMcpKnowledgeSource({ id: 'bad id', url: 'https://wiki.example/mcp' })).toThrow(/id/);
  });

  it('reads a local server over stdio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-knowledge-stdio-'));
    const require = createRequire(import.meta.url);
    const sdk = (path: string) => pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${path}`)).href;
    const script = join(dir, 'server.mjs');
    writeFileSync(script, `
      import { Server } from ${JSON.stringify(sdk('server/index.js'))};
      import { StdioServerTransport } from ${JSON.stringify(sdk('server/stdio.js'))};
      import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdk('types.js'))};
      const server = new Server({ name: 'notes', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: 'find', inputSchema: { type: 'object' } }, { name: 'read', inputSchema: { type: 'object' } } ] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => request.params.name === 'find'
        ? { content: [{ type: 'text', text: JSON.stringify([{ id: 'n1', title: 'Notes', url: 'https://notes.example/n1' }]) }] }
        : { content: [{ type: 'text', text: 'Plain page text for ' + request.params.arguments.page }] });
      await server.connect(new StdioServerTransport());
    `);
    const source = createMcpKnowledgeSource({ id: 'notes', command: process.execPath, args: [script], searchTool: 'find', searchArg: 'q', fetchTool: 'read', fetchArg: 'page' });
    expect(await source.search('anything')).toEqual([{ id: 'n1', title: 'Notes', url: 'https://notes.example/n1' }]);
    expect(await source.fetch('n1')).toEqual({ id: 'n1', title: 'Untitled page', text: 'Plain page text for n1' });
  });

  it('reads the common result shapes', () => {
    expect(parseHits({ structuredContent: { results: [{ content: { id: '7', title: 'Seven', _links: { webui: '/wiki/7', base: 'https://x.atlassian.net' } } }] } }))
      .toEqual([{ id: '7', title: 'Seven', url: 'https://x.atlassian.net/wiki/7' }]);
    expect(parseDocument({ content: [{ type: 'text', text: JSON.stringify({ id: '7', title: 'Seven', body: { storage: { value: '<p>Hi</p>' } } }) }] }, '7'))
      .toEqual({ id: '7', title: 'Seven', text: '<p>Hi</p>' });
  });
});
