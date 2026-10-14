/**
 * Route-neutral executable graph for a fully resolved RFC 0005 analytical
 * tuple. The graph never searches for members or changes metric meaning. It
 * expresses period aggregation, alignment, exact-decimal arithmetic, ranking,
 * projection, and result validation over IDs already frozen in the plan.
 *
 * Acceptance: AGT-018, AGT-019.
 */

import { createHash } from 'node:crypto';
import type {
  AnalyticalExecutionReceiptV1,
  AnalyticalPeriodV2,
  AnalyticalQuestionFrameV2,
  MetricCapabilityContract,
} from '@zlens/core';
export type { AnalyticalExecutionReceiptV1 } from '@zlens/core';
import type { AnalyticalFitClass } from './analytical-compatibility.js';
import type { ResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import { resolvedRelationshipProofMatches } from './relationship-proof.js';

export type AnalyticalExecutionRoute =
  | 'certified'
  | 'semantic'
  | 'governed_sql'
  | 'exploratory';

export type AnalyticalExecutionGraphBlockedCode =
  | 'PLAN_V2_REQUIRED'
  | 'PLAN_BLOCKED'
  | 'CAPABILITY_MISMATCH'
  | 'RELATIONSHIP_PROOF_MISMATCH'
  | 'ROUTE_MISMATCH'
  | 'PERIOD_CONTRACT_INVALID'
  | 'PERIOD_BOUNDS_REQUIRED'
  | 'OUTPUT_CONTRACT_INVALID'
  | 'RANKING_CONTRACT_INVALID';

export interface AnalyticalGraphMemberFilter {
  dimensionId: string;
  canonicalValues: unknown[];
}

export interface AnalyticalGraphSourceInvocationNode {
  id: string;
  kind: 'source_invocation';
  dependencies: [];
  strategy: 'complete_asset' | 'period_aggregate';
  route: AnalyticalExecutionRoute;
  adapterId?: string;
  metricId: string;
  entityGrainIds: string[];
  groupByDimensionIds: string[];
  memberFilters: AnalyticalGraphMemberFilter[];
  period?: {
    id: string;
    kind: AnalyticalPeriodV2['kind'];
    timeDimensionId: string;
    timeRole: string;
    grain: string;
    calendarId: string;
    timezone: string;
    completenessPolicy: NonNullable<AnalyticalQuestionFrameV2['timeContext']>['completenessPolicy'];
    startInclusive: string;
    endExclusive: string;
  };
  outputAliases: {
    dimensions: Array<{ dimensionId: string; outputId: string }>;
    metric?: { metricId: string; periodId?: string; outputId: string };
    completeAssetOutputIds?: string[];
  };
}

export interface AnalyticalGraphAlignNode {
  id: string;
  kind: 'align_periods';
  dependencies: string[];
  keyOutputIds: string[];
  periodMetricOutputIds: Array<{ periodId: string; outputId: string }>;
  alignment: NonNullable<NonNullable<AnalyticalQuestionFrameV2['comparison']>['alignment']>;
}

export interface AnalyticalGraphCalculateNode {
  id: string;
  kind: 'calculate_comparison';
  dependencies: [string];
  expressions: Array<{
    outputId: string;
    kind: 'delta' | 'percent_delta';
    baseOutputId: string;
    comparisonOutputId: string;
    zeroDenominatorPolicy: 'null' | 'not_applicable';
  }>;
}

export interface AnalyticalGraphRankNode {
  id: string;
  kind: 'rank';
  dependencies: [string];
  entityDimensionId: string;
  entityOutputId: string;
  byMetricId: string;
  byPeriodId?: string;
  byOutputId: string;
  direction: 'asc' | 'desc';
  limit: number;
  tiePolicy: 'stable_secondary_key' | 'include_ties';
  rankOutputId?: string;
}

export interface AnalyticalGraphValidateNode {
  id: string;
  kind: 'project_validate';
  dependencies: [string];
  outputIds: string[];
  entityGrainIds: string[];
  maxRows: number;
}

export type AnalyticalExecutionGraphNode =
  | AnalyticalGraphSourceInvocationNode
  | AnalyticalGraphAlignNode
  | AnalyticalGraphCalculateNode
  | AnalyticalGraphRankNode
  | AnalyticalGraphValidateNode;

export interface AnalyticalExecutionGraphV1 {
  schemaVersion: 1;
  graphId: string;
  fingerprint: string;
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  route: AnalyticalExecutionRoute;
  adapterId?: string;
  fitClass: AnalyticalFitClass;
  metricId: string;
  capabilityFingerprint: string;
  relationshipProofFingerprints?: string[];
  nodes: AnalyticalExecutionGraphNode[];
  terminalNodeId: string;
}

export type BuildAnalyticalExecutionGraphResult =
  | { status: 'ready'; graph: AnalyticalExecutionGraphV1 }
  | {
      status: 'blocked';
      code: AnalyticalExecutionGraphBlockedCode;
      reason: string;
      field?: string;
    };

export interface AnalyticalSourceResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  receiptFingerprint: string;
}

