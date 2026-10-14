import type { BlockRecord, TestResultSummary } from '@zlens/project';
import type { GroupingIdentityGap } from '@zlens/core';
import { hasInvariantViolation, type InvariantResult } from './invariant-evaluator.js';

/**
 * Extra signals a certification rule can read beyond the block + test results.
 * Additive and optional so existing rules and callers are unaffected.
 */
export interface CertificationContext {
  /**
   * Results of evaluating the block's declared invariants against the most
   * recent run's result set. Undefined when no run was performed; an empty
   * array means the block declares no invariants.
   */
  invariantResults?: InvariantResult[];
  /**
   * Set when the block's SQL groups by labels only (see `groupingIdentityGapOfSql`
   * in dql-core). Undefined when it was not checked or the grouping is keyed.
   */
  groupingIdentityGap?: GroupingIdentityGap;
}

/**
 * Certification rule that a block must pass to be certified.
 */
export interface CertificationRule {
  id: string;
  name: string;
  description: string;
  severity: 'error' | 'warning';
  check: (
    block: BlockRecord,
    testResults?: TestResultSummary,
    context?: CertificationContext,
  ) => CertificationCheckResult;
}

export interface CertificationCheckResult {
  passed: boolean;
  message?: string;
}

export interface CertificationResult {
  blockId: string;
  blockName: string;
  certified: boolean;
  errors: Array<{ rule: string; message: string }>;
  warnings: Array<{ rule: string; message: string }>;
  checkedAt: Date;
}

/**
 * Built-in certification rules.
 */
