import { describe, expect, it } from 'vitest';
import type { AnalyticalQuestionFrameV2 } from '@zlens/core';
import type { AnalyticalExecutionGraphV1, AnalyticalExecutionReceiptV1 } from './analytical-execution-graph.js';
import {
  buildAnalyticalResultFacts,
  renderDeterministicAnalyticalNarrative,
  validateAnalyticalNarrativeClaims,
  renderAnalyticalFactBrief,
  parseAnalyticalNarrativeClaims,
  composeVerifiedAnalyticalNarrative,
} from './analytical-result-facts.js';

const metricId = 'commerce::metric::net_revenue';

function frame(): AnalyticalQuestionFrameV2 {
  return {
    version: 2,
    interpretedQuestion: 'Current and prior revenue for top customers.',
    questionType: 'ranking',
    metricConceptIds: [metricId],
    entityGrainIds: ['commerce::entity::customer'],
    dimensions: [
      { dimensionId: 'commerce::dimension::customer', role: 'group_by' },
      { dimensionId: 'commerce::dimension::customer', role: 'rank_entity' },
      { dimensionId: 'commerce::dimension::report_date', role: 'time_axis' },
    ],
    memberBindings: [],
    timeContext: {
      timeDimensionId: 'commerce::dimension::report_date',
      timeRole: 'report_as_of',
      calendarId: 'calendar:gregorian',
      timezone: 'America/Chicago',
      grain: 'day',
      completenessPolicy: 'latest_complete',
      periods: [
        { id: 'current', kind: 'current', start: '2026-07-01T05:00:00.000Z', end: '2026-07-22T05:00:00.000Z' },
        { id: 'previous_year', kind: 'previous_year', start: '2025-07-01T05:00:00.000Z', end: '2025-07-22T05:00:00.000Z', alignToPeriodId: 'current' },
      ],
    },
    comparison: {
      basePeriodId: 'current',
      comparisonPeriodIds: ['previous_year'],
      alignment: 'elapsed_period',
      outputs: ['value', 'absolute_delta', 'percent_delta'],
      zeroDenominatorPolicy: 'null',
    },
    ranking: {
      entityDimensionId: 'commerce::dimension::customer',
      byMetricId: metricId,
      byPeriodId: 'current',
      direction: 'desc',
      limit: 2,
      tiePolicy: 'stable_secondary_key',
    },
    requestedOutputs: [
      { id: 'customer', kind: 'dimension' },
      { id: 'current_revenue', kind: 'metric_value', metricId, periodId: 'current' },
      { id: 'prior_revenue', kind: 'metric_value', metricId, periodId: 'previous_year' },
      { id: 'revenue_delta', kind: 'delta', metricId },
      { id: 'revenue_percent_delta', kind: 'percent_delta', metricId },
      { id: 'rank', kind: 'rank' },
    ],
    ambiguity: [],
  };
}

function graph(): AnalyticalExecutionGraphV1 {
  return {
    schemaVersion: 1,
    graphId: 'analytical-graph:one',
    fingerprint: 'graph-fingerprint',
    planId: 'rap:one',
    planFingerprint: 'plan-fingerprint',
    snapshotId: 'snapshot-1',
    route: 'semantic',
    fitClass: 'exact',
    metricId,
    capabilityFingerprint: 'capability-fingerprint',
    nodes: [],
    terminalNodeId: 'validate:result_contract',
  };
}

function receipt(): AnalyticalExecutionReceiptV1 {
  return {
    version: 1,
    receiptId: 'analytical-receipt:one',
    graphId: graph().graphId,
    graphFingerprint: graph().fingerprint,
    planId: graph().planId,
    planFingerprint: graph().planFingerprint,
    snapshotId: graph().snapshotId,
    route: 'semantic',
    trustState: 'governed',
    subReceipts: [{ nodeId: 'source:current', receiptFingerprint: 'source-receipt' }],
    outputColumns: frame().requestedOutputs.map((output) => output.id),
    rowCount: 2,
    rowBound: 10_000,
    resultFingerprint: 'result-fingerprint',
  };
}

