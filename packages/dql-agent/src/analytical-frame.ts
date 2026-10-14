/**
 * Zero-provider construction of an RFC 0005 analytical frame from an already
 * resolved metric, parsed request hints, retrieved semantic members, and an
 * explicit normalized capability contract.
 *
 * This is intentionally conservative: unresolved roles become ambiguity or no
 * frame instead of name-based execution authority.
 *
 * Acceptance: AGT-017, AGT-018.
 */

import { normalizeMetricCapabilityContract, type AnalyticalDimensionBindingV2, type AnalyticalQuestionFrameV2, type MetricCapabilityContract } from '@zlens/core';
import { questionTypeFromText, type AgentEvidenceCandidate, type AgentRetrievalEvidence, type MeaningQueryIntent, type MeaningQuestionType } from './meaning-resolution.js';
import type { ResolvedAnalyticalPlan, ResolvedPlanMemberBinding } from './resolved-analytical-plan.js';

/**
 * Project the final analytical frame from the immutable RAP bindings. Candidate
 * names are deliberately absent from this boundary: retrieval may help bind the
 * RAP, but it cannot re-open a uniquely resolved metric, dimension, or filter.
 */
export function projectResolvedAnalyticalFrame(input: {
  plan: ResolvedAnalyticalPlan;
  sourceFrame: AnalyticalQuestionFrameV2;
}): AnalyticalQuestionFrameV2 {
  const { plan, sourceFrame } = input;
  const resolvedMeasureIds = plan.query.measures.flatMap((binding) =>
    binding.status === 'resolved' && binding.qualifiedId ? [binding.qualifiedId] : []);
  const metricConceptIds = plan.selectedCapability?.metricId
    ? unique([
        plan.selectedCapability.metricId,
        ...sourceFrame.metricConceptIds.filter((metricId) => metricId !== sourceFrame.metricConceptIds[0]),
      ])
    : unique(resolvedMeasureIds);
  const sourceTimeDimensionId = sourceFrame.timeContext?.timeDimensionId;
  const sourceTimeIsGrouped = Boolean(sourceTimeDimensionId && sourceFrame.dimensions.some((binding) =>
    binding.dimensionId === sourceTimeDimensionId && binding.role === 'group_by'));
  const groupedDimensionIds = unique(plan.query.dimensions.flatMap((binding) =>
    binding.status === 'resolved' && binding.qualifiedId
      // The ordinary RAP query list intentionally carries the time phrase for
      // binding/audit.  It must not silently turn a V2 time_axis into a
      // group_by role when the source frame did not request a time-series
      // output; that changes a current-vs-prior ranking into per-day rows.
      && (binding.qualifiedId !== sourceTimeDimensionId || sourceTimeIsGrouped)
      ? [binding.qualifiedId]
      : []));
  const rankingRequested = Boolean(sourceFrame.ranking || plan.query.order || plan.query.limit !== undefined);
  const sourceRankEntityDimensionId = sourceFrame.ranking?.entityDimensionId;
  const dimensions: AnalyticalDimensionBindingV2[] = groupedDimensionIds.flatMap((dimensionId, index) => [
    { dimensionId, role: 'group_by' as const },
    // Preserve the source frame's rank entity. Reassigning rank ownership to
    // the first grouped dimension silently changed "top customers by product
    // category" into "top product categories", then the compatibility guard
    // correctly rejected the category for lacking `rank_entity` support.
    ...(rankingRequested && (sourceRankEntityDimensionId
      ? dimensionId === sourceRankEntityDimensionId
      : index === 0)
      ? [{ dimensionId, role: 'rank_entity' as const }]
      : []),
  ]);
  for (const filter of plan.query.filters) {
    const dimensionId = filter.binding.status === 'resolved' ? filter.binding.qualifiedId : undefined;
    if (dimensionId && !dimensions.some((binding) => binding.dimensionId === dimensionId && binding.role === 'filter')) {
      dimensions.push({ dimensionId, role: 'filter' });
    }
  }
  if (sourceFrame.timeContext?.timeDimensionId) {
    dimensions.push({ dimensionId: sourceFrame.timeContext.timeDimensionId, role: 'time_axis' });
  }

  // Keep an unresolved host-built ambiguity intact while projecting the RAP.
  // Its candidate IDs came from the selected metric's native capability and
  // are the only valid structured clarification choices. Reconstructing only
  // from a failed lexical RAP rebind turns two viable `billing account` /
  // `service account` meanings into an empty generic gap. If RAP resolved the
  // corresponding binding, the authoritative plan supersedes the source
  // ambiguity as usual.
  // Ambiguity is lane-scoped. A physical/semantic ID may legitimately occur
  // in more than one role, but a group-by binding must never consume a filter
  // clarification (or vice versa). Keep the source-frame and frozen RAP proof
  // sets separated by the meaning lane before intersecting them below.
  const resolvedPlanBindingIds = {
    metrics: new Set(plan.query.measures.flatMap((binding) =>
      binding.status === 'resolved' && binding.qualifiedId ? [binding.qualifiedId] : [])),
    dimensions: new Set(plan.query.dimensions.flatMap((binding) =>
      binding.status === 'resolved' && binding.qualifiedId ? [binding.qualifiedId] : [])),
    filters: new Set(plan.query.filters.flatMap((filter) =>
      filter.binding.status === 'resolved' && filter.binding.qualifiedId ? [filter.binding.qualifiedId] : [])),
  };
  const sourceFrameBindingIds = {
    metrics: new Set(sourceFrame.metricConceptIds),
    dimensions: new Set(sourceFrame.dimensions
      .filter((binding) => binding.role !== 'filter')
      .map((binding) => binding.dimensionId)),
    filters: new Set([
      ...sourceFrame.dimensions
        .filter((binding) => binding.role === 'filter')
        .map((binding) => binding.dimensionId),
      ...sourceFrame.memberBindings.map((binding) => binding.dimensionId),
    ]),
  };
  const resolvedSourceAmbiguityKeys = new Set<string>();
  const unresolvedSourceAmbiguity = sourceFrame.ambiguity.filter((entry) => {
    const [lane, ...parts] = entry.field.split('.');
    const requested = normalize(parts.join('.'));
    if (!requested) return true;
    // A server-issued clarification selection is already represented as one
    // exact capability binding in the host-built frame and the RAP. Do not
    // retain the lexical ambiguity that prompted that selection merely because
    // the original natural-language phrase (for example, "name") is still in
    // the audit query list. This is intentionally identity-based rather than
    // label-based and applies equally to metric, dimension, and filter lanes.
    // The exact offered ID must be resolved in that same lane on both sides;
    // a genuine ambiguity remains when zero or more than one offered candidate
    // is resolved in the frozen tuple.
    const laneBindingIds = lane === 'metrics' || lane === 'dimensions' || lane === 'filters'
      ? { source: sourceFrameBindingIds[lane], plan: resolvedPlanBindingIds[lane] }
      : undefined;
    const exactlyResolvedCandidateIds = laneBindingIds
      ? [...new Set(entry.candidateIds.filter((candidateId) =>
          laneBindingIds.source.has(candidateId)
          && laneBindingIds.plan.has(candidateId)))]
      : [];
    if (exactlyResolvedCandidateIds.length === 1) {
      resolvedSourceAmbiguityKeys.add(`${lane}.${requested}`);
      return false;
    }
    // Candidate-bearing source ambiguity is an identity contract. A RAP
    // binding with the same lexical request may be an unrelated third field;
    // it cannot clear the offered A/B choice. Retain that ambiguity unless the
    // exact candidate proof above resolved one and only one offered ID.
    // Legacy source ambiguity without candidates has no such identity proof,
    // so it retains the historical lexical fallback below.
    if (entry.candidateIds.length > 0) return true;
    const binding = lane === 'dimensions'
      ? plan.query.dimensions.find((item) => normalize(item.requested) === requested)
      : lane === 'metrics'
        ? plan.query.measures.find((item) => normalize(item.requested) === requested)
        : lane === 'filters'
          ? plan.query.filters.find((item) => normalize(item.binding.requested) === requested)?.binding
          : undefined;
    return !binding || binding.status !== 'resolved';
  });
  const ambiguity = uniqueAmbiguity([
    ...unresolvedSourceAmbiguity,
    // Preserve the original query for audit, but do not let its unresolved
    // lexical binding recreate an ambiguity that was discharged by exactly one
    // of the source-offered IDs. This applies to every binding lane: a metric
    // ambiguity has the same identity contract as a display-dimension one.
    ...plan.query.measures.flatMap((binding) =>
      resolvedSourceAmbiguityKeys.has(`metrics.${normalize(binding.requested)}`)
        ? []
        : frameBindingAmbiguity('metrics', binding)),
    // The query list retains the original lexical phrase for audit.  Once an
    // exact server-issued candidate resolved the corresponding source
    // ambiguity, that audit binding must not re-create the same ambiguity in
    // the projected frame.
    ...plan.query.dimensions.flatMap((binding) =>
      resolvedSourceAmbiguityKeys.has(`dimensions.${normalize(binding.requested)}`)
        ? []
        : frameBindingAmbiguity('dimensions', binding)),
    ...plan.query.filters.flatMap((filter) =>
      resolvedSourceAmbiguityKeys.has(`filters.${normalize(filter.binding.requested)}`)
        ? []
        : frameBindingAmbiguity('filters', filter.binding)),
  ]);
  const dimensionOutputs = groupedDimensionIds.map((dimensionId) => ({
    id: localId(dimensionId),
    kind: 'dimension' as const,
  }));
  const sourceMetricOutputs = sourceFrame.requestedOutputs.filter((output) =>
    output.kind !== 'dimension' && output.kind !== 'rank');
  const metricOutputs: AnalyticalQuestionFrameV2['requestedOutputs'] = sourceMetricOutputs.length > 0
    ? sourceMetricOutputs.map((output) => ({
        ...output,
        ...('metricId' in output && metricConceptIds.length === 1 ? { metricId: metricConceptIds[0]! } : {}),
      }))
    : metricConceptIds.map((metricId) => ({ id: localId(metricId), kind: 'metric_value' as const, metricId }));
  const explicitRankOutputs = sourceFrame.requestedOutputs.filter((output) => output.kind === 'rank');
  const requestedOutputs = uniqueOutputs([
    ...dimensionOutputs,
    ...sourceFrame.requestedOutputs.filter((output) => output.kind === 'dimension'
      && sourceFrame.timeContext?.timeDimensionId
      && output.id === localId(sourceFrame.timeContext.timeDimensionId)),
    ...metricOutputs,
    ...explicitRankOutputs,
  ]);
  const rankEntityDimensionId = dimensions.find((binding) => binding.role === 'rank_entity')?.dimensionId;
  const ranking = rankingRequested && rankEntityDimensionId && metricConceptIds[0]
    ? {
        entityDimensionId: rankEntityDimensionId,
        byMetricId: metricConceptIds[0],
        ...(sourceFrame.ranking?.byPeriodId ? { byPeriodId: sourceFrame.ranking.byPeriodId } : {}),
        direction: plan.query.order ?? sourceFrame.ranking?.direction ?? 'desc',
        limit: plan.query.limit ?? sourceFrame.ranking?.limit ?? 10,
        tiePolicy: sourceFrame.ranking?.tiePolicy ?? 'stable_secondary_key' as const,
      }
    : undefined;

  const { ranking: _sourceRanking, ...frameBase } = sourceFrame;
  return {
    ...frameBase,
    metricConceptIds,
    entityGrainIds: plan.entityGrain ? [plan.entityGrain] : sourceFrame.entityGrainIds,
    dimensions,
    memberBindings: memberBindingsForResolvedPlanFilters(plan.query.filters),
    ...(ranking ? { ranking } : {}),
    requestedOutputs,
    ambiguity,
  };
}

