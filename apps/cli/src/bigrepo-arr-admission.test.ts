import { describe, expect, it, afterEach } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAnalyticalRequirementSet,
  buildLocalContextPack,
  selectRoleBalancedMeaningCandidates,
  toAgentRetrievalEvidence,
  type AgentEvidenceCandidate,
} from '@zlens/agent';

/**
 * The big-repo admission regression.
 *
 * Nineteen recorded runs of "top 10 customer accounts by net arr" against a
 * 3,373-model warehouse all ended blocked, and every one failed the same way:
 * the host retrieved the relations that could answer the question, then showed
 * the analyst a support report, a forecast table and a single column card
 * instead. With no relation and no column vocabulary the model invented
 * `customer_account_name`, every tier refused the invention, and the turn spent
 * its remaining budget re-guessing.
 *
 * These assertions are about the WORKSPACE, not about a model: what retrieval
 * admits, whether an admitted relation carries the columns a query needs, and
 * whether those columns are legal identifiers. No warehouse and no rows are
 * required to answer that, which is why this fixture has neither.
 */
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const QUESTION = 'top 10 customer accounts by net arr';

async function admittedWorkspace(): Promise<{
  retained: AgentEvidenceCandidate[];
  initial: AgentEvidenceCandidate[];
}> {
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/bigrepo-arr');
  const root = mkdtempSync(join(tmpdir(), 'dql-bigrepo-arr-'));
  directories.push(root);
  cpSync(fixture, root, { recursive: true });
  rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });

  const pack = await buildLocalContextPack(root, { question: QUESTION, mode: 'question', limit: 80 });
  const evidence = toAgentRetrievalEvidence(pack.retrievalDiagnostics.meaningEvidence!, pack.questionPlan, {
    snapshotId: pack.knowledgeLens.snapshotId,
    sourceFingerprint: pack.freshness.fingerprint ?? undefined,
    knowledgeLens: pack.knowledgeLens,
    contextObjects: pack.objects,
    retrievalLanes: pack.retrievalDiagnostics.lanes,
  });
  const requirements = buildAnalyticalRequirementSet({ question: QUESTION, parsedIntent: evidence.parsedIntent });
  // Exactly the selection the V2 kernel performs when it builds a turn's state.
  const initial = selectRoleBalancedMeaningCandidates({
    candidates: evidence.candidates.slice(0, 128),
    requirements,
    maxCandidates: 24,
  });
  return { retained: evidence.candidates, initial };
}

/**
 * The RELATION card for an ARR mart.
 *
 * A synthesized semantic model shares the mart's display name, so matching on
 * the name alone finds a card that has no columns and cannot be queried. The
 * distinction matters: it is precisely the confusion that let a workspace look
 * populated while holding nothing a query could be built from.
 */
const isArrMartRelation = (candidate: AgentEvidenceCandidate): boolean =>
  (candidate.kind === 'dbt_model' || candidate.kind === 'sql_table')
  && (candidate.name === 'mart_arr' || candidate.name === 'mart_crm_opportunity');

describe('big-repo ARR admission (the recorded dead end)', () => {
  it('shows the analyst a relation that can actually answer the question', async () => {
    const { retained, initial } = await admittedWorkspace();

    // Retrieval was never the problem: the mart that can answer this question
    // was always in the pool.
    expect(retained.filter(isArrMartRelation).map((candidate) => candidate.name)).toContain('mart_arr');

    // The regression: it must reach the 24 cards the analyst may reference.
    // Before relations competed for a role of their own, the mart lost every
    // slot to narrower cards whose names merely contained "arr" — a support
    // report, a churn column, a forecast table.
    const admittedMarts = initial.filter(isArrMartRelation);
    expect(
      admittedMarts.map((candidate) => candidate.name),
      `admitted cards: ${initial.map((candidate) => candidate.name).join(', ')}`,
    ).not.toHaveLength(0);
  });

  it('gives every admitted relation the columns a query is built from', async () => {
    const { initial } = await admittedWorkspace();
    const mart = initial.find(isArrMartRelation);
    expect(mart).toBeDefined();
    const columns = (mart!.columns ?? []).map((column) => column.name);
    expect(columns.length).toBeGreaterThan(0);
    // The exact identifiers the recorded runs had to invent.
    if (mart!.name === 'mart_arr') {
      expect(columns).toContain('crm_account_name');
      expect(columns).toContain('arr');
    } else {
      expect(columns).toContain('net_arr');
    }
    // A wide fact table must report its real width, so a planner knows when it
    // is looking at a prefix rather than the whole relation.
    expect(mart!.columnCount ?? 0).toBeGreaterThanOrEqual(columns.length);
  });

  it('keeps synthesized column-dimensions from displacing the relations they were copied from', async () => {
    const { initial } = await admittedWorkspace();
    // This fixture declares no semantic models, so anything semantic here was
    // synthesized from a physical column and is a duplicate of a dbt object.
    const synthesized = initial.filter((candidate) => candidate.kind === 'semantic_member');
    expect(synthesized.length).toBeLessThan(initial.length);
  });
});
