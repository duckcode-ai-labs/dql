import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolDefinition } from '@zlens/agent';
import { ClaudeOAuthProvider } from './claude-oauth.js';

/**
 * The wire contract for native tool calling over a Claude subscription.
 *
 * This path has never spoken to the live endpoint — no machine in this project
 * holds an OAuth credential — so the honest thing is to prove everything about
 * it that does not need one: that a tool turn is sent as tools, that the reply
 * comes back as a tool call, that a tool_result continues the same
 * conversation, and that the subscription's required headers, preamble and
 * prompt-cache marker are all on the request. What remains unverified is the
 * server's acceptance, and only that.
 */

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithCredential(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-oauth-tools-'));
  roots.push(root);
  mkdirSync(join(root, '.dql'), { recursive: true });
  writeFileSync(
    join(root, '.dql', 'oauth-credentials.json'),
    JSON.stringify({
      version: 1,
      claude: {
        type: 'claude',
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        // Far enough out that no refresh is attempted during the test.
        expired: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        email: 'analyst@example.com',
      },
    }),
    'utf-8',
  );
  return root;
}

const tools: AgentToolDefinition[] = [{
  name: 'compile_and_run_dql',
  description: 'Choose the governed relational shape.',
  inputSchema: {
    type: 'object',
    properties: { relationalPlan: { type: 'object' } },
    required: ['relationalPlan'],
  },
  run: async () => ({ executed: true, rowCount: 10 }),
}];

describe('Claude subscription native tool calling', () => {
  it('sends tools, runs the returned call, and continues the turn with its result', async () => {
    const root = projectWithCredential();
    const requests: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body?: string; headers?: Record<string, string> }) => {
      requests.push({
        body: JSON.parse(String(init?.body ?? '{}')),
        headers: init?.headers ?? {},
      });
      call += 1;
      const payload = call === 1
        ? {
          content: [{
            type: 'tool_use',
            id: 'toolu_1',
            name: 'compile_and_run_dql',
            input: { relationalPlan: { measures: [{ id: 'mart_arr.arr', aggregation: 'sum' }] } },
          }],
          stop_reason: 'tool_use',
        }
        : {
          content: [{ type: 'text', text: 'Ten accounts by ARR.' }],
          stop_reason: 'end_turn',
        };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const provider = new ClaudeOAuthProvider({ projectRoot: root });
    const result = await provider.generateWithTools(
      [
        { role: 'system', content: 'You are the analyst.' },
        { role: 'user', content: 'top 10 customer accounts by net arr' },
      ],
      tools,
      { maxTokens: 4096 },
    );

    // The loop returns the final text directly when it ends on prose, and a
    // typed stop object when the controller cut it short.
    const finalText = typeof result === 'string' ? result : result.text;
    expect(finalText).toContain('Ten accounts by ARR.');
    expect(requests).toHaveLength(2);

    const first = requests[0]!.body as { tools?: Array<{ name?: string }>; system?: Array<Record<string, unknown>>; max_tokens?: number };
    expect(first.tools?.map((tool) => tool.name)).toEqual(['compile_and_run_dql']);
    // The subscription API requires the Claude Code preamble as the FIRST
    // system block, and the analyst prompt after it.
    expect(first.system?.[0]).toMatchObject({ type: 'text' });
    expect(String(first.system?.[0]?.text)).toContain('Claude Code');
    // The unchanged analyst prompt is marked ephemeral so every follow-up turn
    // is served from cache instead of re-billed.
    expect(first.system?.[1]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    // 1024 is the shared loop's API-key default and cannot hold a tool call
    // plus an answer.
    expect(first.max_tokens).toBe(4096);

    const headers = requests[0]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-access-token');
    expect(headers['Anthropic-Beta']).toContain('oauth-2025-04-20');
    expect(headers['Anthropic-Beta']).toContain('prompt-caching-2024-07-31');
    // A subscription call authenticates by Bearer token and must never also
    // present an API key.
    expect(headers['x-api-key']).toBeUndefined();

    // The second turn carries the tool result back on the same conversation.
    const second = requests[1]!.body as { messages?: Array<{ role: string; content: unknown }> };
    const toolResult = JSON.stringify(second.messages ?? []);
    expect(toolResult).toContain('tool_result');
    expect(toolResult).toContain('toolu_1');
  });

  it('reports an expired session in words a user can act on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-oauth-none-'));
    roots.push(root);
    const provider = new ClaudeOAuthProvider({ projectRoot: root });
    await expect(provider.generateWithTools(
      [{ role: 'user', content: 'top customers' }],
      tools,
      {},
    )).rejects.toThrow(/Sign in with Claude/i);
  });
});