function frameBindingAmbiguity(
  lane: 'metrics' | 'dimensions' | 'filters',
  binding: ResolvedPlanMemberBinding,
): AnalyticalQuestionFrameV2['ambiguity'] {
  if (binding.status === 'resolved') return [];
  return [{
    field: `${lane}.${binding.requested}`,
    candidateIds: [...binding.candidateIds].sort(),
    reasonCode: binding.status === 'ambiguous'
      ? `${lane.slice(0, -1).toUpperCase()}_AMBIGUOUS`
      : `${lane.slice(0, -1).toUpperCase()}_UNRESOLVED`,
  }];
}

function uniqueAmbiguity(
  entries: AnalyticalQuestionFrameV2['ambiguity'],
): AnalyticalQuestionFrameV2['ambiguity'] {
  return entries.filter((entry, index, all) => all.findIndex((candidate) =>
    candidate.field === entry.field
    && candidate.reasonCode === entry.reasonCode
    && candidate.candidateIds.join('\u0000') === entry.candidateIds.join('\u0000')) === index);
}

function uniqueOutputs(
  outputs: AnalyticalQuestionFrameV2['requestedOutputs'],
): AnalyticalQuestionFrameV2['requestedOutputs'] {
  return outputs.filter((output, index, all) => all.findIndex((candidate) => candidate.id === output.id) === index);
}

