/**
 * DQL'S OWN MCP CLIENT for knowledge sources (RFC 0010, HH-15).
 *
 * DQL calls a document server itself — over streamable HTTP, or stdio for a
 * local server — instead of handing the server to a model provider's hosted
 * MCP connector. That is what lets knowledge work with every provider,
 * Bedrock, Vertex and local models included.
 *
 * Read-only by construction: DQL calls exactly two tools on a server, its
 * search and its fetch, both of which must be on the server's allowlist, and
 * refuses a server that describes either as one that writes
 * (`readOnlyHint: false` or `destructiveHint: true`).
 */
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { KnowledgeDocument, KnowledgeHit, KnowledgeSource } from '@duckcodeailabs/dql-agent';

/** One knowledge server, as the project file or a host describes it. */
export interface KnowledgeServerConfig {
  /** Stable id, e.g. "confluence". */
  id: string;
  /** Shown beside citations, e.g. "Confluence". */
  label?: string;
  /** Streamable HTTP endpoint. */
  url?: string;
  /** Request headers, e.g. this person's `Authorization: Bearer …`. */
  headers?: Record<string, string>;
  /** A local server started over stdio (project file only). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** The server's search tool and its query argument (default `search` / `query`). */
  searchTool?: string;
  searchArg?: string;
  /** The server's page tool and its id argument (default `fetch` / `id`). */
  fetchTool?: string;
  fetchArg?: string;
  /** Fixed arguments sent with every search / fetch (e.g. a site id). */
  searchArgs?: Record<string, unknown>;
  fetchArgs?: Record<string, unknown>;
  /** Tools DQL may call; defaults to the search and fetch tools. */
  allowedTools?: string[];
  /** Per-call deadline. */
  timeoutMs?: number;
}

export class KnowledgeServerError extends Error {
  constructor(message: string, readonly code: 'refused' | 'unavailable' | 'tool_error' = 'unavailable') {
    super(message);
    this.name = 'KnowledgeServerError';
  }
}

interface Connection {
  client: Client;
  checked?: Promise<void>;
  lastUsed: number;
  timer?: ReturnType<typeof setTimeout>;
}

const IDLE_MS = 5 * 60_000;
const MAX_CONNECTIONS = 32;
const connections = new Map<string, Promise<Connection>>();

/** A knowledge source that reads through DQL's MCP client. */
export function createMcpKnowledgeSource(config: KnowledgeServerConfig): KnowledgeSource {
  const server = validateConfig(config);
  const searchTool = server.searchTool ?? 'search';
  const fetchTool = server.fetchTool ?? 'fetch';
  const allowed = new Set(server.allowedTools?.length ? server.allowedTools : [searchTool, fetchTool]);
  const timeout = Math.max(1000, Math.min(60_000, server.timeoutMs ?? 15_000));

  const callTool = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    if (!allowed.has(name)) throw new KnowledgeServerError(`The tool "${name}" is not on ${server.id}'s allowlist.`, 'refused');
    const connection = await connect(server, searchTool, fetchTool);
    try {
      const result = await connection.client.callTool({ name, arguments: args }, undefined, { timeout, ...(signal ? { signal } : {}) });
      if (result.isError) throw new KnowledgeServerError(`${server.id} could not ${name === searchTool ? 'search' : 'read the page'}.`, 'tool_error');
      return result as { content?: unknown; structuredContent?: unknown };
    } catch (error) {
      if (error instanceof KnowledgeServerError) throw error;
      // A connection that failed once is not reused.
      await drop(connectionKey(server));
      throw new KnowledgeServerError(`${server.id} is not reachable.`, 'unavailable');
    }
  };

  return {
    id: server.id,
    label: server.label ?? server.id,
    async search(query, options = {}) {
      const result = await callTool(searchTool, { ...(server.searchArgs ?? {}), [server.searchArg ?? 'query']: query }, options.signal);
      return parseHits(result).slice(0, Math.max(1, options.limit ?? 5));
    },
    async fetch(id, options = {}) {
      const result = await callTool(fetchTool, { ...(server.fetchArgs ?? {}), [server.fetchArg ?? 'id']: id }, options.signal);
      return parseDocument(result, id);
    },
  };
}

/** Close every open knowledge connection (server shutdown, tests). */
export async function closeKnowledgeConnections(): Promise<void> {
  const keys = [...connections.keys()];
  await Promise.all(keys.map((key) => drop(key)));
}

function validateConfig(config: KnowledgeServerConfig): KnowledgeServerConfig {
  if (!config || typeof config.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(config.id)) {
    throw new KnowledgeServerError('A knowledge server needs an id of letters, digits, _ or -.', 'refused');
  }
  if (config.url) {
    let url: URL;
    try { url = new URL(config.url); } catch { throw new KnowledgeServerError(`${config.id} has an invalid URL.`, 'refused'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    // A person's token never travels in the clear, except to this machine.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new KnowledgeServerError(`${config.id} must use https (plain http only on this machine).`, 'refused');
    }
    return config;
  }
  if (config.command) return config;
  throw new KnowledgeServerError(`${config.id} needs a url or a command.`, 'refused');
}

function connectionKey(server: KnowledgeServerConfig): string {
  return createHash('sha256').update(JSON.stringify([server.id, server.url, server.command, server.args, server.cwd, server.env, server.headers])).digest('hex');
}

async function connect(server: KnowledgeServerConfig, searchTool: string, fetchTool: string): Promise<Connection> {
  const key = connectionKey(server);
  let pending = connections.get(key);
  if (!pending) {
    if (connections.size >= MAX_CONNECTIONS) await dropOldest();
    pending = (async () => {
      const client = new Client({ name: 'dql-knowledge', version: '1' });
      const transport = server.url
        ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { ...(server.headers ?? {}) } } })
        : new StdioClientTransport({ command: server.command!, args: server.args ?? [], ...(server.env ? { env: server.env } : {}), ...(server.cwd ? { cwd: server.cwd } : {}), stderr: 'ignore' });
      await client.connect(transport);
      return { client, lastUsed: Date.now() };
    })();
    connections.set(key, pending);
    pending.catch(() => connections.delete(key));
  }
  let connection: Connection;
  try {
    connection = await pending;
  } catch {
    connections.delete(key);
    throw new KnowledgeServerError(`${server.id} is not reachable.`, 'unavailable');
  }
  connection.checked ??= checkReadOnly(connection.client, server, searchTool, fetchTool);
  try {
    await connection.checked;
  } catch (error) {
    await drop(key);
    throw error instanceof KnowledgeServerError ? error : new KnowledgeServerError(`${server.id} is not reachable.`, 'unavailable');
  }
  connection.lastUsed = Date.now();
  if (connection.timer) clearTimeout(connection.timer);
  connection.timer = setTimeout(() => { void drop(key); }, IDLE_MS);
  connection.timer.unref?.();
  return connection;
}

