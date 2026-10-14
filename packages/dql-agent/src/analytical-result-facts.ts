/**
 * Deterministic result facts and narration guards for RFC 0005. Numeric claims
 * are copied only from validated graph outputs and every fact is bound to the
 * terminal receipt. No causal explanation is inferred from analytical rows.
 *
 * Acceptance: AGT-020.
 */

import { createHash } from 'node:crypto';
import type { AnalyticalQuestionFrameV2 } from '@zlens/core';
import type {
  AnalyticalExecutionGraphV1,
  AnalyticalExecutionReceiptV1,
} from './analytical-execution-graph.js';
import { readEnv } from '@zlens/core';

export type AnalyticalResultFactKind =
  | 'scope'
  | 'metric_value'
  | 'delta'
  | 'percent_delta'
  | 'rank'
  | 'freshness'
  | 'caveat';

export interface AnalyticalResultFactV1 {
  factId: string;
  kind: AnalyticalResultFactKind;
  receiptId: string;
  graphFingerprint: string;
  resultFingerprint: string;
  outputIds: string[];
  rowIndex?: number;
  periodId?: string;
  value?: unknown;
  coordinates?: Record<string, unknown>;
  code?:
    | 'PARTIAL_CURRENT_PERIOD'
    | 'LATEST_COMPLETE_PERIOD'
    | 'MISSING_COMPARISON_VALUE'
    | 'ZERO_COMPARISON_DENOMINATOR';
  details?: Record<string, unknown>;
}

export interface AnalyticalResultFactSetV1 {
  version: 1;
  factSetId: string;
  planId: string;
  graphId: string;
  graphFingerprint: string;
  receiptId: string;
  resultFingerprint: string;
  facts: AnalyticalResultFactV1[];
}

export type BuildAnalyticalResultFactsResult =
  | { status: 'ready'; factSet: AnalyticalResultFactSetV1 }
  | {
      status: 'blocked';
      code: 'RECEIPT_MISMATCH' | 'RESULT_CONTRACT_MISMATCH';
      reason: string;
    };

export interface AnalyticalNarrativeClaimV1 {
  claimId: string;
  factIds: string[];
  text: string;
}

export interface AnalyticalNarrativeV1 {
  version: 1;
  factSetId: string;
  text: string;
  claims: AnalyticalNarrativeClaimV1[];
}

export type AnalyticalNarrativeValidationResult =
  | { status: 'valid'; citedFactIds: string[] }
  | {
      status: 'invalid';
      code: 'UNKNOWN_FACT' | 'UNSUPPORTED_NUMBER' | 'CAUSAL_CLAIM' | 'MATERIAL_CAVEAT_HIDDEN' | 'ABSENCE_CLAIM';
      reason: string;
      claimId?: string;
    };