/**
 * A plural prior-result continuation is one membership predicate (`IN`), not
 * ten independent equality predicates.  Both the deterministic and resolved
 * frame paths use this helper so a persisted member set cannot become an
 * impossible `customer_name = A AND customer_name = B` condition after a
 * restart.
 */
function appendMemberBinding(
  bindings: AnalyticalQuestionFrameV2['memberBindings'],
  next: AnalyticalQuestionFrameV2['memberBindings'][number],
): void {
  const index = bindings.findIndex((binding) => binding.dimensionId === next.dimensionId);
  if (index < 0) {
    bindings.push({ ...next, canonicalValues: unique(next.canonicalValues) });
    return;
  }
  const existing = bindings[index]!;
  bindings[index] = {
    ...existing,
    canonicalValues: unique([...existing.canonicalValues, ...next.canonicalValues]),
  };
}

function memberBindingsForResolvedPlanFilters(
  filters: ResolvedAnalyticalPlan['query']['filters'],
): AnalyticalQuestionFrameV2['memberBindings'] {
  const bindings: AnalyticalQuestionFrameV2['memberBindings'] = [];
  for (const filter of filters) {
    if (filter.binding.status !== 'resolved' || !filter.binding.qualifiedId) continue;
    appendMemberBinding(bindings, {
      dimensionId: filter.binding.qualifiedId,
      canonicalValues: [filter.value],
      source: 'question',
      confidence: 'exact',
    });
  }
  return bindings;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function buildDeterministicAnalyticalFrame(input: {
  question: string;
  questionType?: MeaningQuestionType;
  evidence: AgentRetrievalEvidence;
  metricCandidate: AgentEvidenceCandidate;
  /** Complete explicitly requested metric set; the first remains the ranking/default metric. */
  metricCandidates?: AgentEvidenceCandidate[];
  /**
   * Host-owned entity and display-key requirements. These are deliberately
   * separate from ordinary categorical dimensions: a ranking's `customer`
   * role must bind a unique native customer display/rank field rather than
   * every capability field whose alias happens to contain `customer`.
   */
  entityTerms?: string[];
  entityDisplayTerms?: string[];
  /**
   * Stable semantic-dimension identities selected from a server-issued
   * clarification. They are not inferred from reply text: each must resolve
   * against the selected metric's declared capability before it can bind the
   * frame.
   */
  selectedDimensionIds?: string[];
  candidates: AgentEvidenceCandidate[];
}): AnalyticalQuestionFrameV2 | undefined {
  const capability = normalizeMetricCapabilityContract(input.metricCandidate.analyticalCapability);
  if (!capability) return undefined;
  const metricCapabilities = [
    capability,
    ...(input.metricCandidates ?? [])
      .filter((candidate) => candidate.id !== input.metricCandidate.id)
      .flatMap((candidate) => {
        const normalized = normalizeMetricCapabilityContract(candidate.analyticalCapability);
        return normalized ? [normalized] : [];
      }),
  ].filter((candidate, index, all) =>
    all.findIndex((other) => other.metricId === candidate.metricId) === index);
  const meaningType = input.questionType ?? questionTypeFromText(input.question);
  if (meaningType === 'definition') return undefined;
  const queryIntent: MeaningQueryIntent = {
    measures: input.evidence.parsedIntent?.measures ?? [],
    dimensions: input.evidence.parsedIntent?.dimensions ?? [],
    filters: input.evidence.parsedIntent?.filters ?? [],
    ...(input.evidence.parsedIntent?.timeRange ? { timeRange: input.evidence.parsedIntent.timeRange } : {}),
    ...(input.evidence.parsedIntent?.timeGrain ? { timeGrain: input.evidence.parsedIntent.timeGrain } : {}),
    ...(input.evidence.parsedIntent?.order ? { order: input.evidence.parsedIntent.order } : {}),
    ...(input.evidence.parsedIntent?.limit !== undefined ? { limit: input.evidence.parsedIntent.limit } : {}),
  };
  const rankingRequested = meaningType === 'ranking' || queryIntent.limit !== undefined || /\b(top|bottom|highest|lowest|rank)\b/i.test(input.question);
  const requestedEntityTerms = unique(input.entityTerms ?? []).map(normalize).filter(Boolean);
  const requestedEntityDisplayTerms = unique(input.entityDisplayTerms ?? []).map(normalize).filter(Boolean);
  const requestedDimensionTerms = new Set(queryIntent.dimensions.map(normalize).filter(Boolean));
  // The immutable host seed has already separated the entity role from the
  // categorical lane. Retain this defensive removal for older callers whose
  // query intent still contains both forms; otherwise a generic `customer`
  // candidate can manufacture a false ambiguity among Customer Name, Customer
  // Type, and Customer Order Number.
  for (const term of [...requestedEntityTerms, ...requestedEntityDisplayTerms]) {
    requestedDimensionTerms.delete(term);
  }
  for (const filter of queryIntent.filters) requestedDimensionTerms.add(normalize(filter.field));
  for (const candidate of input.candidates) {
    // Entity/member cards may be useful to the bounded meaning call, but they
    // are not dimension identities. Letting a selected Customer entity card
    // pass through this loop reintroduced its broad lexical name as a generic
    // dimension request and made every customer-* capability child compete.
    if (candidate.kind !== 'semantic_member' || candidate.semanticObjectType !== 'dimension') continue;
    const capabilityDimension = resolveCapabilityDimension(candidate.qualifiedId ?? candidate.id, capability);
    if (!capabilityDimension) continue;
    const terms = [candidate.name, ...(candidate.aliases ?? [])].map(normalize).filter(Boolean);
    if (terms.some((term) => phraseAppears(input.question, term))) {
      requestedDimensionTerms.add(normalize(candidate.qualifiedId ?? candidate.id));
    }
  }

  const ambiguity: AnalyticalQuestionFrameV2['ambiguity'] = [];
  const resolvedDimensions = new Map<string, MetricCapabilityContract['dimensions'][number]>();
  const structuredSelectedDimensionIds = new Set<string>();
  // A ranking may group by more than one field, but only the explicitly
  // resolved entity display key is the entity being ranked. Keep that role
  // separate from generic rankable capability metadata: adapters sometimes
  // advertise `rank_entity` for a categorical grouping such as product type,
  // which permits ranking *by* that field but does not make it an answer to
  // “top customers by product category”.
  const entityDisplayDimensionIds = new Set<string>();
  // A structured dimension choice is already a qualified, server-bound
  // meaning. Bind it only through the metric's authored capability contract;
  // this is deliberately stronger than adding the option label back into the
  // natural-language question and prevents a selected member from inventing a
  // join or a display role it does not own.
  for (const selectedId of unique(input.selectedDimensionIds ?? [])) {
    // A model may select a supplied semantic entity card to identify the
    // entity. It is not a qualified display dimension and must never resolve
    // by lexical fallback to the first same-named capability child.
    const dimension = resolveExactCapabilityDimension(selectedId, capability);
    if (dimension) {
      resolvedDimensions.set(dimension.dimensionId, dimension);
      structuredSelectedDimensionIds.add(dimension.dimensionId);
    }
  }
  for (const requested of requestedEntityDisplayTerms) {
    // A structured clarification click is a server-issued, capability-bound
    // answer to this exact display-key ambiguity. Once it has proved a single
    // native display/rank field for the requested label, do not recreate the
    // original Account Name vs Customer Name ambiguity from the broad word
    // "names". The selected field was already checked against this metric's
    // authored capability above; this branch only consumes that binding.
    const selectedDisplayMatches = [...structuredSelectedDimensionIds]
      .map((dimensionId) => resolvedDimensions.get(dimensionId))
      .filter((dimension): dimension is MetricCapabilityContract['dimensions'][number] => Boolean(dimension))
      .filter((dimension) => dimension.supportedRoles.includes('group_by')
        && (rankingRequested
          ? dimension.supportedRoles.includes('rank_entity')
          : dimension.supportedRoles.includes('display')));
    if (selectedDisplayMatches.length === 1) {
      entityDisplayDimensionIds.add(selectedDisplayMatches[0]!.dimensionId);
      continue;
    }
    const matches = resolveEntityDisplayTerm({
      requested,
      entityTerms: requestedEntityTerms,
      capability,
      rankingRequested,
    });
    if (matches.length === 1) {
      resolvedDimensions.set(matches[0]!.dimensionId, matches[0]!);
      entityDisplayDimensionIds.add(matches[0]!.dimensionId);
    } else if (matches.length > 1) {
      ambiguity.push({
        field: `dimensions.${requested}`,
        candidateIds: matches.map((dimension) => dimension.dimensionId).sort(),
        reasonCode: 'DIMENSION_AMBIGUOUS',
      });
    }
  }
  for (const requested of requestedDimensionTerms) {
    // Generic parser terms such as `name` can match more than one capability
    // field. A server-issued qualified selection has already resolved that
    // exact ambiguity, so preserve its native field rather than re-opening
    // the broad lexical candidate set on a restart/follow-up.
    const selectedMatches = [...structuredSelectedDimensionIds]
      .map((dimensionId) => resolvedDimensions.get(dimensionId))
      .filter((dimension): dimension is MetricCapabilityContract['dimensions'][number] => Boolean(dimension))
      .filter((dimension) => dimensionMatchesTerm(dimension, requested)
        || selectedSameSnapshotDimensionBindsRequestedTerm({
          dimension,
          requested,
          candidates: input.candidates,
        }));
    if (selectedMatches.length === 1) continue;
    const matches = resolveDimensionTerm(requested, capability, input.candidates);
    if (matches.length === 1) resolvedDimensions.set(matches[0]!.dimensionId, matches[0]!);
    else if (matches.length > 1) {
      ambiguity.push({
        field: `dimensions.${requested}`,
        candidateIds: matches.map((dimension) => dimension.dimensionId).sort(),
        reasonCode: 'DIMENSION_AMBIGUOUS',
      });
    }
  }

  const filterDimensionIds = new Set<string>();
  const memberBindings: AnalyticalQuestionFrameV2['memberBindings'] = [];
  for (const filter of queryIntent.filters) {
    const matches = resolveDimensionTerm(normalize(filter.field), capability, input.candidates);
    if (matches.length !== 1) continue;
    const dimension = matches[0]!;
    filterDimensionIds.add(dimension.dimensionId);
    resolvedDimensions.set(dimension.dimensionId, dimension);
    appendMemberBinding(memberBindings, {
      dimensionId: dimension.dimensionId,
      canonicalValues: [filter.value],
      source: 'question',
      confidence: 'exact',
    });
  }

  const groupRequested = rankingRequested || /\b(by|per|for each|breakdown)\b/i.test(input.question);
  const dimensions: AnalyticalDimensionBindingV2[] = [];
  for (const dimension of resolvedDimensions.values()) {
    const onlyFilter = filterDimensionIds.has(dimension.dimensionId) && !groupRequested;
    if (onlyFilter) {
      dimensions.push({ dimensionId: dimension.dimensionId, role: 'filter' });
      continue;
    }
    if (dimension.supportedRoles.includes('group_by')) {
      dimensions.push({ dimensionId: dimension.dimensionId, role: 'group_by' });
      const isExplicitEntityDisplay = entityDisplayDimensionIds.has(dimension.dimensionId);
      if (rankingRequested
        && dimension.supportedRoles.includes('rank_entity')
        && (entityDisplayDimensionIds.size === 0 || isExplicitEntityDisplay)) {
        dimensions.push({
          dimensionId: dimension.dimensionId,
          role: 'rank_entity',
        });
      }
    } else if (filterDimensionIds.has(dimension.dimensionId)) {
      dimensions.push({ dimensionId: dimension.dimensionId, role: 'filter' });
    }
  }

  // `current` can be an intrinsic business qualifier ("current BCM run
  // rate"), not a request for a date axis.  Creating a timeContext for that
  // bare modifier forces every metric through time-dimension compatibility and
  // incorrectly blocks snapshot metrics that already encode their current/as-
  // of semantics.  Only require a declared time role for an actual time grain
  // or temporal filter.  The metric's own governed definition remains the
  // authority for an unqualified current/latest snapshot value.
  const requestedTimeGrain = explicitTimeGrain(queryIntent.timeGrain) ?? inferTimeGrain(input.question);
  const timeRequested =
    Boolean(queryIntent.timeRange && !isSnapshotOnlyTimeRange(queryIntent.timeRange))
    || Boolean(requestedTimeGrain)
    || hasExplicitTemporalFilter(input.question);
  const previousYearRequested = /\b(last year|previous year|year over year|yoy)\b/i.test(input.question);
  const currentRequested = /\b(?:today|yesterday)\b|\b(?:this|current)\s+(?:day|week|month|quarter|year)\b|\b(?:month|quarter|year)[ -]to[ -]date\b|\b(?:mtd|qtd|ytd)\b/i.test(input.question)
    || previousYearRequested;
  const timeContext: AnalyticalQuestionFrameV2['timeContext'] = timeRequested
    ? {
        ...(capability.timeDimensions.length === 1
          ? {
              timeDimensionId: capability.timeDimensions[0]!.dimensionId,
              timeRole: capability.timeDimensions[0]!.role,
            }
          : {}),
        ...(requestedTimeGrain ? { grain: requestedTimeGrain } : {}),
        ...(capability.freshness?.defaultCompletenessPolicy
          ? {
              completenessPolicy: capability.freshness.defaultCompletenessPolicy,
            }
          : {}),
        periods: [
          ...(currentRequested ? [{ id: 'current', kind: 'current' as const }] : []),
          ...(previousYearRequested
            ? [
                {
                  id: 'previous_year',
                  kind: 'previous_year' as const,
                  alignToPeriodId: 'current',
                },
              ]
            : []),
          ...(!currentRequested && queryIntent.timeRange ? [{ id: 'requested_period', kind: 'absolute' as const }] : []),
        ],
      }
    : undefined;
  if (timeContext) {
    for (const policy of input.evidence.analyticalPolicies ?? []) {
      if (policy.metricIds?.length && !policy.metricIds.includes(capability.metricId)) continue;
      timeContext.timeRole ??= policy.timeRole;
      timeContext.calendarId ??= policy.calendarId;
      timeContext.timezone ??= policy.timezone;
      timeContext.completenessPolicy ??= policy.completenessPolicy;
    }
    dimensions.push({
      dimensionId: capability.timeDimensions.length === 1 ? capability.timeDimensions[0]!.dimensionId : '',
      role: 'time_axis',
    });
  }
  const filteredDimensions = dimensions.filter((dimension) => Boolean(dimension.dimensionId));
  const grouped = [...resolvedDimensions.values()].filter((dimension) =>
    filteredDimensions.some((binding) => binding.dimensionId === dimension.dimensionId && (binding.role === 'group_by' || binding.role === 'rank_entity')),
  );
  const entityGrainIds = grouped.length > 0 ? [...new Set(grouped.map((dimension) => dimension.entityId))] : [capability.defaultResultGrainId];

  const comparison = previousYearRequested
    ? {
        basePeriodId: 'current',
        comparisonPeriodIds: ['previous_year'],
        outputs: ['value', 'absolute_delta', 'percent_delta'] as Array<'value' | 'absolute_delta' | 'percent_delta'>,
        zeroDenominatorPolicy: 'null' as const,
      }
    : undefined;
  const rankDimension = filteredDimensions.find((dimension) => dimension.role === 'rank_entity');
  const ranking =
    rankingRequested && rankDimension
      ? {
          entityDimensionId: rankDimension.dimensionId,
          byMetricId: capability.metricId,
          ...(currentRequested ? { byPeriodId: 'current' } : {}),
          direction: queryIntent.order ?? (/\b(bottom|lowest)\b/i.test(input.question) ? ('asc' as const) : ('desc' as const)),
          limit: queryIntent.limit ?? extractLimit(input.question) ?? 10,
          tiePolicy: 'stable_secondary_key' as const,
        }
      : undefined;
  const projectedTimeDimensions = meaningType === 'trend' && timeContext?.timeDimensionId
    ? [{
        dimensionId: timeContext.timeDimensionId,
        outputId: localId(timeContext.timeDimensionId),
      }]
    : [];
  const metricOutputs: AnalyticalQuestionFrameV2['requestedOutputs'] = metricCapabilities.flatMap(
    (metricCapability): AnalyticalQuestionFrameV2['requestedOutputs'] => {
      const localMetric = localId(metricCapability.metricId);
      if (comparison) {
        return [
          {
            id: `${localMetric}__current`,
            kind: 'metric_value',
            metricId: metricCapability.metricId,
            periodId: 'current',
          },
          {
            id: `${localMetric}__previous_year`,
            kind: 'metric_value',
            metricId: metricCapability.metricId,
            periodId: 'previous_year',
          },
          {
            id: `${localMetric}__delta`,
            kind: 'delta',
            metricId: metricCapability.metricId,
          },
          {
            id: `${localMetric}__percent_delta`,
            kind: 'percent_delta',
            metricId: metricCapability.metricId,
          },
        ];
      }
      return [{
        id: localMetric,
        kind: 'metric_value',
        metricId: metricCapability.metricId,
        ...(timeContext?.periods[0]?.id ? { periodId: timeContext.periods[0].id } : {}),
      }];
    },
  );
  const requestedOutputs: AnalyticalQuestionFrameV2['requestedOutputs'] = [
    ...grouped.map((dimension) => ({
      id: localId(dimension.dimensionId),
      kind: 'dimension' as const,
    })),
    ...projectedTimeDimensions.map((dimension) => ({
      id: dimension.outputId,
      kind: 'dimension' as const,
    })),
    ...metricOutputs,
  ];

  return {
    version: 2,
    interpretedQuestion: input.question.trim(),
    questionType: meaningType === 'value' ? 'scalar' : meaningType,
    metricConceptIds: metricCapabilities.map((candidate) => candidate.metricId),
    entityGrainIds,
    dimensions: filteredDimensions,
    memberBindings,
    ...(timeContext ? { timeContext } : {}),
    ...(comparison ? { comparison } : {}),
    ...(ranking ? { ranking } : {}),
    requestedOutputs,
    ambiguity,
  };
}

/**
 * Resolve a selected semantic member through one metric's authored capability
 * contract. Router validation uses this to compose a persisted metric frame
 * with a selected display/grouping field without treating the field itself as
 * a metric meaning.
 */
export function resolveMetricCapabilityDimension(
  metricCandidate: AgentEvidenceCandidate,
  selectedDimensionId: string,
): MetricCapabilityContract['dimensions'][number] | undefined {
  const capability = normalizeMetricCapabilityContract(metricCandidate.analyticalCapability);
  return capability ? resolveExactCapabilityDimension(selectedDimensionId, capability) : undefined;
}

/**
 * Prove the narrowly-scoped same-snapshot MetricFlow extension contract.
 *
 * This is intentionally a pure capability check shared by the router,
 * frozen-plan compiler gate, and Ask workspace admission.  An extension is
 * not a lexical synonym: it is valid only when the currently eligible metric
 * declares the exact (or protocol-alias-equivalent) semantic member as a
 * `group_by` dimension in its normalized capability.  Keeping this one proof
 * in front of every authority boundary prevents an old, mismatched, or
 * hand-shaped card from entering the planner package and later looking like
 * compiler-approved evidence.
 */
export function proveSameSnapshotMetricflowRoleExtensionV1(input: {
  candidate: AgentEvidenceCandidate;
  metricCandidate: AgentEvidenceCandidate;
}): {
  capability: MetricCapabilityContract;
  dimension: MetricCapabilityContract['dimensions'][number];
} | undefined {
  const { candidate, metricCandidate } = input;
  const extension = candidate.sameSnapshotRoleExtension;
  if (!extension
    || extension.version !== 1
    || extension.role !== 'categorical_dimension'
    || (extension.basis !== 'sole_metricflow_grouping_dimension'
      && extension.basis !== 'exact_metricflow_grouping_dimension')
    || !extension.requestedTerm.trim()
    || !extension.metricId.trim()
    || !extension.dimensionId.trim()
    || candidate.kind !== 'semantic_member'
    || (candidate.semanticObjectType !== undefined && candidate.semanticObjectType !== 'dimension')
    || candidate.eligible === false
    || candidate.compatibility === 'incompatible'
    || metricCandidate.kind !== 'semantic_metric'
    || metricCandidate.eligible === false
    || metricCandidate.compatibility === 'incompatible') return undefined;

  const capability = normalizeMetricCapabilityContract(metricCandidate.analyticalCapability);
  if (!capability) return undefined;
  const metricAuthorityIds = new Set([
    metricCandidate.id,
    metricCandidate.qualifiedId,
    capability.metricId,
    ...capability.measureIds,
  ].filter((id): id is string => Boolean(id)));
  if (!metricAuthorityIds.has(extension.metricId)) return undefined;

  const candidateIdentity = candidate.qualifiedId ?? candidate.id;
  if (!sameCapabilityDimensionIdentity(candidateIdentity, extension.dimensionId)) return undefined;
  const dimension = resolveExactCapabilityDimension(extension.dimensionId, capability);
  if (!dimension
    || !sameCapabilityDimensionIdentity(dimension.dimensionId, extension.dimensionId)
    || !dimension.supportedRoles.includes('group_by')) return undefined;
  return { capability, dimension };
}

function resolveDimensionTerm(requested: string, capability: MetricCapabilityContract, candidates: AgentEvidenceCandidate[]): MetricCapabilityContract['dimensions'] {
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== 'semantic_member') continue;
    const terms = [candidate.name, ...(candidate.aliases ?? []), candidate.qualifiedId ?? '', candidate.id].map(normalize).filter(Boolean);
    if (terms.some((term) => termsMatch(term, requested))) {
      candidateIds.add(candidate.qualifiedId ?? candidate.id);
    }
  }
  return capability.dimensions.filter((dimension) => dimensionMatchesTerm(dimension, requested) || candidateIds.has(dimension.dimensionId));
}

