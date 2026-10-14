/**
 * `zlens slack serve` — boot the Slack slash-command bot.
 *
 *   zlens slack serve [--port 3479] [--provider claude|openai|gemini|ollama]
 *
 * Reads `SLACK_SIGNING_SECRET` (required) + `SLACK_BOT_TOKEN` (optional, only
 * needed for outbound posts beyond response_url replies). The bot answers
 * `/dql ask <q>` and `/dql block <id>` via the existing block-first agent loop,
 * so Slack reuses the same Certified/Uncertified semantics as the desktop UI.
 */

import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

export async function runSlack(
  sub: string | null,
  _rest: string[],
  flags: CLIFlags,
): Promise<void> {
  if (sub !== 'serve') {
    throw new Error('Usage: zlens slack serve [--port 3479] [--provider claude|openai|gemini|ollama]');
  }
  const projectRoot = findProjectRoot(process.cwd());
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    throw new Error(
      'SLACK_SIGNING_SECRET is required. Set it in your environment before running `zlens slack serve`.',
    );
  }
  const port = parsePort((flags as unknown as { port?: number | string | null }).port);
  const provider = (flags as { provider?: string }).provider as
    | 'claude' | 'openai' | 'gemini' | 'ollama' | undefined;

  const { startSlackServer } = await import('@zlens/slack');
  const server = await startSlackServer({
    projectRoot,
    signingSecret,
    port,
    provider,
  });
  console.log(`  ✓ Slack bot listening on http://127.0.0.1:${server.port}`);
  console.log(`    POST /slack/commands  (slash commands)`);
  console.log(`    POST /slack/actions   (block-kit interactivity)`);
  console.log(`    GET  /health`);
  console.log('\n  Forward Slack to this port via ngrok or a similar tunnel.');
  // Keep the process alive on Ctrl+C.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log('\n  Shutting down…');
      await server.close();
      process.exit(0);
    });
  }
}

function parsePort(raw: number | string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 3479;
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid --port "${String(raw)}"`);
  }
  return n;
}