export function buildAnalyticalResultFacts(input: {
  frame: AnalyticalQuestionFrameV2;
  graph: AnalyticalExecutionGraphV1;
  receipt: AnalyticalExecutionReceiptV1;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}): BuildAnalyticalResultFactsResult {
  const { frame, graph, receipt } = input;
  if (
    receipt.graphId !== graph.graphId ||
    receipt.graphFingerprint !== graph.fingerprint ||
    receipt.planId !== graph.planId ||
    receipt.planFingerprint !== graph.planFingerprint
  ) {
    return {
      status: 'blocked',
      code: 'RECEIPT_MISMATCH',
      reason: 'The result receipt does not bind the supplied graph and plan.',
    };
  }
  const expected = frame.requestedOutputs.map((output) => output.id);
  if (
    input.columns.length !== expected.length ||
    expected.some((outputId, index) => input.columns[index] !== outputId) ||
    input.rows.length !== receipt.rowCount ||
    input.rows.some((row) => expected.some((outputId) => !Object.prototype.hasOwnProperty.call(row, outputId)))
  ) {
    return {
      status: 'blocked',
      code: 'RESULT_CONTRACT_MISMATCH',
      reason: 'The validated rows do not match the frame output order or receipt row count.',
    };
  }
  const dimensionOutputs = frame.requestedOutputs.filter((output) => output.kind === 'dimension');
  const facts: AnalyticalResultFactV1[] = [];
  facts.push(makeFact(receipt, {
    kind: 'scope',
    outputIds: dimensionOutputs.map((output) => output.id),
    details: {
      entityGrainIds: [...frame.entityGrainIds],
      dimensions: frame.dimensions.map((dimension) => ({ ...dimension })),
      memberBindings: frame.memberBindings.map((binding) => ({
        ...binding,
        canonicalValues: [...binding.canonicalValues],
      })),
    },
  }));
  input.rows.forEach((row, rowIndex) => {
    const coordinates = Object.fromEntries(dimensionOutputs.map((output) => [output.id, row[output.id]]));
    for (const output of frame.requestedOutputs) {
      if (output.kind === 'dimension') continue;
      facts.push(makeFact(receipt, {
        kind: output.kind,
        outputIds: [output.id],
        rowIndex,
        ...(output.periodId ? { periodId: output.periodId } : {}),
        value: row[output.id],
        ...(dimensionOutputs.length ? { coordinates } : {}),
      }));
    }
    if (frame.comparison) {
      for (const periodId of frame.comparison.comparisonPeriodIds) {
        const comparisonOutput = frame.requestedOutputs.find(
          (output) => output.kind === 'metric_value' && output.periodId === periodId,
        );
        if (comparisonOutput && row[comparisonOutput.id] == null) {
          facts.push(makeFact(receipt, {
            kind: 'caveat',
            code: 'MISSING_COMPARISON_VALUE',
            outputIds: [comparisonOutput.id],
            rowIndex,
            periodId,
            ...(dimensionOutputs.length ? { coordinates } : {}),
          }));
        }
        const percentOutput = frame.requestedOutputs.find((output) => output.kind === 'percent_delta');
        if (comparisonOutput && percentOutput && isExactZero(row[comparisonOutput.id]) && row[percentOutput.id] == null) {
          facts.push(makeFact(receipt, {
            kind: 'caveat',
            code: 'ZERO_COMPARISON_DENOMINATOR',
            outputIds: [comparisonOutput.id, percentOutput.id],
            rowIndex,
            periodId,
            ...(dimensionOutputs.length ? { coordinates } : {}),
          }));
        }
      }
    }
  });
  if (frame.timeContext) {
    for (const period of frame.timeContext.periods) {
      facts.push(makeFact(receipt, {
        kind: 'freshness',
        outputIds: frame.requestedOutputs
          .filter((output) => output.periodId === period.id)
          .map((output) => output.id),
        periodId: period.id,
        value: period.end,
        details: {
          startInclusive: period.start,
          endExclusive: period.end,
          timeDimensionId: frame.timeContext.timeDimensionId,
          timeRole: frame.timeContext.timeRole,
          calendarId: frame.timeContext.calendarId,
          timezone: frame.timeContext.timezone,
          grain: frame.timeContext.grain,
          completenessPolicy: frame.timeContext.completenessPolicy,
        },
      }));
    }
    if (frame.timeContext.completenessPolicy === 'partial_current') {
      facts.push(makeFact(receipt, {
        kind: 'caveat',
        code: 'PARTIAL_CURRENT_PERIOD',
        outputIds: frame.requestedOutputs.filter((output) => output.periodId === frame.comparison?.basePeriodId || output.periodId === frame.timeContext?.periods[0]?.id).map((output) => output.id),
        details: { completenessPolicy: frame.timeContext.completenessPolicy },
      }));
    }
    if (frame.timeContext.completenessPolicy === 'latest_complete') {
      facts.push(makeFact(receipt, {
        kind: 'caveat',
        code: 'LATEST_COMPLETE_PERIOD',
        outputIds: frame.requestedOutputs.filter((output) => output.periodId === frame.comparison?.basePeriodId || output.periodId === frame.timeContext?.periods[0]?.id).map((output) => output.id),
        details: { completenessPolicy: frame.timeContext.completenessPolicy },
      }));
    }
  }
  const payload = {
    version: 1 as const,
    planId: graph.planId,
    graphId: graph.graphId,
    graphFingerprint: graph.fingerprint,
    receiptId: receipt.receiptId,
    resultFingerprint: receipt.resultFingerprint,
    facts,
  };
  return {
    status: 'ready',
    factSet: deepFreeze({
      ...payload,
      factSetId: `analytical-facts:${hash(stableStringify(payload)).slice(0, 24)}`,
    }),
  };
}