function resolveCapabilityDimension(id: string, capability: MetricCapabilityContract): MetricCapabilityContract['dimensions'][number] | undefined {
  // A server-issued clarification can render the capability child under the
  // stable display namespace `semantic:uncategorized:dimension:` while the
  // same snapshot's executable contract stores its canonical
  // `semantic:dimension:` identity.  This is an exact protocol alias, not a
  // leaf-name fallback: normalize only that namespace and require equality
  // with a dimension declared by the selected metric capability.  It keeps a
  // persisted display choice usable after reload without allowing a client to
  // substitute a same-named field from another model.
  const canonicalId = canonicalCapabilityDimensionId(id);
  return capability.dimensions.find((dimension) =>
    dimension.dimensionId === canonicalId
    || dimensionMatchesTerm(dimension, normalize(id)));
}

function resolveExactCapabilityDimension(
  id: string,
  capability: MetricCapabilityContract,
): MetricCapabilityContract['dimensions'][number] | undefined {
  const exactId = id.trim();
  const canonicalId = canonicalCapabilityDimensionId(exactId);
  return capability.dimensions.find((dimension) =>
    dimension.dimensionId === exactId
    || dimension.dimensionId === canonicalId
    // The local manifest adapter may retain the display namespace on the
    // capability itself while a persisted structured option carries the
    // executable namespace (or vice versa). Both normalize to the same
    // protocol identity; no leaf-name or cross-model fallback is allowed.
    || canonicalCapabilityDimensionId(dimension.dimensionId) === canonicalId);
}