export type AnalyticalGraphExecutionFailureCode =
  | 'SOURCE_RESULT_MISSING'
  | 'SUB_RECEIPT_REQUIRED'
  | 'RESULT_CONTRACT_MISMATCH'
  | 'DECIMAL_VALUE_REQUIRED'
  | 'ROW_BOUND_EXCEEDED';

export type AnalyticalGraphExecutionResult =
  | {
      status: 'completed';
      columns: string[];
      rows: Array<Record<string, unknown>>;
      receipt: AnalyticalExecutionReceiptV1;
    }
  | {
      status: 'failed';
      code: AnalyticalGraphExecutionFailureCode;
      reason: string;
      nodeId: string;
      missingOutputIds?: string[];
    };

export function buildAnalyticalExecutionGraph(input: {
  plan: ResolvedAnalyticalPlan;
  capability: MetricCapabilityContract;
  route: AnalyticalExecutionRoute;
  adapterId?: string;
  fitClass?: AnalyticalFitClass;
  maxRows?: number;
}): BuildAnalyticalExecutionGraphResult {
  const { plan, capability, route } = input;
  const frame = plan.analyticalFrame;
  if (plan.schemaVersion !== 2 || !frame) {
    return blocked('PLAN_V2_REQUIRED', 'Analytical execution graphs require a resolved v2 plan.');
  }
  if (plan.capability === 'blocked' || plan.missingInformation.length > 0) {
    return blocked('PLAN_BLOCKED', plan.missingInformation.join(' ') || 'The resolved plan is blocked.');
  }
  if (frame.metricConceptIds.length !== 1 || frame.metricConceptIds[0] !== capability.metricId) {
    return blocked('CAPABILITY_MISMATCH', 'The selected capability does not match the plan metric.', 'metricConceptIds');
  }
  if (plan.selectedCapabilityFingerprint
    && plan.selectedCapabilityFingerprint !== capability.sourceFingerprint) {
    return blocked('CAPABILITY_MISMATCH', 'The selected capability fingerprint does not match the immutable plan.', 'selectedCapabilityFingerprint');
  }
  const routeCapability = capability.executionCapabilities.find(
    (candidate) => candidate.route === route && (!input.adapterId || candidate.adapterId === input.adapterId),
  );
  if (!routeCapability) {
    return blocked('ROUTE_MISMATCH', `${capability.metricId} does not declare the selected ${route} adapter.`, 'executionCapabilities');
  }
  const requiredRelationshipDimensionIds = [...new Set([
    ...frame.dimensions.map((binding) => binding.dimensionId),
    ...frame.memberBindings.map((binding) => binding.dimensionId),
  ])].filter((dimensionId) => {
    const dimension = capability.dimensions.find((candidate) => candidate.dimensionId === dimensionId);
    return dimension && dimension.entityId !== capability.primaryEntityId;
  });
  const relationshipProofs = plan.relationshipProofs ?? [];
  if (plan.selectedCapabilityFingerprint && requiredRelationshipDimensionIds.some((dimensionId) => {
    const matches = relationshipProofs.filter((proof) => proof.dimensionId === dimensionId);
    return matches.length !== 1 || !resolvedRelationshipProofMatches({
      proof: matches[0]!,
      capability,
      route,
      ...(input.adapterId ? { adapterId: input.adapterId } : {}),
      executionId: plan.executionId ?? '',
      snapshotId: plan.snapshotId,
    });
  })) {
    return blocked('RELATIONSHIP_PROOF_MISMATCH', 'The selected relationship authority does not match the plan, capability, dimension, snapshot, and adapter.', 'relationshipProofs');
  }

  const requestedOutputIds = frame.requestedOutputs.map((output) => output.id);
  if (requestedOutputIds.length === 0 || new Set(requestedOutputIds).size !== requestedOutputIds.length) {
    return blocked('OUTPUT_CONTRACT_INVALID', 'Requested output IDs must be non-empty and unique.', 'requestedOutputs');
  }
  const groupDimensions = unique(
    frame.dimensions
      .filter((dimension) =>
        dimension.role === 'group_by'
        || (frame.questionType === 'trend' && dimension.role === 'time_axis'))
      .map((dimension) => dimension.dimensionId),
  );
  const dimensionOutputs = frame.requestedOutputs.filter((output) => output.kind === 'dimension');
  if (dimensionOutputs.length !== groupDimensions.length) {
    return blocked(
      'OUTPUT_CONTRACT_INVALID',
      'Every grouping dimension must have exactly one requested dimension output.',
      'requestedOutputs',
    );
  }
  const dimensionAliases = groupDimensions.map((dimensionId, index) => ({
    dimensionId,
    outputId: dimensionOutputs[index]!.id,
  }));
  const memberFilters = frame.memberBindings.map((binding) => ({
    dimensionId: binding.dimensionId,
    canonicalValues: [...binding.canonicalValues],
  }));

  const nodes: AnalyticalExecutionGraphNode[] = [];
  if (route === 'certified') {
    const source: AnalyticalGraphSourceInvocationNode = {
      id: 'source:complete_asset',
      kind: 'source_invocation',
      dependencies: [],
      strategy: 'complete_asset',
      route,
      ...(routeCapability.adapterId ? { adapterId: routeCapability.adapterId } : {}),
      metricId: capability.metricId,
      entityGrainIds: [...frame.entityGrainIds],
      groupByDimensionIds: groupDimensions,
      memberFilters,
      outputAliases: {
        dimensions: dimensionAliases,
        completeAssetOutputIds: requestedOutputIds,
      },
    };
    nodes.push(source);
    const validate = validationNode(source.id, requestedOutputIds, frame.entityGrainIds, input.maxRows);
    nodes.push(validate);
    return readyGraph(input, capability, nodes, validate.id);
  }

  const periods = frame.timeContext?.periods ?? [];
  if (frame.timeContext && periods.length === 0) {
    return blocked('PERIOD_CONTRACT_INVALID', 'A time context must contain at least one period.', 'timeContext.periods');
  }
  const periodIds = periods.map((period) => period.id);
  if (new Set(periodIds).size !== periodIds.length) {
    return blocked('PERIOD_CONTRACT_INVALID', 'Period IDs must be unique.', 'timeContext.periods');
  }
  if (periods.some((period) => !period.start || !period.end)) {
    return blocked(
      'PERIOD_BOUNDS_REQUIRED',
      'Every executable analytical period must be resolved to start-inclusive and end-exclusive bounds.',
      'timeContext.periods',
    );
  }
  if (
    frame.timeContext &&
    (!frame.timeContext.timeDimensionId ||
      !frame.timeContext.timeRole ||
      !frame.timeContext.grain ||
      !frame.timeContext.calendarId ||
      !frame.timeContext.timezone ||
      !frame.timeContext.completenessPolicy)
  ) {
    return blocked(
      'PERIOD_CONTRACT_INVALID',
      'Executable periods require an exact time dimension, role, grain, calendar, timezone, and completeness policy.',
      'timeContext',
    );
  }

  const sourcePeriods: Array<AnalyticalPeriodV2 | undefined> = periods.length > 0 ? periods : [undefined];
  for (const period of sourcePeriods) {
    const metricOutput = metricOutputForPeriod(frame, period?.id);
    if (!metricOutput) {
      return blocked(
        'OUTPUT_CONTRACT_INVALID',
        `No unique metric output is declared for ${period ? `period ${period.id}` : 'the aggregate result'}.`,
        'requestedOutputs',
      );
    }
    const source: AnalyticalGraphSourceInvocationNode = {
      id: `source:${period?.id ?? 'all_time'}`,
      kind: 'source_invocation',
      dependencies: [],
      strategy: 'period_aggregate',
      route,
      ...(routeCapability.adapterId ? { adapterId: routeCapability.adapterId } : {}),
      metricId: capability.metricId,
      entityGrainIds: [...frame.entityGrainIds],
      groupByDimensionIds: groupDimensions,
      memberFilters,
      ...(period && frame.timeContext
        ? {
            period: {
              id: period.id,
              kind: period.kind,
              timeDimensionId: frame.timeContext.timeDimensionId!,
              timeRole: frame.timeContext.timeRole!,
              grain: frame.timeContext.grain!,
              calendarId: frame.timeContext.calendarId!,
              timezone: frame.timeContext.timezone!,
              completenessPolicy: frame.timeContext.completenessPolicy!,
              startInclusive: period.start!,
              endExclusive: period.end!,
            },
          }
        : {}),
      outputAliases: {
        dimensions: dimensionAliases,
        metric: {
          metricId: capability.metricId,
          ...(period ? { periodId: period.id } : {}),
          outputId: metricOutput.id,
        },
      },
    };
    nodes.push(source);
  }

  let previousNodeId = nodes.at(-1)!.id;
  if (sourcePeriods.length > 1) {
    if (!frame.comparison?.alignment) {
      return blocked('PERIOD_CONTRACT_INVALID', 'Multiple periods require an explicit comparison alignment.', 'comparison.alignment');
    }
    const align: AnalyticalGraphAlignNode = {
      id: 'align:periods',
      kind: 'align_periods',
      dependencies: nodes
        .filter((node): node is AnalyticalGraphSourceInvocationNode => node.kind === 'source_invocation')
        .map((node) => node.id),
      keyOutputIds: dimensionAliases.map((item) => item.outputId),
      periodMetricOutputIds: periods.map((period) => ({
        periodId: period.id,
        outputId: metricOutputForPeriod(frame, period.id)!.id,
      })),
      alignment: frame.comparison.alignment,
    };
    nodes.push(align);
    previousNodeId = align.id;
  }

  if (frame.comparison) {
    const expressions: AnalyticalGraphCalculateNode['expressions'] = [];
    const baseOutput = metricOutputForPeriod(frame, frame.comparison.basePeriodId);
    if (!baseOutput) {
      return blocked('OUTPUT_CONTRACT_INVALID', 'The comparison base period has no metric output.', 'comparison.basePeriodId');
    }
    for (const comparisonPeriodId of frame.comparison.comparisonPeriodIds) {
      const comparisonOutput = metricOutputForPeriod(frame, comparisonPeriodId);
      if (!comparisonOutput) {
        return blocked('OUTPUT_CONTRACT_INVALID', `Comparison period ${comparisonPeriodId} has no metric output.`, 'requestedOutputs');
      }
      const deltaOutput = comparisonDerivedOutput(frame, 'delta', comparisonPeriodId);
      const percentOutput = comparisonDerivedOutput(frame, 'percent_delta', comparisonPeriodId);
      if (frame.comparison.outputs.includes('absolute_delta') && !deltaOutput) {
        return blocked('OUTPUT_CONTRACT_INVALID', `Comparison period ${comparisonPeriodId} has no unique delta output.`, 'requestedOutputs');
      }
      if (frame.comparison.outputs.includes('percent_delta') && !percentOutput) {
        return blocked('OUTPUT_CONTRACT_INVALID', `Comparison period ${comparisonPeriodId} has no unique percent-delta output.`, 'requestedOutputs');
      }
      if (deltaOutput) {
        expressions.push({
          outputId: deltaOutput.id,
          kind: 'delta',
          baseOutputId: baseOutput.id,
          comparisonOutputId: comparisonOutput.id,
          zeroDenominatorPolicy: frame.comparison.zeroDenominatorPolicy,
        });
      }
      if (percentOutput) {
        expressions.push({
          outputId: percentOutput.id,
          kind: 'percent_delta',
          baseOutputId: baseOutput.id,
          comparisonOutputId: comparisonOutput.id,
          zeroDenominatorPolicy: frame.comparison.zeroDenominatorPolicy,
        });
      }
    }
    if (expressions.length > 0) {
      const calculate: AnalyticalGraphCalculateNode = {
        id: 'calculate:comparison',
        kind: 'calculate_comparison',
        dependencies: [previousNodeId],
        expressions,
      };
      nodes.push(calculate);
      previousNodeId = calculate.id;
    }
  }

  if (frame.ranking) {
    const entityAlias = dimensionAliases.find((item) => item.dimensionId === frame.ranking!.entityDimensionId);
    const byOutput = metricOutputForPeriod(frame, frame.ranking.byPeriodId);
    if (!entityAlias || !byOutput) {
      return blocked(
        'RANKING_CONTRACT_INVALID',
        'Ranking requires a projected entity dimension and a unique metric output for the ranking period.',
        'ranking',
      );
    }
    const rankOutput = frame.requestedOutputs.filter((output) => output.kind === 'rank');
    if (rankOutput.length > 1) {
      return blocked('OUTPUT_CONTRACT_INVALID', 'At most one rank output may be requested.', 'requestedOutputs');
    }
    const rank: AnalyticalGraphRankNode = {
      id: 'rank:result',
      kind: 'rank',
      dependencies: [previousNodeId],
      entityDimensionId: frame.ranking.entityDimensionId,
      entityOutputId: entityAlias.outputId,
      byMetricId: frame.ranking.byMetricId,
      ...(frame.ranking.byPeriodId ? { byPeriodId: frame.ranking.byPeriodId } : {}),
      byOutputId: byOutput.id,
      direction: frame.ranking.direction,
      limit: frame.ranking.limit,
      tiePolicy: frame.ranking.tiePolicy,
      ...(rankOutput[0] ? { rankOutputId: rankOutput[0].id } : {}),
    };
    nodes.push(rank);
    previousNodeId = rank.id;
  }

  const validate = validationNode(previousNodeId, requestedOutputIds, frame.entityGrainIds, input.maxRows);
  nodes.push(validate);
  return readyGraph(input, capability, nodes, validate.id);
}

