import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentRunStore, defaultAgentRunSqlitePath, type AgentRun, type AgentRunExecutors } from '@duckcodeailabs/dql-agent';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { WITHHELD_STOPPED, runForPerson, shouldWithhold } from './answer-figures.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * RFC 0010 HH-14, on every read: a person the host keeps needs-review figures from reads a run by id while it is
 * still going, after it was cancelled, and after it ended without settled trust, and never gets a figure (nor does
 * the store keep one for them). The same reads with figures shown carry the figure (the control that proves the
 * canary is there to find).
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@insurer.example', source: 'host' };
const FIGURE = 'CANARY-FIGURE-4417 Test Adjuster';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-figures-reads-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'figures' }));
  return root;
}

/** Everything the server keeps of runs, as text (the SQLite store and its journal). */
function storedText(root: string): string {
  const folder = join(root, '.dql', 'local');
  return readdirSync(folder).filter((name) => name.startsWith('agent-runs')).map((name) => readFileSync(join(folder, name)).toString('latin1')).join('\n');
}

/** An executor that says what it read so far (quoting a figure), then waits until released. */
function gatedExecutor() {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const executor = (async (context: { emit: (event: Record<string, unknown>) => void; route: string }) => {
    context.emit({ type: 'executor.started', message: `Read so far: ${FIGURE}`, route: context.route, payload: { preview: { columns: ['adjuster'], rows: [{ adjuster: FIGURE }], rowCount: 1 } } });
    await gate;
    return {
      summary: `Leading rows: ${FIGURE}`,
      answer: `Leading rows: ${FIGURE}`,
      status: 'needs_review' as const,
      trustState: 'review_required' as const,
      stopReason: 'human_review_required' as const,
      artifacts: [{ id: 'answer-1', kind: 'answer' as const, title: 'Generated answer', trustState: 'review_required' as const, payload: { text: FIGURE, result: { columns: ['adjuster'], rows: [{ adjuster: FIGURE }], rowCount: 1 } } }],
      evaluations: [],
      nextActions: [],
    };
  }) as unknown as NonNullable<AgentRunExecutors['generated_answer']>;
  return { executor, release };
}

async function start(root: string, rule: 'show' | 'withhold_review' | (() => 'show' | 'withhold_review'), executor?: NonNullable<AgentRunExecutors['generated_answer']>): Promise<string> {
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    ...(executor ? { agentRunExecutors: { conversation: executor, generated_answer: executor, semantic_answer: executor, certified_answer: executor, research: executor } } : {}),
    hostHooks: { resolvePrincipal: () => priya, answerFigures: () => (typeof rule === 'function' ? rule() : rule) },
    captureServer: (created) => { servers.push(created); },
  });
  return `http://127.0.0.1:${port}`;
}