/**
 * A same-snapshot MetricFlow extension is an exact server-side binding from
 * a business term (for example `region`) to one declared capability child
 * (for example `locations.location_name`). Once that child was selected and
 * revalidated above, do not reopen the raw word match merely because the
 * authored field label does not literally contain "region". This is limited
 * to the persisted extension contract and exact capability identity; it is
 * not a geographic synonym or a cross-model fallback.
 */
function selectedSameSnapshotDimensionBindsRequestedTerm(input: {
  dimension: MetricCapabilityContract['dimensions'][number];
  requested: string;
  candidates: AgentEvidenceCandidate[];
}): boolean {
  const requested = normalize(input.requested);
  if (!requested) return false;
  return input.candidates.some((candidate) => {
    const extension = candidate.sameSnapshotRoleExtension;
    if (!extension
      || extension.version !== 1
      || extension.role !== 'categorical_dimension'
      || normalize(extension.requestedTerm) !== requested) return false;
    const candidateIdentity = candidate.qualifiedId ?? candidate.id;
    return sameCapabilityDimensionIdentity(candidateIdentity, input.dimension.dimensionId)
      && sameCapabilityDimensionIdentity(extension.dimensionId, input.dimension.dimensionId);
  });
}

/**
 * Resolve a host-owned entity display requirement only through the selected
 * metric's authored native capability. A bare entity card is not a display
 * field, and an arbitrary categorical attribute such as `customer_type`
 * cannot satisfy `top customers`. If two native display/rank fields match the
 * exact display phrase, retain a genuine typed ambiguity instead of guessing.
 */
