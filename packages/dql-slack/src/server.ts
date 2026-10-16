/**
 * Slack slash-command HTTP server.
 *
 * Listens on `127.0.0.1:<port>` and exposes:
 *   POST /slack/commands   — slash command webhook (`/dql ask ...`, `/dql block ...`)
 *   POST /slack/actions    — Block Kit interactivity (feedback button clicks)
 *
 * The server is intentionally minimal — no Express/Fastify dep. Slack expects
 * a 200 within 3 seconds, so heavy work is offloaded behind a 200 ack via
 * `response_url` (Slack delivers a one-shot URL with each command).
 *
 * Auth model: bot token (env `SLACK_BOT_TOKEN`) + signing secret
 * (`SLACK_SIGNING_SECRET`). Real OAuth installation can be layered later.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  KGStore,
  defaultKgPath,
  pickProvider,
  type AgentAnswer,
  type ProviderName,
} from '@zlens/agent';
import { verifySlackSignature } from './signature.js';
import { formatAnswerForSlack } from './format.js';
import { parseSlackAskScope, slackDomainDefaults, slackThreadId } from './scope.js';
import { readEnv } from '@zlens/core';

export interface SlackServerOptions {
  /** Project root for the agent KG + Skills. */
  projectRoot: string;
  /** Slack signing secret. Required for production; tests can pass any string. */
  signingSecret: string;
  /** TCP port to bind. */
  port?: number;
  /** Optional override for the agent provider (claude/openai/gemini/ollama). */
  provider?: ProviderName;
  /** Skip signature verification (dev only). */
  skipVerification?: boolean;
}

export interface RunningSlackServer {
  port: number;
  close(): Promise<void>;
}

export async function startSlackServer(opts: SlackServerOptions): Promise<RunningSlackServer> {
  const port = opts.port ?? 3479;

  const kgPath = defaultKgPath(opts.projectRoot);
  const provider = await pickProvider(opts.provider);

  const server = createServer((req, res) => {
    void handleRequest(req, res, opts, kgPath, provider).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SlackServerOptions,
  kgPath: string,
  provider: Awaited<ReturnType<typeof pickProvider>>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  const rawBody = await readRaw(req);

  if (!opts.skipVerification) {
    const ts = headerOf(req, 'x-slack-request-timestamp') ?? '';
    const sig = headerOf(req, 'x-slack-signature') ?? '';
    const ok = verifySlackSignature({
      signingSecret: opts.signingSecret,
      timestamp: ts,
      signature: sig,
      body: rawBody,
    });
    if (!ok) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Bad signature');
      return;
    }
  }

  if (url.pathname === '/slack/commands') {
    return handleSlashCommand(rawBody, res, opts, kgPath, provider);
  }
  if (url.pathname === '/slack/actions') {
    return handleAction(rawBody, res, kgPath);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}

async function handleSlashCommand(
  rawBody: string,
  res: ServerResponse,
  opts: SlackServerOptions,
  kgPath: string,
  provider: Awaited<ReturnType<typeof pickProvider>>,
): Promise<void> {
  const params = new URLSearchParams(rawBody);
  const command = params.get('command') ?? '';
  const text = (params.get('text') ?? '').trim();
  const userId = params.get('user_id') ?? '';
  const userName = params.get('user_name') ?? userId;
  const channelId = params.get('channel_id') ?? undefined;
  const responseUrl = params.get('response_url') ?? '';

  // Parse subcommand: `ask <question>` | `block <id>` | `<question>` (default = ask)
  let sub = 'ask';
  let arg = text;
  const m = text.match(/^(ask|block|lineage)\s+([\s\S]+)$/i);
  if (m) {
    sub = m[1].toLowerCase();
    arg = m[2];
  }

  // Acknowledge immediately so Slack doesn't time out.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    response_type: 'ephemeral',
    text: `Working on it… (${sub})`,
  }));

  try {
    const reply = await runDispatch(sub, arg, userName, kgPath, provider, channelId);
    if (responseUrl) {
      await postBack(responseUrl, reply);
    }
  } catch (err) {
    if (responseUrl) {
      await postBack(responseUrl, {
        response_type: 'ephemeral',
        text: `Error: ${(err as Error).message}`,
        blocks: [],
      });
    }
  }
  void command; // command name is logged for telemetry in real deploys
}