export function renderDeterministicAnalyticalNarrative(input: {
  frame: AnalyticalQuestionFrameV2;
  factSet: AnalyticalResultFactSetV1;
  maxRows?: number;
}): AnalyticalNarrativeV1 {
  const claims: AnalyticalNarrativeClaimV1[] = [];
  const outputById = new Map(input.frame.requestedOutputs.map((output) => [output.id, output]));
  const rowFacts = new Map<number, AnalyticalResultFactV1[]>();
  for (const fact of input.factSet.facts) {
    if (fact.rowIndex === undefined || fact.kind === 'caveat') continue;
    const current = rowFacts.get(fact.rowIndex) ?? [];
    current.push(fact);
    rowFacts.set(fact.rowIndex, current);
  }
  const maxRows = Math.min(Math.max(1, input.maxRows ?? 5), 20);
  for (const [rowIndex, facts] of [...rowFacts.entries()].sort(([left], [right]) => left - right).slice(0, maxRows)) {
    const coordinates = facts.find((fact) => fact.coordinates)?.coordinates ?? {};
    const coordinateText = Object.values(coordinates).map(displayValue).join(' · ');
    const values = facts
      .filter((fact) => fact.kind !== 'freshness')
      .map((fact) => {
        const outputId = fact.outputIds[0] ?? fact.kind;
        const label = humanizeOutput(outputId, outputById.get(outputId)?.kind);
        const suffix = fact.kind === 'percent_delta' && fact.value != null && fact.value !== 'not_applicable' ? '%' : '';
        return `${label}: ${displayValue(fact.value)}${suffix}`;
      });
    const text = `${coordinateText ? `${coordinateText} — ` : ''}${values.join('; ')}.`;
    claims.push({
      claimId: `claim:row:${rowIndex}`,
      factIds: facts.map((fact) => fact.factId),
      text,
    });
  }
  for (const freshness of input.factSet.facts.filter((fact) => fact.kind === 'freshness')) {
    const start = displayValue(freshness.details?.startInclusive);
    const end = displayValue(freshness.details?.endExclusive);
    const policy = String(freshness.details?.completenessPolicy ?? 'declared completeness');
    claims.push({
      claimId: `claim:freshness:${freshness.factId}`,
      factIds: [freshness.factId],
      text: `${humanizeOutput(freshness.periodId ?? 'period')} covers ${start} through ${end} under the ${policy.replace(/_/g, ' ')} policy.`,
    });
  }
  for (const caveat of input.factSet.facts.filter((fact) => fact.kind === 'caveat')) {
    claims.push({
      claimId: `claim:caveat:${caveat.factId}`,
      factIds: [caveat.factId],
      text: caveatText(caveat),
    });
  }
  const text = claims.map((claim) => claim.text).join(' ');
  return deepFreeze({ version: 1, factSetId: input.factSet.factSetId, text, claims });
}

/**
 * Does this sentence assert that something is ABSENT FROM THE SOURCE?
 *
 * Two parts are required, because either alone produces false positives. A
 * deterministic row renders a null comparison as `change: not available`, which
 * is a VALUE, not a claim about the world; and plenty of harmless sentences
 * mention "the data". Only the combination — absence wording plus a reference
 * to the data/result itself — asserts non-existence, as in "Wesley Jenkins is
 * not available in the provided customer data".
 */
const ABSENCE_PHRASE =
  /\b(?:not\s+(?:available|present|found|listed|included|shown)|does\s+not\s+(?:appear|exist)|do\s+not\s+(?:appear|exist)|(?:is|are|was|were)\s+(?:absent|unavailable|missing)|could\s+not\s+be\s+found|nothing\s+(?:found|matched)|no\s+(?:records?|data|information|matches?|entries))\b/i;
const SOURCE_SCOPE =
  /\b(?:in|from|within)\s+(?:the\s+)?(?:provided\s+|available\s+|governed\s+|current\s+)?(?:\w+\s+){0,2}(?:data|dataset|datasets|results?|records?|rows|tables?|customers|dimensions?)\b/i;

function assertsAbsenceFromSource(text: string): boolean {
  return ABSENCE_PHRASE.test(text) && SOURCE_SCOPE.test(text);
}

