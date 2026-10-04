import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import {
  createScriptedAnalystProvider,
  SCRIPTED_ANALYST_PERSONAS,
  type ScriptedAnalystPersona,
} from '@duckcodeailabs/dql-agent';
import { startLocalServer, type AskAgentRuntimeMode } from './local-runtime.js';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';

/**
 * THE ASK BATTERY.
 *
 * The runtime is judged by what the user gets. For every question, over every
 * fixture, under every way an analyst can fail — cooperative, lazy, wrong
 * then right, browsing until the budget dies, crashing mid-turn, returning
 * garbage — the user must get an executed governed answer, a clarification,
 * or an honest gap. Never a sentence about providers, dispatches, budgets or
 * snapshots. A project with a complete certified block gets it under EVERY
 * persona: that is the floor's invariant. And a question with a qualifier
 * the fixture cannot bind is never answered as the wider question.
 *
 * This drives the real local server through the same HTTP entry the notebook
 * uses, with the default runtime mode — the one users actually get.
 */

type Expectation = 'certified' | 'answer_or_gap' | 'not_broadened';
interface BatteryQuestion { id: string; question: string; fixtures: string[]; expect: Expectation }

const here = dirname(fileURLToPath(import.meta.url));
const battery = JSON.parse(readFileSync(resolve(here, '../test/ask-battery/questions.json'), 'utf8')) as { questions: BatteryQuestion[] };
const FIXTURES = ['jaffle-semantic', 'jaffle-supply-chain', 'bigrepo-arr'] as const;

/** Words that describe the machinery. None of them belongs in an answer. */
const INFRASTRUCTURE = /\b(provider|dispatch(es)?|budget|orchestration|snapshot|closure|kernel|tool path|retry)\b/i;

/**
 * A warehouse that answers any SELECT with rows shaped like its projection,
 * so certified blocks, semantic compiles and composed programs all execute.
 */
function columnsFromSql(sql: string): string[] {
  // The outer SELECT list: the last SELECT at parenthesis depth zero (after
  // any CTEs), up to the FROM at depth zero.
  const upper = sql.toUpperCase();
  let depth = 0;
  let selectAt = -1;
  let fromAt = -1;
  for (let index = 0; index < upper.length; index += 1) {
    const char = upper[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && upper.startsWith('SELECT', index) && /[\s(]/.test(upper[index - 1] ?? ' ')) { selectAt = index; fromAt = -1; }
    else if (depth === 0 && selectAt >= 0 && fromAt < 0 && upper.startsWith('FROM', index) && /\s/.test(upper[index - 1] ?? '') && /\s/.test(upper[index + 4] ?? '')) fromAt = index;
  }
  const projection = selectAt >= 0 && fromAt > selectAt ? sql.slice(selectAt + 6, fromAt) : '';
  const columns: string[] = [];
  let current = '';
  depth = 0;
  for (const char of projection) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { columns.push(current); current = ''; continue; }
    current += char;
  }
  columns.push(current);
  return columns
    .map((expression) => expression.trim())
    .filter(Boolean)
    .map((expression) => {
      const alias = expression.match(/\sAS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*$/i)?.[1];
      if (alias) return alias;
      const last = expression.match(/([A-Za-z_][A-Za-z0-9_]*)"?\s*$/)?.[1];
      return last ?? 'value';
    });
}

function executor(log: string[]): QueryExecutor {
  return {
    executeQuery: async (sql: string) => {
      log.push(sql);
      const columns = columnsFromSql(sql);
      const numeric = (name: string) => /(revenue|spend|amount|count|arr|total|value|quantity|price|sum|net)/i.test(name);
      const rows = [1, 2, 3].map((index) => Object.fromEntries(columns.map((name) => [name, numeric(name) ? 1000 - index : `Row ${index}`])));
      return { columns, rows, rowCount: rows.length, sql };
    },
  } as unknown as QueryExecutor;
}

interface Harness { base: string; server?: Server; setPersona(persona: ScriptedAnalystPersona): void; root: string; sqlLog: string[] }

async function startFixture(fixture: string): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), `dql-ask-battery-${fixture}-`));
  cpSync(resolve(here, '../test/fixtures', fixture), root, { recursive: true });
  rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
  let persona: ScriptedAnalystPersona = 'cooperative';
  let server: Server | undefined;
  const sqlLog: string[] = [];
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor: executor(sqlLog),
    connection: { driver: 'file' },
    // No --ask-runtime-mode: the battery runs what a user gets by default,
    // unless DQL_ASK_BATTERY_MODE selects a runtime under test.
    ...(process.env.DQL_ASK_BATTERY_MODE ? { askAgentRuntimeMode: process.env.DQL_ASK_BATTERY_MODE as AskAgentRuntimeMode } : {}),
    askAnalyticalPlannerProviderFactory: () => createScriptedAnalystProvider(persona),
    preferredPort: 0,
    captureServer: (created) => { server = created; },
  });
  return {
    base: `http://127.0.0.1:${port}`,
    root,
    sqlLog,
    get server() { return server; },
    setPersona: (next) => { persona = next; },
  };
}

