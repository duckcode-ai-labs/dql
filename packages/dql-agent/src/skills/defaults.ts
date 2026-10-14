/**
 * Default starter Skills (spec 16) — `seedDefaultSkills` writes three EDITABLE
 * starters into `skills/`, idempotently (it NEVER clobbers a file the user
 * has edited). The starters are:
 *
 *   (a) Metrics glossary  — pre-filled from the semantic layer (MetricFlow
 *       metrics → vocabulary + preferred_metrics).
 *   (b) SQL conventions   — prefer {{ ref() }} / qualified relations, exclude
 *       test/internal accounts, one-row-per-grain, prefer certified blocks.
 *   (c) Domain rules      — a commented template for the team to fill in.
 *
 * Idempotency is by file existence: a starter is only written when its
 * `.skill.md` does not already exist. Re-running `seedDefaultSkills` after a
 * user edits a starter is a no-op for that file.
 */

import { existsSync } from 'node:fs';
import {
  loadProjectConfig,
  resolveSemanticLayerWithDiagnostics,
  type SemanticLayer,
} from '@zlens/core';
import { skillPath, writeSkill, type Skill, type WriteSkillInput } from './loader.js';

export interface SeedDefaultSkillsOptions {
  /**
   * Explicit semantic layer to source the metrics glossary from. When omitted,
   * the project's configured semantic layer is loaded (best-effort).
   */
  semanticLayer?: SemanticLayer;
}

export interface SeedDefaultSkillsResult {
  /** Skills written this run (did not already exist). */
  created: Skill[];
  /** Starter ids skipped because their file already existed. */
  skipped: string[];
}

interface MetricLike {
  name: string;
  label?: string;
  description?: string;
}

/** Best-effort load of the project's semantic-layer metrics for the glossary. */
function loadMetrics(projectRoot: string, explicit?: SemanticLayer): MetricLike[] {
  try {
    const layer = explicit ?? resolveProjectSemanticLayer(projectRoot);
    if (!layer) return [];
    const metrics = layer.listMetrics();
    return metrics.map((m) => ({ name: m.name, label: m.label, description: m.description }));
  } catch {
    return [];
  }
}

function resolveProjectSemanticLayer(projectRoot: string): SemanticLayer | undefined {
  const config = loadProjectConfig(projectRoot);
  const semanticConfig = config.semanticLayer?.provider
    ? (config.semanticLayer as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0])
    : config.semanticLayer?.path
      ? { provider: 'dql' as const, path: config.semanticLayer.path }
      : undefined;
  const configured = resolveSemanticLayerWithDiagnostics(semanticConfig, projectRoot).layer;
  if (configured) return configured;
  if (config.dbt?.projectDir) {
    return resolveSemanticLayerWithDiagnostics(
      { provider: 'dbt', projectPath: config.dbt.projectDir },
      projectRoot,
    ).layer ?? undefined;
  }
  return undefined;
}

/** (a) Metrics glossary, pre-filled from the semantic layer. */
function metricsGlossarySkill(metrics: MetricLike[]): WriteSkillInput {
  const vocabulary: Record<string, string> = {};
  for (const metric of metrics) {
    const term = (metric.label && metric.label.trim()) || metric.name;
    vocabulary[term] = `metric:${metric.name}`;
  }
  const bodyLines = [
    '# Metrics glossary',
    '',
    'Business terms map to certified semantic-layer metrics. Prefer these metrics',
    'over ad-hoc SQL aggregations when a question matches one of them.',
    '',
  ];
  if (metrics.length > 0) {
    bodyLines.push('Known metrics:');
    for (const metric of metrics) {
      bodyLines.push(`- **${(metric.label && metric.label.trim()) || metric.name}** (\`${metric.name}\`)${metric.description ? ` — ${metric.description}` : ''}`);
    }
  } else {
    bodyLines.push('_No semantic-layer metrics were found when this glossary was seeded._');
    bodyLines.push('_Add metrics to your semantic layer and re-run `zlens init` to refresh, or edit this file._');
  }
  return {
    id: 'metrics-glossary',
    scope: 'project',
    description: 'Business terms mapped to certified semantic-layer metrics.',
    preferredMetrics: metrics.map((m) => m.name),
    vocabulary,
    body: bodyLines.join('\n'),
    isStarter: true,
  };
}