export function validateAnalyticalNarrativeClaims(input: {
  factSet: AnalyticalResultFactSetV1;
  claims: AnalyticalNarrativeClaimV1[];
}): AnalyticalNarrativeValidationResult {
  const facts = new Map(input.factSet.facts.map((fact) => [fact.factId, fact]));
  const cited = new Set<string>();
  for (const claim of input.claims) {
    if (/\b(?:because|caused?|causing|drove|driven by|led to|resulted in|responsible for)\b/i.test(claim.text)) {
      return { status: 'invalid', code: 'CAUSAL_CLAIM', reason: 'Analytical result narration cannot infer causality.', claimId: claim.claimId };
    }
    const claimFacts = claim.factIds.flatMap((factId) => {
      const fact = facts.get(factId);
      return fact ? [fact] : [];
    });
    if (claimFacts.length !== claim.factIds.length || claimFacts.length === 0) {
      return { status: 'invalid', code: 'UNKNOWN_FACT', reason: 'Every narrative claim must cite existing result facts.', claimId: claim.claimId };
    }
    // An ABSENCE claim cannot be supported by a result fact set. Every fact
    // asserts what IS in a bounded projection of the result; none of them can
    // establish that something is missing from the SOURCE. A run that returned
    // 200 of 500 customers led the narrator to report a real customer —
    // present in the warehouse — as "not available in the provided customer
    // data", which is worse than refusing to answer.
    //
    // A caveat fact that explicitly encodes missingness is the one legitimate
    // basis for saying a value is absent, so a claim citing one is allowed.
    if (assertsAbsenceFromSource(claim.text)) {
      // A cited CAVEAT fact is the licensed basis for a limitation statement —
      // "a comparison value is unavailable", "percentage change is not
      // available" are caveats the fact set does establish. What it can never
      // establish is that an ENTITY is absent from the source.
      const caveatCited = claimFacts.some((fact) => fact.kind === 'caveat');
      if (!caveatCited) {
        return {
          status: 'invalid',
          code: 'ABSENCE_CLAIM',
          reason: 'Result facts describe a bounded result and cannot establish that a value is absent from the source.',
          claimId: claim.claimId,
        };
      }
    }
    claim.factIds.forEach((factId) => cited.add(factId));
    const allowedNumbers = new Set(
      claimFacts.flatMap((fact) => numericTokens(stableStringify({
        value: fact.value,
        coordinates: fact.coordinates,
        details: fact.details,
        rowIndex: fact.rowIndex,
        periodId: fact.periodId,
      }))),
    );
    const unsupported = numericTokens(claim.text).filter((token) => !allowedNumbers.has(token));
    if (unsupported.length > 0) {
      return {
        status: 'invalid',
        code: 'UNSUPPORTED_NUMBER',
        reason: `Claim ${claim.claimId} contains unsupported numeric text: ${unsupported.join(', ')}.`,
        claimId: claim.claimId,
      };
    }
  }
  const hiddenCaveat = input.factSet.facts.find((fact) => fact.kind === 'caveat' && !cited.has(fact.factId));
  if (hiddenCaveat) {
    return {
      status: 'invalid',
      code: 'MATERIAL_CAVEAT_HIDDEN',
      reason: `Material caveat ${hiddenCaveat.code ?? hiddenCaveat.factId} is not cited by the narrative.`,
    };
  }
  return { status: 'valid', citedFactIds: [...cited].sort() };
}

/**
 * Serialize the fact set for a model that must cite it.
 *
 * This is deliberately NOT `renderDeterministicAnalyticalNarrative`: it carries
 * fact ids so `validateAnalyticalNarrativeClaims` can resolve every citation,
 * and it never joins values into prose. The model reads facts and writes
 * sentences; it does not get to invent numbers, because any numeric token that
 * is not present in a cited fact is rejected as `UNSUPPORTED_NUMBER`.
 */
export function renderAnalyticalFactBrief(input: {
  frame: AnalyticalQuestionFrameV2;
  factSet: AnalyticalResultFactSetV1;
  maxFacts?: number;
}): string {
  const outputById = new Map(input.frame.requestedOutputs.map((output) => [output.id, output]));
  const limit = Math.min(Math.max(1, input.maxFacts ?? 120), 400);
  const lines = input.factSet.facts.slice(0, limit).map((fact) => {
    const outputId = fact.outputIds[0] ?? fact.kind;
    const label = humanizeOutput(outputId, outputById.get(outputId)?.kind);
    const coordinates = Object.entries(fact.coordinates ?? {})
      .map(([key, value]) => `${key}=${displayValue(value)}`)
      .join(', ');
    const parts = [
      fact.factId,
      `kind=${fact.kind}`,
      `label=${label}`,
      coordinates ? `at=${coordinates}` : '',
      fact.rowIndex === undefined ? '' : `row=${fact.rowIndex}`,
      `value=${displayValue(fact.value)}`,
      fact.kind === 'caveat' ? `caveat=${caveatText(fact)}` : '',
    ].filter(Boolean);
    return `- ${parts.join(' | ')}`;
  });
  return lines.join('\n');
}

