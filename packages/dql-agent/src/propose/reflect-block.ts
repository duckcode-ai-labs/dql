/**
 * Reflect-before-certify (P2) — a bounded self-evaluation loop the agent runs on a
 * freshly built block BEFORE it is handed to a human reviewer.
 *
 * DQL's verifier is real: the Certifier rules + a block's own tests/invariants. So
 * "reflect" here is not an LLM second-guessing itself — it is the agent running that
 * verifier, then deterministically REVISING the draft to clear what it safely can,
 * and reporting what it could not (which stays for the human).
 *
 * Two kinds of fix:
 *   1. Output-contract reconciliation (the deepest, only possible WITH an execution
 *      probe): the SQL is the source of truth — align `declaredOutputs` with the
 *      columns the query actually returns, removing phantom outputs and declaring
 *      real ones. This catches the #1 way a "certified" block silently lies.
 *   2. Governance gap-filling: infer grain, default a review cadence, repair an
 *      invalid pattern, etc. — the contract metadata the Certifier checks.
 *
 * What it NEVER auto-fills: `owner`. Owner accountability is the human gate (a block
 * with no owner stays blocking), per the project's AI-drafts/human-certifies rule.
 */

import { Certifier, type CertificationContext } from '@zlens/governance';
import type { InvariantResult } from '@zlens/governance';
import type { BlockRecord, BlockStatus, TestResultSummary } from '@zlens/project';

/** The mutable draft fields the reflection may revise. */
export interface ReflectableDraft {
  slug: string;
  domain: string;
  owner: string;
  description: string;
  grain?: string;
  outputs: string[];
  entities: string[];
  invariants: string[];
  llmContext?: string;
  reviewCadence?: string;
  tags: string[];
  sourceSystems: string[];
  gitPath: string;
  blockType?: 'custom' | 'semantic';
  pattern?: string;
  metricRef?: string;
}

/** Grounded evidence from actually executing the block, when the caller has an executor. */
export interface ExecutionProbe {
  /** Columns the block SQL actually returns — the truth for the output contract. */
  actualColumns?: string[];
  /** Test summary from running the block's tests against real data. */
  tests?: { passed: number; failed: number; assertionCount?: number };
  /** Invariant evaluation against the most recent result. */
  invariantResults?: InvariantResult[];
}

export interface ReflectionFix {
  /** Certifier rule (or 'output-contract') the fix addresses. */
  rule: string;
  /** Human-readable description of what was changed. */
  action: string;
}

export interface BlockReflection {
  /** True when no blocking (error) check remains after the loop. */
  ready: boolean;
  iterations: number;
  fixesApplied: ReflectionFix[];
  remainingBlocking: string[];
  remainingWarnings: string[];
  /** Output-contract reconciliation result, when an execution probe was supplied. */
  outputContract?: { aligned: boolean; phantomOutputs: string[]; undeclaredColumns: string[] };
  /** Tests verdict from the probe, when supplied. */
  testsPassed?: boolean;
  /** Final structured Certifier verdict on the revised draft (for the review header). */
  certification: {
    certified: boolean;
    errors: Array<{ rule: string; message: string }>;
    warnings: Array<{ rule: string; message: string }>;
  };
  /** The revised draft (a copy — the input is not mutated). */
  revised: ReflectableDraft;
}

const MAX_ITERATIONS = 4;
const TIME_DIM_RE = /(_at$|_date$|_time$|_ts$|^date$|^month$|^week$|^day$|ordered_at|created)/i;
const VALID_PATTERNS = new Set([
  'custom',
  'metric_wrapper',
  'entity_profile',
  'entity_rollup',
  'ranking',
  'trend',
  'drilldown',
]);