/** (b) SQL conventions — house rules for grounded, certified-first SQL. */
function sqlConventionsSkill(): WriteSkillInput {
  return {
    id: 'sql-conventions',
    scope: 'project',
    description: 'House SQL conventions for grounded, certified-first analytics.',
    body: [
      '# SQL conventions',
      '',
      'Apply these conventions to all generated SQL:',
      '',
      "- **Reference relations correctly.** In governed BLOCK SQL, reference tables via `{{ ref('<model>') }}`.",
      '  In ad-hoc CELL SQL, use the fully-qualified relation `database.schema.table`. Never a bare model name.',
      '- **Prefer certified blocks.** When a certified block answers the question at the right grain, reuse it',
      '  instead of regenerating SQL.',
      '- **Prove the answer contract before reusing a block.** Decompose the question into metric, grain,',
      '  dimensions, filters, ranking direction, top-N, and required output columns. A certified block is',
      '  trusted only when those pieces match; otherwise use it as context and generate review-required SQL.',
      '- **Preserve follow-up context.** Resolve phrases like "these categories" or "those products" against',
      '  the prior result values, and carry forward the prior measure unless the user asks for a new one.',
      '- **Exclude test / internal accounts *only when a flag column exists in the grounded schema*.**',
      '  If a test/internal flag is present (e.g. an `is_test`, `is_internal`, or `is_test_account` column),',
      '  filter it out unless the question asks for those records. NEVER add a filter on a column that is not',
      '  in the inspected/grounded schema — an invented filter column fails SQL validation.',
      '- **One row per grain.** Make the grain explicit and ensure the query returns exactly one row per grain',
      '  (no accidental fan-out from un-deduplicated joins).',
      '- **Preserve amount semantics and precision.** Aggregate raw DECIMAL/NUMERIC values at their native',
      '  grain; never round, format, or cast to FLOAT/DOUBLE/REAL before SUM/AVG. Apply COALESCE to the',
      '  aggregate and ROUND only the outer final result. Never sum balances, snapshots, rates, ratios,',
      '  lifetime/cumulative values, or already-aggregated metrics across a lower-grain join.',
      '- **Read-only only.** Generate a single `SELECT` / `WITH` query; never DML or DDL.',
    ].join('\n'),
    isStarter: true,
  };
}

/** (c) Domain rules — a commented template for the team to fill in. */
function domainRulesSkill(): WriteSkillInput {
  return {
    id: 'domain-rules',
    scope: 'project',
    description: 'Team-specific domain rules and business logic (template — fill in).',
    body: [
      '# Domain rules',
      '',
      'Fill in the business rules specific to your domain. Examples to replace:',
      '',
      '<!--',
      '- "Active customer" = a customer with an order in the last 90 days.',
      '- Revenue excludes refunds and chargebacks.',
      '- The fiscal year starts in February.',
      '- Region "EMEA" includes the UK.',
      '-->',
      '',
      '_This is a starter template. Edit it with your team\'s definitions; re-running',
      '`zlens init` will not overwrite your changes._',
    ].join('\n'),
    isStarter: true,
  };
}

/** (d) Block authoring — how the agent should draft meaningful, certified-ready blocks. */
function blockAuthoringSkill(): WriteSkillInput {
  return {
    id: 'block-authoring',
    scope: 'project',
    description: 'How the agent should draft meaningful, certified-ready DQL blocks from your data.',
    body: [
      '# Block authoring',
      '',
      'Guidance the agent follows when drafting DQL blocks from dbt + the semantic',
      'layer. Edit it to match how your team models analytics — the agent will adapt.',
      '',
      '- **Lead with semantic metrics.** When a model backs a semantic measure, build a real',
      '  aggregation block (group by the declared grain/dimensions, aggregate the measure) — not `SELECT *`.',
      '- **One business concept per block.** A block answers one clear thing (e.g. "Monthly Revenue",',
      '  "Active Customers"), not "everything in this table".',
      '- **Name by the business term, not the model.** Prefer "Revenue by Month" over `fct_orders`.',
      '- **Make the grain explicit.** State one row per <grain> and keep the SQL at that grain.',
      '- **Declare outputs.** Name the measures/dimensions the block exposes; avoid blind passthroughs.',
      '- **Pick the vital few.** Favor the handful of high-value blocks stakeholders actually ask for',
      '  over one wrapper per dbt model.',
      '- **Write real example questions.** Each block should list 3 concrete business questions it answers.',
      '- **Stay grounded and review-required.** Use only real columns/metrics from the project; every draft',
      '  is reviewed and certified by a human before reuse.',
    ].join('\n'),
    isStarter: true,
  };
}

/**
 * Seed the editable starter skills into `skills/`. Idempotent: a starter is
 * written only when its file does not already exist, so user edits are never
 * clobbered.
 */
export function seedDefaultSkills(
  projectRoot: string,
  options: SeedDefaultSkillsOptions = {},
): SeedDefaultSkillsResult {
  const metrics = loadMetrics(projectRoot, options.semanticLayer);
  const starters: WriteSkillInput[] = [
    metricsGlossarySkill(metrics),
    sqlConventionsSkill(),
    domainRulesSkill(),
    blockAuthoringSkill(),
  ];

  const created: Skill[] = [];
  const skipped: string[] = [];
  for (const starter of starters) {
    if (existsSync(skillPath(projectRoot, starter.id))) {
      skipped.push(starter.id);
      continue;
    }
    created.push(writeSkill(projectRoot, starter));
  }
  return { created, skipped };
}