export function executeAnalyticalExecutionGraph(input: {
  graph: AnalyticalExecutionGraphV1;
  sourceResults: Record<string, AnalyticalSourceResult>;
  percentScale?: number;
}): AnalyticalGraphExecutionResult {
  const results = new Map<string, Array<Record<string, unknown>>>();
  const subReceipts: AnalyticalExecutionReceiptV1['subReceipts'] = [];
  let outputColumns: string[] = [];
  let rowBound = 0;

  for (const node of input.graph.nodes) {
    if (node.kind === 'source_invocation') {
      const source = input.sourceResults[node.id];
      if (!source) return executionFailure('SOURCE_RESULT_MISSING', `No result was supplied for ${node.id}.`, node.id);
      if (!source.receiptFingerprint.trim()) {
        return executionFailure('SUB_RECEIPT_REQUIRED', `Source ${node.id} has no execution receipt fingerprint.`, node.id);
      }
      const expected =
        node.strategy === 'complete_asset'
          ? node.outputAliases.completeAssetOutputIds ?? []
          : [
              ...node.outputAliases.dimensions.map((item) => item.outputId),
              ...(node.outputAliases.metric ? [node.outputAliases.metric.outputId] : []),
            ];
      const missing = expected.filter((outputId) => !source.columns.includes(outputId));
      if (missing.length > 0) {
        return executionFailure(
          'RESULT_CONTRACT_MISMATCH',
          `Source ${node.id} is missing required outputs: ${missing.join(', ')}.`,
          node.id,
          missing,
        );
      }
      results.set(node.id, source.rows.map((row) => ({ ...row })));
      subReceipts.push({ nodeId: node.id, receiptFingerprint: source.receiptFingerprint });
      continue;
    }

    const dependencyRows = results.get(node.dependencies[0]);
    if (!dependencyRows) {
      return executionFailure('SOURCE_RESULT_MISSING', `Dependency ${node.dependencies[0]} was not produced.`, node.id);
    }
    if (node.kind === 'align_periods') {
      const aligned = alignPeriodRows(node, results);
      if ('failure' in aligned) return aligned.failure;
      results.set(node.id, aligned.rows);
      continue;
    }
    if (node.kind === 'calculate_comparison') {
      const calculated: Array<Record<string, unknown>> = [];
      for (const row of dependencyRows) {
        const next = { ...row };
        for (const expression of node.expressions) {
          const base = parseExactDecimal(row[expression.baseOutputId]);
          const comparison = parseExactDecimal(row[expression.comparisonOutputId]);
          if (!base || !comparison) {
            if (row[expression.baseOutputId] == null || row[expression.comparisonOutputId] == null) {
              next[expression.outputId] = null;
              continue;
            }
            return executionFailure(
              'DECIMAL_VALUE_REQUIRED',
              `${expression.outputId} requires exact decimal inputs.`,
              node.id,
            );
          }
          const delta = subtractDecimal(base, comparison);
          if (expression.kind === 'delta') {
            next[expression.outputId] = formatDecimal(delta);
          } else if (comparison.coefficient === 0n) {
            next[expression.outputId] = expression.zeroDenominatorPolicy === 'not_applicable' ? 'not_applicable' : null;
          } else {
            next[expression.outputId] = percentChange(delta, comparison, input.percentScale ?? 12);
          }
        }
        calculated.push(next);
      }
      results.set(node.id, calculated);
      continue;
    }
    if (node.kind === 'rank') {
      const ranked = rankRows(node, dependencyRows);
      if ('failure' in ranked) return ranked.failure;
      results.set(node.id, ranked.rows);
      continue;
    }

    outputColumns = [...node.outputIds];
    rowBound = node.maxRows;
    if (dependencyRows.length > node.maxRows) {
      return executionFailure(
        'ROW_BOUND_EXCEEDED',
        `Result returned ${dependencyRows.length} rows, above the ${node.maxRows} row contract.`,
        node.id,
      );
    }
    const missing = node.outputIds.filter((outputId) => dependencyRows.some((row) => !Object.prototype.hasOwnProperty.call(row, outputId)));
    if (missing.length > 0) {
      return executionFailure(
        'RESULT_CONTRACT_MISMATCH',
        `Terminal result is missing required outputs: ${missing.join(', ')}.`,
        node.id,
        missing,
      );
    }
    results.set(
      node.id,
      dependencyRows.map((row) => Object.fromEntries(node.outputIds.map((outputId) => [outputId, row[outputId]]))),
    );
  }

  const rows = results.get(input.graph.terminalNodeId);
  if (!rows) return executionFailure('SOURCE_RESULT_MISSING', 'The terminal graph node produced no result.', input.graph.terminalNodeId);
  const resultFingerprint = hash(stableStringify({ columns: outputColumns, rows }));
  const receiptPayload = {
    version: 1 as const,
    graphId: input.graph.graphId,
    graphFingerprint: input.graph.fingerprint,
    planId: input.graph.planId,
    planFingerprint: input.graph.planFingerprint,
    snapshotId: input.graph.snapshotId,
    route: input.graph.route,
    trustState: trustForRoute(input.graph.route),
    subReceipts: subReceipts.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    outputColumns,
    rowCount: rows.length,
    rowBound,
    resultFingerprint,
  };
  return {
    status: 'completed',
    columns: outputColumns,
    rows,
    receipt: {
      ...receiptPayload,
      receiptId: `analytical-receipt:${hash(stableStringify(receiptPayload)).slice(0, 24)}`,
    },
  };
}

