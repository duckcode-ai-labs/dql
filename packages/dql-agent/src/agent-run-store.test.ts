import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteAgentRunStore } from './agent-run-store.js';
import type { AgentRun, AgentRunProgressV1 } from './agent-run-engine.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
function tmp(): string { const dir = mkdtempSync(join(tmpdir(), 'run-store-')); dirs.push(dir); return dir; }

function run(id: string, startedAt: string, events = 3): AgentRun {
  return {
    id,
    question: `question ${id}`,
    route: 'generated_answer',
    status: 'completed',
    startedAt,
    completedAt: startedAt,
    events: Array.from({ length: events }, (_, index) => ({ type: 'executor.started', message: `event ${index}` })),
    artifacts: [{ kind: 'answer', payload: { answer: `answer ${id}` } }],
    evaluations: [],
  } as unknown as AgentRun;
}

function progress(id: string): AgentRunProgressV1 {
  const startedAt = '2026-07-20T10:00:00Z';
  return {
    version: 1,
    id,
    question: `question ${id}`,
    requestedMode: 'ask',
    route: 'generated_answer',
    steps: [],
    artifacts: [],
    evaluations: [],
    events: [{
      id: `${id}:event:1`,
      runId: id,
      type: 'run.started',
      at: startedAt,
      message: 'Started.',
    }],
    lifecycle: {
      version: 1,
      state: 'running',
      phase: 'run.started',
      revision: 1,
      eventCursor: 1,
      startedAt,
      updatedAt: startedAt,
    },
  };
}

