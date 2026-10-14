import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createScriptedAnalystProvider, type ProviderRunOptions, type ReasoningEffort } from '@zlens/agent';
import type { QueryExecutor } from '@zlens/connectors';
import { askDispatchReasoningEffort, startLocalServer } from './local-runtime.js';

const here = dirname(fileURLToPath(import.meta.url));

function projectWithCeiling(ceiling?: ReasoningEffort, active = 'claude-code'): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-ask-effort-'));
  mkdirSync(join(root, '.dql'), { recursive: true });
  writeFileSync(join(root, '.dql', 'provider-settings.json'), JSON.stringify({
    version: 1,
    activeProvider: active,
    providers: { [active]: { id: active, enabled: true, ...(ceiling ? { reasoningEffort: ceiling } : {}) } },
  }));
  return root;
}

describe('reasoning effort for Ask provider calls', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  it('uses the route effort, harder on a repair, and the request choice when there is one', () => {
    const root = projectWithCeiling();
    roots.push(root);
    expect(askDispatchReasoningEffort(root, 'resolve', {}, 'claude-code')).toBe('medium');
    expect(askDispatchReasoningEffort(root, 'draft', {}, 'claude-code')).toBe('high');
    expect(askDispatchReasoningEffort(root, 'correct', {}, 'claude-code')).toBe('medium');
    expect(askDispatchReasoningEffort(root, 'repair', {}, 'claude-code')).toBe('high');
    expect(askDispatchReasoningEffort(root, 'research_select', {}, 'claude-code')).toBe('high');
    expect(askDispatchReasoningEffort(root, 'resolve', { thinkingMode: 'low' }, 'claude-code')).toBe('low');
    expect(askDispatchReasoningEffort(root, 'resolve', { thinkingMode: 'auto' }, 'claude-code')).toBe('medium');
    expect(askDispatchReasoningEffort(root, 'resolve', { reasoningEffort: 'high', thinkingMode: 'low' }, 'claude-code')).toBe('high');
    expect(askDispatchReasoningEffort(root, 'resolve', {}, undefined)).toBe('medium');
  });

  it('never goes above the provider ceiling set in Settings', () => {
    const root = projectWithCeiling('low');
    roots.push(root);
    expect(askDispatchReasoningEffort(root, 'resolve', {}, 'claude-code')).toBe('low');
    expect(askDispatchReasoningEffort(root, 'repair', {}, 'claude-code')).toBe('low');
    expect(askDispatchReasoningEffort(root, 'resolve', { reasoningEffort: 'high' }, 'claude-code')).toBe('low');
  });

  it('ZLENS_ASK_READING_EFFORT sets the reading apart from SQL drafting; the request and the ceiling still win', () => {
    const root = projectWithCeiling();
    roots.push(root);
    const previous = process.env.ZLENS_ASK_READING_EFFORT;
    process.env.ZLENS_ASK_READING_EFFORT = 'low';
    try {
      expect(askDispatchReasoningEffort(root, 'resolve', {}, 'claude-code')).toBe('low');
      expect(askDispatchReasoningEffort(root, 'correct', {}, 'claude-code')).toBe('low');
      expect(askDispatchReasoningEffort(root, 'draft', {}, 'claude-code')).toBe('high');
      expect(askDispatchReasoningEffort(root, 'resolve', { reasoningEffort: 'medium' }, 'claude-code')).toBe('medium');
      process.env.ZLENS_ASK_READING_EFFORT = 'nonsense';
      expect(askDispatchReasoningEffort(root, 'resolve', {}, 'claude-code')).toBe('medium');
      // A project CONFIGURED for an API provider reads at low effort by default;
      // one that merely falls back to it (no settings) keeps the route effort;
      // 'auto' restores the route effort.
      delete process.env.ZLENS_ASK_READING_EFFORT;
      const api = projectWithCeiling(undefined, 'anthropic');
      roots.push(api);
      expect(askDispatchReasoningEffort(api, 'resolve', {}, 'anthropic')).toBe('low');
      expect(askDispatchReasoningEffort(api, 'draft', {}, 'anthropic')).toBe('high');
      expect(askDispatchReasoningEffort(root, 'resolve', {}, 'anthropic')).toBe('medium');
      const unconfigured = mkdtempSync(join(tmpdir(), 'dql-ask-effort-none-'));
      roots.push(unconfigured);
      expect(askDispatchReasoningEffort(unconfigured, 'resolve', {}, 'anthropic')).toBe('medium');
      process.env.ZLENS_ASK_READING_EFFORT = 'auto';
      expect(askDispatchReasoningEffort(api, 'resolve', {}, 'anthropic')).toBe('medium');
    } finally {
      if (previous === undefined) delete process.env.ZLENS_ASK_READING_EFFORT; else process.env.ZLENS_ASK_READING_EFFORT = previous;
    }
  });
});

describe('an Ask request sends a reasoning effort on every provider call', () => {
  let root: string;
  let server: Server | undefined;
  let base: string;
  const efforts: Array<ReasoningEffort | undefined> = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dql-ask-effort-run-'));
    cpSync(resolve(here, '../test/fixtures', 'jaffle-semantic'), root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const executor = {
      executeQuery: async (sql: string) => ({ columns: ['value'], rows: [{ value: 1 }], rowCount: 1, sql }),
    } as unknown as QueryExecutor;
    const port = await startLocalServer({
      rootDir: root,
      projectRoot: root,
      executor,
      connection: { driver: 'file' },
      askAnalyticalPlannerProviderFactory: () => {
        const scripted = createScriptedAnalystProvider('cooperative');
        return {
          ...scripted,
          generate: (messages: Parameters<typeof scripted.generate>[0], options?: ProviderRunOptions) => {
            efforts.push(options?.reasoningEffort);
            return scripted.generate(messages, options);
          },
        };
      },
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    base = `http://127.0.0.1:${port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((done) => server ? server.close(() => done()) : done());
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the question at the route effort', async () => {
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is total revenue?', requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    expect(efforts.length).toBeGreaterThan(0);
    expect(efforts.every((effort) => effort === 'medium' || effort === 'high')).toBe(true);
    expect(efforts[0]).toBe('medium');
  }, 120_000);
});
