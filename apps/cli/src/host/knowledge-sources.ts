/**
 * KNOWLEDGE SOURCES FOR ONE PERSON (RFC 0010, HH-15).
 *
 * Which document servers an answer may read, and with whose credentials:
 *   - with the host's `knowledgeSources` hook, the servers it returns for the
 *     person asking, each with that person's own headers (an error: none);
 *   - with a host that signs people in but has no such hook: none — nobody's
 *     documents are read with a key from the project file;
 *   - with no host (`dql notebook`): the project's `.dql/mcp-servers.json`
 *     servers marked `use: ["knowledge"]`.
 *
 * Each server becomes a read-only KnowledgeSource over DQL's own MCP client.
 * Every knowledge call is reported to the host's audit sink as ids, links
 * and outcomes — never the question, search words or document text.
 */
import { createKnowledgeSession, type KnowledgeSession, type KnowledgeSource } from '@duckcodeailabs/dql-agent';
import { createMcpKnowledgeSource, type KnowledgeServerConfig } from '@duckcodeailabs/dql-mcp';
import { loadKnowledgeServers } from '../llm/mcp-config.js';
import type { DqlHostHooks, DqlKnowledgeServer, DqlPrincipal } from './request-context.js';
import { auditActor, auditKnowledge } from './observability.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A host's server, checked; undefined when malformed. */
export function normalizeHostKnowledgeServer(value: unknown): KnowledgeServerConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<DqlKnowledgeServer>;
  if (typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.url !== 'string') return undefined;
  const text = (field: unknown) => (typeof field === 'string' && field.trim() ? field.trim() : undefined);
  const object = (field: unknown) => (field && typeof field === 'object' && !Array.isArray(field) ? field as Record<string, unknown> : undefined);
  const headers = object(raw.headers)
    ? Object.fromEntries(Object.entries(raw.headers as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined;
  return {
    id: raw.id,
    url: raw.url,
    ...(text(raw.label) ? { label: text(raw.label) } : {}),
    ...(headers && Object.keys(headers).length ? { headers } : {}),
    ...(text(raw.searchTool) ? { searchTool: text(raw.searchTool) } : {}),
    ...(text(raw.searchArg) ? { searchArg: text(raw.searchArg) } : {}),
    ...(text(raw.fetchTool) ? { fetchTool: text(raw.fetchTool) } : {}),
    ...(text(raw.fetchArg) ? { fetchArg: text(raw.fetchArg) } : {}),
    ...(object(raw.searchArgs) ? { searchArgs: object(raw.searchArgs) } : {}),
    ...(object(raw.fetchArgs) ? { fetchArgs: object(raw.fetchArgs) } : {}),
  };
}

/** The knowledge servers for the person asking now. Fails closed. */
export async function knowledgeServersFor(input: {
  projectRoot: string;
  hooks: DqlHostHooks | undefined;
  principal: DqlPrincipal | null | undefined;
}): Promise<KnowledgeServerConfig[]> {
  const { hooks, principal } = input;
  if (hooks?.knowledgeSources) {
    if (!principal) return [];
    try {
      const listed = await hooks.knowledgeSources(principal);
      if (!Array.isArray(listed)) return [];
      const seen = new Set<string>();
      return listed.map(normalizeHostKnowledgeServer).filter((server): server is KnowledgeServerConfig => {
        if (!server || seen.has(server.id)) return false;
        seen.add(server.id);
        return true;
      });
    } catch {
      return [];
    }
  }
  // A host that signs people in decides whose documents are read; without
  // its hook, nobody's are.
  if (hooks?.resolvePrincipal || (principal && principal.source !== 'local')) return [];
  return loadKnowledgeServers(input.projectRoot).servers;
}

/**
 * One answer's knowledge session for the person asking: sources over DQL's
 * MCP client and an audit record for every call. Undefined without sources.
 */
export async function knowledgeSessionFor(input: {
  projectRoot: string;
  hooks: DqlHostHooks | undefined;
  principal: DqlPrincipal | null | undefined;
  runId?: string;
  requestId?: string;
  /** For tests: build sources without the network. */
  sourceFor?: (server: KnowledgeServerConfig) => KnowledgeSource;
}): Promise<KnowledgeSession | undefined> {
  const servers = await knowledgeServersFor(input);
  const sources: KnowledgeSource[] = [];
  for (const server of servers) {
    try {
      sources.push((input.sourceFor ?? createMcpKnowledgeSource)(server));
    } catch {
      // A server that is not configured safely (plain http off this machine,
      // a bad id) is left out.
    }
  }
  if (!sources.length) return undefined;
  const sink = input.hooks?.audit;
  const principal = input.principal ?? null;
  return createKnowledgeSession(sources, {
    ...(sink ? {
      onActivity: (activity) => auditKnowledge(sink, activity, {
        principal,
        actor: auditActor(principal),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
      }),
    } : {}),
  });
}
