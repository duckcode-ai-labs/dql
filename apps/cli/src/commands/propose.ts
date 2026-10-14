/**
 * `zlens propose` — scan dbt evidence and generate a ranked queue of DRAFT blocks.
 *
 * Product principle: **AI drafts, humans certify.** Instead of authoring DQL
 * from a blank file, a new user runs `zlens propose` against an existing dbt repo
 * and gets a draft governance layer: one `block` per high-value model, born
 * `status: draft`, run through the Certifier (verdict stored so a reviewer sees
 * what's missing), demand-ranked, and NEVER auto-certified.
 *
 * Usage:
 *   zlens propose [path]                      Propose drafts for the project at path
 *   zlens propose --dbt-manifest <path>       Explicit manifest.json path
 *   zlens propose --owner <name>              Default owner stamped on drafts
 *   zlens propose --limit <n>                 Cap drafts written this run
 *   zlens propose --plan                      Show the deterministic PLAN; write nothing
 *   zlens propose --dry-run                   Rank only; write nothing
 *   zlens propose --enrich                    AI-enrich content (llmContext/examples/
 *                                           descriptions) via the configured provider
 *   zlens propose --format json               Machine-readable output
 */

import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadProjectConfig, resolveDbtManifestPath } from '@zlens/core';
import { propose, proposePlan, resolveLocalOwner, type ProposeSummary, type ProposePlan, type EnrichedContent } from '@zlens/agent';
import type { CLIFlags } from '../args.js';
import { gatherProposeEnrichment } from '../propose-enrich.js';

