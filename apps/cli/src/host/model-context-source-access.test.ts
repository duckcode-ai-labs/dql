import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlModelProvider, DqlPrincipal, DqlSourceRef } from './request-context.js';

/**
 * RFC 0010 HH-13: a certified Dataset the host keeps from a person does not reach the model, or the plan shown
 * to that person, by name or by definition. Every list of certified blocks that DQL builds as model context
 * names a block to the host by one id, so one `sourceAccess` answer decides them all. Over HTTP, two of them
 * can be reached today: POST /api/research-plan (the Research plan) and an Ask run's provider requests.
 * The conversation reply (catalog context, suggestions) and the run planner's ranked catalog are filtered in
 * local-runtime.ts too, but the default Ask runtime (pipeline_v3) never routes to them, so no request reaches
 * them from here. A host whose `sourceAccess` throws is a host that allowed nothing; without a host, nothing
 * is filtered.
 */
const P: DqlPrincipal = { id: 'u-p', kind: 'person', email: 'p@example.test', source: 'host' };
const Q: DqlPrincipal = { id: 'u-q', kind: 'person', email: 'q@example.test', source: 'host' };
const PEOPLE: Record<string, DqlPrincipal> = { p: P, q: Q };

const HIDDEN_NAME = 'CANARY_Payout_Ledger';
const HIDDEN_DEFINITION = 'CANARY-DEF-7731 payouts to restricted claimants';
const HIDDEN_SQL = 'canary_secret_table_9921';
const SHOWN_NAME = 'Visible_Orders';
const SHOWN_DEFINITION = 'Orders placed this quarter';
const HIDDEN_FILE = 'blocks/payout-ledger.dql';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function blockSource(name: string, description: string, table: string): string {
  return [
    'block "' + name + '" {',
    '  domain = "claims"',
    '  type = "custom"',
    '  status = "certified"',
    '  owner = "claims@example.test"',
    '  description = "' + description + '"',
    '  tags = ["claims"]',
    '  query = """',
    '    SELECT id, region FROM ' + table,
    '  """',
    '}',
    '',
  ].join('\n');
}

/** The id a host hears for a certified block that has a file (HH-13): the Dataset id Ask names it by. */
const datasetIdOf = (name: string, filePath: string): string => `app:block:claims:${createHash('sha256').update(`${filePath}\u0000${name}`).digest('hex').slice(0, 20)}`;

interface Recorded { requests: string[]; provider: DqlModelProvider }
function recordingProvider(): Recorded {
  const requests: string[] = [];
  const provider = {
    name: 'recorder',
    available: async () => true,
    generate: async (messages: Array<{ role: string; content: string }>) => {
      requests.push(JSON.stringify(messages));
      return 'Hello. Ask me about your data.';
    },
  } as unknown as DqlModelProvider;
  return { requests, provider };
}

async function serve(sourceAccess: DqlHostHooks['sourceAccess'] | 'none') {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-model-context-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'model_context' }));
  mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  writeFileSync(join(projectRoot, HIDDEN_FILE), blockSource(HIDDEN_NAME, HIDDEN_DEFINITION, HIDDEN_SQL));
  writeFileSync(join(projectRoot, 'blocks', 'visible-orders.dql'), blockSource(SHOWN_NAME, SHOWN_DEFINITION, 'orders'));
  const recorded = recordingProvider();
  const asked: Array<{ person: string; sources: DqlSourceRef[] }> = [];
  const hooks: DqlHostHooks = {
    resolvePrincipal: (req) => PEOPLE[String(req.headers['x-test-person'] ?? 'p')] ?? null,
    modelProvider: () => ({ id: 'recorder', provider: recorded.provider }),
    ...(sourceAccess === 'none' ? {} : {
      sourceAccess: async (principal: DqlPrincipal, sources: DqlSourceRef[]): Promise<Iterable<string>> => {
        asked.push({ person: principal.id, sources: [...sources] });
        return sourceAccess!(principal, sources);
      },
    }),
  };
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    connection: { driver: 'file' } as ConnectionConfig,
    preferredPort: 0,
    hostHooks: sourceAccess === 'none' ? { resolvePrincipal: hooks.resolvePrincipal, modelProvider: hooks.modelProvider } : hooks,
    captureServer: (created) => { servers.push(created); },
  });
  const post = async (path: string, person: string, body: unknown): Promise<{ status: number; text: string; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-person': person },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: response.status, text, body: parsed };
  };
  return { post, asked, recorded };
}

