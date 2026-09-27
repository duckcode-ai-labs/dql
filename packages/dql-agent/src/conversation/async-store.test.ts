/**
 * RFC 0010 HH-6: a host keeps conversations (and runs) in its own store, whose
 * methods answer with Promises. The async helpers must read and fold a thread
 * exactly as the synchronous ones do over DQL's SQLite store, and the
 * persisted-form helpers must keep what the SQLite stores keep.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationStore,
  conversationTurnForStorage,
  conversationTurnSearchTags,
  newConversationThread,
  type ConversationStoreLike,
  type ConversationTurnInput,
} from './session-store.js';
import { advanceThreadState, advanceThreadStateAsync, buildConversationSnapshot, loadConversationSnapshot } from './snapshot.js';
import { agentRunFromStorage, agentRunProgressForStorage, interruptedAgentRun } from '../agent-run-store.js';
import type { AgentRunProgressV1 } from '../agent-run-engine.js';

const TURNS: ConversationTurnInput[] = Array.from({ length: 9 }, (_, index) => ({
  question: `Revenue by region for 202${index % 5}`,
  answerSummary: `West leads in 202${index % 5}.`,
  route: 'generated_answer',
  runStatus: 'completed',
  trustLabel: 'governed',
  result: { columns: ['region', 'revenue'], rowCount: 4, rowsSample: [['West', 10]], dimensionValues: { region: ['West', 'East'] } },
  contract: { measures: ['revenue'], dimensions: ['region'], filters: [`202${index % 5}`] },
}));

/** The same store, every method a tick later. */
function promised(store: ConversationStore): ConversationStoreLike {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as ConversationStoreLike;
}

describe('conversation helpers over a store that answers with Promises', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const open = (name: string) => {
    const root = mkdtempSync(join(tmpdir(), `dql-async-${name}-`));
    dirs.push(root);
    return new ConversationStore(join(root, 'conversations.sqlite'));
  };

  it('folds and compacts a thread exactly as the synchronous helpers do', async () => {
    const sync = open('sync');
    const asyncBacking = open('async');
    const store = promised(asyncBacking);
    const syncThread = sync.createThread({ id: 'thr-same', surface: 'ask' }).id;
    const asyncThread = (await store.createThread({ id: 'thr-same', surface: 'ask' })).id;
    for (const input of TURNS) {
      advanceThreadState(sync, syncThread, sync.appendTurn(syncThread, input));
      await advanceThreadStateAsync(store, asyncThread, await store.appendTurn(asyncThread, input));
    }
    // Turn ids and times are fresh on each store; everything else must match.
    const strip = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/trn_[a-z0-9]+_[a-z0-9]+/g, 'trn').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'at'));
    expect(strip(asyncBacking.getThread(asyncThread))).toEqual(strip(sync.getThread(syncThread)));
    expect(asyncBacking.getThread(asyncThread)?.summaryTurnSeq).toBeGreaterThan(0);

    const question = 'and by product?';
    const expected = buildConversationSnapshot(sync, syncThread, { question });
    const actual = await loadConversationSnapshot(store, asyncThread, { question });
    expect(strip(actual)).toEqual(strip(expected));
    expect(await loadConversationSnapshot(store, 'missing')).toBeNull();
  });

  it('gives a host store the same bounded turn and thread records', () => {
    const turn = conversationTurnForStorage('thr-1', {
      ...TURNS[0],
      answerSummary: 'x'.repeat(5_000),
      result: { columns: Array.from({ length: 40 }, (_, index) => `c${index}`), rowsSample: Array.from({ length: 80 }, () => [1]) },
    });
    expect(turn).toMatchObject({ threadId: 'thr-1', seq: 0 });
    expect(turn.id).toMatch(/^trn_/);
    expect(turn.answerSummary).toHaveLength(1_200);
    expect(turn.result?.columns).toHaveLength(24);
    expect(turn.result?.rowsSample).toHaveLength(50);
    expect(conversationTurnSearchTags(turn)).toContain('generated_answer');
    expect(newConversationThread({ id: 'my-session', ownerId: 'u-1' })).toMatchObject({ id: 'my-session', ownerId: 'u-1', surface: 'notebook', summaryTurnSeq: 0 });
    expect(newConversationThread({ id: '../bad' }).id).toMatch(/^thr_/);
  });
});

describe('runs a host store keeps', () => {
  it('closes an interrupted run as the person who asked, with a retryable receipt', () => {
    const progress = agentRunProgressForStorage({
      version: 1,
      id: 'run-1',
      question: 'Claims paid last week',
      requestedMode: 'ask',
      ownerId: 'u-priya',
      lifecycle: { state: 'running', phase: 'route.executing', revision: 3, eventCursor: 2, startedAt: '2026-09-27T10:00:00.000Z', updatedAt: '2026-09-27T10:00:01.000Z' },
      plan: [],
      steps: [],
      artifacts: [],
      evaluations: [],
      events: [],
    } as unknown as AgentRunProgressV1);
    const run = interruptedAgentRun(progress, '2026-09-27T10:05:00.000Z');
    expect(run).toMatchObject({ id: 'run-1', ownerId: 'u-priya', status: 'blocked', completedAt: '2026-09-27T10:05:00.000Z' });
    expect(run.nextActions?.[0]).toMatchObject({ id: 'retry-interrupted-run' });
    expect(agentRunFromStorage(JSON.parse(JSON.stringify(run)))).toMatchObject({ id: 'run-1', ownerId: 'u-priya' });
    expect(agentRunFromStorage({ nope: true })).toBeUndefined();
  });
});
