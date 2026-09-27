import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createScriptedAnalystProvider,
  type AgentMessage,
  type AgentProvider,
} from '@duckcodeailabs/dql-agent';
import { closeKnowledgeConnections, startFakeKnowledgeServer, type FakeKnowledgeServer } from '@duckcodeailabs/dql-mcp';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { knowledgeServersFor, knowledgeSessionFor, normalizeHostKnowledgeServer } from './knowledge-sources.js';
import { withKnowledgeWithheld } from './answer-knowledge.js';
import type { DqlAuditEvent } from './observability.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';

/**
 * RFC 0010 HH-15: Ask answers cite team documents read through DQL's own MCP
 * client; the governed answer, its figures and its trust never change.
 */
const here = dirname(fileURLToPath(import.meta.url));
const QUESTION = 'Who are the top customers by lifetime spend?';
const PAGE_TEXT = 'Lifetime spend is the total a customer paid across every order. The top tier averages 98,765 dollars a year.';

const PEOPLE: Record<string, DqlPrincipal> = {
  maria: { id: 'u-maria', kind: 'person', email: 'maria@insurer.example', source: 'host' },
  dev: { id: 'u-dev', kind: 'person', email: 'dev@insurer.example', source: 'host' },
};

/** The scripted analyst answers the data; knowledge turns search, read one page, then write a note. */
function provider(): AgentProvider {
  const analyst = createScriptedAnalystProvider('cooperative');
  const call = (tool: string, input: unknown) => '```json\n' + JSON.stringify({ tool, input }) + '\n```';
  return {
    ...analyst,
    name: analyst.name,
    available: () => analyst.available(),
    async generate(messages: AgentMessage[], options) {
      const system = messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n');
      if (!system.includes("You look up what the team's documents say")) return analyst.generate(messages, options);
      const observations = messages.filter((message) => message.role === 'user' && /knowledge_(search|document)/.test(String(message.content)));
      if (observations.length === 0) return call('search_knowledge', { query: 'lifetime spend' });
      if (observations.length === 1) {
        const id = /"id":\s*"([^"]+)"/.exec(String(observations[0]!.content))?.[1];
        return id ? call('fetch_knowledge_page', { source: 'wiki', id }) : 'NONE';
      }
      return 'The Customer glossary defines lifetime spend as the total a customer paid across every order. It says the top tier averages 98,765 dollars a year.';
    },
  } as AgentProvider;
}

function executor(): QueryExecutor {
  return {
    executeQuery: async (sql: string) => {
      const rows = [1, 2, 3].map((index) => ({ customer_name: `Customer ${index}`, lifetime_spend: 1000 - index }));
      return { columns: ['customer_name', 'lifetime_spend'], rows, rowCount: rows.length, sql };
    },
  } as unknown as QueryExecutor;
}