const rows = [
  { customer: 'Zoom', current_revenue: '100.10', prior_revenue: '80.05', revenue_delta: '20.05', revenue_percent_delta: '25.046845721424', rank: 1 },
  { customer: 'Acme', current_revenue: '50', prior_revenue: '0', revenue_delta: '50', revenue_percent_delta: null, rank: 2 },
];

describe('receipt-backed analytical facts and narration (AGT-020)', () => {
  it('binds every value, comparison, rank, freshness statement, and caveat to the terminal receipt', () => {
    const built = buildAnalyticalResultFacts({
      frame: frame(),
      graph: graph(),
      receipt: receipt(),
      columns: receipt().outputColumns,
      rows,
    });
    expect(built.status).toBe('ready');
    if (built.status !== 'ready') return;
    expect(built.factSet.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'metric_value', rowIndex: 0, outputIds: ['current_revenue'], value: '100.10', receiptId: receipt().receiptId }),
      expect.objectContaining({ kind: 'delta', rowIndex: 0, outputIds: ['revenue_delta'], value: '20.05' }),
      expect.objectContaining({ kind: 'percent_delta', rowIndex: 0, value: '25.046845721424' }),
      expect.objectContaining({ kind: 'rank', rowIndex: 0, value: 1 }),
      expect.objectContaining({ kind: 'freshness', periodId: 'current', value: '2026-07-22T05:00:00.000Z' }),
      expect.objectContaining({ kind: 'caveat', code: 'ZERO_COMPARISON_DENOMINATOR', rowIndex: 1 }),
      expect.objectContaining({ kind: 'caveat', code: 'LATEST_COMPLETE_PERIOD' }),
    ]));
    expect(new Set(built.factSet.facts.map((fact) => fact.resultFingerprint))).toEqual(new Set([receipt().resultFingerprint]));
    expect(Object.isFrozen(built.factSet)).toBe(true);

    const narrative = renderDeterministicAnalyticalNarrative({ frame: frame(), factSet: built.factSet });
    expect(narrative.text).toContain('Zoom — Current Revenue: 100.10');
    expect(narrative.text).toContain('change: 25.046845721424%');
    expect(narrative.text).toContain('Current covers 2026-07-01T05:00:00.000Z through 2026-07-22T05:00:00.000Z');
    expect(narrative.text).toContain('comparison value is zero for Acme');
    expect(narrative.text).toContain('latest complete governed period');
    expect(validateAnalyticalNarrativeClaims({ factSet: built.factSet, claims: narrative.claims })).toMatchObject({ status: 'valid' });
  });

  it('AGT-020 rejects a claim that an entity is absent from the source', () => {
    // The live failure: a run returned 200 of 500 customers with no member
    // filter, and the narrator reported a customer who IS in the warehouse as
    // missing. No result fact can establish absence from the SOURCE — facts
    // describe a bounded projection.
    const built = buildAnalyticalResultFacts({ frame: frame(), graph: graph(), receipt: receipt(), columns: receipt().outputColumns, rows });
    if (built.status !== 'ready') throw new Error(built.reason);
    const valueFact = built.factSet.facts.find((fact) => fact.kind === 'metric_value')!;

    expect(validateAnalyticalNarrativeClaims({
      factSet: built.factSet,
      claims: [{
        claimId: 'absent',
        factIds: [valueFact.factId],
        text: 'Wesley Jenkins is not available in the provided customer data.',
      }],
    })).toMatchObject({ status: 'invalid', code: 'ABSENCE_CLAIM' });

    // Every caveat must still be cited, so these cases carry them.
    const allCaveats = built.factSet.facts.filter((fact) => fact.kind === 'caveat');
    const caveatClaims = allCaveats.map((fact, index) => ({
      claimId: `caveat-${index}`, factIds: [fact.factId], text: 'A reporting caveat applies.',
    }));

    // A rendered null VALUE is not an absence claim about the world.
    expect(validateAnalyticalNarrativeClaims({
      factSet: built.factSet,
      claims: [
        { claimId: 'value', factIds: [valueFact.factId], text: 'Zoom — Revenue: 100.10; change: not available.' },
        ...caveatClaims,
      ],
    })).toMatchObject({ status: 'valid' });

    // A cited caveat still licenses its own limitation wording.
    expect(validateAnalyticalNarrativeClaims({
      factSet: built.factSet,
      claims: [
        { claimId: 'lim', factIds: [allCaveats[0]!.factId], text: 'A comparison value is unavailable in the results.' },
        ...caveatClaims.slice(1),
      ],
    })).toMatchObject({ status: 'valid' });
  });

  it('rejects invented numbers, causal wording, hidden caveats, and receipt drift', () => {
    const built = buildAnalyticalResultFacts({ frame: frame(), graph: graph(), receipt: receipt(), columns: receipt().outputColumns, rows });
    if (built.status !== 'ready') throw new Error(built.reason);
    const valueFact = built.factSet.facts.find((fact) => fact.kind === 'metric_value')!;
    expect(validateAnalyticalNarrativeClaims({
      factSet: built.factSet,
      claims: [{ claimId: 'invented', factIds: [valueFact.factId], text: 'Revenue was 999.' }],
    })).toMatchObject({ status: 'invalid', code: 'UNSUPPORTED_NUMBER' });
    expect(validateAnalyticalNarrativeClaims({
      factSet: built.factSet,
      claims: [{ claimId: 'causal', factIds: [valueFact.factId], text: 'Revenue was 100.10 because Zoom drove growth.' }],
    })).toMatchObject({ status: 'invalid', code: 'CAUSAL_CLAIM' });
    expect(validateAnalyticalNarrativeClaims({
      factSet: built.factSet,
      claims: [{ claimId: 'value-only', factIds: [valueFact.factId], text: 'Revenue was 100.10.' }],
    })).toMatchObject({ status: 'invalid', code: 'MATERIAL_CAVEAT_HIDDEN' });
    expect(buildAnalyticalResultFacts({
      frame: frame(),
      graph: graph(),
      receipt: { ...receipt(), graphFingerprint: 'wrong' },
      columns: receipt().outputColumns,
      rows,
    })).toMatchObject({ status: 'blocked', code: 'RECEIPT_MISMATCH' });
  });
});