export const BUILTIN_RULES: CertificationRule[] = [
  {
    id: 'has-description',
    name: 'Block has description',
    description:
      'Blocks should have a business-facing description. The AI drafts one at build time and the ' +
      'reviewer can edit it — so this is advisory, not a hard gate. Owner accountability is the gate.',
    severity: 'warning',
    check: (block) => ({
      passed: !!block.description && block.description.trim().length > 0,
      message: block.description ? undefined : 'Missing description',
    }),
  },
  {
    id: 'has-owner',
    name: 'Block has owner',
    description: 'Every block must have an accountable owner — the one field a human must confirm to certify',
    severity: 'error',
    check: (block) => ({
      passed: !!block.owner && block.owner.trim().length > 0,
      message: block.owner ? undefined : 'Missing owner',
    }),
  },
  {
    id: 'has-domain',
    name: 'Block has domain',
    description:
      'Blocks should belong to a domain. The draft pipeline assigns one from context (default "misc"), ' +
      'so this is advisory — the reviewer can reassign it without blocking certification.',
    severity: 'warning',
    check: (block) => ({
      passed: !!block.domain && block.domain.trim().length > 0,
      message: block.domain ? undefined : 'Missing domain',
    }),
  },
  {
    id: 'has-tags',
    name: 'Block has tags',
    description: 'Blocks should have at least one tag for discoverability',
    severity: 'warning',
    check: (block) => ({
      passed: block.tags.length > 0,
      message: block.tags.length > 0 ? undefined : 'No tags specified',
    }),
  },
  {
    id: 'has-llm-context',
    name: 'Block has LLM context',
    description:
      'Blocks should carry a one-paragraph NL description so agents can ground answers on them. Adoption is organic — warning only.',
    severity: 'warning',
    check: (block) => {
      const ctx = block.llmContext?.trim();
      return {
        passed: !!ctx && ctx.length > 0,
        message: ctx && ctx.length > 0 ? undefined : 'No llmContext set — agents will fall back to description/SQL',
      };
    },
  },
  {
    id: 'tests-pass',
    name: 'All tests pass',
    description: 'Block tests must all pass for certification',
    severity: 'error',
    check: (_block, testResults) => {
      if (!testResults) {
        return { passed: false, message: 'No test results available' };
      }
      if (testResults.failed > 0) {
        return {
          passed: false,
          message: `${testResults.failed} test(s) failed`,
        };
      }
      return { passed: true };
    },
  },
  {
    id: 'has-tests',
    name: 'Block has tests',
    description: 'Blocks should have at least one test assertion',
    severity: 'warning',
    check: (block, testResults) => {
      const declaredCount = block.testAssertions?.length ?? 0;
      const executedCount = testResults?.assertions.length ?? 0;
      if (declaredCount === 0 && executedCount === 0) {
        return { passed: false, message: 'No test assertions defined' };
      }
      return { passed: true };
    },
  },
  {
    id: 'invariants-hold',
    name: 'Declared invariants hold',
    description:
      "A block's declared invariants must hold against its most recent run's result. " +
      'Warning by default; an error in enterprise mode. Complements tests — does not replace them.',
    severity: 'warning',
    check: (block, _testResults, context) => {
      const declared = block.invariants ?? [];
      if (declared.length === 0) {
        // Blocks without invariants are unaffected — nothing to enforce.
        return { passed: true };
      }
      const results = context?.invariantResults;
      if (!results || results.length === 0) {
        // Invariants are declared but no run produced results to check them
        // against. We cannot assert the guarantees hold, so block certification.
        return {
          passed: false,
          message: 'Invariants are declared but no run result was available to evaluate them',
        };
      }
      const violations = results.filter((entry) => !entry.passed && !entry.uncheckable);
      if (violations.length > 0) {
        return {
          passed: false,
          message: violations
            .map((entry) => `${entry.expr} — ${entry.detail}`)
            .join('; '),
        };
      }
      return { passed: true };
    },
  },
  {
    id: 'groups-by-identity-key',
    name: 'Block groups by an identity key',
    description:
      "Ask serves a block as a certified answer only when its grouping carries an identity key, because two entities can share a label. " +
      'A labels-only block can still be certified and used in Apps, so this is a warning, not a blocker.',
    severity: 'warning',
    check: (_block, _testResults, context) => {
      const gap = context?.groupingIdentityGap;
      return { passed: !gap, message: gap?.message };
    },
  },
  {
    id: 'declares-grain',
    name: 'Block declares grain',
    description: 'Enterprise reusable blocks should declare the row or business grain they answer',
    severity: 'warning',
    check: (block) => ({
      passed: !!block.grain && block.grain.trim().length > 0,
      message: block.grain ? undefined : 'Missing grain metadata',
    }),
  },
  {
    id: 'declares-outputs',
    name: 'Block declares outputs',
    description: 'Enterprise reusable blocks should declare expected output fields for review',
    severity: 'warning',
    check: (block) => ({
      passed: Array.isArray(block.declaredOutputs) && block.declaredOutputs.length > 0,
      message: block.declaredOutputs?.length ? undefined : 'Missing declared outputs',
    }),
  },
  {
    id: 'declares-entities',
    name: 'Block declares entities',
    description: 'Enterprise reusable blocks should declare the business entities represented by the result',
    severity: 'warning',
    check: (block) => ({
      passed: Array.isArray(block.entities) && block.entities.length > 0,
      message: block.entities?.length ? undefined : 'Missing entities metadata',
    }),
  },
  {
    id: 'declares-review-cadence',
    name: 'Block declares review cadence',
    description: 'Enterprise reusable blocks should state how often the logic must be reviewed',
    severity: 'warning',
    check: (block) => ({
      passed: !!block.reviewCadence && block.reviewCadence.trim().length > 0,
      message: block.reviewCadence ? undefined : 'Missing reviewCadence metadata',
    }),
  },
  {
    id: 'valid-block-pattern',
    name: 'Block pattern is valid',
    description: 'Official reusable blocks should use a known DQL pattern when pattern metadata is declared',
    severity: 'warning',
    check: (block) => {
      if (!block.pattern) return { passed: true };
      return {
        passed: isOfficialPattern(block.pattern),
        message: isOfficialPattern(block.pattern) ? undefined : `Unknown block pattern: ${block.pattern}`,
      };
    },
  },
  {
    id: 'entity-profile-contract',
    name: 'Entity profile declares stable entity grain',
    description: 'entity_profile blocks require one business entity, a stable grain, and an identifier output',
    severity: 'warning',
    check: (block) => {
      if (block.pattern !== 'entity_profile') return { passed: true };
      const hasEntity = (block.entities ?? []).length === 1;
      const grain = block.grain ?? '';
      const outputs = block.declaredOutputs ?? [];
      const hasIdentifier = outputs.some((output) => output === grain || /(_id|_key)$/i.test(output));
      return {
        passed: hasEntity && Boolean(grain) && hasIdentifier,
        message: hasEntity && grain && hasIdentifier
          ? undefined
          : 'entity_profile requires exactly one entity, a grain, and an identifier output',
      };
    },
  },
  {
    id: 'metric-wrapper-contract',
    name: 'Metric wrapper binds exactly one semantic metric',
    description: 'metric_wrapper blocks should wrap one dbt MetricFlow metric and optional dimensions',
    severity: 'warning',
    check: (block) => {
      if (block.pattern !== 'metric_wrapper') return { passed: true };
      const metricRefs = semanticMetricRefs(block);
      const passed = metricRefs.length === 1;
      return {
        passed,
        message: passed
          ? undefined
          : 'metric_wrapper requires exactly one semantic metric reference through metric or metrics metadata',
      };
    },
  },
  {
    id: 'entity-rollup-contract',
    name: 'Entity rollup declares entity grain and measures',
    description: 'entity_rollup blocks should aggregate measures to one business entity grain',
    severity: 'warning',
    check: (block) => {
      if (block.pattern !== 'entity_rollup') return { passed: true };
      const hasEntity = (block.entities ?? []).length === 1;
      const grain = block.grain ?? '';
      const outputs = block.declaredOutputs ?? [];
      const hasIdentifier = outputs.some((output) => output === grain || /(_id|_key)$/i.test(output));
      const hasMeasure = outputs.some(isMeasureLikeOutput);
      return {
        passed: hasEntity && Boolean(grain) && hasIdentifier && hasMeasure,
        message: hasEntity && grain && hasIdentifier && hasMeasure
          ? undefined
          : 'entity_rollup requires one entity, a stable entity grain, an identifier output, and at least one measure output',
      };
    },
  },
  {
    id: 'ranking-contract',
    name: 'Ranking declares metric and tie-breaker context',
    description: 'ranking blocks should expose a ranked entity/dimension, metric output, and deterministic ordering context',
    severity: 'warning',
    check: (block) => {
      if (block.pattern !== 'ranking') return { passed: true };
      const outputs = block.declaredOutputs ?? [];
      const hasMetric = outputs.some(isMeasureLikeOutput);
      const hasDimension = Boolean(block.grain) || (block.entities ?? []).length > 0;
      return {
        passed: hasMetric && hasDimension,
        message: hasMetric && hasDimension
          ? undefined
          : 'ranking requires a ranked grain/entity and a metric/rank output',
      };
    },
  },
  {
    id: 'trend-contract',
    name: 'Trend declares time grain',
    description: 'trend blocks should declare a time grain or time output',
    severity: 'warning',
    check: (block) => {
      if (block.pattern !== 'trend') return { passed: true };
      const text = [block.grain, ...(block.declaredOutputs ?? []), ...(block.allowedFilters ?? [])].join(' ');
      const hasTime = /\b(date|day|week|month|quarter|year|period|time)\b/i.test(text);
      return {
        passed: hasTime,
        message: hasTime ? undefined : 'trend requires a time grain, output, or allowed filter',
      };
    },
  },
  {
    id: 'drilldown-contract',
    name: 'Drilldown declares reusable filters',
    description: 'drilldown blocks should expose detail outputs plus filters or parameters inherited from a parent question',
    severity: 'warning',
    check: (block) => {
      if (block.pattern !== 'drilldown') return { passed: true };
      const hasOutputs = (block.declaredOutputs ?? []).length > 0;
      const hasReusableFilterContract = hasFilterOrParameterContract(block);
      return {
        passed: hasOutputs && hasReusableFilterContract,
        message: hasOutputs && hasReusableFilterContract
          ? undefined
          : 'drilldown requires declared detail outputs and at least one allowed filter, parameter policy, or filter binding',
      };
    },
  },
  {
    id: 'parameter-policy-values',
    name: 'Parameter policies are valid',
    description: 'parameterPolicy entries should use supported review-policy values',
    severity: 'warning',
    check: (block) => {
      const invalid = (block.parameterPolicy ?? [])
        .filter((entry) => !isAllowedParameterPolicy(entry.policy))
        .map((entry) => `${entry.name}=${entry.policy}`);
      return {
        passed: invalid.length === 0,
        message: invalid.length === 0
          ? undefined
          : `Unsupported parameter policy value(s): ${invalid.join(', ')}`,
      };
    },
  },
  {
    id: 'filter-binding-contract',
    name: 'Filter bindings map declared filters',
    description: 'filterBindings should map business filters that are declared in allowedFilters',
    severity: 'warning',
    check: (block) => {
      const allowedFilters = new Set((block.allowedFilters ?? []).map((filter) => filter.trim()).filter(Boolean));
      const bindings = block.filterBindings ?? [];
      const unknown = allowedFilters.size === 0
        ? []
        : bindings
          .filter((entry) => !allowedFilters.has(entry.filter))
          .map((entry) => entry.filter);
      const hasUnboundAllowedFilters = allowedFilters.size > 0
        && bindings.length === 0
        && (block.parameterPolicy ?? []).length === 0;
      if (unknown.length > 0) {
        return {
          passed: false,
          message: `filterBindings reference undeclared allowed filter(s): ${[...new Set(unknown)].join(', ')}`,
        };
      }
      return {
        passed: !hasUnboundAllowedFilters,
        message: hasUnboundAllowedFilters
          ? 'allowedFilters requires filterBindings or parameterPolicy so app/dashboard filters can be applied safely'
          : undefined,
      };
    },
  },
  {
    id: 'bridge-review-required',
    name: 'Bridge block declares cross-domain review context',
    description: 'bridge blocks connect domains and must declare both sides plus explicit review metadata',
    severity: 'warning',
    check: (block) => {
      if (block.pattern !== 'bridge') return { passed: true };
      const entities = normalizeList(block.entities);
      const sourceSystems = normalizeList(block.sourceSystems);
      const outputs = normalizeList(block.declaredOutputs);
      const hasTwoSides = entities.length >= 2 || sourceSystems.length >= 2;
      const hasBridgeOutput = outputs.some((output) => /\bbridge|_id$|_key$/i.test(output));
      const hasReviewMetadata = (block.reviewCadence?.trim().length ?? 0) > 0;
      const passed = hasTwoSides && hasBridgeOutput && hasReviewMetadata;
      return {
        passed,
        message: passed
          ? undefined
          : 'bridge requires two source systems or entities, a bridge/id/key output, and explicit review cadence',
      };
    },
  },
  {
    id: 'replacement-declares-predecessor',
    name: 'Replacement declares predecessor',
    description: 'replacement blocks should point at the block or business question they supersede',
    severity: 'warning',
    check: (block) => {
      if (block.pattern !== 'replacement') return { passed: true };
      const passed = (block.replacementFor ?? []).length > 0;
      return {
        passed,
        message: passed ? undefined : 'replacement requires replacementFor metadata',
      };
    },
  },
  {
    id: 'cost-reasonable',
    name: 'Query cost is reasonable',
    description: 'Estimated query cost should be below threshold',
    severity: 'warning',
    check: (block) => {
      if (block.costEstimate == null) return { passed: true };
      if (block.costEstimate > 100) {
        return {
          passed: false,
          message: `Cost estimate ${block.costEstimate} exceeds threshold of 100`,
        };
      }
      return { passed: true };
    },
  },
];