let knowledge: FakeKnowledgeServer;
const servers: Server[] = [];
const roots: string[] = [];
beforeAll(async () => {
  knowledge = await startFakeKnowledgeServer({
    tokens: ['maria-token', 'project-token'],
    pages: [{ id: 'glossary', title: 'Customer glossary', url: 'https://wiki.example/glossary', text: PAGE_TEXT }],
  });
});
afterEach(async () => {
  await closeKnowledgeConnections();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(async () => { await knowledge.close(); });

async function start(hostHooks?: DqlHostHooks, projectFile = false): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dql-knowledge-'));
  roots.push(root);
  cpSync(resolve(here, '../../test/fixtures/jaffle-semantic'), root, { recursive: true });
  rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
  if (projectFile) {
    mkdirSync(join(root, '.dql'), { recursive: true });
    writeFileSync(join(root, '.dql', 'mcp-servers.json'), JSON.stringify({
      servers: [{ name: 'wiki', label: 'Team wiki', url: knowledge.url, use: ['knowledge'], trusted: true, authorizationToken: 'project-token' }],
    }));
  }
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor: executor(),
    connection: { driver: 'file' },
    askAnalyticalPlannerProviderFactory: () => provider(),
    preferredPort: 0,
    ...(hostHooks ? { hostHooks } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  return `http://127.0.0.1:${port}`;
}

async function ask(base: string, person?: string) {
  const response = await fetch(`${base}/api/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(person ? { 'x-test-person': person } : {}) },
    body: JSON.stringify({ question: QUESTION, requestedMode: 'ask' }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as { run: any }).run;
}

const hostWith = (extra: Partial<DqlHostHooks>): DqlHostHooks => ({
  resolvePrincipal: (req: IncomingMessage) => PEOPLE[String(req.headers['x-test-person'])] ?? null,
  ...extra,
});

describe('knowledge sources (RFC 0010 HH-15)', () => {
  it('without a host, cites the project file\'s knowledge server beside an unchanged governed answer', async () => {
    const plain = await ask(await start());
    const cited = await ask(await start(undefined, true));
    expect(plain.knowledge).toBeUndefined();
    expect(plain.trustState).toBe('certified');
    expect(cited.knowledge).toEqual({
      version: 1,
      note: 'The Customer glossary defines lifetime spend as the total a customer paid across every order.',
      citations: [{ sourceId: 'wiki', sourceLabel: 'Team wiki', docId: 'glossary', title: 'Customer glossary', url: 'https://wiki.example/glossary' }],
      contextOnly: true,
      figuresRemoved: 1,
    });
    // Citing a document changes nothing about the answer's trust or figures.
    expect(cited.trustState).toBe(plain.trustState);
    expect(cited.status).toBe(plain.status);
    expect(cited.answer).toBe(plain.answer);
    expect(JSON.stringify(cited)).not.toContain('98,765');
    expect(cited.diagnosticReceiptV9.story.at(-1)).toMatchObject({ phase: 'search', title: 'Read a team document' });
    expect(knowledge.calls.filter((call) => call.authorization === 'Bearer project-token').map((call) => call.tool)).toEqual(['search', 'fetch']);
  }, 120_000);

  it('with a host, reads each person\'s sources with their own token, through the tool gate, and audits ids only', async () => {
    const audit: DqlAuditEvent[] = [];
    const gated: Array<{ name: string; principal: string | null }> = [];
    const base = await start(hostWith({
      knowledgeSources: (principal) => (principal.id === 'u-maria'
        ? [{ id: 'wiki', label: 'Team wiki', url: knowledge.url, headers: { Authorization: 'Bearer maria-token' } }]
        : []),
      tools: async (call, next) => { gated.push({ name: call.name, principal: call.principal?.id ?? null }); return next(); },
      audit: (event) => { audit.push(event); },
    }), true);
    knowledge.calls.length = 0;
    const maria = await ask(base, 'maria');
    const dev = await ask(base, 'dev');
    expect(maria.knowledge?.citations.map((citation: any) => citation.docId)).toEqual(['glossary']);
    // Dev has no source of his own; the project file's key is never used for a host's people.
    expect(dev.knowledge).toBeUndefined();
    expect(dev.trustState).toBe(maria.trustState);
    expect(knowledge.calls.map((call) => call.authorization)).toEqual(['Bearer maria-token', 'Bearer maria-token']);
    expect(gated.filter((call) => call.name.includes('knowledge'))).toEqual([
      { name: 'search_knowledge', principal: 'u-maria' },
      { name: 'fetch_knowledge_page', principal: 'u-maria' },
    ]);
    const events = audit.filter((event) => event.kind === 'knowledge');
    expect(events).toEqual([
      expect.objectContaining({ kind: 'knowledge', action: 'search', sourceId: 'wiki', outcome: 'ok', resultCount: 1, principalId: 'u-maria', runId: maria.id }),
      expect.objectContaining({ kind: 'knowledge', action: 'fetch', sourceId: 'wiki', docId: 'glossary', url: 'https://wiki.example/glossary', outcome: 'ok', principalId: 'u-maria' }),
    ]);
    const recorded = JSON.stringify(audit);
    expect(recorded).not.toContain('lifetime spend');
    expect(recorded).not.toContain('Lifetime spend is');
    expect(recorded).not.toContain(QUESTION);
  }, 120_000);

  it('a gate that refuses knowledge tools, or a hook that fails, leaves the answer without documents', async () => {
    const refused = await start(hostWith({
      knowledgeSources: () => [{ id: 'wiki', url: knowledge.url, headers: { Authorization: 'Bearer maria-token' } }],
      tools: async (call, next) => { if (call.name.includes('knowledge')) throw new Error('off'); return next(); },
    }));
    const failing = await start(hostWith({ knowledgeSources: () => { throw new Error('token store down'); } }));
    const [first, second] = [await ask(refused, 'maria'), await ask(failing, 'maria')];
    expect(first.knowledge).toBeUndefined();
    expect(second.knowledge).toBeUndefined();
    expect(first.trustState).toBe(second.trustState);
  }, 120_000);
});

describe('which knowledge servers a person gets', () => {
  it('fails closed and keeps only well-formed host servers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-knowledge-servers-'));
    roots.push(root);
    mkdirSync(join(root, '.dql'));
    writeFileSync(join(root, '.dql', 'mcp-servers.json'), JSON.stringify({ servers: [
      { name: 'wiki', url: 'https://wiki.example/mcp', use: ['knowledge'], trusted: true, authorizationToken: 't' },
      { name: 'notes', command: 'node', args: ['notes.mjs'], use: ['knowledge'], trusted: true },
      { name: 'chat-only', url: 'https://chat.example/mcp', trusted: true },
      { name: 'untrusted', url: 'https://x.example/mcp', use: ['knowledge'] },
    ] }));
    const local: DqlPrincipal = { id: 'me', kind: 'person', source: 'local' };
    expect(await knowledgeServersFor({ projectRoot: root, hooks: undefined, principal: local })).toEqual([
      { id: 'wiki', url: 'https://wiki.example/mcp', headers: { Authorization: 'Bearer t' } },
      { id: 'notes', command: 'node', args: ['notes.mjs'], cwd: root },
    ]);
    expect(await knowledgeServersFor({ projectRoot: root, hooks: { resolvePrincipal: () => null }, principal: PEOPLE.maria })).toEqual([]);
    expect(await knowledgeServersFor({ projectRoot: root, hooks: { knowledgeSources: () => [{ id: 'w', url: 'https://w' }] }, principal: null })).toEqual([]);
    expect(await knowledgeServersFor({ projectRoot: root, hooks: { knowledgeSources: async () => { throw new Error('x'); } }, principal: PEOPLE.maria })).toEqual([]);
    expect(await knowledgeServersFor({
      projectRoot: root,
      hooks: { knowledgeSources: () => [{ id: 'w', url: 'https://w', headers: { Authorization: 'Bearer a', Bad: 3 as never } }, { id: 'w', url: 'https://dup' }, { id: 'bad id', url: 'https://x' } as never] },
      principal: PEOPLE.maria,
    })).toEqual([{ id: 'w', url: 'https://w', headers: { Authorization: 'Bearer a' } }]);
    expect(normalizeHostKnowledgeServer({ id: 'x' })).toBeUndefined();
  });
});

describe('team documents and a model off this machine', () => {
  it('without a host, reads pages only for a model on this machine, or for servers the person allowed to reach hosted models', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-knowledge-hosted-'));
    roots.push(root);
    mkdirSync(join(root, '.dql'));
    writeFileSync(join(root, '.dql', 'mcp-servers.json'), JSON.stringify({ servers: [
      { name: 'wiki', label: 'Team wiki', url: 'https://wiki.example/mcp', use: ['knowledge'], trusted: true },
      { name: 'handbook', label: 'Public handbook', url: 'https://handbook.example/mcp', use: ['knowledge'], trusted: true, knowledge: { hostedModels: true } },
    ] }));
    const local: DqlPrincipal = { id: 'me', kind: 'person', source: 'local' };
    const read: string[][] = [];
    const sessionFor = async (onThisMachine: boolean) => {
      const used: string[] = [];
      let withheld: string[] = [];
      const session = await knowledgeSessionFor({
        projectRoot: root, hooks: undefined, principal: local,
        sourceFor: (server) => { used.push(server.id); return { id: server.id, label: server.id, search: async () => [], fetch: async () => undefined } as never; },
        modelOnThisMachine: () => onThisMachine,
        onWithheld: (labels) => { withheld = labels; },
      });
      read.push(used);
      return { session, withheld };
    };
    // A hosted model: only the server the person marked.
    expect((await sessionFor(false)).withheld).toEqual(['Team wiki']);
    expect(read.at(-1)).toEqual(['handbook']);
    // A model on this machine: every server.
    expect((await sessionFor(true)).withheld).toEqual([]);
    expect(read.at(-1)).toEqual(['wiki', 'handbook']);
    // A host decides on its own; the project file's flag never widens it.
    let asked = false;
    await knowledgeSessionFor({
      projectRoot: root, hooks: { knowledgeSources: () => [{ id: 'w', url: 'https://w.example' }] }, principal: PEOPLE.maria,
      sourceFor: (server) => ({ id: server.id, label: server.id, search: async () => [], fetch: async () => undefined }) as never,
      modelOnThisMachine: () => { asked = true; return false; },
    });
    expect(asked).toBe(false);
  });

  it('says in the answer which documents were not read and how to allow them, and changes nothing else', () => {
    const result = { status: 'completed', trustState: 'certified', answer: 'Lifetime spend is 12.', askPipelineReceipt: { story: [] } } as never;
    const told = withKnowledgeWithheld(result, ['Team wiki']) as { answer: string; trustState: string; askPipelineReceipt: { story: Array<{ title: string; detail: string }> } };
    expect(told.answer).toBe('Lifetime spend is 12.');
    expect(told.trustState).toBe('certified');
    expect(told.askPipelineReceipt.story).toEqual([expect.objectContaining({ title: 'Team documents not read', detail: expect.stringContaining('"hostedModels": true') })]);
    expect(withKnowledgeWithheld(result, [])).toBe(result);
  });
});
