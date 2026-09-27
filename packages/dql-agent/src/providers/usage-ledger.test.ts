import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractProviderUsage, extractStreamedClaudeUsage, recordProviderUsage, setProviderUsageListener, type ProviderUsageLine } from './usage-ledger.js';

describe('the provider usage ledger', () => {
  it('reads each provider\'s usage block into one shape', () => {
    expect(extractProviderUsage('claude', { usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } }))
      .toEqual({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800 });
    expect(extractProviderUsage('openai', { usage: { prompt_tokens: 900, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 350 } } }))
      .toEqual({ inputTokens: 900, outputTokens: 500, cacheReadTokens: 100, reasoningTokens: 350 });
    expect(extractProviderUsage('gemini', { usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 120, thoughtsTokenCount: 80 } }))
      .toEqual({ inputTokens: 700, outputTokens: 200, reasoningTokens: 80 });
    expect(extractProviderUsage('claude', { content: [] })).toBeUndefined();
  });

  it('appends one line per successful call only when a ledger file is named, without prompt or reply text', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dql-usage-')), 'usage.jsonl');
    const reply = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'SELECT 1' }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    recordProviderUsage({ provider: 'claude', operation: 'generate', model: 'claude-sonnet-5', response: reply() }, {});
    recordProviderUsage({ provider: 'claude', operation: 'generate', model: 'claude-sonnet-5', response: new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }) }, { DQL_PROVIDER_USAGE_LEDGER: file });
    const response = reply();
    recordProviderUsage({ provider: 'claude', operation: 'generate', model: 'claude-sonnet-5', response }, { DQL_PROVIDER_USAGE_LEDGER: file });
    // The caller can still read its own body.
    expect((await response.json()).usage.output_tokens).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5', operation: 'generate', inputTokens: 10, outputTokens: 5 });
    expect(JSON.stringify(lines[0])).not.toContain('SELECT 1');
  });
});

describe('local models', () => {
  it('reads Ollama token counts', () => {
    expect(extractProviderUsage('ollama', { prompt_eval_count: 11800, eval_count: 640 })).toEqual({ inputTokens: 11800, outputTokens: 640 });
  });
});

describe('usage for a host (RFC 0010 HH-6)', () => {
  it('reads a streamed Claude reply\'s tokens and tells a listening host, with no ledger file and no text', async () => {
    const stream = [
      'event: message_start', 'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"output_tokens":1,"cache_read_input_tokens":80}}}', '',
      'event: content_block_delta', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"SELECT secret"}}', '',
      'event: message_delta', 'data: {"type":"message_delta","usage":{"output_tokens":42}}', '',
    ].join('\n');
    expect(extractStreamedClaudeUsage(stream)).toEqual({ inputTokens: 120, outputTokens: 42, cacheReadTokens: 80 });
    const heard: ProviderUsageLine[] = [];
    setProviderUsageListener((line) => { heard.push(line); });
    try {
      recordProviderUsage({ provider: 'claude', operation: 'stream', model: 'claude-sonnet-5', response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) }, {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      setProviderUsageListener(null);
    }
    expect(heard).toEqual([expect.objectContaining({ provider: 'claude', model: 'claude-sonnet-5', operation: 'stream', inputTokens: 120, outputTokens: 42 })]);
    expect(JSON.stringify(heard)).not.toContain('secret');
  });
});