describe('SqliteAgentRunStore', () => {
  it('round-trips save/get/list ordered newest-first', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite') });
    store.save(run('a', '2026-07-20T10:00:00Z'));
    store.save(run('b', '2026-07-20T11:00:00Z'));
    expect(store.get('a')?.question).toBe('question a');
    expect(store.list().map((r) => r.id)).toEqual(['b', 'a']);
    store.close();
  });

  it('claims a request identity once and reports the original claim on every replay', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite') });
    expect(store.requestClaim('req-1')).toBeUndefined();
    const first = store.claimRequest('req-1', 'run-a', 'fp-a');
    expect(first).toMatchObject({ runId: 'run-a', fingerprint: 'fp-a', existing: false });
    const again = store.claimRequest('req-1', 'run-b', 'fp-b');
    expect(again).toMatchObject({ runId: 'run-a', fingerprint: 'fp-a', existing: true });
    expect(store.requestClaim('req-1')?.runId).toBe('run-a');
    store.claimRequest('req-2', 'run-b', 'fp-b');
    expect(store.requestClaim('req-2')?.runId).toBe('run-b');
  });

  it('updates in place when the same run id is saved twice', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite') });
    store.save(run('a', '2026-07-20T10:00:00Z'));
    store.save({ ...run('a', '2026-07-20T10:00:00Z'), question: 'updated' } as AgentRun);
    expect(store.list()).toHaveLength(1);
    expect(store.get('a')?.question).toBe('updated');
    store.close();
  });

  it('persists accepted running state and replaces it with the terminal run', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite') });
    store.saveProgress(progress('active'));
    expect(store.get('active')).toBeUndefined();
    expect(store.getProgress('active')?.lifecycle.state).toBe('running');
    store.save(run('active', '2026-07-20T10:00:00Z'));
    expect(store.getProgress('active')).toBeUndefined();
    expect(store.get('active')?.status).toBe('completed');
    store.close();
  });

  it('closes orphaned running state as an inspectable interrupted run on restart', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    store.saveProgress(progress('orphan'));
    store.close();
    const reopened = new SqliteAgentRunStore({ path });
    const interrupted = reopened.get('orphan');
    expect(interrupted).toMatchObject({
      id: 'orphan',
      status: 'blocked',
      lifecycle: { state: 'terminal', phase: 'run.failed' },
      diagnosticReceipt: {
        failure: { code: 'RUN_INTERRUPTED', recoverable: true },
      },
    });
    expect(interrupted?.artifacts[0]?.payload).toMatchObject({
      diagnosticReceipt: { failure: { code: 'RUN_INTERRUPTED' } },
    });
    reopened.close();
  });

  // F10 (ZLens 0.1.0 e2e): a second ZLens process opening the project (another
  // notebook, the runtime `zlens agent ask` starts) closed the run the notebook
  // was still answering, and the page read "the runtime restarted".
  it('leaves a run that another live runtime is still answering alone', () => {
    const path = join(tmp(), 'runs.sqlite');
    const live = new SqliteAgentRunStore({ path });
    const fresh = progress('in-flight');
    fresh.lifecycle.updatedAt = new Date().toISOString();
    live.saveProgress(fresh);
    const other = new SqliteAgentRunStore({ path });
    expect(other.getProgress('in-flight')?.lifecycle.state).toBe('running');
    expect(other.get('in-flight')).toBeUndefined();
    live.save(run('in-flight', fresh.lifecycle.startedAt));
    expect(other.get('in-flight')?.status).toBe('completed');
    other.close();
    live.close();
  });

  it('leaves a run owned by another process on this machine alone while that process lives', () => {
    const path = join(tmp(), 'runs.sqlite');
    const writer = new SqliteAgentRunStore({ path });
    const fresh = progress('other-process');
    fresh.lifecycle.updatedAt = new Date().toISOString();
    writer.saveProgress(fresh);
    writer.close();
    const db = new Database(path);
    const owner = db.prepare('SELECT runtime_owner FROM agent_runs WHERE id = ?').get('other-process') as { runtime_owner: string };
    const [host] = owner.runtime_owner.split('#');
    // The parent of this test process is alive; a pid far above any real one is not.
    db.prepare('UPDATE agent_runs SET runtime_owner = ? WHERE id = ?').run(`${host}#${process.ppid}#elsewhere`, 'other-process');
    db.close();
    const reopened = new SqliteAgentRunStore({ path });
    expect(reopened.getProgress('other-process')?.lifecycle.state).toBe('running');
    reopened.close();
    const db2 = new Database(path);
    db2.prepare('UPDATE agent_runs SET runtime_owner = ? WHERE id = ?').run(`${host}#2147483646#gone`, 'other-process');
    db2.close();
    const afterExit = new SqliteAgentRunStore({ path });
    const closed = afterExit.get('other-process');
    expect(closed?.diagnosticReceipt?.failure?.code).toBe('RUN_INTERRUPTED');
    // It says what is known: the runtime answering it stopped. Never that it
    // "restarted" when this process cannot know that.
    expect(closed?.diagnosticReceipt?.failure?.message).not.toMatch(/restarted/);
    afterExit.close();
  });

  it('closes a run whose owner looks alive but has been silent longer than any run may take', () => {
    const path = join(tmp(), 'runs.sqlite');
    const live = new SqliteAgentRunStore({ path });
    live.saveProgress(progress('stale'));
    const other = new SqliteAgentRunStore({ path });
    expect(other.get('stale')?.diagnosticReceipt?.failure?.code).toBe('RUN_INTERRUPTED');
    other.close();
    live.close();
  });

  it('preserves typed Ask continuation but writes only a content-free V5 receipt on restart', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    const initial = progress('orphan-v5');
    initial.askAnalystState = {
      version: 1,
      mode: 'authoritative',
      phase: 'program_ready',
      frame: {
        version: 3,
        questionFingerprint: 'sha256:question',
        kind: 'aggregation',
        requirements: {
          measures: ['revenue'], dimensions: [], entityTerms: [], entityDisplayTerms: [], memberTerms: [], outputTerms: [],
        },
        conversation: { binding: 'none' },
      },
      mission: { version: 1, mode: 'ask', taskLimit: 3, planningContinuationLimit: 2, tasks: [], hypotheses: [] },
      workspace: {
        version: 1,
        admittedCandidateIds: ['metric:revenue'],
        excludedCandidates: [],
        sourceCoverage: [],
        tools: [{ version: 1, id: 'tool:retrieve_snapshot', kind: 'retrieve_snapshot', status: 'completed', candidateIds: ['metric:revenue'], reasonCode: 'snapshot_acquired' }],
      },
      program: {
        version: 1,
        id: 'program:restart',
        frameFingerprint: 'sha256:question',
        taskIds: ['task-1'],
        candidateIds: ['metric:revenue'],
        executionCandidateIds: ['metric:revenue'],
        requiredRoles: ['metric'],
        filters: [{ fieldTerms: ['customer_name'], memberIds: [], value: 'Brittany Barrera', operator: 'equals' }],
        relationshipRequirements: [],
        outputs: { measures: ['revenue'], dimensions: [], entityDisplayTerms: [], assertions: ['all_requested_measures', 'result_contract'] },
      },
      conversationDelta: {
        version: 1,
        sourceQuestionFingerprint: 'sha256:question',
        partialFrame: {
          kind: 'aggregation',
          requirements: { measures: ['revenue'], dimensions: [], entityTerms: [], entityDisplayTerms: [], memberTerms: [], outputTerms: [] },
        },
      },
      planningContinuations: 1,
      toolCalls: 1,
      executionAttempts: 0,
      repairAttempts: 0,
    } as never;
    store.saveProgress(initial);
    store.close();

    const reopened = new SqliteAgentRunStore({ path });
    const interrupted = reopened.get('orphan-v5');
    expect(interrupted?.askAnalystState?.program.filters[0]?.value).toBe('Brittany Barrera');
    expect(interrupted?.diagnosticReceiptV5).toMatchObject({
      version: 5,
      state: { requirementCounts: { filters: 1 }, program: { id: 'program:restart' } },
      businessAnswer: { mode: 'deterministic_fallback', factIds: [] },
    });
    expect(JSON.stringify(interrupted?.diagnosticReceiptV5)).not.toContain('Brittany Barrera');
    reopened.close();
  });

  it('round-trips V2 Ask state, program, planner receipt, and conversation delta across a restart', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    const initial = progress('orphan-v2');
    initial.askAnalystState = {
      version: 2,
      mode: 'authoritative',
      phase: 'program_ready',
      planningMode: 'targeted_revision',
      plannerRevisionCount: 1,
      frame: {
        version: 4,
        questionFingerprint: 'sha256:question-v2',
        kind: 'ranking',
        planningMode: 'targeted_revision',
        requirements: {
          measures: ['revenue'], dimensions: ['product category'], entityTerms: ['customer'], entityDisplayTerms: ['customer name'], memberTerms: [], outputTerms: [],
        },
        conversation: { binding: 'structured_clarification', selectedStableId: 'selection:customer_name' },
      },
      mission: {
        version: 1,
        mode: 'ask',
        taskLimit: 3,
        planningContinuationLimit: 2,
        tasks: [{ id: 'task-1', kind: 'ranking', question: 'top customers by product revenue', dependencies: [] }],
        deferredTasks: [{ id: 'task-2', kind: 'breakdown' }],
        hypotheses: [],
      },
      workspace: {
        version: 2,
        snapshotId: 'snapshot:v2',
        sourceFingerprint: 'sha256:snapshot-v2',
        workspaceCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'],
        plannerCandidateIds: ['metric:revenue', 'dimension:customer_name'],
        admittedCandidateIds: ['metric:revenue', 'dimension:customer_name'],
        excludedCandidates: [{ id: 'dimension:product_category', reasonCode: 'not_admitted' }],
        sourceCoverage: [],
        // Role coverage is intentionally count-only observability. Simulate
        // an untrusted persisted shape attempting to smuggle source labels or
        // raw query-like text through the restart checkpoint.
        roleCoverage: [{
          role: 'metric',
          candidateCount: 1,
          sensitiveMember: 'Brittany Barrera',
          rawLike: 'SELECT customer_name FROM customers',
        }, {
          role: 'categorical_dimension',
          candidateCount: 2,
          untrustedContext: 'product category',
        }, {
          role: 'customer=Brittany Barrera',
          candidateCount: 99,
          rawLike: 'customer=Brittany Barrera',
        }] as never,
        tools: [{ version: 1, id: 'tool:candidate_extension', kind: 'candidate_extension', status: 'completed', candidateIds: ['dimension:product_category'], reasonCode: 'targeted_same_snapshot_admitted' }],
        targetedContext: { version: 1, status: 'admitted', candidateIds: ['dimension:product_category'], relationshipPathIds: [], reasonCode: 'targeted_same_snapshot_admitted' },
      },
      program: {
        version: 2,
        id: 'program:restart-v2',
        frameFingerprint: 'sha256:question-v2',
        taskIds: ['task-1'],
        candidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'],
        executionCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'],
        plannerCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'],
        workspaceCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'],
        requiredRoles: ['metric', 'entity_label', 'categorical_dimension'],
        filters: [{ fieldTerms: ['customer_name'], memberIds: ['member:stable'], value: 'Brittany Barrera', operator: 'equals' }],
        relationshipRequirements: [],
        outputs: { measures: ['revenue'], dimensions: ['product category'], entityDisplayTerms: ['customer name'], assertions: ['all_requested_measures', 'all_requested_dimensions', 'result_contract'] },
        planner: {
          version: 1,
          tasks: [{ taskId: 'task-1', selectedConceptIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'], roleBindings: { metric: ['metric:revenue'], entity_label: ['dimension:customer_name'], categorical_dimension: ['dimension:product_category'] }, operations: ['aggregate', 'group', 'rank'], assumptions: ['top defaults to 10'] }],
          confidence: 'high',
          missingInformation: [],
        },
      },
      conversationDelta: {
        version: 2,
        sourceQuestionFingerprint: 'sha256:question-v2',
        selectedStableId: 'selection:customer_name',
        programId: 'program:restart-v2',
        partialFrame: {
          kind: 'ranking',
          planningMode: 'targeted_revision',
          requirements: { measures: ['revenue'], dimensions: ['product category'], entityTerms: ['customer'], entityDisplayTerms: ['customer name'], memberTerms: [], outputTerms: [] },
        },
      },
      planningReceipt: {
        version: 1,
        mode: 'targeted_revision',
        plannerCalls: 2,
        revisionCalls: 1,
        verification: { version: 1, status: 'valid', missingRoles: [], candidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'], reasonCode: 'program_verified' },
      },
      planningContinuations: 1,
      toolCalls: 2,
      executionAttempts: 0,
      repairAttempts: 0,
    } as never;
    store.saveProgress(initial);
    store.close();

    const reopened = new SqliteAgentRunStore({ path });
    const interrupted = reopened.get('orphan-v2');
    expect(interrupted?.askAnalystState).toMatchObject({
      version: 2,
      planningMode: 'targeted_revision',
      plannerRevisionCount: 1,
      frame: { version: 4, planningMode: 'targeted_revision' },
      workspace: { version: 2, targetedContext: { status: 'admitted' } },
      program: { version: 2, id: 'program:restart-v2', planner: { tasks: [expect.objectContaining({ taskId: 'task-1' })] } },
      conversationDelta: { version: 2, programId: 'program:restart-v2' },
      planningReceipt: { plannerCalls: 2, revisionCalls: 1, verification: { status: 'valid' } },
    });
    expect(interrupted?.askAnalystState?.workspace.roleCoverage).toEqual([
      { role: 'metric', candidateCount: 1 },
      { role: 'categorical_dimension', candidateCount: 2 },
    ]);
    // V2 continuation remains local durable state; the restart diagnostic is
    // still content-free and preserves the V1-V5 reader contract.
    expect(interrupted?.askAnalystState?.program.filters[0]?.value).toBe('Brittany Barrera');
    expect(JSON.stringify(interrupted?.diagnosticReceiptV5)).not.toContain('Brittany Barrera');
    expect(interrupted?.diagnosticReceiptV6).toMatchObject({
      version: 6,
      planning: { mode: 'targeted_revision', plannerCalls: 2, revisionCalls: 1, verification: { status: 'valid' } },
      cascade: { planFrozen: false },
      connection: { attempted: false },
      execution: { attempts: 0 },
      roleCoverage: [
        { role: 'metric', candidateCount: 1 },
        { role: 'categorical_dimension', candidateCount: 2 },
      ],
      story: expect.arrayContaining([
        expect.objectContaining({ stage: 'planner', status: 'completed' }),
        expect.objectContaining({ stage: 'verification', status: 'completed' }),
        expect.objectContaining({ stage: 'connection', status: 'skipped' }),
      ]),
    });
    expect(JSON.stringify(interrupted?.diagnosticReceiptV6)).not.toContain('Brittany Barrera');
    expect(JSON.stringify(interrupted?.askAnalystState?.workspace.roleCoverage)).not.toContain('SELECT customer_name');
    expect(JSON.stringify(interrupted?.askAnalystState?.workspace.roleCoverage)).not.toContain('product category');
    expect(JSON.stringify(interrupted?.askAnalystState?.workspace.roleCoverage)).not.toContain('customer=Brittany Barrera');
    expect(JSON.stringify(interrupted?.diagnosticReceiptV6)).not.toContain('SELECT customer_name');
    expect(JSON.stringify(interrupted?.diagnosticReceiptV6)).not.toContain('product category');
    expect(JSON.stringify(interrupted?.diagnosticReceiptV6)).not.toContain('customer=Brittany Barrera');
    expect(interrupted?.artifacts[0]?.payload).toMatchObject({ diagnosticReceiptV6: { version: 6 } });
    reopened.close();

    // A V2 checkpoint can be durable after the provider boundary records a
    // failed initial dispatch but before the planning receipt increments its
    // counter. The concise V6 receipt is the default trace/UI input, so it
    // must report that real call as blocked rather than claiming the planner
    // was skipped with zero calls.
    const failed = JSON.parse(JSON.stringify(initial)) as AgentRunProgressV1;
    failed.id = 'orphan-v2-failed-planner';
    failed.question = 'top customers';
    failed.events[0] = {
      ...failed.events[0]!,
      id: 'orphan-v2-failed-planner:event:1',
      runId: 'orphan-v2-failed-planner',
    };
    const failedState = failed.askAnalystState as any;
    failedState.phase = 'blocked';
    failedState.planningMode = 'initial_planner';
    failedState.frame.planningMode = 'initial_planner';
    failedState.workspace.tools = [{
      version: 1,
      id: 'tool:provider_meaning',
      kind: 'provider_meaning',
      status: 'failed',
      candidateIds: [],
      reasonCode: 'planning.initial.failed',
    }];
    failedState.planningReceipt = {
      version: 1,
      mode: 'initial_planner',
      plannerCalls: 0,
      revisionCalls: 0,
      verification: {
        version: 1,
        status: 'invalid',
        missingRoles: [],
        candidateIds: [],
        reasonCode: 'provider_preflight_unavailable',
      },
    };
    failedState.planningContinuations = 0;
    const failedStore = new SqliteAgentRunStore({ path });
    failedStore.saveProgress(failed);
    failedStore.close();

    const restarted = new SqliteAgentRunStore({ path });
    const failedInterrupted = restarted.get('orphan-v2-failed-planner');
    expect(failedInterrupted?.diagnosticReceiptV6).toMatchObject({
      version: 6,
      planning: {
        mode: 'initial_planner',
        plannerCalls: 1,
        revisionCalls: 0,
        verification: { status: 'invalid', reasonCode: 'provider_preflight_unavailable' },
      },
      story: expect.arrayContaining([
        expect.objectContaining({ stage: 'planner', status: 'blocked', reasonCode: 'planning.initial.failed' }),
      ]),
    });
    expect(JSON.stringify(failedInterrupted?.diagnosticReceiptV6)).not.toContain('Brittany Barrera');
    expect(failedInterrupted?.artifacts[0]?.payload).toMatchObject({ diagnosticReceiptV6: { version: 6 } });
    restarted.close();
  });

  it('round-trips V3 relationship paths, current-question atoms, trusted anchors, and checkpointed partial task outcomes across an interrupted restart', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    const initial = progress('orphan-v3-program');
    initial.askAnalystState = {
      version: 3,
      mode: 'authoritative',
      phase: 'program_ready',
      planningMode: 'deterministic_binding',
      plannerRevisionCount: 0,
      frame: {
        version: 4,
        questionFingerprint: 'sha256:question-v3',
        kind: 'ranking',
        planningMode: 'deterministic_binding',
        requirements: {
          measures: ['revenue'], dimensions: ['customer_name', 'region'], entityTerms: ['customer'],
          entityDisplayTerms: ['customer_name'], memberTerms: ['Philadelphia'], outputTerms: [],
        },
        conversation: { binding: 'prior_result' },
      },
      mission: {
        version: 1,
        mode: 'ask',
        taskLimit: 3,
        planningContinuationLimit: 2,
        tasks: [{ id: 'task-1', kind: 'ranking', question: 'add region here', dependencies: [] }],
        hypotheses: [],
      },
      workspace: {
        version: 2,
        snapshotId: 'snapshot:v3',
        sourceFingerprint: 'sha256:snapshot-v3',
        workspaceCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:region'],
        plannerCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:region'],
        admittedCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:region'],
        excludedCandidates: [],
        sourceCoverage: [],
        tools: [],
      },
      program: {
        version: 3,
        id: 'program:restart-v3',
        frameFingerprint: 'sha256:question-v3',
        taskIds: ['task-1'],
        candidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:region', 'dql:path:customer-region'],
        executionCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:region', 'dql:path:customer-region'],
        plannerCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:region'],
        workspaceCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:region', 'dql:path:customer-region'],
        requiredRoles: ['metric', 'entity_label', 'categorical_dimension', 'member'],
        filters: [{ fieldTerms: ['dimension:region'], memberIds: [], value: 'Philadelphia', operator: 'equals' }],
        relationshipRequirements: ['dql:relationship:customer-to-region'],
        relationshipPaths: [{
          version: 1,
          candidateId: 'dql:path:customer-region',
          proofClass: 'governed',
          relationshipEvidence: ['dql:relationship:customer-to-region'],
        }],
        inputAtoms: [{ version: 1, source: 'current_question', role: 'member', term: 'Philadelphia', required: true }],
        trustedTaskAnchors: [{
          version: 1,
          kind: 'analytical_shape',
          values: [],
          measures: ['revenue'],
          dimensions: ['customer_name'],
          sourceTurnId: 'turn:top-customers',
          resultFingerprint: 'a'.repeat(64),
        }],
        outputs: {
          measures: ['revenue'], dimensions: ['customer_name', 'region'], entityDisplayTerms: ['customer_name'],
          assertions: ['all_requested_measures', 'all_requested_dimensions', 'safe_relationship_closure', 'result_contract'],
        },
        planner: {
          version: 2,
          source: 'deterministic',
          tasks: [{
            taskId: 'task-1',
            selectedConceptIds: ['metric:revenue', 'dimension:customer_name', 'dimension:region'],
            roleBindings: {
              metric: ['metric:revenue'],
              entity_label: ['dimension:customer_name'],
              categorical_dimension: ['dimension:region'],
            },
            operations: ['aggregate', 'group', 'rank'],
            assumptions: ['top defaults to 10'],
          }],
          missingInformation: [],
        },
      },
      conversationDelta: {
        version: 2,
        sourceQuestionFingerprint: 'sha256:question-v3',
        programId: 'program:restart-v3',
        partialFrame: {
          kind: 'ranking',
          planningMode: 'deterministic_binding',
          requirements: {
            measures: ['revenue'], dimensions: ['customer_name', 'region'], entityTerms: ['customer'],
            entityDisplayTerms: ['customer_name'], memberTerms: ['Philadelphia'], outputTerms: [],
          },
        },
      },
      planningReceipt: {
        version: 1,
        mode: 'deterministic_binding',
        plannerCalls: 0,
        revisionCalls: 0,
        verification: {
          version: 1,
          status: 'valid',
          missingRoles: [],
          candidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:region'],
          reasonCode: 'program_verified',
        },
      },
      planningContinuations: 0,
      toolCalls: 0,
      executionAttempts: 0,
      repairAttempts: 0,
    } as never;
    // V2 ordinary-Ask task receipts are additive progress state. They must
    // survive an interrupted V3 runtime restart so an independently completed
    // child is not hidden behind a later planning/execution gap.
    const completedTaskArtifact = {
      id: 'answer:task-1',
      kind: 'answer' as const,
      title: 'Task 1 result',
      trustState: 'governed' as const,
      payload: {
        result: {
          columns: ['revenue'],
          rows: [{ revenue: 1 }],
          rowCount: 1,
          resultFingerprint: 'result:task-1',
        },
      },
    };
    initial.artifacts = [completedTaskArtifact];
    initial.steps = [{
      id: 'orphan-v3-program:step:1',
      index: 1,
      route: 'semantic_answer',
      askAnalystTaskId: 'task-1',
      goal: 'Task 1',
      successCriteria: [],
      status: 'passed',
      attempts: 1,
      summary: 'The first task completed.',
      evaluations: [],
      artifacts: [completedTaskArtifact],
    }] as never;
    initial.analyticalTaskOutcomes = [{
      version: 1,
      taskId: 'task-1',
      status: 'completed',
      trustState: 'governed',
      summary: 'The first task completed.',
      resultFingerprint: 'result:task-1',
    }, {
      version: 1,
      taskId: 'task-2',
      status: 'dependency_blocked',
      trustState: 'blocked',
      summary: 'The second task requires task-1 output.',
      dependencyTaskIds: ['task-1'],
      failure: {
        version: 1,
        code: 'DEPENDENCY_BLOCKED',
        message: 'The second task requires task-1 output.',
        phase: 'dependency',
      },
    }];
    initial.analyticalTaskOutcomeSummary = {
      version: 1,
      status: 'partial',
      trustState: 'governed',
      taskCount: 2,
      successfulTaskIds: ['task-1'],
      failedTaskIds: [],
      dependencyBlockedTaskIds: ['task-2'],
    };
    store.saveProgress(initial);
    store.close();

    const reopened = new SqliteAgentRunStore({ path });
    const interrupted = reopened.get('orphan-v3-program');
    expect(interrupted?.askAnalystState).toMatchObject({
      version: 3,
      program: {
        version: 3,
        id: 'program:restart-v3',
        relationshipPaths: [expect.objectContaining({
          candidateId: 'dql:path:customer-region',
          relationshipEvidence: ['dql:relationship:customer-to-region'],
        })],
        inputAtoms: [expect.objectContaining({
          source: 'current_question', role: 'member', term: 'Philadelphia', required: true,
        })],
        trustedTaskAnchors: [expect.objectContaining({
          kind: 'analytical_shape',
          sourceTurnId: 'turn:top-customers',
          resultFingerprint: 'a'.repeat(64),
        })],
      },
    });
    expect(interrupted?.analyticalTaskOutcomeSummary).toMatchObject({
      status: 'partial', trustState: 'governed', successfulTaskIds: ['task-1'], dependencyBlockedTaskIds: ['task-2'],
    });
    expect(interrupted?.analyticalTaskOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-1', status: 'completed', resultFingerprint: 'result:task-1' }),
      expect.objectContaining({ taskId: 'task-2', status: 'dependency_blocked', dependencyTaskIds: ['task-1'] }),
    ]));
    expect(interrupted?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'answer:task-1' }),
    ]));
    // Local continuation state remains durable, while observer-facing restart
    // receipts remain content-free and never reveal the literal or anchor.
    expect(JSON.stringify(interrupted?.diagnosticReceiptV6)).not.toContain('Philadelphia');
    expect(JSON.stringify(interrupted?.diagnosticReceiptV6)).not.toContain('turn:top-customers');
    reopened.close();
  });

  it('keeps V1/V2 runs readable and rejects malformed V3 task receipts at the local store boundary', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite') });
    const legacy = progress('legacy-without-v3-task-receipts');
    store.saveProgress(legacy);
    expect(store.getProgress(legacy.id)?.analyticalTaskOutcomes).toBeUndefined();
    expect(store.getProgress(legacy.id)?.analyticalTaskOutcomeSummary).toBeUndefined();

    const canonicalArtifact = {
      id: 'answer:valid-task',
      kind: 'answer' as const,
      title: 'Valid task result',
      trustState: 'governed' as const,
      payload: { result: {
        columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1,
        resultFingerprint: 'result:valid-task',
      } },
    };
    const malformed = progress('malformed-v3-task-receipts') as AgentRunProgressV1 & Record<string, unknown>;
    malformed.artifacts = [canonicalArtifact];
    malformed.steps = [{
      id: 'malformed-v3-task-receipts:step:1', index: 1, route: 'semantic_answer', askAnalystTaskId: 'valid-task',
      goal: 'Valid task', successCriteria: [], status: 'passed', attempts: 1,
      evaluations: [], artifacts: [canonicalArtifact],
    }] as never;
    malformed.analyticalTaskOutcomes = [{
      version: 1, taskId: 'valid-task', status: 'completed', trustState: 'governed',
      resultFingerprint: 'result:valid-task',
    }] as never;
    // These would otherwise let an edited local JSON record invent a second
    // successful task or make the Notebook call `.map` on a non-array value.
    (malformed as Record<string, unknown>).analyticalTaskOutcomes = [
      ...malformed.analyticalTaskOutcomes!,
      { version: 2, taskId: 'forged-task', status: 'completed', resultFingerprint: 'result:forged' },
      'not-a-task-receipt',
    ];
    (malformed as Record<string, unknown>).analyticalTaskOutcomeSummary = {
      version: 1, status: 'completed', trustState: 'governed', taskCount: 2,
      successfulTaskIds: ['valid-task', 'forged-task'], failedTaskIds: [], dependencyBlockedTaskIds: [],
    };
    store.saveProgress(malformed);
    const normalized = store.getProgress(malformed.id);
    expect(normalized?.analyticalTaskOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'valid-task', status: 'completed', resultFingerprint: 'result:valid-task' }),
      expect.objectContaining({
        taskId: 'forged-task', status: 'blocked',
        failure: expect.objectContaining({ code: 'TASK_RESULT_ARTIFACT_UNVERIFIED' }),
      }),
    ]));
    expect(normalized?.analyticalTaskOutcomeSummary).toMatchObject({
      status: 'partial', successfulTaskIds: ['valid-task'], failedTaskIds: ['forged-task'], taskCount: 2,
    });
    store.close();
  });

  it('never elevates a persisted task trust above its canonical exploratory result artifact', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    const initial = progress('review-required-task-trust');
    const exploratoryArtifact = {
      id: 'answer:exploratory-task',
      kind: 'answer' as const,
      title: 'Exploratory result',
      trustState: 'review_required' as const,
      payload: { result: {
        columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1,
        resultFingerprint: 'result:exploratory-task',
      } },
    };
    initial.artifacts = [exploratoryArtifact];
    initial.steps = [{
      id: 'review-required-task-trust:step:1', index: 1, route: 'generated_answer', askAnalystTaskId: 'task-1',
      goal: 'Exploratory task', successCriteria: [], status: 'needs_review', attempts: 1,
      evaluations: [], artifacts: [exploratoryArtifact],
    }] as never;
    initial.analyticalTaskOutcomes = [{
      version: 1, taskId: 'task-1', status: 'completed',
      // A local JSON edit must never upgrade a review-required execution.
      trustState: 'certified', resultFingerprint: 'result:exploratory-task',
    }];
    initial.analyticalTaskOutcomeSummary = {
      version: 1, status: 'completed', trustState: 'certified', taskCount: 1,
      successfulTaskIds: ['task-1'], failedTaskIds: [], dependencyBlockedTaskIds: [],
    };
    store.saveProgress(initial);
    store.close();

    const reopened = new SqliteAgentRunStore({ path });
    const interrupted = reopened.get('review-required-task-trust');
    expect(interrupted?.analyticalTaskOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-1', trustState: 'review_required' }),
    ]));
    expect(interrupted?.analyticalTaskOutcomeSummary).toMatchObject({ trustState: 'review_required' });
    reopened.close();
  });

  it('preserves a user cancellation as cancelled across restart', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    const initial = progress('cancelled-restart');
    store.saveProgress({
      ...initial,
      lifecycle: {
        ...initial.lifecycle,
        state: 'cancelling',
        updatedAt: '2026-07-20T10:00:01Z',
      },
    });
    store.close();

    const reopened = new SqliteAgentRunStore({ path });
    const cancelled = reopened.get('cancelled-restart');
    expect(cancelled).toMatchObject({
      route: 'generated_answer',
      status: 'cancelled',
      trustState: 'not_applicable',
      stopReason: 'cancelled',
      summary: 'Stopped by user.',
      nextActions: [],
      lifecycle: { state: 'terminal', phase: 'run.cancelled' },
      diagnosticReceipt: {
        failure: { code: 'RUN_CANCELLED', recoverable: false, safeActions: [] },
      },
    });
    expect(cancelled?.events.at(-1)?.type).toBe('run.cancelled');
    expect(cancelled?.artifacts).toEqual([]);
    reopened.close();
  });

  it('enforces retention on write (oldest pruned)', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite'), maxRuns: 20 });
    for (let index = 0; index < 30; index += 1) {
      store.save(run(`r${index}`, `2026-07-20T10:${String(index).padStart(2, '0')}:00Z`));
    }
    const ids = store.list().map((r) => r.id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('r29');
    expect(ids).not.toContain('r0');
    store.close();
  });

  it('compacts event streams for runs beyond the recent window but keeps artifacts', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite'), maxRuns: 50, fullPayloadRuns: 2 });
    for (let index = 0; index < 5; index += 1) {
      store.save(run(`r${index}`, `2026-07-20T10:0${index}:00Z`));
    }
    const all = store.list();
    const newest = all[0]!;
    const oldest = all.at(-1)!;
    expect(newest.events.length).toBeGreaterThan(0);
    expect(oldest.events).toEqual([]);
    expect(oldest.artifacts).toHaveLength(1);
    store.close();
  });

  it('imports a legacy JSON store once and renames it to *.migrated', () => {
    const dir = tmp();
    const legacy = join(dir, 'agent-runs.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, runs: [run('legacy1', '2026-07-19T10:00:00Z'), { junk: true }] }));
    const store = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    expect(store.get('legacy1')?.question).toBe('question legacy1');
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.migrated`)).toBe(true);
    // Re-opening must not double-import or crash.
    store.close();
    const reopened = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    expect(reopened.list()).toHaveLength(1);
    reopened.close();
  });

  it('drops corrupt row-bearing ordinary Ask receipts while importing legacy JSON', () => {
    const dir = tmp();
    const legacy = join(dir, 'agent-runs.json');
    const corruptReceipt = {
      version: 1,
      purpose: 'classification',
      dispatchPhase: 'classification',
      provider: 'openai',
      permittedCategories: ['question', 'result_rows'],
      resultRowCount: 1,
      cumulativeResultRowCount: 1,
      columnCount: 1,
      redactionPolicyId: 'hand-edited-local-json',
      optIn: true,
      payloadFingerprint: 'sha256:corrupt',
    };
    const legacyRun = {
      ...run('legacy-egress', '2026-07-19T10:00:00Z'),
      providerEgressReceipts: [corruptReceipt],
      diagnosticReceipt: { version: 1, providerEgressReceipts: [corruptReceipt] },
      artifacts: [{
        kind: 'answer',
        payload: { diagnosticReceipt: { version: 1, providerEgressReceipts: [corruptReceipt] } },
      }],
    };
    writeFileSync(legacy, JSON.stringify({ version: 1, runs: [legacyRun] }));

    const store = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    const imported = store.get('legacy-egress');
    expect(imported?.providerEgressReceipts).toEqual([]);
    expect(imported?.diagnosticReceipt?.providerEgressReceipts).toEqual([]);
    expect((imported?.artifacts[0]?.payload as { diagnosticReceipt?: { providerEgressReceipts?: unknown[] } })
      .diagnosticReceipt?.providerEgressReceipts).toEqual([]);
    store.close();
  });

  it('keeps V1/V2 phase-less ordinary narration rows as read-only legacy evidence on import', () => {
    const dir = tmp();
    const legacy = join(dir, 'agent-runs.json');
    const legacyReceipt = {
      version: 1,
      purpose: 'answer_narration',
      provider: 'openai',
      permittedCategories: ['question', 'result_rows'],
      resultRowCount: 2,
      cumulativeResultRowCount: 2,
      columnCount: 1,
      redactionPolicyId: 'legacy-result-rows-v1',
      optIn: true,
      payloadFingerprint: 'sha256:legacy-narration',
    };
    const legacyRun = {
      ...run('legacy-narration', '2026-07-19T10:00:00Z'),
      providerEgressReceipts: [legacyReceipt],
      diagnosticReceipt: { version: 1, providerEgressReceipts: [legacyReceipt] },
    };
    writeFileSync(legacy, JSON.stringify({ version: 1, runs: [legacyRun] }));

    const store = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    const imported = store.get('legacy-narration');
    expect(imported?.providerEgressReceipts).toEqual([
      expect.objectContaining({ purpose: 'answer_narration', resultRowCount: 2, legacyReadOnly: true }),
    ]);
    expect(imported?.diagnosticReceipt?.providerEgressReceipts).toEqual([
      expect.objectContaining({ purpose: 'answer_narration', legacyReadOnly: true }),
    ]);
    store.close();
  });

  it('tolerates a corrupt legacy file (kept on disk, store still works)', () => {
    const dir = tmp();
    const legacy = join(dir, 'agent-runs.json');
    writeFileSync(legacy, 'not json {');
    const store = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    store.save(run('a', '2026-07-20T10:00:00Z'));
    expect(store.list()).toHaveLength(1);
    expect(existsSync(`${legacy}.migrated`)).toBe(true);
    store.close();
  });
});

describe('content-addressed artifact payloads', () => {
  const big = () => ({ answer: 'x'.repeat(1_000_000), result: { columns: ['n'], rows: [[1]], rowCount: 1 } });
  const heavyRun = (id: string, startedAt: string): AgentRun => ({
    ...run(id, startedAt, 1),
    artifacts: [{ id: `${id}:answer`, kind: 'answer', title: 'Answer', trustState: 'governed', payload: big() }],
    // The task step carries its own payload: a listing hydrates task-step
    // proofs only, so the answer artifact must stay an address there.
    steps: [{ id: `${id}:step`, askAnalystTaskId: 'task-1', artifacts: [{ id: `${id}:task`, kind: 'answer', title: 'Task', trustState: 'governed', payload: { ...big(), task: true } }] }],
  } as unknown as AgentRun);
  const openDb = (path: string) => new (require('better-sqlite3') as typeof import('better-sqlite3'))(path, { readonly: true });

  it('stores a 1 MB payload once, as one blob, and hydrates it back on get', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    store.save(heavyRun('h1', '2026-07-20T10:00:00Z'));
    const db = openDb(path);
    const row = db.prepare('SELECT length(payload_json) AS bytes FROM agent_runs WHERE id = ?').get('h1') as { bytes: number };
    const blobs = db.prepare('SELECT COUNT(*) AS n FROM agent_run_artifacts').get() as { n: number };
    db.close();
    expect(row.bytes).toBeLessThan(20_000);
    expect(blobs.n).toBe(2);
    const loaded = store.get('h1')!;
    expect(loaded.artifacts[0]!.payload).toEqual(big());
    expect((loaded.steps[0] as { artifacts: Array<{ payload?: unknown }> }).artifacts[0]!.payload).toEqual({ ...big(), task: true });
    expect(loaded.artifacts[0]!.payloadRef).toMatch(/^sha256:/);
    store.close();
  });

  it('shares one blob between runs with the same payload, lists without hydrating, and prunes orphans with retention', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path, maxRuns: 2 });
    store.save(heavyRun('h1', '2026-07-20T10:00:00Z'));
    store.save(heavyRun('h2', '2026-07-20T11:00:00Z'));
    let db = openDb(path);
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_run_artifacts').get() as { n: number }).n).toBe(2);
    db.close();
    const listed = store.list(5);
    expect(listed.map((entry) => entry.id)).toEqual(['h2', 'h1']);
    expect(listed[0]!.artifacts[0]!.payload).toBeUndefined();
    expect(listed[0]!.artifacts[0]!.payloadRef).toMatch(/^sha256:/);
    // A third, different run evicts h1; h2 still cites the shared blob, so it stays.
    store.save({ ...run('h3', '2026-07-20T12:00:00Z', 1), artifacts: [{ id: 'h3:a', kind: 'answer', title: 'A', trustState: 'governed', payload: { answer: 'small' } }] } as unknown as AgentRun);
    db = openDb(path);
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_run_artifacts').get() as { n: number }).n).toBe(3);
    db.close();
    // Evicting h2 as well leaves the big blob with no citing run: it is pruned.
    store.save({ ...run('h4', '2026-07-20T13:00:00Z', 1), artifacts: [{ id: 'h4:a', kind: 'answer', title: 'A', trustState: 'governed', payload: { answer: 'small too' } }] } as unknown as AgentRun);
    db = openDb(path);
    const remaining = db.prepare('SELECT bytes FROM agent_run_artifacts ORDER BY bytes DESC').all() as Array<{ bytes: number }>;
    db.close();
    expect(remaining.every((blob) => blob.bytes < 10_000)).toBe(true);
    store.close();
  });

  it('externalizes rows written before content addressing when the store opens', () => {
    const path = join(tmp(), 'runs.sqlite');
    const first = new SqliteAgentRunStore({ path });
    first.close();
    const db = new (require('better-sqlite3') as typeof import('better-sqlite3'))(path);
    const inline = heavyRun('old', '2026-07-20T09:00:00Z');
    db.prepare('INSERT INTO agent_runs (id, question, route, status, started_at, completed_at, compacted, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run('old', 'q', 'generated_answer', 'completed', inline.startedAt, inline.startedAt, JSON.stringify(inline), inline.startedAt);
    db.close();
    const reopened = new SqliteAgentRunStore({ path });
    const check = openDb(path);
    const row = check.prepare('SELECT length(payload_json) AS bytes FROM agent_runs WHERE id = ?').get('old') as { bytes: number };
    check.close();
    expect(row.bytes).toBeLessThan(20_000);
    expect(reopened.get('old')!.artifacts[0]!.payload).toEqual(big());
    reopened.close();
  });
});
