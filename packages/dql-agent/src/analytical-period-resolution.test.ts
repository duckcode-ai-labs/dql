import { describe, expect, it } from 'vitest';
import type { AnalyticalQuestionFrameV2 } from '@zlens/core';
import { resolveAnalyticalPeriods } from './analytical-period-resolution.js';

function frame(policy: 'partial_current' | 'latest_complete' | 'closed_period', periods = [{ id: 'current', kind: 'current' as const }]): AnalyticalQuestionFrameV2 {
  return {
    version: 2,
    interpretedQuestion: 'Revenue today.',
    questionType: 'scalar',
    metricConceptIds: ['commerce::metric::revenue'],
    entityGrainIds: ['scalar'],
    dimensions: [{ dimensionId: 'commerce::dimension::report_date', role: 'time_axis' }],
    memberBindings: [],
    timeContext: {
      timeDimensionId: 'commerce::dimension::report_date',
      timeRole: 'report_as_of',
      calendarId: 'calendar:gregorian',
      timezone: 'America/Chicago',
      grain: 'day',
      completenessPolicy: policy,
      periods,
    },
    requestedOutputs: [{ id: 'revenue', kind: 'metric_value', metricId: 'commerce::metric::revenue', periodId: 'current' }],
    ambiguity: [],
  };
}

describe('governed analytical period resolution (AGT-017 / AGT-019 / E2E-013)', () => {
  it('binds partial today to local midnight through the captured reference instant', () => {
    const result = resolveAnalyticalPeriods({
      frame: frame('partial_current'),
      snapshotId: 'snapshot-1',
      referenceInstant: '2026-07-22T15:30:00.000Z',
    });
    expect(result).toMatchObject({
      status: 'resolved',
      frame: { timeContext: { periods: [{ start: '2026-07-22T05:00:00.000Z', end: '2026-07-22T15:30:00.000Z' }] } },
    });
  });

  it('uses the latest complete local day from snapshot-bound freshness', () => {
    const result = resolveAnalyticalPeriods({
      frame: frame('latest_complete'),
      snapshotId: 'snapshot-1',
      referenceInstant: '2026-07-22T15:30:00.000Z',
      freshnessObservation: {
        version: 1,
        snapshotId: 'snapshot-1',
        metricId: 'commerce::metric::revenue',
        timeDimensionId: 'commerce::dimension::report_date',
        observedThrough: '2026-07-22T05:00:00.000Z',
      },
    });
    expect(result).toMatchObject({
      status: 'resolved',
      asOf: '2026-07-22T05:00:00.000Z',
      frame: { timeContext: { periods: [{ start: '2026-07-21T05:00:00.000Z', end: '2026-07-22T05:00:00.000Z' }] } },
    });
  });

  it('aligns a prior-year period from the exact resolved current bounds', () => {
    const comparison = frame('latest_complete', [
      { id: 'current', kind: 'current' as const },
      { id: 'previous_year', kind: 'previous_year' as const, alignToPeriodId: 'current' },
    ]);
    comparison.comparison = {
      basePeriodId: 'current', comparisonPeriodIds: ['previous_year'], alignment: 'elapsed_period', outputs: ['value'], zeroDenominatorPolicy: 'null',
    };
    comparison.requestedOutputs.push({ id: 'prior_revenue', kind: 'metric_value', metricId: 'commerce::metric::revenue', periodId: 'previous_year' });
    const result = resolveAnalyticalPeriods({
      frame: comparison,
      snapshotId: 'snapshot-1',
      referenceInstant: '2026-07-22T15:30:00.000Z',
      freshnessObservation: {
        version: 1,
        snapshotId: 'snapshot-1', metricId: 'commerce::metric::revenue', timeDimensionId: 'commerce::dimension::report_date', observedThrough: '2026-07-22T05:00:00.000Z',
      },
    });
    expect(result).toMatchObject({
      status: 'resolved',
      frame: { timeContext: { periods: [
        { id: 'current', start: '2026-07-21T05:00:00.000Z', end: '2026-07-22T05:00:00.000Z' },
        { id: 'previous_year', start: '2025-07-21T05:00:00.000Z', end: '2025-07-22T05:00:00.000Z' },
      ] } },
    });
  });

  it('fails closed when latest-complete freshness is absent or mismatched', () => {
    expect(resolveAnalyticalPeriods({
      frame: frame('latest_complete'), snapshotId: 'snapshot-1', referenceInstant: '2026-07-22T15:30:00.000Z',
    })).toMatchObject({ status: 'blocked', code: 'FRESHNESS_REQUIRED' });
    expect(resolveAnalyticalPeriods({
      frame: frame('latest_complete'), snapshotId: 'snapshot-1', referenceInstant: '2026-07-22T15:30:00.000Z',
      freshnessObservation: {
        version: 1, snapshotId: 'other-snapshot', metricId: 'commerce::metric::revenue', timeDimensionId: 'commerce::dimension::report_date', observedThrough: '2026-07-22T05:00:00.000Z',
      },
    })).toMatchObject({ status: 'blocked', code: 'FRESHNESS_MISMATCH' });
  });
});