function resolveEntityDisplayTerm(input: {
  requested: string;
  entityTerms: string[];
  capability: MetricCapabilityContract;
  rankingRequested: boolean;
}): MetricCapabilityContract['dimensions'] {
  // New semantic indexes expose `display` explicitly, while a compatible
  // older MetricFlow capability may expose only `rank_entity`. Both describe
  // a metric-native entity result role. Do not relax this to every group-by
  // field: a customer type or owner grouping is still not an answer to
  // “top customers”.
  const nativeEntityDimensions = input.capability.dimensions.filter((dimension) =>
    dimension.supportedRoles.includes('group_by')
    && (input.rankingRequested
      ? dimension.supportedRoles.includes('rank_entity')
      : dimension.supportedRoles.includes('display'))
    && (input.entityTerms.length === 0 || input.entityTerms.some((entityTerm) =>
      termsMatch(normalize(dimension.entityId), entityTerm))));
  // A requirement seed can carry the full capability-qualified display
  // identity after local retrieval (`customers.customer_name`).  Prefer that
  // exact identity before the friendly-label matcher below: an older local
  // index may also expose the unscoped display alias (`customer_name`) as a
  // second card, but it is not a second business meaning when the selected
  // capability identifies one exact native child.  This is intentionally an
  // identifier comparison, never a leaf-name fallback across models.
  const normalizedRequested = normalize(input.requested);
  const exactQualifiedMatches = nativeEntityDimensions.filter((dimension) =>
    normalize(dimension.dimensionId) === normalizedRequested
    || (dimension.aliases ?? []).some((alias) => normalize(alias) === normalizedRequested));
  if (exactQualifiedMatches.length > 0) return exactQualifiedMatches;
  const exactDisplayMatches = nativeEntityDimensions.filter((dimension) =>
    dimensionMatchesTerm(dimension, input.requested));
  if (exactDisplayMatches.length > 0) return exactDisplayMatches;

  // `top customers` is host-normalized to the output requirement `customer
  // name`. A legacy capability can still prove that requirement when it has a
  // unique native entity field literally named `customer`. Do not let a
  // broader lexical match turn `customer_type`, `customer_owner`, or
  // `customer_order_number` into that label. If no exact native identity
  // exists, preserve only non-attribute entity alternatives so two genuine
  // authored account paths remain an identifier-bound ambiguity.
  const entityNativeMatches = nativeEntityDimensions.filter((dimension) =>
    input.entityTerms.some((entityTerm) =>
      nativeEntityIdentity(dimension, entityTerm) === 'exact'));
  if (entityNativeMatches.length > 0) return entityNativeMatches;
  return nativeEntityDimensions.filter((dimension) =>
    input.entityTerms.some((entityTerm) =>
      nativeEntityIdentity(dimension, entityTerm) === 'qualified'));
}

