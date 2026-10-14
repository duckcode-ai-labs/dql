/** Deterministic capability-readiness projection for modeling and diagnostics. */
import { normalizeMetricCapabilityContract } from '@zlens/core';
import type { AgentEvidenceCandidate } from './meaning-resolution.js';

export type AnalyticalReadinessQuestion = 'scalar' | 'filter' | 'grouping' | 'trend' | 'comparison' | 'ranking';

export interface AnalyticalCapabilityReadiness {
  candidateId: string;
  metricId?: string;
  status: 'complete' | 'incomplete';
  support: Record<AnalyticalReadinessQuestion, boolean>;
  blockers: Partial<Record<AnalyticalReadinessQuestion, string[]>>;
}

/**
 * Explain what each retrieved metric/certified asset can answer before route
 * selection. This is a diagnostic report only and grants no capability.
 *
 * Acceptance: CONTRACT-002, SKILL-004.
 */
export function buildAnalyticalCapabilityReadiness(candidates: AgentEvidenceCandidate[]): AnalyticalCapabilityReadiness[] {
  return candidates
    .filter((candidate) => candidate.kind === 'semantic_metric' || candidate.kind === 'certified_block')
    .map((candidate) => {
      const candidateId = candidate.qualifiedId ?? candidate.id;
      const capability = normalizeMetricCapabilityContract(candidate.analyticalCapability);
      if (!capability) {
        const reasons = ['No complete normalized MetricCapabilityContract is present in the active snapshot.'];
        return {
          candidateId,
          status: 'incomplete' as const,
          support: {
            scalar: false,
            filter: false,
            grouping: false,
            trend: false,
            comparison: false,
            ranking: false,
          },
          blockers: {
            scalar: reasons,
            filter: reasons,
            grouping: reasons,
            trend: reasons,
            comparison: reasons,
            ranking: reasons,
          },
        };
      }
      const hasRoute = capability.executionCapabilities.length > 0;
      const outputKinds = new Set(capability.supportedOutputKinds);
      const operations = new Set(capability.operations);
      const filterDimension = capability.dimensions.some((dimension) => dimension.supportedRoles.includes('filter'));
      const groupDimension = capability.dimensions.some((dimension) => dimension.supportedRoles.includes('group_by'));
      const rankDimension = capability.dimensions.some((dimension) => dimension.supportedRoles.includes('rank_entity'));
      const checks: Record<AnalyticalReadinessQuestion, Array<[boolean, string]>> = {
        scalar: [
          [hasRoute, 'No execution adapter is declared.'],
          [outputKinds.has('metric_value'), 'Metric-value output is not declared.'],
          [Boolean(capability.defaultResultGrainId), 'No default result grain is declared.'],
        ],
        filter: [
          [hasRoute, 'No execution adapter is declared.'],
          [operations.has('filter'), 'Filter operation is not supported.'],
          [filterDimension, 'No dimension supports the filter role.'],
        ],
        grouping: [
          [hasRoute, 'No execution adapter is declared.'],
          [operations.has('group'), 'Group operation is not supported.'],
          [groupDimension, 'No dimension supports the group_by role.'],
          [outputKinds.has('dimension'), 'Dimension output is not declared.'],
        ],
        trend: [
          [hasRoute, 'No execution adapter is declared.'],
          [operations.has('trend'), 'Trend operation is not supported.'],
          [capability.timeDimensions.length > 0, 'No time dimension is declared.'],
        ],
        comparison: [
          [hasRoute, 'No execution adapter is declared.'],
          [operations.has('compare'), 'Comparison operation is not supported.'],
          [capability.timeDimensions.length > 0, 'No time dimension is declared.'],
          [outputKinds.has('delta') || outputKinds.has('percent_delta'), 'No comparison output is declared.'],
        ],
        ranking: [
          [hasRoute, 'No execution adapter is declared.'],
          [operations.has('rank'), 'Rank operation is not supported.'],
          [operations.has('group'), 'Ranking requires post-aggregation grouping support.'],
          [rankDimension, 'No dimension supports the rank_entity role.'],
          [outputKinds.has('rank'), 'Rank output is not declared.'],
        ],
      };
      const support = Object.fromEntries(Object.entries(checks).map(([question, values]) => [question, values.every(([ok]) => ok)])) as Record<
        AnalyticalReadinessQuestion,
        boolean
      >;
      const blockers = Object.fromEntries(
        Object.entries(checks).flatMap(([question, values]) => {
          const reasons = values.filter(([ok]) => !ok).map(([, reason]) => reason);
          return reasons.length > 0 ? [[question, reasons]] : [];
        }),
      ) as AnalyticalCapabilityReadiness['blockers'];
      return {
        candidateId,
        metricId: capability.metricId,
        status: 'complete' as const,
        support,
        blockers,
      };
    })
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}