/**
 * Parse the model's claim payload. Prose without explicit `factIds` cannot be
 * verified — the validator resolves every id against the fact map — so a strict
 * JSON contract is the only shape that can be checked rather than trusted.
 */
/**
 * How many output tokens the verified-facts narrator needs for a result.
 *
 * The contract makes every claim echo the fact ids it rests on, and a fact id
 * is a long hex string that tokenizes badly — so the ceiling has to grow with
 * the result. At a flat 350 a ten-row answer was cut off mid-word
 * ("...Elizabeth Shea (875), and Dyl"), the JSON never closed, BOTH attempts
 * failed as UNPARSEABLE_CLAIMS, and the reader got the deterministic row dump
 * under "Verified narration was unavailable". Nothing in CI caught it because
 * the gate never reaches a model; this function exists so the arithmetic is
 * testable without one.
 */
export function narrationMaxTokensForFacts(factCount: number): number {
  return Math.min(1600, 350 + Math.max(0, factCount) * 45);
}

export function parseAnalyticalNarrativeClaims(raw: string): AnalyticalNarrativeClaimV1[] | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  if (!candidate) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  const claims = (parsed as { claims?: unknown })?.claims;
  if (!Array.isArray(claims) || claims.length === 0) return undefined;
  const out: AnalyticalNarrativeClaimV1[] = [];
  for (const entry of claims) {
    if (!entry || typeof entry !== 'object') return undefined;
    const record = entry as { claimId?: unknown; factIds?: unknown; text?: unknown };
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    const factIds = Array.isArray(record.factIds)
      ? record.factIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (!text || factIds.length === 0) return undefined;
    out.push({
      claimId: typeof record.claimId === 'string' && record.claimId ? record.claimId : `claim:${out.length}`,
      factIds,
      text,
    });
  }
  return out;
}

export interface ComposedAnalyticalNarrative {
  narrative: AnalyticalNarrativeV1;
  source: 'llm' | 'deterministic';
  /** Validation codes that forced the deterministic floor, newest last. */
  validationFailures: string[];
  attempts: number;
}

export interface AnalyticalNarrativeCompletion {
  (input: { system: string; user: string }): Promise<string>;
}

const NARRATIVE_SYSTEM_PROMPT = [
  'You write one short, business-facing answer from verified analytical facts.',
  'Return ONLY a JSON object: {"claims":[{"claimId":"...","factIds":["fact:..."],"text":"..."}]}.',
  'Rules, all enforced by an automatic verifier that will reject your output:',
  '1. Every claim must cite the exact factIds whose values it states.',
  '2. Every number you write must appear in a fact you cited. Never compute, round, or infer a new number.',
  '3. Never explain WHY something happened. No "because", "caused", "driven by", "led to", "resulted in".',
  '4. Every fact whose kind is "caveat" must be cited by some claim.',
  'Write plainly, like an analyst answering a colleague. Lead with the direct answer.',
].join('\n');

/**
 * Compose the answer prose for an analytical result: the model drafts, the fact
 * set verifies, and the deterministic render is the floor.
 *
 * The deterministic join used to BE the answer, which is why an ordinary Ask
 * returned `label: value label: value`. It is still the guaranteed fallback, but
 * it is now the last resort rather than the default, and a fallback caused by a
 * failed verification is labelled so it is never silently mistaken for prose.
 *
 * With no `complete`, behaviour is byte-identical to the old deterministic path,
 * which is what keeps every non-Ask consumer unchanged.
 */