function alignPeriodRows(
  node: AnalyticalGraphAlignNode,
  results: Map<string, Array<Record<string, unknown>>>,
): { rows: Array<Record<string, unknown>> } | { failure: Extract<AnalyticalGraphExecutionResult, { status: 'failed' }> } {
  const aligned = new Map<string, Record<string, unknown>>();
  for (const dependency of node.dependencies) {
    const rows = results.get(dependency);
    if (!rows) return { failure: executionFailure('SOURCE_RESULT_MISSING', `Dependency ${dependency} was not produced.`, node.id) };
    for (const row of rows) {
      const missingKeys = node.keyOutputIds.filter((key) => !Object.prototype.hasOwnProperty.call(row, key));
      if (missingKeys.length > 0) {
        return {
          failure: executionFailure(
            'RESULT_CONTRACT_MISMATCH',
            `Alignment input ${dependency} is missing keys: ${missingKeys.join(', ')}.`,
            node.id,
            missingKeys,
          ),
        };
      }
      const key = stableStringify(node.keyOutputIds.map((outputId) => row[outputId]));
      const existing = aligned.get(key) ?? Object.fromEntries(node.keyOutputIds.map((outputId) => [outputId, row[outputId]]));
      const metricOutput = node.periodMetricOutputIds.find((item) => Object.prototype.hasOwnProperty.call(row, item.outputId));
      if (!metricOutput) {
        return {
          failure: executionFailure('RESULT_CONTRACT_MISMATCH', `Alignment input ${dependency} has no declared period metric output.`, node.id),
        };
      }
      if (Object.prototype.hasOwnProperty.call(existing, metricOutput.outputId)) {
        return {
          failure: executionFailure(
            'RESULT_CONTRACT_MISMATCH',
            `Alignment input ${dependency} contains duplicate entity keys.`,
            node.id,
          ),
        };
      }
      existing[metricOutput.outputId] = row[metricOutput.outputId];
      aligned.set(key, existing);
    }
  }
  const rows = [...aligned.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => {
      const completed = { ...row };
      for (const output of node.periodMetricOutputIds) completed[output.outputId] ??= null;
      return completed;
    });
  return { rows };
}