export async function runPropose(
  fileArg: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  // --dbt-manifest <path> may arrive in rest (it is not a first-class flag).
  let explicitManifest: string | undefined;
  const dbtIdx = rest.indexOf('--dbt-manifest');
  if (dbtIdx >= 0 && rest[dbtIdx + 1]) explicitManifest = resolve(rest[dbtIdx + 1]);

  // --limit <n> may also arrive in rest.
  let limit: number | undefined;
  const limitIdx = rest.indexOf('--limit');
  if (limitIdx >= 0 && rest[limitIdx + 1]) {
    const value = Number(rest[limitIdx + 1]);
    if (Number.isFinite(value) && value > 0) limit = value;
  }

  const skip = new Set<string>(['--dbt-manifest', explicitManifest, '--limit', rest[limitIdx + 1]].filter(Boolean) as string[]);
  const pathArg = fileArg && !fileArg.startsWith('-') ? fileArg : rest.find((a) => !a.startsWith('-') && !skip.has(a));
  const projectRoot = resolve(pathArg ?? '.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error('No ZLens project found (missing dql.config.json). Run `zlens init` first, then `zlens propose`.');
    process.exitCode = 1;
    return;
  }

  const resolved = resolveDbtManifestPath(projectRoot, explicitManifest);
  if (!resolved) {
    const cfg = loadProjectConfig(projectRoot);
    console.error('\n  ✗ No dbt manifest found.');
    console.error('');
    if (cfg.dbt?.projectDir) {
      console.error(`    dql.config.json points at dbt project: ${cfg.dbt.projectDir}`);
      console.error('    Run `dbt parse` (or `dbt compile`) there first, then re-run `zlens propose`.');
    } else {
      console.error('    Add a "dbt" section to dql.config.json, or pass --dbt-manifest <path>.');
    }
    console.error('');
    process.exitCode = 1;
    return;
  }

  const cfg = loadProjectConfig(projectRoot);
  const proposeConfig = cfg.propose;

  // --plan: deterministic preview (classify → plan). Writes NOTHING.
  const planOnly = Boolean(flags.plan) || rest.includes('--plan');
  if (planOnly) {
    let plan: ProposePlan;
    try {
      plan = proposePlan(projectRoot, resolved, { config: proposeConfig });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  ✗ Plan failed: ${msg}\n`);
      process.exitCode = 1;
      return;
    }
    if (flags.format === 'json') {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    printPlan(plan);
    return;
  }

  // --enrich: opt-in AI enrichment (CLI is deterministic by default for CI
  // reproducibility). Best-effort; no provider → deterministic dbt-derived content.
  const enrich = Boolean((flags as { enrich?: boolean }).enrich) || rest.includes('--enrich');
  let enrichedBySlug: Map<string, EnrichedContent> | undefined;
  if (enrich && !flags.dryRun) {
    if (flags.format !== 'json') console.log('\n  Enriching draft content with AI (best-effort)…');
    enrichedBySlug = await gatherProposeEnrichment(projectRoot, resolved, proposeConfig).catch(() => undefined);
  }

  // Stamp the resolved local OSS owner when --owner is absent so drafts are not
  // born with a "Missing owner" Certifier strike. A dry-run must not persist.
  const owner = flags.owner || resolveLocalOwner(projectRoot, { persist: !flags.dryRun });

  let summary: ProposeSummary;
  try {
    summary = propose({
      projectRoot,
      dbtManifestPath: resolved,
      owner,
      limit,
      dryRun: Boolean(flags.dryRun),
      config: proposeConfig,
      enrichedBySlug,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ✗ Proposal failed: ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const dryRun = Boolean(flags.dryRun);
  console.log('\n  ZLens Propose — drafts from dbt evidence');
  console.log('  ' + '='.repeat(50));
  if (summary.projectName) console.log(`  dbt project:    ${summary.projectName}`);
  console.log(`  Models scanned: ${summary.modelsScanned}`);
  console.log(`  Business:       ${summary.businessModels}  (plumbing excluded: ${summary.plumbingExcluded}, metrics: ${summary.metricsFound})`);
  console.log(`  Selected:       ${summary.proposalsRanked}  (≤ ${summary.config.maxPerDomain} per domain)`);
  console.log(`  Drafts ${dryRun ? 'to write' : 'written'}:  ${summary.draftsWritten}`);
  console.log(`  Skipped:        ${summary.draftsSkipped}`);
  console.log('');
  console.log('  AI drafts, humans certify. Every block is status="draft" and');
  console.log('  was checked by the Certifier (verdict stored in each file).');
  console.log('');

  const shown = summary.proposals.slice(0, 25);
  for (const p of shown) {
    const where = p.path ? p.path : p.skipped ? '(skipped)' : '(ranked)';
    const exposure = p.ranking.exposureLinked ? ' · exposure' : '';
    const runs = p.ranking.runCount > 0 ? ` · ${p.ranking.runCount} run(s)` : '';
    console.log(`  • ${p.model}  [${p.inference.pattern}]  score ${p.ranking.score}`);
    console.log(`    domain ${p.domain} · fan-out ${p.ranking.fanOut}${exposure}${runs}${p.inference.grain ? ` · grain ${p.inference.grain}` : ''}`);
    const blocking = p.certification.errors.length;
    const warnings = p.certification.warnings.length;
    console.log(`    certify gap: ${blocking} blocking, ${warnings} warning(s) → ${where}`);
    if (p.skipped) console.log(`    note: ${p.skipped}`);
  }
  if (summary.proposals.length > shown.length) {
    console.log(`\n  ... and ${summary.proposals.length - shown.length} more.`);
  }
  console.log('');
  console.log('  Next: review the top drafts under blocks/_drafts (or domains/<d>/blocks/_drafts),');
  console.log('  then `zlens certify --from-draft <path> --owner you@example.com` to promote.');
  console.log('');
}

/** Pretty-print the deterministic PLAN (classify → plan, writes nothing). */
function printPlan(plan: ProposePlan): void {
  console.log('\n  ZLens Propose — PLAN (nothing written)');
  console.log('  ' + '='.repeat(50));
  console.log(`  Models scanned:    ${plan.totals.modelsScanned}`);
  console.log(`  Business models:   ${plan.totals.businessModels}`);
  console.log(`  Plumbing excluded: ${plan.totals.plumbingExcluded}`);
  console.log(`  Metrics found:     ${plan.totals.metricsFound}`);
  console.log(`  Will generate:     ${plan.willGenerate}   (≤ ${plan.config.maxPerDomain} per domain)`);
  console.log(`  Will skip:         ${plan.willSkip}`);
  console.log('');
  console.log('  Selective, business-only seed. Plumbing/niche models are excluded.');
  console.log('  Approve the scope, then generate drafts for review (AI drafts, humans certify).');
  console.log('');

  for (const domain of plan.domains) {
    const owner = domain.owner ? ` · owner ${domain.owner}` : '';
    console.log(`  ▸ ${domain.name}  (${domain.modelCount})${owner}`);
    for (const c of domain.candidates) {
      const grain = c.grain ? ` · grain ${c.grain}` : '';
      const pattern = c.pattern ? ` [${c.pattern}]` : '';
      console.log(`    • ${c.model}${pattern}  score ${c.score}${grain}`);
      if (c.evidence.length > 0) console.log(`      why: ${c.evidence.join('; ')}`);
    }
    console.log('');
  }
  console.log('  Run `zlens propose` (without --plan) to write the drafts for this scope.');
  console.log('');
}