describe('verified narration replaces the deterministic row join', () => {
  const facts = () => {
    const built = buildAnalyticalResultFacts({
      frame: frame(), graph: graph(), receipt: receipt(), columns: receipt().outputColumns, rows,
    });
    if (built.status !== 'ready') throw new Error(built.reason);
    return built.factSet;
  };

  /** The exact shape the user was shown: `Label: value` pairs joined together. */
  const readsLikeARowDump = (text: string) => /\b\w[\w ]*: [^;.]+;/.test(text);

  it('keeps the deterministic join byte-identical when no model is supplied', async () => {
    const factSet = facts();
    const composed = await composeVerifiedAnalyticalNarrative({
      frame: frame(), factSet, question: 'top customers by revenue',
    });
    expect(composed.source).toBe('deterministic');
    expect(composed.attempts).toBe(0);
    expect(composed.narrative.text)
      .toBe(renderDeterministicAnalyticalNarrative({ frame: frame(), factSet }).text);
    // This is the regression the user reported, and it is still what an
    // unconfigured project gets — just no longer the default for everyone.
    expect(readsLikeARowDump(composed.narrative.text)).toBe(true);
  });

  it('returns verified prose instead of the row join when the model cites its facts', async () => {
    const factSet = facts();
    const rank1 = factSet.facts.find((f) => f.kind === 'rank' && f.rowIndex === 0)!;
    const caveats = factSet.facts.filter((f) => f.kind === 'caveat');
    const composed = await composeVerifiedAnalyticalNarrative({
      frame: frame(), factSet, question: 'top customers by revenue',
      complete: async () => JSON.stringify({
        claims: [
          { claimId: 'c1', factIds: [rank1.factId], text: 'Zoom is the top customer this period.' },
          ...caveats.map((caveat, index) => ({
            claimId: `caveat-${index}`, factIds: [caveat.factId], text: 'A reporting caveat applies.',
          })),
        ],
      }),
    });
    expect(composed.source).toBe('llm');
    expect(composed.attempts).toBe(1);
    expect(composed.narrative.text).toContain('Zoom is the top customer this period.');
    expect(readsLikeARowDump(composed.narrative.text)).toBe(false);
  });

  it('rejects a causal claim, feeds the code back, and accepts the corrected retry', async () => {
    const factSet = facts();
    const rank1 = factSet.facts.find((f) => f.kind === 'rank' && f.rowIndex === 0)!;
    const caveats = factSet.facts.filter((f) => f.kind === 'caveat');
    const prompts: string[] = [];
    let call = 0;
    const composed = await composeVerifiedAnalyticalNarrative({
      frame: frame(), factSet, question: 'why is Zoom top?',
      complete: async ({ user }) => {
        prompts.push(user);
        call += 1;
        const claims = [
          {
            claimId: 'c1',
            factIds: [rank1.factId],
            // Causality is exactly what an analytical result cannot establish.
            text: call === 1 ? 'Zoom ranks first because of strong demand.' : 'Zoom ranks first.',
          },
          ...caveats.map((caveat, index) => ({
            claimId: `caveat-${index}`, factIds: [caveat.factId], text: 'A reporting caveat applies.',
          })),
        ];
        return `\`\`\`json\n${JSON.stringify({ claims })}\n\`\`\``;
      },
    });
    expect(call).toBe(2);
    expect(composed.source).toBe('llm');
    expect(composed.validationFailures).toEqual(['CAUSAL_CLAIM']);
    expect(prompts[1]).toContain('CAUSAL_CLAIM');
    expect(composed.narrative.text).toBe('Zoom ranks first. A reporting caveat applies. A reporting caveat applies.');
  });

  it('falls back to the deterministic join after two failures, and says so', async () => {
    const composed = await composeVerifiedAnalyticalNarrative({
      frame: frame(), factSet: facts(), question: 'top customers',
      complete: async () => JSON.stringify({
        claims: [{ claimId: 'c1', factIds: ['fact:does-not-exist'], text: 'Something happened.' }],
      }),
    });
    expect(composed.source).toBe('deterministic');
    expect(composed.validationFailures).toEqual(['UNKNOWN_FACT', 'UNKNOWN_FACT']);
    expect(composed.attempts).toBe(2);
  });

  it('refuses numbers the cited facts do not contain', async () => {
    const factSet = facts();
    const rank1 = factSet.facts.find((f) => f.kind === 'rank' && f.rowIndex === 0)!;
    const composed = await composeVerifiedAnalyticalNarrative({
      frame: frame(), factSet, question: 'top customers',
      complete: async () => JSON.stringify({
        claims: [{ claimId: 'c1', factIds: [rank1.factId], text: 'Zoom earned 999999 dollars.' }],
      }),
    });
    expect(composed.source).toBe('deterministic');
    expect(composed.validationFailures).toEqual(['UNSUPPORTED_NUMBER', 'UNSUPPORTED_NUMBER']);
  });

  it('gives the model fact ids to cite, not a pre-joined sentence', () => {
    const brief = renderAnalyticalFactBrief({ frame: frame(), factSet: facts() });
    expect(brief).toContain('fact:');
    expect(brief).toContain('kind=metric_value');
    expect(brief).toContain('value=100.10');
    expect(readsLikeARowDump(brief)).toBe(false);
  });

  it('treats an unparseable or empty claim payload as a failure, never as prose', () => {
    expect(parseAnalyticalNarrativeClaims('not json at all')).toBeUndefined();
    expect(parseAnalyticalNarrativeClaims('{"claims":[]}')).toBeUndefined();
    // A claim with no citations cannot be verified, so it must not be accepted.
    expect(parseAnalyticalNarrativeClaims('{"claims":[{"text":"hi","factIds":[]}]}')).toBeUndefined();
    expect(parseAnalyticalNarrativeClaims('{"claims":[{"text":"hi","factIds":["fact:a"]}]}'))
      .toEqual([{ claimId: 'claim:0', factIds: ['fact:a'], text: 'hi' }]);
  });
});
