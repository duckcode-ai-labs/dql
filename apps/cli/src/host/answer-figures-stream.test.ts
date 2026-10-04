import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunExecutors } from '@duckcodeailabs/dql-agent';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * RFC 0010 HH-14: when the host keeps a needs-review answer's figures from a person, nothing that could quote a
 * figure streams to them while the run goes: every event of a streamed Ask (its wording and its payload, the
 * answer artifact included), the answer deltas and the final run. The same answer streams whole when the host
 * shows figures (the control that proves the canary is there to find).
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const FIGURE = 'ADJ-16 Test Adjuster 16';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A needs-review answer whose text, artifact and rows all quote the figure. */
const reviewAnswer = () => ({
  summary: `Leading rows: ${FIGURE} · 15`,
  answer: `Leading rows: ${FIGURE} · 15`,
  status: 'needs_review' as const,
  trustState: 'review_required' as const,
  stopReason: 'human_review_required' as const,
  artifacts: [{
    id: 'answer-1',
    kind: 'answer' as const,
    title: 'Generated answer',
    trustState: 'review_required' as const,
    payload: { text: `Leading rows: ${FIGURE} · 15`, answer: FIGURE, result: { columns: ['adjuster', 'open_claims'], rows: [{ adjuster: FIGURE, open_claims: 15 }], rowCount: 1 } },
  }],
  evaluations: [],
  nextActions: [],
});

async function streamAsk(rule: 'show' | 'withhold_review'): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-figures-stream-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'figures' }));
  const executor = reviewAnswer as unknown as NonNullable<AgentRunExecutors['generated_answer']>;
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    agentRunExecutors: { conversation: executor, generated_answer: executor, semantic_answer: executor, certified_answer: executor, research: executor },
    hostHooks: { resolvePrincipal: () => priya, answerFigures: () => rule },
    captureServer: (created) => { servers.push(created); },
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/agent-runs?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ question: 'Which adjusters have the most open claims?' }),
  });
  expect(response.status).toBe(200);
  return response.text();
}

const events = (stream: string) => stream.split('\n\n').filter(Boolean).map((block) => ({
  name: /^event: (.*)$/m.exec(block)?.[1] ?? '',
  data: /^data: (.*)$/m.exec(block)?.[1] ?? '',
}));

describe('a streamed needs-review answer for a person whose figures the host withholds (HH-14)', () => {
  it('control: with figures shown, the stream carries the answer\'s figure', async () => {
    const stream = await streamAsk('show');
    expect(events(stream).some((event) => event.name === 'agent-run-event' && event.data.includes(FIGURE))).toBe(true);
  });

  it('no event, delta or final run carries a figure; each event still says what happened', async () => {
    const stream = await streamAsk('withhold_review');
    const all = events(stream);
    expect(all.map((event) => event.name)).toContain('agent-run-complete');
    expect(all.filter((event) => event.data.includes('ADJ-16') || event.data.includes('Test Adjuster')).map((event) => event.name)).toEqual([]);
    expect(all.some((event) => event.name === 'agent-run-answer-delta')).toBe(false);
    const runEvents = all.filter((event) => event.name === 'agent-run-event').map((event) => JSON.parse(event.data) as Record<string, unknown>);
    expect(runEvents.map((event) => event.type)).toContain('artifact.created');
    for (const event of runEvents) expect(Object.keys(event).filter((key) => !['id', 'runId', 'type', 'at', 'message', 'route', 'status', 'trustState'].includes(key))).toEqual([]);
    expect(JSON.parse(all.find((event) => event.name === 'agent-run-complete')!.data)).toMatchObject({ figuresWithheld: true });
  });
});