function rankRows(
  node: AnalyticalGraphRankNode,
  inputRows: Array<Record<string, unknown>>,
): { rows: Array<Record<string, unknown>> } | { failure: Extract<AnalyticalGraphExecutionResult, { status: 'failed' }> } {
  const rows = inputRows.map((row) => ({ ...row }));
  const parsed = new Map<Record<string, unknown>, ExactDecimal>();
  for (const row of rows) {
    const value = parseExactDecimal(row[node.byOutputId]);
    if (!value) {
      return {
        failure: executionFailure('DECIMAL_VALUE_REQUIRED', `Ranking output ${node.byOutputId} must be numeric.`, node.id),
      };
    }
    parsed.set(row, value);
  }
  rows.sort((left, right) => {
    const compared = compareDecimal(parsed.get(left)!, parsed.get(right)!);
    if (compared !== 0) return node.direction === 'desc' ? -compared : compared;
    return stableStringify(left[node.entityOutputId]).localeCompare(stableStringify(right[node.entityOutputId]));
  });
  let selected = rows.slice(0, node.limit);
  if (node.tiePolicy === 'include_ties' && rows.length > node.limit && node.limit > 0) {
    const cutoff = parsed.get(rows[node.limit - 1]!)!;
    selected = rows.filter((row, index) => index < node.limit || compareDecimal(parsed.get(row)!, cutoff) === 0);
  }
  if (node.rankOutputId) {
    let last: ExactDecimal | undefined;
    let lastRank = 0;
    selected.forEach((row, index) => {
      const value = parsed.get(row)!;
      if (node.tiePolicy === 'include_ties' && last && compareDecimal(last, value) === 0) {
        row[node.rankOutputId!] = lastRank;
      } else {
        lastRank = index + 1;
        row[node.rankOutputId!] = lastRank;
      }
      last = value;
    });
  }
  return { rows: selected };
}