/** Both tools exist, and neither says it writes. */
async function checkReadOnly(client: Client, server: KnowledgeServerConfig, searchTool: string, fetchTool: string): Promise<void> {
  const listed = await client.listTools();
  for (const name of [searchTool, fetchTool]) {
    const tool = listed.tools.find((entry) => entry.name === name);
    if (!tool) throw new KnowledgeServerError(`${server.id} has no "${name}" tool.`, 'refused');
    const annotations = (tool.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean };
    if (annotations.readOnlyHint === false || annotations.destructiveHint === true) {
      throw new KnowledgeServerError(`${server.id}'s "${name}" tool can change content, so it is not used as a knowledge source.`, 'refused');
    }
  }
}

async function drop(key: string): Promise<void> {
  const pending = connections.get(key);
  connections.delete(key);
  if (!pending) return;
  try {
    const connection = await pending;
    if (connection.timer) clearTimeout(connection.timer);
    await connection.client.close();
  } catch {
    // already gone
  }
}

async function dropOldest(): Promise<void> {
  let oldest: { key: string; at: number } | undefined;
  for (const [key, pending] of connections) {
    const connection = await pending.catch(() => undefined);
    const at = connection?.lastUsed ?? 0;
    if (!oldest || at < oldest.at) oldest = { key, at };
  }
  if (oldest) await drop(oldest.key);
}

// ---- reading results ------------------------------------------------------

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined);
const str = (...values: unknown[]): string | undefined => {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  for (const value of values) if (typeof value === 'number') return String(value);
  return undefined;
};

function textParts(result: { content?: unknown }): string[] {
  return (Array.isArray(result.content) ? result.content : [])
    .map((part) => rec(part))
    .filter((part): part is Rec => Boolean(part) && part!.type === 'text' && typeof part!.text === 'string')
    .map((part) => part.text as string);
}

function parsed(result: { content?: unknown; structuredContent?: unknown }): unknown[] {
  const out: unknown[] = [];
  if (result.structuredContent !== undefined) out.push(result.structuredContent);
  for (const text of textParts(result)) {
    try { out.push(JSON.parse(text)); } catch { /* prose */ }
  }
  return out;
}

function linkOf(record: Rec): string | undefined {
  const links = rec(record._links);
  const webui = str(links?.webui);
  const base = str(links?.base);
  return str(record.url, record.webUrl, record.link, record.href) ?? (webui ? (base ? `${base}${webui}` : webui) : undefined);
}

/** Search results in the common shapes: `{results:[…]}`, a list, or `{hits|items|pages:[…]}`. */
export function parseHits(result: { content?: unknown; structuredContent?: unknown }): KnowledgeHit[] {
  for (const value of parsed(result)) {
    const record = rec(value);
    const list = Array.isArray(value) ? value : (record?.results ?? record?.hits ?? record?.items ?? record?.pages);
    if (!Array.isArray(list)) continue;
    const hits: KnowledgeHit[] = [];
    for (const entry of list) {
      const item = rec(entry);
      if (!item) continue;
      const content = rec(item.content);
      const id = str(item.id, item.pageId, item.contentId, item.ari, content?.id);
      if (!id) continue;
      hits.push({
        id,
        title: str(item.title, content?.title, item.name) ?? 'Untitled page',
        ...(linkOf(item) ?? (content ? linkOf(content) : undefined) ? { url: linkOf(item) ?? linkOf(content!) } : {}),
        ...(str(item.text, item.snippet, item.excerpt, item.summary) ? { snippet: str(item.text, item.snippet, item.excerpt, item.summary)!.slice(0, 500) } : {}),
      });
    }
    return hits;
  }
  return [];
}

/** A page in the common shapes: `{id,title,text,url}`, a body field, or plain text. */
export function parseDocument(result: { content?: unknown; structuredContent?: unknown }, id: string): KnowledgeDocument {
  for (const value of parsed(result)) {
    const record = rec(value);
    if (!record) continue;
    const body = rec(record.body);
    const text = str(record.text, record.content, record.markdown, body?.storage && rec(body.storage)?.value, body?.value);
    if (!text) continue;
    return {
      id: str(record.id, id) ?? id,
      title: str(record.title, record.name) ?? 'Untitled page',
      ...(linkOf(record) ? { url: linkOf(record) } : {}),
      text,
    };
  }
  const text = textParts(result).join('\n').trim();
  if (!text) throw new KnowledgeServerError('The page came back empty.', 'tool_error');
  return { id, title: 'Untitled page', text };
}
