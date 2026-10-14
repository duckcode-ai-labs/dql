import { describe, expect, it } from 'vitest';
import { ClaudeCodeCliProvider } from './subscription-cli.js';
import type { AgentMessage } from '@zlens/agent';

const result = (text: string) => JSON.stringify({ is_error: false, result: text });

function recordingRunner(calls: Array<{ args: string[]; input: string }>, fail?: (index: number) => boolean) {
  let index = 0;
  return async (_command: string, args: string[], options: { input?: string }) => {
    const call = index;
    index += 1;
    calls.push({ args, input: options.input ?? '' });
    if (fail?.(call)) return { code: 1, stdout: '', stderr: 'session not found' };
    return { code: 0, stdout: result('ok'), stderr: '' };
  };
}

const turn = (count: number): AgentMessage[] => [
  { role: 'system', content: 'analyst prompt' },
  ...Array.from({ length: count }, (_, i) => ({ role: 'user' as const, content: `observation ${i}` })),
];

describe('Claude Code CLI session reuse', () => {
  it('re-sends the whole transcript by default, keeping runs hermetic', async () => {
    const calls: Array<{ args: string[]; input: string }> = [];
    const provider = new ClaudeCodeCliProvider({ runProcess: recordingRunner(calls) as never });
    await provider.generate(turn(1), { conversationId: 'turn-1' });
    await provider.generate(turn(2), { conversationId: 'turn-1' });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).toContain('--no-session-persistence');
      expect(call.args).not.toContain('--resume');
    }
  });

  it('opens a session once and then sends only what is new', async () => {
    const previous = process.env.ZLENS_SUBSCRIPTION_CLI_SESSION;
    process.env.ZLENS_SUBSCRIPTION_CLI_SESSION = 'on';
    try {
      const calls: Array<{ args: string[]; input: string }> = [];
      const provider = new ClaudeCodeCliProvider({ runProcess: recordingRunner(calls) as never });
      await provider.generate(turn(1), { conversationId: 'turn-1' });
      await provider.generate(turn(2), { conversationId: 'turn-1' });
      expect(calls[0]!.args).toContain('--session-id');
      expect(calls[0]!.args).not.toContain('--no-session-persistence');
      expect(calls[1]!.args).toContain('--resume');
      // The second send carries the new observation and not the first one.
      expect(calls[1]!.input).toContain('observation 1');
      expect(calls[1]!.input).not.toContain('observation 0');
    } finally {
      if (previous === undefined) delete process.env.ZLENS_SUBSCRIPTION_CLI_SESSION;
      else process.env.ZLENS_SUBSCRIPTION_CLI_SESSION = previous;
    }
  });

  it('says the whole thing again when a resume fails, rather than losing the turn', async () => {
    const previous = process.env.ZLENS_SUBSCRIPTION_CLI_SESSION;
    process.env.ZLENS_SUBSCRIPTION_CLI_SESSION = 'on';
    try {
      const calls: Array<{ args: string[]; input: string }> = [];
      // The second call is the resume; make only that one fail.
      const provider = new ClaudeCodeCliProvider({ runProcess: recordingRunner(calls, (index) => index === 1) as never });
      await provider.generate(turn(1), { conversationId: 'turn-1' });
      const text = await provider.generate(turn(2), { conversationId: 'turn-1' });
      expect(text).toBe('ok');
      expect(calls).toHaveLength(3);
      expect(calls[1]!.args).toContain('--resume');
      // The retry starts a fresh session and carries every message again.
      expect(calls[2]!.args).toContain('--session-id');
      expect(calls[2]!.input).toContain('observation 0');
      expect(calls[2]!.input).toContain('observation 1');
    } finally {
      if (previous === undefined) delete process.env.ZLENS_SUBSCRIPTION_CLI_SESSION;
      else process.env.ZLENS_SUBSCRIPTION_CLI_SESSION = previous;
    }
  });

  it('does not retry a resumed turn when Claude reports a structured 401 with neutral text', async () => {
    const previous = process.env.ZLENS_SUBSCRIPTION_CLI_SESSION;
    process.env.ZLENS_SUBSCRIPTION_CLI_SESSION = 'on';
    try {
      const calls: Array<{ args: string[]; input: string }> = [];
      const provider = new ClaudeCodeCliProvider({
        runProcess: async (_command, args, options) => {
          calls.push({ args, input: options?.input ?? '' });
          if (calls.length === 1) return { code: 0, stdout: result('ok'), stderr: '' };
          return {
            code: 1,
            stderr: '',
            stdout: JSON.stringify({ is_error: true, terminal_reason: 'api_error', api_error_status: 401, result: 'Request failed' }),
          };
        },
      });
      await provider.generate(turn(1), { conversationId: 'turn-1' });
      const error = await provider.generate(turn(2), { conversationId: 'turn-1' }).then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string; detail?: string },
      );
      expect(error?.code).toBe('provider_auth');
      expect(error?.detail).toBe('Request failed');
      expect(calls).toHaveLength(2);
      expect(calls[1]!.args).toContain('--resume');
    } finally {
      if (previous === undefined) delete process.env.ZLENS_SUBSCRIPTION_CLI_SESSION;
      else process.env.ZLENS_SUBSCRIPTION_CLI_SESSION = previous;
    }
  });
});