function isOfficialPattern(pattern: string): boolean {
  return new Set([
    'metric_wrapper',
    'entity_profile',
    'entity_rollup',
    'ranking',
    'trend',
    'bridge',
    'drilldown',
    'replacement',
    'custom',
  ]).has(pattern);
}

function semanticMetricRefs(block: BlockRecord): string[] {
  return block.metricsRef?.length ? block.metricsRef : (block.metricRef ? [block.metricRef] : []);
}

function normalizeList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function isMeasureLikeOutput(output: string): boolean {
  const normalized = output.replace(/[_-]+/g, ' ');
  return /\b(total|count|score|points?|revenue|amount|orders?|metric|measure|value|sum|avg|average|rate|pct|percent)\b/i.test(normalized);
}

function hasFilterOrParameterContract(block: BlockRecord): boolean {
  return (block.allowedFilters ?? []).length > 0
    || (block.parameterPolicy ?? []).length > 0
    || (block.filterBindings ?? []).length > 0;
}

function isAllowedParameterPolicy(policy: string): boolean {
  return new Set([
    'dynamic',
    'static',
    'business',
    'derived',
    'optional',
    'ambiguous_review_required',
  ]).has(policy);
}

const ENTERPRISE_REQUIRED_RULE_IDS = new Set([
  'has-description',
  'has-owner',
  'has-domain',
  'tests-pass',
  'has-tests',
  'invariants-hold',
  'declares-grain',
  'declares-outputs',
  'declares-review-cadence',
  'valid-block-pattern',
  'entity-profile-contract',
  'metric-wrapper-contract',
  'entity-rollup-contract',
  'ranking-contract',
  'trend-contract',
  'drilldown-contract',
  'bridge-review-required',
  'replacement-declares-predecessor',
  'parameter-policy-values',
  'filter-binding-contract',
]);