function draftToRecord(d: ReflectableDraft): BlockRecord {
  const now = new Date();
  return {
    id: d.slug,
    name: d.slug,
    domain: d.domain,
    type: d.blockType ?? 'custom',
    version: '0.1.0',
    status: 'draft' as BlockStatus,
    gitRepo: '',
    gitPath: d.gitPath,
    gitCommitSha: '',
    description: d.description,
    owner: d.owner,
    tags: d.tags,
    dependencies: [],
    usedInCount: 0,
    createdAt: now,
    updatedAt: now,
    llmContext: d.llmContext,
    invariants: d.invariants,
    pattern: d.pattern ?? 'custom',
    metricRef: d.metricRef,
    grain: d.grain,
    entities: d.entities.length > 0 ? d.entities : undefined,
    declaredOutputs: d.outputs.length > 0 ? d.outputs : undefined,
    testAssertions: d.invariants.map((inv) => `assert ${inv}`),
  };
}

function probeToTestSummary(probe: ExecutionProbe | undefined): TestResultSummary | undefined {
  if (!probe?.tests) return undefined;
  const count = probe.tests.assertionCount ?? probe.tests.passed + probe.tests.failed;
  return {
    passed: probe.tests.passed,
    failed: probe.tests.failed,
    skipped: 0,
    duration: 0,
    assertions: Array.from({ length: count }, (_unused, i) => ({
      name: `assert ${i}`,
      passed: i < probe.tests!.passed,
    })) as TestResultSummary['assertions'],
    runAt: new Date(),
  };
}

/** Infer a sensible grain from the draft when one is missing. */
function inferGrain(d: ReflectableDraft): string {
  if (d.pattern === 'metric_wrapper' || d.blockType === 'semantic') {
    const timeCol = d.outputs.find((o) => TIME_DIM_RE.test(o));
    return timeCol ? `${d.metricRef ?? 'metric'} by ${timeCol}` : (d.metricRef ?? 'metric');
  }
  if (d.entities.length > 0) return `one row per ${d.entities[0]}`;
  const timeCol = d.outputs.find((o) => TIME_DIM_RE.test(o));
  if (timeCol) return `one row per ${timeCol}`;
  return 'one row per result';
}

/**
 * Apply the deterministic, SAFE fixes the failed checks call for. Returns the fixes
 * applied this pass; an empty array means no further progress is possible (the loop
 * then stops). Never touches `owner`.
 */
function autoFix(d: ReflectableDraft, failed: Array<{ rule: string; message: string }>): ReflectionFix[] {
  const fixes: ReflectionFix[] = [];
  const has = (needle: string) => failed.some((f) => f.rule.toLowerCase().includes(needle));

  if (has('grain') && (!d.grain || !d.grain.trim())) {
    d.grain = inferGrain(d);
    fixes.push({ rule: 'declares-grain', action: `inferred grain "${d.grain}"` });
  }
  if (has('review cadence') && (!d.reviewCadence || !d.reviewCadence.trim())) {
    d.reviewCadence = 'quarterly';
    fixes.push({ rule: 'declares-review-cadence', action: 'defaulted review cadence to "quarterly"' });
  }
  if (has('llm context') && (!d.llmContext || !d.llmContext.trim())) {
    d.llmContext = d.metricRef
      ? `Answers "${d.slug.replace(/_/g, ' ')}" questions using the governed metric "${d.metricRef}".`
      : `Use this block to answer "${d.slug.replace(/_/g, ' ')}" questions. ${d.description}`.trim();
    fixes.push({ rule: 'has-llm-context', action: 'drafted an llmContext' });
  }
  if (has('tags') && d.tags.length === 0) {
    d.tags = ['proposed', 'ai-build'];
    fixes.push({ rule: 'has-tags', action: 'added default tags' });
  }
  if (has('pattern') && !VALID_PATTERNS.has((d.pattern ?? '').trim())) {
    d.pattern = 'custom';
    fixes.push({ rule: 'valid-block-pattern', action: 'reset invalid pattern to "custom"' });
  }
  // metric_wrapper must bind exactly one metric: bind it if we have one, else demote
  // the pattern so the block is not advertised as a metric wrapper it cannot honor.
  if (has('metric wrapper')) {
    if (d.metricRef && d.blockType !== 'semantic') {
      d.blockType = 'semantic';
      fixes.push({ rule: 'metric-wrapper-contract', action: `bound semantic metric "${d.metricRef}"` });
    } else if (!d.metricRef && d.pattern === 'metric_wrapper') {
      d.pattern = 'custom';
      fixes.push({ rule: 'metric-wrapper-contract', action: 'demoted unbound metric_wrapper to "custom"' });
    }
  }
  // trend must declare a time grain.
  if (has('trend') && d.pattern === 'trend' && !(d.grain && TIME_DIM_RE.test(d.grain))) {
    const timeCol = d.outputs.find((o) => TIME_DIM_RE.test(o));
    if (timeCol) {
      d.grain = `one row per ${timeCol}`;
      fixes.push({ rule: 'trend-contract', action: `set time grain to ${timeCol}` });
    }
  }
  return fixes;
}

