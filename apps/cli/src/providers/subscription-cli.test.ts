import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCodeCliProvider,
  CodexCliProvider,
  codexReasoningEffort,
  ProviderExitError,
  ProviderTimeoutError,
  parseClaudeResult,
  sanitizeProviderDetail,
  parseCodexFinalMessage,
  resolveSubscriptionCliTimeoutMs,
} from './subscription-cli.js';

describe('subscription CLI timeout', () => {
  it('keeps a hard deadline even when the caller also supplies cancellation', () => {
    expect(resolveSubscriptionCliTimeoutMs({})).toBe(90_000);
    expect(resolveSubscriptionCliTimeoutMs({ DQL_SUBSCRIPTION_CLI_TIMEOUT_MS: '15000' })).toBe(15_000);
    expect(resolveSubscriptionCliTimeoutMs({ DQL_SUBSCRIPTION_CLI_TIMEOUT_MS: '1000' })).toBe(5_000);
    expect(resolveSubscriptionCliTimeoutMs({ DQL_SUBSCRIPTION_CLI_TIMEOUT_MS: '900000' })).toBe(300_000);
    expect(resolveSubscriptionCliTimeoutMs({ DQL_SUBSCRIPTION_CLI_TIMEOUT_MS: 'invalid' })).toBe(90_000);
  });
});

describe('a CLI exit is classified: quota waits, authentication needs re-login, and other exits may retry', () => {
  it('a session-limit message is provider_quota with the reset time in the detail', () => {
    const error = new ProviderExitError('Claude Code', "You've hit your session limit · resets 12pm (America/Chicago)");
    expect(error.code).toBe('provider_quota');
    expect(error.message).toBe("The AI model's usage limit is reached.");
    expect(error.detail).toContain('resets 12pm');
  });
  it('a plain non-zero exit is provider_exit, with the stderr sanitized: no paths, one line, bounded', () => {
    const error = new ProviderExitError('Claude Code', 'Error: something broke\n   at /Users/someone/.claude/cli.js:12\n' + 'x'.repeat(500));
    expect(error.code).toBe('provider_exit');
    expect(error.message).toBe('Claude Code exited before producing an answer.');
    expect(error.detail).toContain('<path>');
    expect(error.detail).not.toContain('/Users/');
    expect(error.detail.length).toBeLessThanOrEqual(300);
    expect(new ProviderExitError('Codex', '').detail).toBe('empty reply');
    expect(sanitizeProviderDetail('token sk-abcdefghijklmnop at /tmp/x')).toBe('token <redacted> at <path>');
  });
  it('a structured OAuth 401 is provider_auth with reauthentication guidance, even when stderr is empty', async () => {
    const provider = new ClaudeCodeCliProvider({
      command: 'fixture-claude',
      runProcess: async () => ({
        code: 1,
        stderr: '',
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'error',
          is_error: true,
          terminal_reason: 'api_error',
          api_error_status: 401,
          result: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
        }),
      }),
    });
    const error = await provider.generate([{ role: 'user', content: 'hi' }]).then(
      () => undefined,
      (reason: unknown) => reason as Error & { code?: string; detail?: string },
    );
    expect(error).toBeDefined();
    expect(error?.code).toBe('provider_auth');
    expect(error?.message).toContain('claude /login');
    expect(error?.detail).toContain('OAuth access token has expired');
    expect(error?.detail).toContain('Re-authenticate to continue');
  });
  it('uses a structured 401 as authentication evidence even when its result text is neutral', async () => {
    const provider = new ClaudeCodeCliProvider({
      command: 'fixture-claude',
      runProcess: async () => ({
        code: 1,
        stderr: '',
        stdout: JSON.stringify({ is_error: true, terminal_reason: 'api_error', api_error_status: 401, result: 'Request failed' }),
      }),
    });
    const error = await provider.generate([{ role: 'user', content: 'hi' }]).then(
      () => undefined,
      (reason: unknown) => reason as Error & { code?: string; detail?: string },
    );
    expect(error?.code).toBe('provider_auth');
    expect(error?.detail).toBe('Request failed');
  });
  it('preserves quota classification for a structured non-zero result', async () => {
    const provider = new ClaudeCodeCliProvider({
      command: 'fixture-claude',
      runProcess: async () => ({ code: 1, stderr: '', stdout: JSON.stringify({ is_error: true, result: "You've hit your session limit · resets 12pm (America/Chicago)" }) }),
    });
    const error = await provider.generate([{ role: 'user', content: 'hi' }]).then(
      () => undefined,
      (reason: unknown) => reason as Error & { code?: string; detail?: string },
    );
    expect(error?.code).toBe('provider_quota');
    expect(error?.detail).toContain('resets 12pm');
  });
  it('falls back to a sanitized generic provider exit for malformed stdout', async () => {
    const provider = new ClaudeCodeCliProvider({
      command: 'fixture-claude',
      runProcess: async () => ({ code: 1, stderr: '', stdout: 'not JSON; credential sk-abcdefghijklmnop at /private/tmp/secret' }),
    });
    const error = await provider.generate([{ role: 'user', content: 'hi' }]).then(
      () => undefined,
      (reason: unknown) => reason as Error & { code?: string; detail?: string },
    );
    expect(error?.code).toBe('provider_exit');
    expect(error?.message).toBe('Claude Code exited before producing an answer.');
    expect(error?.detail).toBe('The CLI exited with an unreadable error response.');
    expect(error?.detail).not.toContain('not JSON');
    expect(error?.detail).not.toContain('sk-abcdefghijklmnop');
    expect(error?.detail).not.toContain('/private/tmp/secret');
  });
  it('redacts complete Basic and custom authorization header values from structured errors, stderr, and debug output', async () => {
    const bearer = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    const access = 'access-value-0123456789';
    const refresh = 'refresh-value-0123456789';
    const basic = 'dXNlcjpzZWNyZXQ=';
    const custom = 'custom-scheme-credential-0123456789';
    const previousDebug = process.env.DQL_DEBUG_PROVIDER_CLI;
    const logged: unknown[][] = [];
    const originalError = console.error;
    const provider = new ClaudeCodeCliProvider({
      command: 'fixture-claude',
      runProcess: async () => ({
        code: 1,
        stderr: `Proxy-Authorization: Custom ${custom}\nrefresh_token=${refresh}`,
        stdout: JSON.stringify({ is_error: true, result: `Request failed Authorization: Basic ${basic}; Authorization:Bearer ${bearer}; payload={"access_token":"${access}"}` }),
      }),
    });
    process.env.DQL_DEBUG_PROVIDER_CLI = '1';
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const error = await provider.generate([{ role: 'user', content: 'hi' }]).then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string; detail?: string },
      );
      expect(error?.detail).toContain('<redacted>');
      for (const secret of [basic, custom, bearer, access, refresh]) expect(error?.detail).not.toContain(secret);
      expect(logged).toHaveLength(1);
      const debug = JSON.stringify(logged[0]);
      for (const secret of [basic, custom, bearer, access, refresh]) expect(debug).not.toContain(secret);
    } finally {
      console.error = originalError;
      if (previousDebug === undefined) delete process.env.DQL_DEBUG_PROVIDER_CLI;
      else process.env.DQL_DEBUG_PROVIDER_CLI = previousDebug;
    }
  });
});