export async function composeVerifiedAnalyticalNarrative(input: {
  frame: AnalyticalQuestionFrameV2;
  factSet: AnalyticalResultFactSetV1;
  question: string;
  complete?: AnalyticalNarrativeCompletion;
  maxAttempts?: number;
  maxRows?: number;
}): Promise<ComposedAnalyticalNarrative> {
  const floor = renderDeterministicAnalyticalNarrative({
    frame: input.frame,
    factSet: input.factSet,
    ...(input.maxRows === undefined ? {} : { maxRows: input.maxRows }),
  });
  if (!input.complete) {
    return { narrative: floor, source: 'deterministic', validationFailures: [], attempts: 0 };
  }
  const brief = renderAnalyticalFactBrief({ frame: input.frame, factSet: input.factSet });
  const maxAttempts = Math.min(Math.max(1, input.maxAttempts ?? 2), 3);
  const failures: string[] = [];
  let correction = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw: string;
    try {
      raw = await input.complete({
        system: NARRATIVE_SYSTEM_PROMPT,
        user: [
          `Question: ${input.question}`,
          '',
          'Verified facts:',
          brief,
          correction ? `\nYour previous attempt was REJECTED: ${correction}\nFix exactly that and return the JSON again.` : '',
        ].join('\n'),
      });
    } catch (error) {
      failures.push(`PROVIDER_ERROR: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    const claims = parseAnalyticalNarrativeClaims(raw);
    if (!claims) {
      if (readEnv('ZLENS_ORCHESTRATOR_TRACE')) {
        console.warn(`[zlens] narration unparseable (attempt ${attempt}) len=${raw.length} tail="${raw.slice(-220).replace(/\n/g, '\\n')}"`);
      }
      correction = 'The response was not the required JSON claims object.';
      failures.push('UNPARSEABLE_CLAIMS');
      continue;
    }
    const validation = validateAnalyticalNarrativeClaims({ factSet: input.factSet, claims });
    if (validation.status === 'valid') {
      const text = claims.map((claim) => claim.text.trim()).filter(Boolean).join(' ');
      return {
        narrative: deepFreeze({ version: 1, factSetId: input.factSet.factSetId, text, claims }),
        source: 'llm',
        validationFailures: failures,
        attempts: attempt,
      };
    }
    correction = `${validation.code} — ${validation.reason}`;
    failures.push(validation.code);
  }
  return { narrative: floor, source: 'deterministic', validationFailures: failures, attempts: maxAttempts };
}

function makeFact(
  receipt: AnalyticalExecutionReceiptV1,
  input: Omit<AnalyticalResultFactV1, 'factId' | 'receiptId' | 'graphFingerprint' | 'resultFingerprint'>,
): AnalyticalResultFactV1 {
  const payload = {
    ...input,
    receiptId: receipt.receiptId,
    graphFingerprint: receipt.graphFingerprint,
    resultFingerprint: receipt.resultFingerprint,
  };
  return { ...payload, factId: `fact:${hash(stableStringify(payload)).slice(0, 24)}` };
}

function caveatText(fact: AnalyticalResultFactV1): string {
  if (fact.code === 'PARTIAL_CURRENT_PERIOD') return 'The current period is partial; values may increase before it closes.';
  if (fact.code === 'LATEST_COMPLETE_PERIOD') return 'The current value uses the latest complete governed period, not a partial in-progress period.';
  if (fact.code === 'MISSING_COMPARISON_VALUE') return `A comparison value is unavailable${coordinateSuffix(fact)}.`;
  if (fact.code === 'ZERO_COMPARISON_DENOMINATOR') return `Percentage change is not available; the comparison value is zero${coordinateSuffix(fact)}.`;
  return 'The result includes a material analytical caveat.';
}

function coordinateSuffix(fact: AnalyticalResultFactV1): string {
  const coordinates = Object.values(fact.coordinates ?? {}).map(displayValue).filter(Boolean);
  return coordinates.length ? ` for ${coordinates.join(' · ')}` : '';
}

function humanizeOutput(value: string, kind?: string): string {
  if (kind === 'percent_delta') return 'change';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'not available';
  if (typeof value === 'string') return value === 'not_applicable' ? 'not applicable' : value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isExactZero(value: unknown): boolean {
  return (typeof value === 'number' && value === 0) || (typeof value === 'bigint' && value === 0n) || (typeof value === 'string' && /^[+-]?0+(?:\.0+)?$/.test(value.trim()));
}

function numericTokens(value: string): string[] {
  return value.match(/-?\d+(?:,\d{3})*(?:\.\d+)?%?/g)
    ?.map((token) => normalizeNumericToken(token.replace(/,/g, '').replace(/%$/, ''))) ?? [];
}

/**
 * Compare numbers by VALUE, not by spelling.
 *
 * `2004` and `2004.00` are the same number, but string equality called the
 * second one unsupported — so a narration written as "$2,004.00", which is
 * exactly how the results table renders it, was rejected against a fact stored
 * as `2004`. Two such rejections and the reader gets the deterministic row dump
 * with "Verified narration was unavailable" on top, for a sentence whose
 * numbers were all correct.
 *
 * This does not weaken the check: 2004 still fails against 2005. It only stops
 * formatting from masquerading as a factual error.
 */
function normalizeNumericToken(token: string): string {
  const parsed = Number(token);
  return Number.isFinite(parsed) ? String(parsed) : token;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