function metricOutputForPeriod(
  frame: AnalyticalQuestionFrameV2,
  periodId: string | undefined,
): AnalyticalQuestionFrameV2['requestedOutputs'][number] | undefined {
  const metrics = frame.requestedOutputs.filter(
    (output) =>
      output.kind === 'metric_value' &&
      output.metricId === frame.metricConceptIds[0] &&
      (periodId ? output.periodId === periodId : output.periodId === undefined),
  );
  if (metrics.length === 1) return metrics[0];
  if (!periodId) {
    const allMetricOutputs = frame.requestedOutputs.filter(
      (output) => output.kind === 'metric_value' && output.metricId === frame.metricConceptIds[0],
    );
    return allMetricOutputs.length === 1 ? allMetricOutputs[0] : undefined;
  }
  return undefined;
}

function comparisonDerivedOutput(
  frame: AnalyticalQuestionFrameV2,
  kind: 'delta' | 'percent_delta',
  comparisonPeriodId: string,
): AnalyticalQuestionFrameV2['requestedOutputs'][number] | undefined {
  const outputs = frame.requestedOutputs.filter(
    (output) => output.kind === kind && output.metricId === frame.metricConceptIds[0],
  );
  const exact = outputs.filter((output) => output.periodId === comparisonPeriodId);
  if (exact.length === 1) return exact[0];
  return outputs.length === 1 && !outputs[0]!.periodId ? outputs[0] : undefined;
}