/** P is kept from the hidden Dataset; Q may use everything. */
const hidesFromP: NonNullable<DqlHostHooks['sourceAccess']> = (principal, sources) => sources
  .filter((source) => principal.id !== 'u-p' || source.name !== HIDDEN_NAME)
  .map((source) => source.id);

const mentionsHidden = (text: string): boolean => [HIDDEN_NAME, HIDDEN_DEFINITION, HIDDEN_SQL, 'CANARY'].some((needle) => text.includes(needle));

describe('Research plan and the host\'s sourceAccess (HH-13)', () => {
  const ask = { question: `How does ${SHOWN_NAME} change by region?` };
  // This question is about what the hidden block holds, without naming it, so a leak into the plan would show.
  const askHidden = { question: 'Show payouts to restricted claimants by region' };

  it('a person kept from block X gets a plan that never names it, and the host heard X by its Dataset id', async () => {
    const { post, asked } = await serve(hidesFromP);
    for (const question of [ask, askHidden]) {
      const planned = await post('/api/research-plan', 'p', question);
      expect(planned.status, planned.text.slice(0, 200)).toBe(200);
      expect(mentionsHidden(planned.text), planned.text).toBe(false);
      expect(planned.body.blockCount).toBe(1);
    }
    const heard = asked.filter((entry) => entry.person === 'u-p').flatMap((entry) => entry.sources);
    expect(heard.find((source) => source.name === HIDDEN_NAME)?.id).toBe(datasetIdOf(HIDDEN_NAME, HIDDEN_FILE));
  });

  it('a person allowed X still gets it counted in their plan', async () => {
    const { post } = await serve(hidesFromP);
    const planned = await post('/api/research-plan', 'q', ask);
    expect(planned.status, planned.text.slice(0, 200)).toBe(200);
    expect(planned.body.blockCount).toBe(2);
  });

  it('a host whose sourceAccess throws allows nothing: X is absent', async () => {
    const { post } = await serve(() => { throw new Error('policy store down: CANARY-INTERNAL'); });
    const planned = await post('/api/research-plan', 'p', askHidden);
    expect(planned.status, planned.text.slice(0, 200)).toBe(200);
    expect(planned.body.blockCount).toBe(0);
    expect(mentionsHidden(planned.text), planned.text).toBe(false);
  });

  it('without a host sourceAccess, nothing is filtered (unchanged)', async () => {
    const { post } = await serve('none');
    const planned = await post('/api/research-plan', 'p', ask);
    expect(planned.status, planned.text.slice(0, 200)).toBe(200);
    expect(planned.body.blockCount).toBe(2);
  });
});

describe('Ask run: what the provider is sent, and the host\'s sourceAccess (HH-13)', () => {
  // The recording provider answers nothing readable, so the run stops after its first model calls; what matters
  // here is what those calls carried.
  const question = { question: 'What is the total payout by region?', requestedMode: 'ask' };
  const sent = (recorded: Recorded): string => recorded.requests.join('\n');

  it('keeps X out of every provider request and out of the run for P; Q\'s requests carry it', async () => {
    const { post, recorded } = await serve(hidesFromP);
    const forP = await post('/api/agent-runs', 'p', question);
    expect(forP.status, forP.text.slice(0, 300)).toBe(201);
    expect(recorded.requests.length, 'the recording provider was asked').toBeGreaterThan(0);
    expect(sent(recorded)).toContain(SHOWN_NAME);
    expect(mentionsHidden(sent(recorded)), 'provider payload for P').toBe(false);
    expect(mentionsHidden(forP.text), 'run shown to P').toBe(false);

    recorded.requests.length = 0;
    const forQ = await post('/api/agent-runs', 'q', question);
    expect(forQ.status, forQ.text.slice(0, 300)).toBe(201);
    expect(sent(recorded)).toContain(HIDDEN_NAME);
    expect(sent(recorded)).toContain(SHOWN_NAME);
  }, 120_000);

  it('a host whose sourceAccess throws allows nothing: X is absent from every provider request', async () => {
    const { post, recorded } = await serve(() => { throw new Error('policy store down'); });
    const answered = await post('/api/agent-runs', 'p', question);
    expect(answered.status, answered.text.slice(0, 300)).toBe(201);
    expect(mentionsHidden(sent(recorded))).toBe(false);
  }, 120_000);

  it('without a host sourceAccess, X is in the provider request (unchanged)', async () => {
    const { post, recorded } = await serve('none');
    const answered = await post('/api/agent-runs', 'p', question);
    expect(answered.status, answered.text.slice(0, 300)).toBe(201);
    expect(sent(recorded)).toContain(HIDDEN_NAME);
  }, 120_000);
});
