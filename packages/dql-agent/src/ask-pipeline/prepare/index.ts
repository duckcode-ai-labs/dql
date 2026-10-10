import { prepareCertified } from './certified.js';
import { prepareExploratory } from './exploratory.js';
import { prepareSemantic } from './semantic.js';
import type { PrepareInput, PrepareResult, PreparedCandidate, PreparedRefusal } from './types.js';
export type { PreparedBlock } from './types.js';

export * from './types.js';
export { entails } from './certified.js';
export { bindSemanticRequest } from './semantic.js';
export { composeRelational } from './relational.js';

const TRUST_RANK: Record<PreparedCandidate['trust'], number> = { certified: 0, governed: 1, review_required: 2 };
const TIER_RANK: Record<PreparedCandidate['tier'], number> = { certified: 0, semantic: 1, relational: 2, exploratory: 3 };

/**
 * Run every governed tier against the same intent and choose the highest
 * trust that prepared. Exploration is never automatic: without an explicit
 * opt-in it is recorded as a refusal so the user can choose it.
 */
export async function prepare(input: PrepareInput): Promise<PrepareResult> {
  const candidates: PreparedCandidate[] = [];
  const refusals: PreparedRefusal[] = [];
  const attempts: PrepareResult['attempts'] = [];
  const record = (tier: PrepareResult['attempts'][number]['tier'], result: { candidates: PreparedCandidate[]; refusals: PreparedRefusal[] }) => {
    candidates.push(...result.candidates);
    refusals.push(...result.refusals);
    // A tier with nothing to try — no certified block exists, exploration was
    // not opted into — is SKIPPED, not refused: the answer went past it, and a
    // reader must not conclude that a block would have repaired the failure.
    const skipped = !result.candidates.length && result.refusals.length > 0 && result.refusals.every((refusal) => refusal.code === 'no_certified_block' || refusal.code === 'exploration_not_opted_in');
    attempts.push({ tier, outcome: result.candidates.length ? 'prepared' : skipped ? 'skipped' : 'refused', ...(result.refusals[0] ? { detail: tier === 'certified' ? `${result.refusals[0].code}: ${result.refusals.map((refusal) => refusal.message).join(' | ').slice(0, 580)}` : `${result.refusals[0].code}: ${result.refusals[0].message.slice(0, 200)}` } : {}) });
  };
  const excluded = new Set(input.excludeTiers ?? []);
  let certifiedFallbacks: PreparedCandidate[] = [];
  if (excluded.has('certified')) attempts.push({ tier: 'certified', outcome: 'skipped', detail: 'failed an execution proof' });
  else {
    const certified = prepareCertified(input.intent, input.vocabulary, input.deps);
    record('certified', certified);
    certifiedFallbacks = certified.fallbacks;
  }
  if (excluded.has('semantic')) attempts.push({ tier: 'semantic', outcome: 'skipped', detail: 'failed an execution proof' });
  else if (candidates.length === 0) record('semantic', await prepareSemantic(input.intent, input.vocabulary, input.deps));
  else attempts.push({ tier: 'semantic', outcome: 'skipped' });
  // Only certified blocks and authored semantics are governed tiers; anything
  // else is answered by AI-written SQL in the pipeline's AI lane.
  // THE LAST TIER RUNS ON ITS OWN when nothing governed could prepare the
  // reading (unless the project turned automatic exploration off, in which
  // case it stays an explicit opt-in). A policy denial never reaches it.
  const denied = refusals.some((refusal) => refusal.code === 'policy_filter_unbindable' || refusal.code === 'policy_conflict');
  if (candidates.length === 0 && excluded.has('exploratory')) attempts.push({ tier: 'exploratory', outcome: 'skipped', detail: 'failed an execution proof' });
  else if (candidates.length === 0 && !denied && (input.explorationOptIn || input.explorationAuto)) record('exploratory', await prepareExploratory(input.intent, input.vocabulary, input.deps, input.question ?? input.intent.reading));
  else if (candidates.length === 0 && !denied) {
    refusals.push({ tier: 'exploratory', code: 'exploration_not_opted_in', message: 'no governed tier could prepare this intent; review-required exploration needs an explicit opt-in', repairable: false });
    attempts.push({ tier: 'exploratory', outcome: 'refused', detail: 'exploration_not_opted_in' });
  }
  candidates.sort((a, b) => TRUST_RANK[a.trust] - TRUST_RANK[b.trust] || TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  // A label-only certified block is evidence while a keyed answer can be
  // composed; the pipeline serves it as published only after its repair
  // re-ask produced nothing better, never before.
  return { candidates, refusals, attempts, fallbacks: candidates.length === 0 ? certifiedFallbacks : [], ...(candidates[0] ? { chosen: candidates[0] } : {}) };
}