async function askOnce(harness: Harness, question: string) {
  const response = await fetch(`${harness.base}/api/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, requestedMode: 'ask' }),
  });
  const payload = await response.json() as { run: any; error?: unknown };
  return { status: response.status, run: payload.run, raw: payload };
}

const executedSql = (run: any): string => (run?.artifacts ?? [])
  .map((artifact: any) => artifact?.payload?.sql ?? artifact?.payload?.dqlArtifact?.source ?? artifact?.payload?.result?.sql ?? '')
  .join('\n');

const userText = (run: any): string => [run?.answer, run?.summary, run?.businessAnswer?.headline, run?.businessAnswer?.narrative]
  .filter((value) => typeof value === 'string').join('\n');

describe.each(FIXTURES)('Ask battery over %s', (fixture) => {
  let harness: Harness;
  beforeAll(async () => { harness = await startFixture(fixture); }, 120_000);
  afterAll(async () => {
    await new Promise<void>((done) => harness?.server ? harness.server.close(() => done()) : done());
    rmSync(harness.root, { recursive: true, force: true });
  });

  const questions = battery.questions.filter((question) => question.fixtures.includes(fixture));
  const cases = questions.flatMap((question) => SCRIPTED_ANALYST_PERSONAS.map((persona) => [question.id, persona, question] as const));

  it.each(cases)('%s under a %s analyst ends in an answer, a clarification, or an honest gap', async (_id, persona, question) => {
    harness.setPersona(persona);
    const { status, run, raw } = await askOnce(harness, question.question);
    const context = () => JSON.stringify({
      persona, question: question.question, route: run?.route, status: run?.status, trust: run?.trustState,
      stop: run?.stopReason, text: userText(run).slice(0, 400), outcome: run?.diagnosticReceiptV8?.outcome,
      mode: run?.askAgentRuntimeMode,
      failure: run?.failure ?? run?.analyticalFailure,
      observations: (run?.diagnosticReceiptV8?.observations ?? []).map((o: any) => `${o.tool}:${o.outcome}:${o.reasonCode}`),
      sql: executedSql(run).slice(0, 300),
      executorCalls: harness.sqlLog.splice(0).map((sql) => sql.replace(/\s+/g, ' ').slice(0, 160)),
    }, null, 2);
    expect(status, JSON.stringify(raw).slice(0, 600)).toBe(201);
    expect(['completed', 'needs_review', 'needs_clarification', 'blocked'], context()).toContain(run.status);
    // What the user reads never describes the machinery.
    expect(userText(run), context()).not.toMatch(INFRASTRUCTURE);
    // Result rows never leave the host in ordinary Ask.
    for (const receipt of run.providerEgressReceipts ?? []) expect(receipt.resultRowCount, context()).toBe(0);

    if (question.expect === 'certified') {
      // THE FLOOR'S INVARIANT (legacy runtime): a complete certified block is
      // served no matter what the analyst did. The Ask pipeline has no host
      // floor by design — the interpreter reads the question once — so there
      // the invariant holds for every analyst that actually interprets
      // (cooperative, or wrong then corrected); the others end honestly.
      const pipeline = run.askAgentRuntimeMode === 'pipeline_v3';
      const interprets = persona === 'cooperative' || persona === 'wrong_ids_then_corrects';
      if (!pipeline || interprets) {
        // A certified block that groups only by a label (product_name) is not
        // served for a ranking: two products sharing a name would merge. The
        // pipeline composes the keyed governed answer and keeps the block as
        // refused evidence with its identity reason (AGT-064).
        const labelOnlyBlockRefused = pipeline && ((run.diagnosticReceiptV9?.refusals ?? [])
          .some((refusal: { tier?: string; message?: string }) => refusal.tier === 'certified' && /identity key/.test(refusal.message ?? ''))
          || (run.diagnosticReceiptV9?.tiers ?? []).some((tier: { detail?: string }) => /served as published/.test(tier.detail ?? ''))
          || /served as published because no keyed governed answer could be composed/.test(userText(run)));
        if (labelOnlyBlockRefused) {
          expect(run.route, context()).toBe('generated_answer');
          expect(run.trustState, context()).toBe('governed');
        } else {
          expect(run.route, context()).toBe('certified_answer');
          expect(run.trustState, context()).toBe('certified');
        }
      }
    }
    if (question.expect === 'not_broadened' && (run.status === 'completed' || run.status === 'needs_review') && run.route !== 'conversation') {
      // If something executed for "beverage revenue", it was about beverages.
      expect(`${executedSql(run)}\n${userText(run)}`, context()).toMatch(/drink|beverage/i);
    }
  }, 90_000);
});
