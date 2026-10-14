/**
 * Golden-question regression suite — the committed encoding of real answer-
 * accuracy bugs observed in production use. Every case here maps to a shipped
 * fix; when the agent gets a question wrong in the field, its question gets
 * added HERE before the fix lands, so the bug can never silently return.
 *
 * These cases run the REAL deterministic pipeline (question plan → retrieval →
 * route decision) against a synthetic consumption-domain catalog. No warehouse,
 * no LLM — fast enough to gate every merge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DQLManifest } from '@zlens/core';
import {
  planAgentAnswer,
  upsertMetadataSnapshot,
  type PlanAgentAnswerResult,
} from './catalog.js';

const FINGERPRINT = 'golden-regressions-fixture';
const GENERATED_AT = '1970-01-01T00:00:00.000Z';

let projectRoot: string;

function seedFixture(root: string): void {
  upsertMetadataSnapshot(root, {
    projectRoot: root,
    manifest: { generatedAt: GENERATED_AT } as DQLManifest,
    objects: [
      {
        objectKey: 'semantic:metric:consumption.previous_day_bcm', objectType: 'semantic_metric',
        name: 'consumption.previous_day_bcm', fullName: 'consumption.previous_day_bcm',
        domain: 'consumption', status: 'approved',
        description: 'Billed consumption metric for the previous business day.',
        payload: { label: 'Previous Day BCM', aggregation: 'sum', dimensions: ['customer', 'date'], table: 'fct_consumption' },
      },
      {
        objectKey: 'semantic:metric:consumption.previous_day_acm', objectType: 'semantic_metric',
        name: 'consumption.previous_day_acm', fullName: 'consumption.previous_day_acm',
        domain: 'consumption', status: 'approved',
        description: 'Actual consumption metric for the previous business day.',
        payload: { label: 'Previous Day ACM', aggregation: 'sum', dimensions: ['customer', 'date'], table: 'fct_consumption' },
      },
      {
        objectKey: 'semantic:metric:consumption.daily_consumption', objectType: 'semantic_metric',
        name: 'consumption.daily_consumption', fullName: 'consumption.daily_consumption',
        domain: 'consumption', status: 'approved',
        description: 'Total consumption volume per day.',
        payload: { label: 'Daily Consumption', aggregation: 'sum', dimensions: ['customer', 'date'], table: 'fct_consumption' },
      },
      {
        objectKey: 'semantic:metric:consumption.consumption_percent_by_customer', objectType: 'semantic_metric',
        name: 'consumption.consumption_percent_by_customer', fullName: 'consumption.consumption_percent_by_customer',
        domain: 'consumption', status: 'approved',
        description: 'Share of total consumption attributed to each customer.',
        payload: { label: 'Consumption % by Customer', aggregation: 'ratio', dimensions: ['customer'], table: 'fct_consumption' },
      },
      {
        objectKey: 'semantic:dimension:consumption.customer', objectType: 'semantic_dimension',
        name: 'consumption.customer', fullName: 'consumption.customer',
        domain: 'consumption', status: 'approved',
        description: 'Customer receiving the consumption.',
        payload: { label: 'Customer', table: 'fct_consumption', column: 'customer_name' },
      },
      {
        objectKey: 'dbt:model:fct_consumption', objectType: 'dbt_model', name: 'fct_consumption',
        fullName: 'analytics.fct_consumption', status: 'dbt_catalog',
        description: 'Daily customer consumption facts with billed and actual volumes.',
        payload: {
          uniqueId: 'model.analytics.fct_consumption', relation: 'analytics.fct_consumption',
          columns: [{ name: 'customer_name' }, { name: 'consumption_bcm' }, { name: 'consumption_acm' }, { name: 'consumption_date' }],
        },
      },
    ],
    edges: [], diagnostics: [], compileConflicts: [],
    fingerprint: FINGERPRINT, generatedAt: GENERATED_AT,
  });
}

function ask(question: string, extra: Record<string, unknown> = {}): Promise<PlanAgentAnswerResult> {
  return planAgentAnswer(projectRoot, {
    question,
    preparedMetadataFingerprint: FINGERPRINT,
    ...extra,
  });
}

function memberFilters(plan: PlanAgentAnswerResult): string[] {
  return plan.contextPack.questionPlan.requestedShape.filters.map((f) => f.toLowerCase());
}

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-golden-regressions-'));
  seedFixture(projectRoot);
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('golden regressions — casing and governed-name robustness', () => {
  it('GOLD-001: metric labels typed in Title Case never become member filters', async () => {
    const plan = await ask('What is the Previous Day BCM?');
    expect(memberFilters(plan)).not.toContain('previous day');
    expect(plan.contextPack.questionPlan.metricTerms.map((t) => t.toLowerCase())).toContain('previous day bcm');
  });

  it('GOLD-002: BCM, bcm, and Previous Day BCM route identically', async () => {
    const lower = await ask('previous day bcm total');
    const title = await ask('Previous Day BCM total');
    const upper = await ask('PREVIOUS DAY BCM total');

    expect(title.routeDecision.route).toBe(lower.routeDecision.route);
    expect(upper.routeDecision.route).toBe(lower.routeDecision.route);
    for (const plan of [lower, title, upper]) {
      expect(memberFilters(plan)).not.toContain('previous day');
    }
  });

  it('GOLD-003: genuine member values survive next to a governed name', async () => {
    const plan = await ask('previous day bcm for Capital One');
    expect(memberFilters(plan).some((f) => f.includes('capital one'))).toBe(true);
  });

  it('GOLD-004: the governed metric is retrieved as evidence for its own name', async () => {
    const plan = await ask('previous day bcm by customer');
    expect(plan.contextPack.objects.map((o) => o.objectKey)).toContain(
      'semantic:metric:consumption.previous_day_bcm',
    );
  });
});

describe('golden regressions — follow-up behavior', () => {
  it('GOLD-005: a follow-up naming a different metric does not stay stuck on the prior one', async () => {
    const prior = await ask('daily consumption today');
    const followUp = await ask('consumption % by customer', {
      priorContextPackId: prior.contextPackId,
      conversationTopicRelation: 'continuation',
      followUp: {
        kind: 'contextual',
        sourceQuestion: 'daily consumption today',
        priorMeasures: ['daily_consumption'],
      },
    });

    const terms = followUp.contextPack.questionPlan.metricTerms.map((t) => t.toLowerCase());
    // The question names its own measure — prior-turn carry must not override it.
    expect(terms.some((t) => t.includes('percent') || t.includes('%'))).toBe(true);
    expect(terms).not.toContain('daily_consumption');
  });

  it('GOLD-006: a back-referencing measure-less refinement inherits the prior metric', async () => {
    // Contract: contextual carry applies ONLY when the question textually refers
    // back ("same", "that", ...). A refinement with no back-reference and no
    // measure of its own carries nothing — that suppression is the guard that
    // fixed the sticky-metric bug, so this case pins the allowed side of it.
    const prior = await ask('daily consumption today');
    const followUp = await ask('same but only for Capital One', {
      priorContextPackId: prior.contextPackId,
      conversationTopicRelation: 'refinement',
      followUp: {
        kind: 'contextual',
        sourceQuestion: 'daily consumption today',
        priorMeasures: ['daily_consumption'],
      },
    });

    const terms = followUp.contextPack.questionPlan.metricTerms.map((t) => t.toLowerCase());
    expect(terms.some((t) => t.includes('daily_consumption') || t.includes('consumption'))).toBe(true);
  });
});

describe('golden regressions — determinism', () => {
  it('GOLD-007: the same question always routes the same way', async () => {
    const first = await ask('previous day bcm by customer');
    const second = await ask('previous day bcm by customer');

    expect(second.routeDecision.route).toBe(first.routeDecision.route);
    expect(second.routeDecision.exactObjectKey).toBe(first.routeDecision.exactObjectKey);
    expect(second.contextPack.retrievalDiagnostics.selectedEvidence[0]?.objectKey).toBe(
      first.contextPack.retrievalDiagnostics.selectedEvidence[0]?.objectKey,
    );
  });
});
