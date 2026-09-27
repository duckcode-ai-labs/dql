/**
 * A small MCP document server for tests and local demos: `search` and
 * `fetch` over streamable HTTP (stateless), in the shape Confluence's and
 * other search/fetch MCP servers answer. It records every call it receives
 * (tool, arguments, the Authorization header) so tests can check who asked.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface FakeKnowledgePage {
  id: string;
  title: string;
  url: string;
  text: string;
  /** Only callers whose bearer token is listed may see it; absent = everyone with any accepted token. */
  readers?: string[];
}

export interface FakeKnowledgeServerOptions {
  pages: FakeKnowledgePage[];
  /** Bearer tokens accepted; absent = no auth required. */
  tokens?: string[];
  /** Mark the search tool as one that writes (to test refusal). */
  writableSearch?: boolean;
  port?: number;
}

export interface FakeKnowledgeServer {
  url: string;
  calls: Array<{ tool: string; args: Record<string, unknown>; authorization?: string }>;
  close(): Promise<void>;
}

export async function startFakeKnowledgeServer(options: FakeKnowledgeServerOptions): Promise<FakeKnowledgeServer> {
  const calls: FakeKnowledgeServer['calls'] = [];
  const visible = (token: string | undefined) => options.pages.filter((page) => !page.readers || (token !== undefined && page.readers.includes(token)));

  const serverFor = (authorization: string | undefined) => {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const server = new Server({ name: 'fake-knowledge', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'search', description: 'Search pages', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: options.writableSearch ? { readOnlyHint: false } : { readOnlyHint: true } },
        { name: 'fetch', description: 'Read a page', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: true } },
        { name: 'update_page', description: 'Change a page', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { destructiveHint: true } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ tool: request.params.name, args, ...(authorization ? { authorization } : {}) });
      if (request.params.name === 'search') {
        const words = String(args.query ?? '').toLowerCase().split(/\W+/).filter((word) => word.length > 2);
        const results = visible(token)
          .map((page) => ({ page, score: words.filter((word) => `${page.title} ${page.text}`.toLowerCase().includes(word)).length }))
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score)
          .map(({ page }) => ({ id: page.id, title: page.title, url: page.url, text: page.text.slice(0, 160) }));
        return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
      }
      if (request.params.name === 'fetch') {
        const page = visible(token).find((entry) => entry.id === args.id);
        if (!page) return { isError: true, content: [{ type: 'text', text: 'Page not found' }] };
        return { content: [{ type: 'text', text: JSON.stringify({ id: page.id, title: page.title, url: page.url, text: page.text }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: 'Not allowed' }] };
    });
    return server;
  };

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
      if (options.tokens && !options.tokens.some((token) => authorization === `Bearer ${token}`)) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      const server = serverFor(authorization);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('fake knowledge server has no port');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    close: () => new Promise<void>((resolve) => { http.closeAllConnections?.(); http.close(() => resolve()); }),
  };
}