export const ENTERPRISE_RULES: CertificationRule[] = [
  ...BUILTIN_RULES.map((rule): CertificationRule => (
    ENTERPRISE_REQUIRED_RULE_IDS.has(rule.id)
      ? { ...rule, severity: 'error' as const }
      : rule
  )),
  {
    id: 'declares-lineage-context',
    name: 'Block declares lineage context',
    description: 'Enterprise reusable blocks must expose source-system or dependency lineage context',
    severity: 'error',
    check: (block) => {
      const sourceSystems = block.sourceSystems ?? [];
      const dependencies = block.dependencies ?? [];
      const passed = sourceSystems.length > 0 || dependencies.length > 0;
      return {
        passed,
        message: passed ? undefined : 'Missing sourceSystems or dependency lineage metadata',
      };
    },
  },
  {
    id: 'declares-pattern',
    name: 'Block declares reusable pattern',
    description: 'Enterprise reusable blocks must declare an official DQL block pattern',
    severity: 'error',
    check: (block) => {
      const pattern = block.pattern?.trim();
      const passed = Boolean(pattern) && Boolean(pattern && isOfficialPattern(pattern));
      return {
        passed,
        message: passed ? undefined : 'Missing or unknown block pattern',
      };
    },
  },
];

export const PROMOTABLE_RULES: CertificationRule[] = [
  ...BUILTIN_RULES,
  {
    id: 'canonical-git-path',
    name: 'Block is in a canonical Git path',
    description: 'Promotable blocks must not live under draft-only paths',
    severity: 'error',
    check: (block) => ({
      passed: !!block.gitPath && !block.gitPath.includes('/_drafts/') && !block.gitPath.startsWith('blocks/_drafts/'),
      message: block.gitPath ? 'Block is still stored in a draft-only path' : 'Missing Git path',
    }),
  },
  {
    id: 'stable-version',
    name: 'Block has a stable version',
    description: 'Promotable blocks must have a semantic version',
    severity: 'error',
    check: (block) => ({
      passed: /^\d+\.\d+\.\d+$/.test(block.version),
      message: `Version "${block.version}" is not a stable semantic version`,
    }),
  },
];

/**
 * Certifier evaluates blocks against certification rules.
 */
export class Certifier {
  private rules: CertificationRule[];

  constructor(rules?: CertificationRule[]) {
    this.rules = rules ?? BUILTIN_RULES;
  }

  /**
   * Add a custom rule.
   */
  addRule(rule: CertificationRule): void {
    this.rules.push(rule);
  }

  /**
   * Evaluate a block against all rules.
   */
  evaluate(
    block: BlockRecord,
    testResults?: TestResultSummary,
    context?: CertificationContext,
  ): CertificationResult {
    const errors: Array<{ rule: string; message: string }> = [];
    const warnings: Array<{ rule: string; message: string }> = [];

    for (const rule of this.rules) {
      const result = rule.check(block, testResults, context);
      if (!result.passed) {
        const entry = { rule: rule.name, message: result.message ?? rule.description };
        if (rule.severity === 'error') {
          errors.push(entry);
        } else {
          warnings.push(entry);
        }
      }
    }

    return {
      blockId: block.id,
      blockName: block.name,
      certified: errors.length === 0,
      errors,
      warnings,
      checkedAt: new Date(),
    };
  }
}