function validationNode(
  dependency: string,
  outputIds: string[],
  entityGrainIds: string[],
  maxRows = 10_000,
): AnalyticalGraphValidateNode {
  return {
    id: 'validate:result_contract',
    kind: 'project_validate',
    dependencies: [dependency],
    outputIds: [...outputIds],
    entityGrainIds: [...entityGrainIds],
    maxRows: Math.min(Math.max(1, maxRows), 100_000),
  };
}

function readyGraph(
  input: {
    plan: ResolvedAnalyticalPlan;
    route: AnalyticalExecutionRoute;
    adapterId?: string;
    fitClass?: AnalyticalFitClass;
  },
  capability: MetricCapabilityContract,
  nodes: AnalyticalExecutionGraphNode[],
  terminalNodeId: string,
): BuildAnalyticalExecutionGraphResult {
  const payload = {
    schemaVersion: 1 as const,
    planId: input.plan.planId,
    planFingerprint: input.plan.fingerprint,
    snapshotId: input.plan.snapshotId,
    route: input.route,
    ...(input.adapterId ? { adapterId: input.adapterId } : {}),
    fitClass: input.fitClass ?? ('exact' as const),
    metricId: capability.metricId,
    capabilityFingerprint: capability.sourceFingerprint,
    relationshipProofFingerprints: [...new Set(
      input.plan.relationshipProofs?.map((proof) => proof.authorityFingerprint) ?? [],
    )].sort(),
    nodes,
    terminalNodeId,
  };
  const fingerprint = hash(stableStringify(payload));
  return {
    status: 'ready',
    graph: deepFreeze({
      ...payload,
      graphId: `analytical-graph:${fingerprint.slice(0, 24)}`,
      fingerprint,
    }),
  };
}

