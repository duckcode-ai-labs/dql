import {
  composeEffectiveTrust,
  type DataStateLike,
  type ResolvedTrustLabel,
  type TrustLabelId,
} from '@zlens/core';

export interface TrustStampableAnswer {
  kind?: string;
  sourceTier?: string;
  certification?: string;
  reviewStatus?: string;
  /**
   * Certification of the governed semantic metric behind a Lane-2 answer, when
   * that answer was compiled deterministically from the metric. A certified
   * metric elevates the ANSWER to 'reviewed' (verified) — never 'certified',
   * because certification of an answer is a human act (the metric was certified
   * by a human; the answer is a fresh compile of it).
   */
  semanticMetricCertification?: string;
  block?: {
    dataState?: DataStateLike;
  };
}

/**
 * Canonical answer-loop trust mapping. Keep the legacy answer fields as-is, but
 * derive the shared dql-core trust label id from one place so every cascade lane
 * can stamp the same vocabulary at the same exit point.
 */
export function trustLabelIdForAnswer(result: TrustStampableAnswer): TrustLabelId {
  if (result.kind === 'no_answer') return 'insufficient_context';
  if (result.sourceTier === 'business_context' && result.reviewStatus === 'certified') return 'reviewed';
  if (result.certification === 'certified' || result.kind === 'certified') return 'certified';
  // A deterministic compile from a certified/reviewed governed metric is verified
  // ('reviewed'), above plain generated SQL but below human-certified.
  if (
    result.sourceTier === 'semantic_layer' &&
    (result.semanticMetricCertification === 'certified' || result.semanticMetricCertification === 'reviewed')
  ) {
    return 'reviewed';
  }
  if (
    result.certification === 'ai_generated' ||
    result.certification === 'analyst_review_required' ||
    result.reviewStatus === 'analyst_review_required' ||
    result.reviewStatus === 'draft_ready'
  ) {
    return 'ai_generated';
  }
  return 'insufficient_context';
}

export function stampTrustLabel(result: TrustStampableAnswer): ResolvedTrustLabel {
  const id = trustLabelIdForAnswer(result);
  const dataState = id === 'certified' ? result.block?.dataState : undefined;
  return composeEffectiveTrust({ id, dataState });
}