function nativeEntityIdentity(
  dimension: MetricCapabilityContract['dimensions'][number],
  entityTerm: string,
): 'exact' | 'qualified' | undefined {
  const normalizedEntity = normalize(entityTerm);
  if (!normalizedEntity) return undefined;
  // Use the field's own label/qualified leaf for the entity-key fallback.
  // Retrieval aliases are deliberately excluded here: an attribute card may
  // carry the broad entity word as a discovery alias (`customer_type` ↔
  // `customer`) but that does not make the attribute the entity display key.
  const identities = [
    dimension.label,
    localId(dimension.dimensionId),
  ].map((value) => value ? normalize(value) : '').filter(Boolean);
  if (identities.some((identity) => identity === normalizedEntity)) return 'exact';
  // A field whose own identity begins with the generic entity name is an
  // attribute of that entity, not its display/rank key. It must not satisfy a
  // request for the entity itself merely because it is the only field left.
  if (identities.some((identity) => identity.startsWith(`${normalizedEntity} `))) return undefined;
  // A qualified authored identity such as `billing account` or `service
  // account` is a genuine alternative entity role. Return it only to create a
  // typed ambiguity when there is no exact native entity key.
  return identities.some((identity) => identity.endsWith(` ${normalizedEntity}`))
    ? 'qualified'
    : undefined;
}

