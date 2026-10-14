import { describe, expect, it, vi } from 'vitest';
import type { AgentProvider } from '@zlens/agent';
import { createFailoverProvider, isFailoverEligibleProviderError } from './failover-provider.js';

/**
 * A project with Claude Code, Codex and Ollama all enabled used exactly one of
 * them, and a turn died with it: an expired login ended every question with
 * "The AI provider could not complete this Ask step" while two working
 * providers sat idle. These fix which failures move to another transport, and
 * — more importantly — which never do.
 */

function provider(name: string, behaviour: () => Promise<string>): AgentProvider {
  return {
    name: name as AgentProvider['name'],
    available: async () => true,
    generate: behaviour,
  };
}

const failing = (error: unknown) => provider('claude', async () => { throw error; });
const answering = (text: string) => provider('claude', async () => text);

describe('what counts as a reason to try another provider', () => {
  it('treats an ordinary transport fault as eligible', () => {
    expect(isFailoverEligibleProviderError(new Error('socket hang up'))).toBe(true);
    expect(isFailoverEligibleProviderError(new Error('Claude Code exited before producing an answer'))).toBe(true);
  });

  it('never fails over a host DECISION — that would shop for a different gate', () => {
    for (const code of [
      'PROVIDER_DISPATCH_NARRATION_NOT_ALLOWED',
      'PROVIDER_DISPATCH_BUDGET_EXHAUSTED',
      'PROVIDER_DISPATCH_PLANNING_NOT_ALLOWED',
    ]) {
      expect(isFailoverEligibleProviderError(Object.assign(new Error('denied'), { code })), code).toBe(false);
    }
  });

  it('never fails over a cancellation or a run deadline', () => {
    expect(isFailoverEligibleProviderError(Object.assign(new Error('stop'), { name: 'AbortError' }))).toBe(false);
    expect(isFailoverEligibleProviderError(Object.assign(new Error('late'), { code: 'RUN_SOFT_TARGET_EXCEEDED' }))).toBe(false);
    const aborted = AbortSignal.abort();
    expect(isFailoverEligibleProviderError(new Error('socket hang up'), aborted)).toBe(false);
  });
});

describe('failing over between configured providers', () => {
  it('answers from the next provider when the active one faults', async () => {
    const onFailover = vi.fn();
    const failover = createFailoverProvider(
      failing(new Error('Claude Code exited before producing an answer')),
      [{ id: 'codex', create: async () => answering('answered by codex') }],
      { onFailover },
    );
    await expect(failover.generate([{ role: 'user', content: 'top customers' }])).resolves.toBe('answered by codex');
    expect(onFailover).toHaveBeenCalledOnce();
    expect(onFailover.mock.calls[0]![0]).toMatchObject({ to: 'codex' });
  });

  it('walks the whole list before giving up', async () => {
    const tried: string[] = [];
    const failover = createFailoverProvider(
      failing(new Error('primary down')),
      [
        { id: 'codex', create: async () => { tried.push('codex'); return failing(new Error('codex down')); } },
        { id: 'ollama', create: async () => { tried.push('ollama'); return answering('answered by ollama'); } },
      ],
    );
    await expect(failover.generate([{ role: 'user', content: 'q' }])).resolves.toBe('answered by ollama');
    expect(tried).toEqual(['codex', 'ollama']);
  });

  it('reports the PRIMARY failure when everything fails, since that is the one to fix', async () => {
    const failover = createFailoverProvider(
      failing(new Error('claude login expired')),
      [{ id: 'codex', create: async () => failing(new Error('codex not installed')) }],
    );
    await expect(failover.generate([{ role: 'user', content: 'q' }])).rejects.toThrow(/claude login expired/);
  });

  it('does not shop a host denial to a second provider', async () => {
    const alternate = vi.fn();
    const failover = createFailoverProvider(
      failing(Object.assign(new Error('narration not allowed'), { code: 'PROVIDER_DISPATCH_NARRATION_NOT_ALLOWED' })),
      [{ id: 'codex', create: alternate }],
    );
    await expect(failover.generate([{ role: 'user', content: 'q' }])).rejects.toThrow(/narration not allowed/);
    expect(alternate).not.toHaveBeenCalled();
  });

  it('stops immediately when the run was cancelled', async () => {
    const alternate = vi.fn();
    const failover = createFailoverProvider(
      failing(new Error('socket hang up')),
      [{ id: 'codex', create: alternate }],
    );
    await expect(failover.generate([{ role: 'user', content: 'q' }], { signal: AbortSignal.abort() }))
      .rejects.toThrow(/socket hang up/);
    expect(alternate).not.toHaveBeenCalled();
  });

  it('keeps the primary alone when nothing else is configured', () => {
    const only = answering('solo');
    expect(createFailoverProvider(only, [])).toBe(only);
  });

  it('advertises the native tool loop only when the PRIMARY has one', () => {
    const withTools: AgentProvider = {
      ...answering('x'),
      generateWithTools: async () => 'tool answer',
    };
    expect(createFailoverProvider(withTools, [{ id: 'codex', create: async () => answering('y') }]).generateWithTools)
      .toBeDefined();
    expect(createFailoverProvider(answering('x'), [{ id: 'codex', create: async () => withTools }]).generateWithTools)
      .toBeUndefined();
  });

  it('lets a fallback without a native loop answer through plain generation', async () => {
    const primary: AgentProvider = {
      ...answering('unused'),
      generateWithTools: async () => { throw new Error('primary tool loop down'); },
    };
    const failover = createFailoverProvider(primary, [
      { id: 'ollama', create: async () => answering('plain text answer') },
    ]);
    await expect(failover.generateWithTools!([{ role: 'user', content: 'q' }], [])).resolves.toBe('plain text answer');
  });
});