/** Starts a streamed Ask and returns its run id once accepted, and the rest of the stream. */
async function ask(base: string): Promise<{ runId: string; rest: Promise<string> }> {
  const response = await fetch(`${base}/api/agent-runs?stream=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ question: 'Which adjusters have the most open claims?' }) });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const accepted = /event: agent-run-accepted\ndata: (.*)\n/.exec(text);
    if (accepted) {
      const runId = (JSON.parse(accepted[1]!) as { runId: string }).runId;
      const rest = (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) return text;
          text += decoder.decode(next.value, { stream: true });
        }
      })();
      return { runId, rest };
    }
  }
  throw new Error(`No accepted event: ${text}`);
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let tries = 0; tries < 100; tries += 1) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Timed out waiting for the run.');
}

const byId = async (base: string, runId: string) => {
  const response = await fetch(`${base}/api/agent-runs/${runId}`);
  return { status: response.status, text: await response.text() };
};

describe('reading a run by id, for a person whose needs-review figures the host withholds (HH-14)', () => {
  it.each(['show', 'withhold_review'] as const)('while it is still going (%s)', async (rule) => {
    const root = project();
    const { executor, release } = gatedExecutor();
    const base = await start(root, rule, executor);
    const { runId, rest } = await ask(base);
    const inFlight = await until(() => byId(base, runId), (read) => read.status === 200 && read.text.includes('executor.started'));
    expect(JSON.parse(inFlight.text)).toMatchObject({ lifecycleState: expect.any(String), progress: expect.any(Object) });
    if (rule === 'show') expect(inFlight.text).toContain(FIGURE);
    else expect(inFlight.text).not.toContain('CANARY-FIGURE');
    release();
    await rest;
    const finished = await byId(base, runId);
    expect(JSON.parse(finished.text)).toMatchObject({ lifecycleState: 'terminal' });
    if (rule === 'show') {
      expect(finished.text).toContain(FIGURE);
      expect(storedText(root)).toContain('CANARY-FIGURE');
    } else {
      expect(finished.text).not.toContain('CANARY-FIGURE');
      expect(JSON.parse(finished.text).run).toMatchObject({ figuresWithheld: true });
      // Nothing the server keeps for this person holds the figure, in progress or at the end.
      expect(storedText(root)).not.toContain('CANARY-FIGURE');
    }
  });

  it('while it is still going, when the rule changed after it started (read by id, decided at the read)', async () => {
    const root = project();
    const { executor, release } = gatedExecutor();
    let rule: 'show' | 'withhold_review' = 'show';
    const base = await start(root, () => rule, executor);
    const { runId, rest } = await ask(base);
    const shown = await until(() => byId(base, runId), (read) => read.status === 200 && read.text.includes('executor.started'));
    expect(shown.text).toContain(FIGURE);
    rule = 'withhold_review';
    const withheld = await byId(base, runId);
    expect(withheld.status).toBe(200);
    expect(withheld.text).toContain('executor.started');
    expect(withheld.text).not.toContain('CANARY-FIGURE');
    release();
    await rest;
    expect((await byId(base, runId)).text).not.toContain('CANARY-FIGURE');
  });

  it.each(['show', 'withhold_review'] as const)('after it was cancelled (%s)', async (rule) => {
    const root = project();
    const { executor, release } = gatedExecutor();
    const base = await start(root, rule, executor);
    const { runId, rest } = await ask(base);
    await until(() => byId(base, runId), (read) => read.status === 200 && read.text.includes('executor.started'));
    const cancelled = await fetch(`${base}/api/agent-runs/${runId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(202);
    release();
    await rest;
    const read = await until(() => byId(base, runId), (value) => value.text.includes('"lifecycleState":"terminal"'));
    expect(JSON.parse(read.text).run).toMatchObject({ status: 'cancelled' });
    if (rule === 'show') expect(read.text).toContain(FIGURE);
    else {
      expect(read.text).not.toContain('CANARY-FIGURE');
      expect(storedText(root)).not.toContain('CANARY-FIGURE');
    }
  });

  it.each(['show', 'withhold_review'] as const)('a stored run that ended without settled trust and kept a result (%s)', async (rule) => {
    const root = project();
    const store = new SqliteAgentRunStore({ path: defaultAgentRunSqlitePath(root) });
    const at = new Date().toISOString();
    const stopped: AgentRun = {
      id: 'run-stopped-1', question: 'Which adjusters have the most open claims?', requestedMode: 'ask', route: 'generated_answer', status: 'cancelled', trustState: 'not_applicable', stopReason: 'cancelled',
      startedAt: at, completedAt: at, steps: [], summary: 'Stopped by user.',
      artifacts: [{ id: 'answer-1', kind: 'answer', title: 'Generated answer', trustState: 'review_required', payload: { text: FIGURE, result: { columns: ['adjuster'], rows: [{ adjuster: FIGURE }], rowCount: 1 } } }],
      evaluations: [], events: [{ id: 'e1', runId: 'run-stopped-1', type: 'executor.started', at, message: `Read so far: ${FIGURE}` } as never], nextActions: [], repairAttempts: 0, ownerId: priya.id,
    };
    await store.save(stopped);
    (store as unknown as { close?: () => void }).close?.();
    const base = await start(root, rule);
    const read = await byId(base, 'run-stopped-1');
    expect(read.status).toBe(200);
    if (rule === 'show') expect(read.text).toContain(FIGURE);
    else {
      expect(read.text).not.toContain('CANARY-FIGURE');
      expect(JSON.parse(read.text).run).toMatchObject({ figuresWithheld: true, summary: WITHHELD_STOPPED });
    }
  });
});

describe('the one decision for a run as a person reads it', () => {
  const base = { id: 'r', question: 'q', requestedMode: 'ask', route: 'generated_answer', stopReason: 'completed', startedAt: '', completedAt: '', steps: [], summary: 'Which region do you mean: West or East?', evaluations: [], nextActions: [], repairAttempts: 0 } as unknown as AgentRun;
  const decide = (rule: 'show' | 'withhold_review', run: Record<string, unknown>) => shouldWithhold(rule, run as unknown as AgentRun);
  const result = { id: 'a', kind: 'answer', title: 'Answer', payload: { result: { rows: [{ v: FIGURE }] } } } as const;
  it('withholds needs-review answers and unsettled runs that kept a result, and nothing certified or governed', () => {
    expect(decide('withhold_review', { ...base, status: 'needs_review', trustState: 'review_required', artifacts: [], events: [] })).toBe(true);
    expect(decide('withhold_review', { ...base, status: 'cancelled', trustState: 'not_applicable', artifacts: [{ ...result, trustState: 'review_required' }], events: [] })).toBe(true);
    expect(decide('withhold_review', { ...base, status: 'blocked', trustState: 'blocked', artifacts: [{ ...result, trustState: 'blocked' }], events: [] })).toBe(true);
    expect(decide('withhold_review', { ...base, status: 'completed', trustState: 'certified', artifacts: [{ ...result, trustState: 'certified' }], events: [] })).toBe(false);
    expect(decide('withhold_review', { ...base, status: 'cancelled', trustState: 'not_applicable', artifacts: [{ ...result, trustState: 'governed' }], events: [] })).toBe(false);
    expect(decide('show', { ...base, status: 'needs_review', trustState: 'review_required', artifacts: [], events: [] })).toBe(false);
  });

  it('keeps a clarification\'s own words but none of its workings', () => {
    const clarification = { ...base, status: 'needs_clarification', trustState: 'not_applicable', artifacts: [], events: [{ id: 'e', runId: 'r', type: 'executor.started', at: '', message: `probed ${FIGURE}`, payload: { members: [FIGURE] } }] } as unknown as AgentRun;
    const read = runForPerson('withhold_review', clarification);
    expect(read.summary).toBe(clarification.summary);
    expect(JSON.stringify(read)).not.toContain('CANARY-FIGURE');
    expect(runForPerson('show', clarification)).toBe(clarification);
  });
});