function canonicalCapabilityDimensionId(id: string): string {
  return id.trim().replace(
    /^semantic:uncategorized:dimension:/,
    'semantic:dimension:',
  );
}

function sameCapabilityDimensionIdentity(left: string, right: string): boolean {
  return canonicalCapabilityDimensionId(left) === canonicalCapabilityDimensionId(right);
}

/**
 * Match a requested business dimension against the dimension's own authored
 * label/leaf alias, not its model-qualified namespace.  A metric model named
 * `account_revenue` prefixes every one of its dimensions; treating that
 * prefix as a match for "account" made fiscal period and customer name look
 * like equally valid account display keys.
 */
function dimensionMatchesTerm(
  dimension: MetricCapabilityContract['dimensions'][number],
  requested: string,
): boolean {
  const normalizedRequested = normalize(requested);
  if (!normalizedRequested) return false;
  if (normalize(dimension.dimensionId) === normalizedRequested) return true;
  const identities = [
    dimension.label,
    localId(dimension.dimensionId),
    ...(dimension.aliases ?? []).map(localId),
  ].map((value) => value ? normalize(value) : '').filter(Boolean);
  return identities.some((identity) => termsMatch(identity, normalizedRequested));
}

function phraseAppears(question: string, phrase: string): boolean {
  const questionTokens = new Set(normalize(question).split(' ').map(singularize));
  const significant = phrase
    .split(' ')
    .map(singularize)
    .filter((token) => token.length >= 3 && !['name', 'dimension'].includes(token));
  // Candidate aliases such as `customer name` must not be promoted into a
  // separately requested dimension merely because the question says
  // `customer`.  The host seed already owns the display role. Requiring every
  // meaningful token makes this an explicit phrase-presence check while
  // retaining singular/plural normalization.
  return significant.length > 0 && significant.every((token) => questionTokens.has(token));
}

function termsMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right || left.endsWith(` ${right}`) || right.endsWith(` ${left}`)) return true;
  const leftTokens = new Set(left.split(' ').map(singularize));
  const rightTokens = right
    .split(' ')
    .map(singularize)
    .filter((token) => token.length >= 3);
  return rightTokens.length > 0 && rightTokens.every((token) => leftTokens.has(token));
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singularize(value: string): string {
  return value.length > 3 && value.endsWith('s') ? value.slice(0, -1) : value;
}

function localId(value: string): string {
  return (
    value
      .split(/::|[:./]/)
      .filter(Boolean)
      .at(-1) ?? value
  );
}

function inferTimeGrain(question: string): string | undefined {
  if (/\b(today|day|daily)\b/i.test(question)) return 'day';
  if (/\b(week|weekly)\b/i.test(question)) return 'week';
  if (/\b(month|monthly|mtd)\b/i.test(question)) return 'month';
  if (/\b(quarter|quarterly)\b/i.test(question)) return 'quarter';
  if (/\b(year|yearly|annual|yoy)\b/i.test(question)) return 'year';
  return undefined;
}

function explicitTimeGrain(value: string | undefined): 'day' | 'week' | 'month' | 'quarter' | 'year' | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'day'
    || normalized === 'week'
    || normalized === 'month'
    || normalized === 'quarter'
    || normalized === 'year'
    ? normalized
    : undefined;
}

/**
 * The parser can represent an explicit time range without preserving every
 * source token. Keep snapshot-only modifiers out of the physical date-role
 * contract: a bare "current" / "latest" metric should be answered by its
 * authored snapshot semantics, not fabricated into a time-axis request.
 */
function isSnapshotOnlyTimeRange(value: string): boolean {
  return /^(?:current|latest|snapshot|as[ -]?of[ -]?(?:latest|current))$/i.test(value.trim());
}

/**
 * Detect temporal filters in the user's actual wording. `current` by itself
 * deliberately does not match: `current BCM run rate` is a metric qualifier,
 * whereas `current month` and `today` require a date role.
 */
function hasExplicitTemporalFilter(question: string): boolean {
  return /\b(?:today|yesterday)\b|\b(?:this|current|last|previous|past)\s+(?:(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+)?(?:day|days|week|weeks|month|months|quarter|quarters|year|years)\b|\b(?:month|quarter|year)[ -]to[ -]date\b|\b(?:mtd|qtd|ytd|last year|previous year|year over year|yoy)\b|\bfy\s?\d{2,4}\b|\bfiscal\s+year\s+\d{2,4}\b/i.test(question);
}

function extractLimit(question: string): number | undefined {
  const match = /\b(?:top|bottom)\s+(\d{1,4})\b/i.exec(question);
  return match ? Math.max(1, Number(match[1])) : undefined;
}