describe('a CLI timeout is a typed provider error', () => {
  it('carries the retry code, a reader sentence without the variable, and the hint as detail', () => {
    const error = new ProviderTimeoutError(60_000);
    expect(error.code).toBe('provider_timeout');
    expect(error.message).toBe('The AI model did not respond within 60 seconds.');
    expect(error.message).not.toContain('DQL_SUBSCRIPTION_CLI_TIMEOUT_MS');
    expect(error.detail).toContain('DQL_SUBSCRIPTION_CLI_TIMEOUT_MS');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('parseClaudeResult with a schema (structured_output)', () => {
  it('a validated object wins over an empty or narrated result', () => {
    expect(parseClaudeResult(JSON.stringify({ is_error: false, result: '', structured_output: { ok: true } }))).toEqual({ text: '{"ok":true}', isError: false, structured: true });
    expect(parseClaudeResult(JSON.stringify({ is_error: false, result: 'ok: true, n: 7', structured_output: { ok: true, n: 7, items: [{ a: [1, 2] }] } }))).toEqual({ text: '{"ok":true,"n":7,"items":[{"a":[1,2]}]}', isError: false, structured: true });
  });
  it('an older release that repeats the JSON in result still parses, and a missing structured field falls back to result', () => {
    expect(parseClaudeResult(JSON.stringify({ is_error: false, result: '{"ok":true}' }))).toEqual({ text: '{"ok":true}', isError: false });
    expect(parseClaudeResult(JSON.stringify({ is_error: false, result: 'Done.', structured_output: null }))).toEqual({ text: 'Done.', isError: false });
  });
  it('an error wrapper stays an error even when it carries a structured field', () => {
    expect(parseClaudeResult(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login', structured_output: { ok: true } }))).toEqual({ text: 'Not logged in · Please run /login', isError: true });
  });
  it('the last-JSON-line fallback reads structured output too', () => {
    const stdout = 'warning: something\n' + JSON.stringify({ is_error: false, result: '', structured_output: { n: 1 } });
    expect(parseClaudeResult(stdout)).toEqual({ text: '{"n":1}', isError: false, structured: true });
  });
});

describe('parseClaudeResult', () => {
  it('extracts .result and is_error from a single JSON object', () => {
    const json = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Revenue is $2.8M.' });
    expect(parseClaudeResult(json)).toEqual({ text: 'Revenue is $2.8M.', isError: false });
  });

  it('flags is_error true (e.g. not logged in)', () => {
    const json = JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' });
    expect(parseClaudeResult(json)).toEqual({ text: 'Not logged in · Please run /login', isError: true });
  });

  it('retains safe structural terminal fields for a non-zero exit classifier', () => {
    const json = JSON.stringify({ is_error: true, terminal_reason: 'api_error', api_error_status: 401, result: 'Request failed' });
    expect(parseClaudeResult(json)).toEqual({ text: 'Request failed', isError: true, terminalReason: 'api_error', apiErrorStatus: 401 });
  });

  it('falls back to the last JSON line when stdout has leading noise', () => {
    const stdout = 'warning: something\n{"is_error":false,"result":"OK"}';
    expect(parseClaudeResult(stdout)).toEqual({ text: 'OK', isError: false });
  });

  it('returns undefined for empty / unparseable output', () => {
    expect(parseClaudeResult('')).toBeUndefined();
    expect(parseClaudeResult('plain text, no json')).toBeUndefined();
  });
});

describe('parseCodexFinalMessage', () => {
  it('extracts the final agent_message text from JSONL', () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Total revenue is $2.8M."}}',
      '{"type":"turn.completed"}',
    ].join('\n');
    expect(parseCodexFinalMessage(jsonl)).toBe('Total revenue is $2.8M.');
  });

  it('returns the LAST agent_message when several are present', () => {
    const jsonl = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
    ].join('\n');
    expect(parseCodexFinalMessage(jsonl)).toBe('second');
  });

  it('returns undefined when there is no agent_message', () => {
    expect(parseCodexFinalMessage('{"type":"turn.started"}\n{"type":"error","message":"x"}')).toBeUndefined();
    expect(parseCodexFinalMessage('')).toBeUndefined();
    expect(parseCodexFinalMessage('not json at all')).toBeUndefined();
  });
});

// ── Live tests (opt-in) ────────────────────────────────────────────────────────
// Real subscription round-trips cost money and require a logged-in CLI, so they only
// run with DQL_TEST_LIVE_CLI=1. They prove the provider works end-to-end.
const hasClaude = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
const liveClaude = process.env.DQL_TEST_LIVE_CLI === '1' && hasClaude;

describe.runIf(liveClaude)('ClaudeCodeCliProvider (live)', () => {
  it('detects an installed, logged-in Claude subscription', async () => {
    const status = await ClaudeCodeCliProvider.detect();
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(true);
  });

  it('generates a one-shot completion via the subscription', async () => {
    const provider = new ClaudeCodeCliProvider();
    expect(await provider.available()).toBe(true);
    const text = await provider.generate([
      { role: 'system', content: 'You are a test harness. Answer with a single word only.' },
      { role: 'user', content: 'Reply with exactly the word: PONG' },
    ]);
    expect(text.toUpperCase()).toContain('PONG');
  }, 60000);
});

const hasCodex = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;
describe.runIf(process.env.DQL_TEST_LIVE_CLI === '1' && hasCodex)('CodexCliProvider (live)', () => {
  it('detects an installed Codex CLI', async () => {
    const status = await CodexCliProvider.detect();
    expect(status.installed).toBe(true);
  });
});

describe('pre-spawn cancellation (Slice 1)', () => {
  it('Claude generate rejects with the exact abort reason without spawning', async () => {
    const { ClaudeCodeCliProvider } = await import('./subscription-cli.js');
    const provider = new ClaudeCodeCliProvider({ command: '/definitely/not/a/real/claude' });
    const deadline = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const controller = new AbortController();
    controller.abort(deadline);
    await expect(provider.generate([{ role: 'user', content: 'hi' }], { signal: controller.signal }))
      .rejects.toBe(deadline);
  });

  it('Codex generate rejects with the exact abort reason without spawning', async () => {
    const { CodexCliProvider } = await import('./subscription-cli.js');
    const provider = new CodexCliProvider({ command: '/definitely/not/a/real/codex' });
    const deadline = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const controller = new AbortController();
    controller.abort(deadline);
    await expect(provider.generate([{ role: 'user', content: 'hi' }], { signal: controller.signal }))
      .rejects.toBe(deadline);
  });
});

describe('subscription CLI dispatch accounting', () => {
  it.each([
    ['Claude', new ClaudeCodeCliProvider({ command: '/definitely/not/a/real/claude' })],
    ['Codex', new CodexCliProvider({ command: '/definitely/not/a/real/codex' })],
  ])('records one %s process dispatch before a spawn failure', async (_label, provider) => {
    const dispatches: unknown[] = [];
    await expect(provider.generate([{ role: 'user', content: 'hi' }], {
      onProviderDispatch: (event) => { dispatches.push(event); return event.envelope; },
    })).rejects.toThrow();
    expect(dispatches).toHaveLength(1);
  });

  it('does not record a process dispatch when cancellation prevents spawning', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const dispatches: unknown[] = [];
    await expect(new ClaudeCodeCliProvider({ command: '/not-used' }).generate(
      [{ role: 'user', content: 'hi' }],
      { signal: controller.signal, onProviderDispatch: (event) => { dispatches.push(event); return event.envelope; } },
    )).rejects.toThrow();
    expect(dispatches).toHaveLength(0);
  });

  it.each([
    ['Claude', () => new ClaudeCodeCliProvider({
      command: 'fixture-claude',
      runProcess: async () => ({ code: 0, stdout: 'not a JSON result', stderr: '' }),
    })],
    ['Codex', () => new CodexCliProvider({
      command: 'fixture-codex',
      runProcess: async () => ({ code: 0, stdout: '{"type":"turn.completed"}', stderr: '' }),
    })],
  ])('records a successful %s process followed by an invalid-result failure', async (_label, createProvider) => {
    const completions: Array<{ settlement?: string; outcome?: string }> = [];
    await expect(createProvider().generate([{ role: 'user', content: 'hi' }], {
      onProviderDispatchComplete: (event) => { completions.push(event); },
    })).rejects.toThrow();
    expect(completions).toEqual([
      expect.objectContaining({ settlement: 'process', outcome: 'ok' }),
      expect.objectContaining({ settlement: 'result', outcome: 'error' }),
    ]);
  });

  it('passes the call\'s reasoning effort to Codex, and an operator pin overrides it', async () => {
    const calls: string[][] = [];
    const provider = new CodexCliProvider({
      command: 'fixture-codex',
      runProcess: async (_command, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; },
    });
    await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'high' }).catch(() => undefined);
    expect(calls[0]).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="high"']));
    await provider.generate([{ role: 'user', content: 'hi' }]).catch(() => undefined);
    expect(calls[1]!.join(' ')).not.toMatch(/model_reasoning_effort/);
    expect(codexReasoningEffort('medium', { DQL_CODEX_REASONING_EFFORT: 'max' })).toBe('max');
    expect(codexReasoningEffort('medium', { DQL_CODEX_REASONING_EFFORT: 'max"; rm' })).toBe('medium');
    expect(codexReasoningEffort(undefined, {})).toBeUndefined();
  });

  it('records cancellation at actual child-process settlement rather than a parser failure', async () => {
    const controller = new AbortController();
    const provider = new ClaudeCodeCliProvider({
      command: 'fixture-claude',
      runProcess: async () => {
        controller.abort(new DOMException('cancelled', 'AbortError'));
        return { code: 0, stdout: '{"is_error":false,"result":"late"}', stderr: '' };
      },
    });
    const completions: Array<{ settlement?: string; outcome?: string }> = [];
    await expect(provider.generate([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
      onProviderDispatchComplete: (event) => { completions.push(event); },
    })).rejects.toThrow(/cancelled/i);
    expect(completions).toEqual([expect.objectContaining({ settlement: 'process', outcome: 'cancelled' })]);
  });
});
