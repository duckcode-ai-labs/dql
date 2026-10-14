import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import type { MetricCapabilityContract } from '@zlens/core';
import {
  AgentRunEngine,
  buildAnalyticalTurnPlan,
  buildCoverageGap,
  normalizeCanonicalQueryResult,
  selectRoute,
} from './index.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';

interface EvalCandidateFixture {
  id: string;
  kind: AgentEvidenceCandidate['kind'];
  name: string;
  aliases?: string[];
  trustTier: AgentEvidenceCandidate['trustTier'];
  relevanceScore: number;
  compatibility: AgentEvidenceCandidate['compatibility'];
  domain?: string;
  dimensions?: string[];
  aggregation?: string;
  /** Authored certified output identities; prose and tags are not a contract. */
  outputs?: string[];
  exactMatch?: boolean;
  analyticalRoute?: 'certified' | 'semantic';
}

interface EvalResolutionFixture {
  questionType: MeaningResolution['questionType'];
  selectedConceptIds: string[];
  recommendedExecutionId?: string;
  recommendedRoute: MeaningResolution['recommendedRoute'];
  measures: string[];
  dimensions: string[];
  filters?: Array<{ field: string; value: string }>;
  order?: 'asc' | 'desc';
  limit?: number;
  confidence: MeaningResolution['confidence'];
  missingInformation?: string[];
}

interface AskAiEvalCase {
  id: string;
  verification: 'executable' | 'specified';
  question: string;
  prior?: { columns?: string[]; values?: Record<string, string[]> };
  candidates?: EvalCandidateFixture[];
  resolution?: EvalResolutionFixture;
  expected: {
    meaningCalls?: number;
    firstEligibleTier?: string;
    fallbackTiers?: string[];
    resultRowsAreObjects?: boolean;
    clarificationCode?: string;
    repeats?: number;
    route?: string;
    memberBinding?: { dimension: string; value: string };
    resultColumns?: string[];
  };
}

interface AskAiEvalFixture {
  version: number;
  name: string;
  acceptanceIds: string[];
  cases: AskAiEvalCase[];
}

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/specs/dql-2-domain-context/fixtures/ask-ai-orchestration.agent-evals.yml',
);

function readFixture(): AskAiEvalFixture {
  return load(readFileSync(fixturePath, 'utf8')) as AskAiEvalFixture;
}

function fixtureCapability(candidate: EvalCandidateFixture): MetricCapabilityContract | undefined {
  if (!candidate.analyticalRoute) return undefined;
  const metricId = candidate.kind === 'semantic_metric'
    ? candidate.id
    : 'semantic:commerce:metric:revenue';
  return {
    metricId,
    semanticModelId: 'semantic:commerce:model:orders',
    measureIds: ['semantic:commerce:measure:revenue'],
    primaryEntityId: 'semantic:commerce:entity:order',
    defaultResultGrainId: 'semantic:commerce:entity:customer',
    resultGrainIds: ['semantic:commerce:entity:customer'],
    aggregation: candidate.aggregation ?? 'sum',
    additivity: { entities: 'additive', time: 'additive' },
    dimensions: (candidate.dimensions ?? []).map((dimension) => ({
      dimensionId: `semantic:${candidate.domain ?? 'commerce'}:dimension:${dimension}`,
      entityId: `semantic:${candidate.domain ?? 'commerce'}:entity:${dimension}`,
      supportedRoles: ['group_by', 'rank_entity'],
      relationshipPathIds: [`fixture:relationship:${dimension}`],
      // Semantic alternatives in this deterministic harness must be genuinely
      // executable alternatives. A generic relationship is not enough to
      // offer a user-facing metric clarification after the strict MetricFlow
      // compatibility gate.
      nativeGroupingReference: `order__${dimension}`,
      nativeGroupingPath: ['order'],
    })),
    timeDimensions: [],
    operations: ['group', 'rank'],
    supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
    executionCapabilities: [{ route: candidate.analyticalRoute, adapterId: 'fixture-adapter' }],
    sourceFingerprint: 'e'.repeat(64),
  };
}

function materializeCandidates(fixtures: EvalCandidateFixture[]): AgentEvidenceCandidate[] {
  return fixtures.map((fixture) => ({
    id: fixture.id,
    kind: fixture.kind,
    name: fixture.name,
    aliases: fixture.aliases,
    trustTier: fixture.trustTier,
    relevanceScore: fixture.relevanceScore,
    compatibility: fixture.compatibility,
    matchReasons: ['YAML candidate fixture'],
    eligible: true,
    domain: fixture.domain,
    dimensions: fixture.dimensions,
    aggregation: fixture.aggregation,
    exactMatch: fixture.exactMatch,
    compatibilityFacts: fixture.outputs?.map((output) => `output: ${output}`),
    analyticalCapability: fixtureCapability(fixture),
  }));
}

function materializeResolution(testCase: AskAiEvalCase): MeaningResolution {
  const fixture = testCase.resolution!;
  return {
    interpretedQuestion: testCase.question,
    questionType: fixture.questionType,
    selectedConceptIds: fixture.selectedConceptIds,
    recommendedExecutionId: fixture.recommendedExecutionId,
    queryIntent: {
      measures: fixture.measures,
      dimensions: fixture.dimensions,
      filters: fixture.filters ?? [],
      ...(fixture.order ? { order: fixture.order } : {}),
      ...(fixture.limit !== undefined ? { limit: fixture.limit } : {}),
    },
    rejectedCandidates: [],
    confidence: fixture.confidence,
    missingInformation: fixture.missingInformation ?? [],
    recommendedRoute: fixture.recommendedRoute,
  };
}

function normalizeTier(value: string): string {
  if (value === 'certified_block') return 'certified';
  if (value === 'semantic_layer') return 'semantic';
  if (value === 'governed_relational') return 'governed_sql';
  if (value === 'generated_sql') return 'generated';
  return value;
}

describe('Ask AI orchestration YAML evaluation harness (AGT-027..033 / E2E-022)', () => {

  it('keeps the compound and Research fixture rows specified until their real child/catalog harness is supplied', () => {
    const fixture = readFixture();
    const specified = fixture.cases.filter((testCase) => testCase.verification === 'specified');
    expect(specified.map((testCase) => testCase.id)).toEqual([
      'compound-partial-success',
      'bounded-research-ledger',
    ]);
    const plan = buildAnalyticalTurnPlan({ question: specified[0]!.question });
    expect(plan.tasks.length).toBeGreaterThan(1);
    expect(buildCoverageGap({
      code: 'EXECUTION_FAILED',
      phase: 'execution',
      message: 'Specified fixture: child execution harness remains tester-owned.',
      searchedSources: [],
      attemptedRoutes: ['certified', 'semantic', 'governed_relational', 'generated'],
      missing: [],
      recoverable: false,
      planFrozen: true,
      nextActions: [],
    }).planFrozen).toBe(true);
  });
});