async function runDispatch(
  sub: string,
  arg: string,
  userName: string,
  kgPath: string,
  provider: Awaited<ReturnType<typeof pickProvider>>,
  channelId?: string,
): Promise<ReturnType<typeof formatAnswerForSlack>> {
  if (sub === 'block') {
    const kg = new KGStore(kgPath);
    try {
      const node = kg.getNode(`block:${arg}`) ?? kg.getNode(arg);
      if (!node) {
        return formatAnswerForSlack(
          { kind: 'no_answer', text: `Block "${arg}" not found in the KG.`, citations: [], considered: [] },
          { question: `block ${arg}` },
        );
      }
      return formatAnswerForSlack(
        {
          kind: node.status === 'certified' ? 'certified' : 'uncertified',
          text: node.description ?? node.llmContext ?? '_(no description)_',
          block: node,
          citations: [{ nodeId: node.nodeId, kind: node.kind, name: node.name, gitSha: node.gitSha }],
          considered: [],
        },
        { question: `block ${arg}` },
      );
    } finally {
      kg.close();
    }
  }

  if (sub === 'lineage') {
    return formatAnswerForSlack(
      {
        kind: 'no_answer',
        text: `Lineage rendering in Slack is coming soon. For now run \`zlens lineage --block ${arg}\` from the CLI.`,
        citations: [],
        considered: [],
      },
      { question: `lineage ${arg}` },
    );
  }

  // Default: ask. The running ZLens runtime owns the answer (routing, the V2
  // lane, the gates, trust); the bot is a thin transport to it, exactly as the
  // MCP server is.
  const scope = parseSlackAskScope(arg, { channelId, defaults: slackDomainDefaults(readEnv('ZLENS_SLACK_DOMAIN_DEFAULTS')) });
  const result = await askRuntime(scope.question, userName, {
    ...(scope.domain ? { domain: scope.domain } : {}),
    ...(scope.purpose ? { purpose: scope.purpose } : {}),
    threadId: slackThreadId(channelId),
  });
  return formatAnswerForSlack(result, { question: scope.question });
}

/** POST one question to the local runtime and adapt the run for the formatter. */
async function askRuntime(question: string, userName: string, scope: { domain?: string; purpose?: string; threadId?: string } = {}): Promise<AgentAnswer> {
  const workspaceContext = { ...(scope.domain ? { domain: scope.domain } : {}), ...(scope.purpose ? { purpose: scope.purpose } : {}) };
  const base = (readEnv('ZLENS_RUNTIME_URL') ?? 'http://127.0.0.1:3474').replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question, requestedMode: 'auto', userId: userName,
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
        ...(Object.keys(workspaceContext).length ? { workspaceContext } : {}),
      }),
    });
  } catch (error) {
    return {
      kind: 'no_answer',
      text: `The ZLens runtime at ${base} is not reachable (${(error as Error).message}). Start the workbench with \`zlens notebook\` (\`npm run notebook\`) or set ZLENS_RUNTIME_URL.`,
      citations: [],
      considered: [],
    };
  }
  if (!response.ok) {
    return { kind: 'no_answer', text: `ZLens runtime returned ${response.status}.`, citations: [], considered: [] };
  }
  const payload = (await response.json().catch(() => ({}))) as {
    run?: { status?: string; trustState?: string; answer?: string; summary?: string; artifacts?: Array<{ payload?: { sql?: string; proposedSql?: string; dqlArtifact?: { source?: string } } }> };
  };
  const run = payload.run;
  if (!run) return { kind: 'no_answer', text: 'The runtime returned no run.', citations: [], considered: [] };
  const proposedSql = run.artifacts?.map((artifact) => artifact.payload?.proposedSql ?? artifact.payload?.sql).find(Boolean);
  const kind: AgentAnswer['kind'] = run.status === 'completed'
    ? (run.trustState === 'certified' ? 'certified' : 'uncertified')
    : run.status === 'needs_review'
      ? 'uncertified'
      : 'no_answer';
  return {
    kind,
    text: run.answer ?? run.summary ?? '',
    citations: [],
    considered: [],
    ...(proposedSql ? { proposedSql } : {}),
  };
}

async function handleAction(rawBody: string, res: ServerResponse, kgPath: string): Promise<void> {
  // Slack sends `payload=<json>` for interactivity events.
  const params = new URLSearchParams(rawBody);
  const raw = params.get('payload') ?? '{}';
  let payload: {
    user?: { id?: string; username?: string };
    actions?: Array<{ action_id: string; value: string }>;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad payload');
    return;
  }

  const action = payload.actions?.[0];
  if (action && (action.action_id === 'feedback_up' || action.action_id === 'feedback_down')) {
    try {
      const value = JSON.parse(action.value) as { rating: 'up' | 'down'; question: string; blockId?: string };
      const kg = new KGStore(kgPath);
      try {
        kg.recordFeedback({
          id: `slack_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          user: payload.user?.username ?? payload.user?.id ?? 'slack',
          question: value.question,
          answerKind: value.blockId?.startsWith('block:') ? 'certified' : 'uncertified',
          blockId: value.blockId,
          rating: value.rating,
        });
      } finally {
        kg.close();
      }
    } catch {
      // swallow — Slack doesn't need to know
    }
  }

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('');
}

async function postBack(url: string, body: ReturnType<typeof formatAnswerForSlack>): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on('data', (c: Buffer) => chunks.push(new Uint8Array(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function headerOf(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0] ?? null;
  return null;
}