function blocked(
  code: AnalyticalExecutionGraphBlockedCode,
  reason: string,
  field?: string,
): BuildAnalyticalExecutionGraphResult {
  return { status: 'blocked', code, reason, ...(field ? { field } : {}) };
}

function executionFailure(
  code: AnalyticalGraphExecutionFailureCode,
  reason: string,
  nodeId: string,
  missingOutputIds?: string[],
): Extract<AnalyticalGraphExecutionResult, { status: 'failed' }> {
  return { status: 'failed', code, reason, nodeId, ...(missingOutputIds?.length ? { missingOutputIds } : {}) };
}

/** Exact base-10 representation shared by analytical graph and Ask post-processing. */
export interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

export function parseExactDecimal(value: unknown): ExactDecimal | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  const expanded = expandExponent(String(value).trim());
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(expanded);
  if (!match) return undefined;
  const fraction = match[3] ?? '';
  const sign = match[1] === '-' ? -1n : 1n;
  return normalizeDecimal({ coefficient: sign * BigInt(`${match[2]}${fraction}`), scale: fraction.length });
}

function expandExponent(value: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) return value;
  const sign = match[1] ?? '';
  const integer = match[2]!;
  const fraction = match[3] ?? '';
  const exponent = Number(match[4]);
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  if (decimalIndex <= 0) return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function normalizeDecimal(value: ExactDecimal): ExactDecimal {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

export function subtractDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeDecimal({
    coefficient:
      left.coefficient * pow10(scale - left.scale) -
      right.coefficient * pow10(scale - right.scale),
    scale,
  });
}

export function addDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeDecimal({
    coefficient:
      left.coefficient * pow10(scale - left.scale) +
      right.coefficient * pow10(scale - right.scale),
    scale,
  });
}

export function negateDecimal(value: ExactDecimal): ExactDecimal {
  return { coefficient: -value.coefficient, scale: value.scale };
}

export function absDecimal(value: ExactDecimal): ExactDecimal {
  return value.coefficient < 0n ? negateDecimal(value) : value;
}

export function multiplyDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return normalizeDecimal({ coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale });
}

export function sumDecimals(values: ExactDecimal[]): ExactDecimal {
  return values.reduce((total, value) => addDecimal(total, value), { coefficient: 0n, scale: 0 });
}

export function compareDecimal(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * pow10(scale - left.scale);
  const rightValue = right.coefficient * pow10(scale - right.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function percentChange(delta: ExactDecimal, denominator: ExactDecimal, scale: number): string {
  const safeScale = Math.min(Math.max(0, scale), 18);
  const numerator = delta.coefficient * 100n * pow10(denominator.scale + safeScale);
  const divisor = denominator.coefficient * pow10(delta.scale);
  let quotient = numerator / divisor;
  const remainder = numerator % divisor;
  if (abs(remainder) * 2n >= abs(divisor)) {
    quotient += (numerator < 0n) !== (divisor < 0n) ? -1n : 1n;
  }
  return formatDecimal(normalizeDecimal({ coefficient: quotient, scale: safeScale }));
}

export function formatDecimal(value: ExactDecimal): string {
  const sign = value.coefficient < 0n ? '-' : '';
  const digits = abs(value.coefficient).toString().padStart(value.scale + 1, '0');
  if (value.scale === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
}

export function divideDecimal(numerator: ExactDecimal, denominator: ExactDecimal, scale = 18): string | undefined {
  if (denominator.coefficient === 0n) return undefined;
  const safeScale = Math.min(Math.max(0, scale), 18);
  const scaled = numerator.coefficient * pow10(denominator.scale + safeScale);
  const divisor = denominator.coefficient * pow10(numerator.scale);
  let quotient = scaled / divisor;
  const remainder = scaled % divisor;
  if (abs(remainder) * 2n >= abs(divisor)) {
    quotient += (scaled < 0n) !== (divisor < 0n) ? -1n : 1n;
  }
  return formatDecimal(normalizeDecimal({ coefficient: quotient, scale: safeScale }));
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function trustForRoute(route: AnalyticalExecutionRoute): AnalyticalExecutionReceiptV1['trustState'] {
  if (route === 'certified') return 'certified';
  if (route === 'semantic' || route === 'governed_sql') return 'governed';
  return 'review_required';
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