/**
 * Reflect on a freshly built draft and revise it in place of a human's first pass.
 * Pure: returns a new draft + a structured report. Pass an {@link ExecutionProbe}
 * (the caller runs the SQL/tests) to unlock output-contract reconciliation and a
 * real tests/invariants verdict — without it, the loop fills governance gaps only.
 */
export function reflectAndReviseBlock(
  draft: ReflectableDraft,
  probe?: ExecutionProbe,
  opts: { maxIterations?: number } = {},
): BlockReflection {
  const fields: ReflectableDraft = {
    ...draft,
    outputs: [...draft.outputs],
    entities: [...draft.entities],
    invariants: [...draft.invariants],
    tags: [...draft.tags],
    sourceSystems: [...draft.sourceSystems],
  };
  const fixesApplied: ReflectionFix[] = [];

  // 1) Output-contract reconciliation — the SQL is the source of truth.
  let outputContract: BlockReflection['outputContract'];
  if (probe?.actualColumns && probe.actualColumns.length > 0) {
    const actual = probe.actualColumns;
    const phantomOutputs = fields.outputs.filter((o) => !actual.includes(o));
    const undeclaredColumns = actual.filter((c) => !fields.outputs.includes(c));
    if (phantomOutputs.length > 0 || undeclaredColumns.length > 0 || fields.outputs.length === 0) {
      fields.outputs = [...actual];
      if (phantomOutputs.length > 0) {
        fixesApplied.push({
          rule: 'output-contract',
          action: `removed phantom outputs not returned by the SQL: ${phantomOutputs.join(', ')}`,
        });
      }
      if (undeclaredColumns.length > 0) {
        fixesApplied.push({
          rule: 'output-contract',
          action: `declared real output columns: ${undeclaredColumns.join(', ')}`,
        });
      }
    }
    outputContract = {
      aligned: phantomOutputs.length === 0 && undeclaredColumns.length === 0,
      phantomOutputs,
      undeclaredColumns,
    };
  }

  // 2) Bounded governance gap-filling loop, grounded by the probe's tests/invariants.
  const testResults = probeToTestSummary(probe);
  const context: CertificationContext | undefined = probe?.invariantResults
    ? { invariantResults: probe.invariantResults }
    : undefined;
  const certifier = new Certifier();
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;

  let iterations = 0;
  let evaluation = certifier.evaluate(draftToRecord(fields), testResults, context);
  while (
    evaluation.errors.length + evaluation.warnings.length > 0 &&
    iterations < maxIterations
  ) {
    const applied = autoFix(fields, [...evaluation.errors, ...evaluation.warnings]);
    if (applied.length === 0) break; // no safe fix left — stop, leave the rest for the human
    fixesApplied.push(...applied);
    iterations += 1;
    evaluation = certifier.evaluate(draftToRecord(fields), testResults, context);
  }

  return {
    ready: evaluation.errors.length === 0,
    iterations,
    fixesApplied,
    remainingBlocking: evaluation.errors.map((e) => `${e.rule}: ${e.message}`),
    remainingWarnings: evaluation.warnings.map((w) => `${w.rule}: ${w.message}`),
    outputContract,
    testsPassed: probe?.tests ? probe.tests.failed === 0 : undefined,
    certification: {
      certified: evaluation.errors.length === 0,
      errors: evaluation.errors,
      warnings: evaluation.warnings,
    },
    revised: fields,
  };
}
