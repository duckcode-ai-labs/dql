/**
 * `zlens propose` engine — turn dbt evidence into a ranked queue of DRAFT blocks.
 *
 * Product principle: **AI drafts, humans certify.** A new user should not author
 * DQL from a blank file. This engine scans dbt artifacts and proposes a draft
 * governance layer: one `block` per high-value model, born `status: draft`, run
 * through the Certifier (results stored so a reviewer sees "what's missing to
 * certify"), and demand-ranked by downstream value.
 *
 * Hard rules enforced here:
 *   - Nothing is ever emitted with `status: certified`. Promotion is a separate
 *     human action (`zlens certify --from-draft`).
 *   - Re-running is idempotent: an existing draft / certified / review block for
 *     the same model is never overwritten or duplicated.
 *   - Inference is conservative — grain/pattern/outputs are only set when the
 *     evidence is obvious, and invariants are limited to provably-safe checks.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Certifier } from '@zlens/governance';
import type { BlockRecord, BlockStatus } from '@zlens/project';
import {
  loadDbtArtifacts,
  type DbtArtifacts,
  type DbtColumn,
  type DbtModelNode,
} from './dbt-artifacts.js';
import {
  upsertProposedDraft,
  blockSlug,
  type ProposedDraftRecord,
} from './write-draft.js';
import {
  classifyModel,
  type Classification,
  type ClassifierContext,
} from './classify.js';
import {
  resolveProposeConfig,
  type ProposeConfig,
  type ProposeConfigInput,
} from './config.js';
import { buildBusinessQuery, buildMetricWrapperBlocks, deriveBlockFilters } from './generate-sql.js';
import type { EnrichedContent } from './enrich.js';

export interface ProposeOptions {
  projectRoot: string;
  dbtManifestPath: string;
  /** Default owner stamped on drafts (reviewer fills in if blank). */
  owner?: string;
  /**
   * Cap on the number of drafts written in one run. Keeps the queue reviewable
   * on large dbt projects. undefined = no cap.
   */
  limit?: number;
  /**
   * When true, score and rank but do not write any files. Useful for previews.
   */
  dryRun?: boolean;
  /**
   * Set of model/block slugs that already exist in the project (drafts or
   * certified). When omitted, the engine derives it by checking the filesystem.
   * Injectable for tests.
   */
  existingBlockSlugs?: Set<string>;
  /**
   * Optional `propose` config block (from `dql.config.json`). Refines the
   * classifier conventions, bounded selection, and AI-enrichment toggle.
   * Defaults apply for every field when omitted.
   */
  config?: ProposeConfigInput | null;
  /**
   * When provided, restrict generation to exactly these block slugs (the human
   * "approved scope"). Pass 1 classification still scans all models; only the
   * selected, approved slugs are inferred + certified + written. Reuses the
   * same bounded-selection path otherwise.
   */
  onlySlugs?: string[];
  /**
   * Optional pre-computed AI enrichment (keyed by slug), produced asynchronously
   * by the generate path. When present for a slug, its `description`/`llmContext`/
   * `examples` override the deterministic dbt-derived content. The engine never
   * calls a provider itself — enrichment is consumed here as plain data, so
   * `propose()` stays sync, deterministic, and offline-safe.
   */
  enrichedBySlug?: Map<string, EnrichedContent>;
}

export type ProposedPattern =
  | 'entity_profile'
  | 'metric_wrapper'
  | 'entity_rollup'
  | 'trend'
  | 'custom';

export interface ProposalInference {
  pattern: ProposedPattern;
  grain?: string;
  declaredOutputs: string[];
  entities: string[];
  llmContext?: string;
  invariants: string[];
  examples: Array<{ question: string; sql?: string }>;
  tags: string[];
}

export interface ProposalRanking {
  /** Number of dbt models that depend on this model (downstream fan-out). */
  fanOut: number;
  /** Whether a dbt exposure references this model. */
  exposureLinked: boolean;
  /** Recorded runs from run_results.json (0 when unavailable). */
  runCount: number;
  /** Composite score used to order the queue (higher = more valuable). */
  score: number;
}

export interface ProposalResult {
  model: string;
  slug: string;
  domain: string;
  /** Deterministic business-layer classification (business | plumbing | niche). */
  classification: Classification;
  /** Human-readable signals that drove the classification + selection. */
  evidence: string[];
  /** Owner derived from dbt meta, if present. */
  owner?: string;
  inference: ProposalInference;
  ranking: ProposalRanking;
  /** Path written (relative to projectRoot), or undefined when skipped/dry-run. */
  path?: string;
  /** Why a draft was skipped (already exists), if applicable. */
  skipped?: string;
  /** Stored Certifier verdict so a reviewer sees what's missing to certify. */
  certification: {
    certified: false;
    errors: Array<{ rule: string; message: string }>;
    warnings: Array<{ rule: string; message: string }>;
  };
}

export interface ProposeSummary {
  projectName?: string;
  modelsScanned: number;
  /** Models classified `business` by the cascade. */
  businessModels: number;
  /** Models classified `plumbing` and excluded from generation. */
  plumbingExcluded: number;
  /** Semantic metrics discovered in the manifest. */
  metricsFound: number;
  proposalsRanked: number;
  draftsWritten: number;
  draftsSkipped: number;
  /** Resolved propose config used for this run. */
  config: ProposeConfig;
  proposals: ProposalResult[];
}

const TIME_COLUMN_RE = /(^|_)(date|day|week|month|quarter|year|period|ts|time|timestamp|datetime|created_at|updated_at)($|_)/i;
const ID_COLUMN_RE = /(_id|_key|_pk|_sk)$/i;
const MEASURE_COLUMN_RE = /(amount|amt|total|count|qty|quantity|revenue|cost|price|sum|avg|score|value|balance|rate|pct|percent)/i;

/** Choose the effective columns for a model: catalog (typed) ∪ manifest YAML. */
function effectiveColumns(model: DbtModelNode, artifacts: DbtArtifacts): DbtColumn[] {
  const catalog = artifacts.catalogColumns.get(model.uniqueId) ?? [];
  if (catalog.length === 0) return model.columns;
  // Merge descriptions from the YAML columns onto the typed catalog columns.
  const yamlByName = new Map(model.columns.map((c) => [c.name.toLowerCase(), c]));
  return catalog.map((c) => ({
    name: c.name,
    type: c.type ?? yamlByName.get(c.name.toLowerCase())?.type,
    description: c.description ?? yamlByName.get(c.name.toLowerCase())?.description,
  }));
}

/**
 * Infer the row grain conservatively. We only commit to a grain when there is a
 * single obvious identifier column or an explicit primary-key declaration; we
 * never guess composite grains.
 */
function inferGrain(model: DbtModelNode, columns: DbtColumn[]): string | undefined {
  // 1. Explicit primary key in meta/config (dbt convention varies; check both).
  const metaPk = model.meta.primary_key ?? model.meta.grain ?? (model.config.meta as Record<string, unknown> | undefined)?.primary_key;
  if (typeof metaPk === 'string' && metaPk.trim()) return metaPk.trim();
  if (Array.isArray(metaPk) && metaPk.length === 1 && typeof metaPk[0] === 'string') return metaPk[0];

  // 2. A single id/key column → that is the grain.
  const idColumns = columns.filter((c) => ID_COLUMN_RE.test(c.name));
  if (idColumns.length === 1) return idColumns[0].name;

  // 3. A column matching `<entity>_id` where entity == singularized model name.
  const entity = singularize(stripModelPrefix(model.name));
  const named = columns.find((c) => c.name.toLowerCase() === `${entity}_id` || c.name.toLowerCase() === `${entity}_key`);
  if (named) return named.name;

  return undefined;
}

/** Conservative pattern inference from columns + folder + semantic linkage. */
function inferPattern(
  model: DbtModelNode,
  columns: DbtColumn[],
  grain: string | undefined,
  hasSemanticMetric: boolean,
): ProposedPattern {
  if (hasSemanticMetric) return 'metric_wrapper';

  const hasTime = columns.some((c) => TIME_COLUMN_RE.test(c.name));
  const hasMeasure = columns.some((c) => MEASURE_COLUMN_RE.test(c.name));
  const idCount = columns.filter((c) => ID_COLUMN_RE.test(c.name)).length;

  // dim_* with a single grain and no measures → entity_profile.
  if (grain && !hasMeasure && /^(dim_|d_)/i.test(model.name)) return 'entity_profile';
  if (grain && !hasMeasure && idCount === 1) return 'entity_profile';

  // fct_*/agg with a grain + measures → entity_rollup.
  if (grain && hasMeasure && /^(fct_|fact_|f_|agg_)/i.test(model.name)) return 'entity_rollup';

  // Time + measure, no stable single grain → trend.
  if (hasTime && hasMeasure && !grain) return 'trend';

  return 'custom';
}

function inferEntities(model: DbtModelNode, grain: string | undefined): string[] {
  if (!grain) return [];
  // Derive the business entity from the grain column or model name.
  const base = grain.replace(ID_COLUMN_RE, '');
  const entity = base || singularize(stripModelPrefix(model.name));
  return entity ? [entity] : [];
}

/**
 * Build provably-safe, *column-checkable* invariants only. The runtime invariant
 * evaluator only sees a query's result columns, so a `row_count >= 0` invariant is
 * "uncheckable" there (it surfaces as a warning) even though the generated test
 * assertion covers it. We therefore emit only column predicates the evaluator can
 * actually check — when an obvious non-negative measure exists, a `>= 0` guard the
 * reviewer can keep or drop. (Row-count coverage lives in the block's tests.)
 */
function inferInvariants(columns: DbtColumn[]): string[] {
  const invariants: string[] = [];
  const countLike = columns.find((c) => /(^|_)(count|qty|quantity|num_|n_)/i.test(c.name));
  if (countLike) invariants.push(`${countLike.name} >= 0`);
  return invariants;
}

/** Build llmContext + examples from the model description (conservative). */
function buildLlmContext(model: DbtModelNode, columns: DbtColumn[], grain: string | undefined): {
  llmContext?: string;
  examples: Array<{ question: string; sql?: string }>;
} {
  const desc = model.description?.trim();
  const grainSentence = grain ? ` One row per ${grain}.` : '';
  const llmContext = desc
    ? `${desc}${grainSentence}`.trim()
    : undefined;

  // Prefer concrete business questions (better agent grounding + a real eval set)
  // over a generic "what does this contain?". Derived only from observable evidence
  // — the grain entity and an obvious measure column — so we never invent semantics.
  const examples: Array<{ question: string; sql?: string }> = [];
  const entity = singularize(
    ((grain ? grain.replace(/_id$/i, '') : '') || stripModelPrefix(model.name)),
  ).replace(/_/g, ' ').trim();
  const measureColumn =
    columns.find((c) => /(amount|spend|revenue|sales|price|value|cost|total)/i.test(c.name)) ??
    columns.find((c) => /(^|_)(count|qty|quantity|num_|n_)/i.test(c.name));
  const measurePhrase = measureColumn ? measureColumn.name.replace(/_/g, ' ') : undefined;

  if (grain && entity) {
    examples.push({ question: `How many ${pluralize(entity)} are there?` });
    if (measurePhrase) {
      examples.push({ question: `What is the total ${measurePhrase} per ${entity}?` });
    }
  } else if (measurePhrase) {
    examples.push({ question: `What is the total ${measurePhrase}?` });
  } else if (desc) {
    examples.push({ question: `What does the ${stripModelPrefix(model.name).replace(/_/g, ' ')} data cover?` });
  }
  return { llmContext, examples };
}

function inferTags(model: DbtModelNode): string[] {
  const tags = new Set<string>(['proposed', 'from-dbt']);
  for (const tag of model.tags) tags.add(tag);
  if (model.folder) tags.add(model.folder);
  return [...tags];
}

function buildInference(
  model: DbtModelNode,
  artifacts: DbtArtifacts,
  hasSemanticMetric: boolean,
): ProposalInference {
  const columns = effectiveColumns(model, artifacts);
  const grain = inferGrain(model, columns);
  const pattern = inferPattern(model, columns, grain, hasSemanticMetric);
  const { llmContext, examples } = buildLlmContext(model, columns, grain);
  return {
    pattern,
    grain,
    declaredOutputs: columns.map((c) => c.name),
    entities: inferEntities(model, grain),
    llmContext,
    invariants: inferInvariants(columns),
    examples,
    tags: inferTags(model),
  };
}

/**
 * Score a model by DEMAND only: downstream fan-out (primary), exposure linkage,
 * and run frequency. Layer exclusion is now the classifier's job (plumbing is
 * dropped, not penalized), so the score is a non-negative demand signal used to
 * order + cap the selection — folder/name no longer *penalize* the score, which
 * would otherwise push a legitimately-business model below `minScore`. A small
 * positive nudge for mart-style models keeps the most answer-shaped models on
 * top within a domain.
 */
function rankModel(
  model: DbtModelNode,
  fanOut: number,
  exposureLinked: boolean,
  runCount: number,
): ProposalRanking {
  let score = fanOut * 10;
  if (exposureLinked) score += 50;
  score += Math.min(runCount, 20) * 2;
  // Marts/answer-surface models surface first within their domain (nudge only).
  if (model.folder === 'marts' || /^(fct_|dim_|mart_|rpt_)/i.test(model.name)) score += 15;
  return { fanOut, exposureLinked, runCount, score };
}

/** Map our inference into a BlockRecord for the Certifier (status always draft). */
function toBlockRecord(
  slug: string,
  domain: string,
  owner: string,
  model: DbtModelNode,
  inference: ProposalInference,
  gitPath: string,
): BlockRecord {
  const now = new Date();
  const sourceSystems = [model.schema, model.database].filter((v): v is string => Boolean(v));
  return {
    id: slug,
    name: slug,
    domain,
    type: 'custom',
    version: '0.1.0',
    status: 'draft' as BlockStatus,
    gitRepo: '',
    gitPath,
    gitCommitSha: '',
    description: model.description?.trim() || `Draft governance block proposed from dbt model ${model.name}.`,
    owner,
    tags: inference.tags,
    dependencies: model.dependsOn,
    usedInCount: 0,
    createdAt: now,
    updatedAt: now,
    llmContext: inference.llmContext,
    examples: inference.examples.length > 0 ? inference.examples : undefined,
    invariants: inference.invariants,
    pattern: inference.pattern,
    grain: inference.grain,
    entities: inference.entities.length > 0 ? inference.entities : undefined,
    declaredOutputs: inference.declaredOutputs.length > 0 ? inference.declaredOutputs : undefined,
    sourceSystems: sourceSystems.length > 0 ? sourceSystems : undefined,
    // Two tests proposed below match the invariants we emit.
    testAssertions: inference.invariants.map((inv) => `assert ${inv}`),
  };
}

/**
 * Detect blocks that already exist for a model so re-runs never duplicate or
 * overwrite. We check both draft-queue locations and the canonical domain
 * folder for a `<slug>.dql` file.
 */
function deriveExistingSlugs(projectRoot: string, slugs: string[]): Set<string> {
  const existing = new Set<string>();
  for (const slug of slugs) {
    const candidates = [
      join(projectRoot, 'blocks', '_drafts', `${slug}.dql`),
      join(projectRoot, 'blocks', `${slug}.dql`),
    ];
    // Domain-first locations are checked lazily below; we scan the common ones.
    if (candidates.some((p) => existsSync(p))) existing.add(slug);
  }
  return existing;
}

/**
 * A model after the CHEAP pass: classified, domain-assigned, demand-scored.
 * No column inference and no Certifier yet — those are deferred to the bounded
 * selection so a 10k-model manifest costs O(N) cheap work, not O(N) certifies.
 */
interface ScoredCandidate {
  model: DbtModelNode;
  slug: string;
  domain: string;
  owner?: string;
  classification: Classification;
  evidence: string[];
  ranking: ProposalRanking;
}

/** Result of the cheap scan: candidates + the shared signal maps + totals. */
interface ScanResult {
  artifacts: DbtArtifacts;
  config: ProposeConfig;
  metricModels: Set<string>;
  scored: ScoredCandidate[];
  totals: {
    modelsScanned: number;
    businessModels: number;
    plumbingExcluded: number;
    nicheExcluded: number;
    metricsFound: number;
  };
}

/**
 * PASS 1 (cheap, ALL models, O(N), NO Certifier, NO column inference): load
 * artifacts, build the fan-out / exposure / semantic signal maps, then classify
 * + assign domain + score every model. Deterministic and reproducible.
 */
function scanModels(dbtManifestPath: string, config: ProposeConfig): ScanResult {
  const artifacts = loadDbtArtifacts(dbtManifestPath);

  // Downstream fan-out: count edges pointing *into* each model.
  const fanOut = new Map<string, number>();
  for (const model of artifacts.models) {
    for (const dep of model.dependsOn) {
      fanOut.set(dep, (fanOut.get(dep) ?? 0) + 1);
    }
  }
  // Exposure linkage.
  const exposureLinked = new Set<string>();
  for (const exposure of artifacts.exposures) {
    for (const dep of exposure.dependsOn) exposureLinked.add(dep);
  }
  // Models bound to a semantic metric → business + eligible for metric_wrapper.
  const metricModels = new Set<string>();
  for (const metric of artifacts.semanticMetrics) {
    if (metric.model) metricModels.add(metric.model.toLowerCase());
  }

  const classifierCtx: ClassifierContext = { exposureLinked, metricModels, config };

  let businessModels = 0;
  let plumbingExcluded = 0;
  let nicheExcluded = 0;
  const scored: ScoredCandidate[] = [];

  for (const model of artifacts.models) {
    const { classification, domain, owner, evidence } = classifyModel(model, classifierCtx);
    if (classification === 'business') businessModels++;
    else if (classification === 'plumbing') plumbingExcluded++;
    else nicheExcluded++;

    const ranking = rankModel(
      model,
      fanOut.get(model.uniqueId) ?? 0,
      exposureLinked.has(model.uniqueId),
      artifacts.runCounts.get(model.uniqueId) ?? 0,
    );
    scored.push({
      model,
      slug: blockSlug(model.name),
      domain,
      owner,
      classification,
      evidence: enrichEvidence(model, ranking, evidence),
      ranking,
    });
  }

  return {
    artifacts,
    config,
    metricModels,
    scored,
    totals: {
      modelsScanned: artifacts.models.length,
      businessModels,
      plumbingExcluded,
      nicheExcluded,
      metricsFound: artifacts.semanticMetrics.length,
    },
  };
}

/** Add demand signals to the evidence chain for the plan view. */
function enrichEvidence(model: DbtModelNode, ranking: ProposalRanking, evidence: string[]): string[] {
  const out = [...evidence];
  if (ranking.fanOut > 0) out.push(`feeds ${ranking.fanOut} downstream model${ranking.fanOut === 1 ? '' : 's'}`);
  if (ranking.runCount > 0) out.push(`${ranking.runCount} recorded run${ranking.runCount === 1 ? '' : 's'}`);
  return out;
}

/**
 * Select the bounded seed deterministically: business-classified, score ≥
 * minScore, then the top `maxPerDomain` per domain. `niche`/`plumbing` are never
 * selected. When `onlySlugs` is provided, restrict to that approved scope (still
 * business-only — plumbing is never generated even if explicitly requested).
 * Returns selected candidates in stable rank order (score desc, fan-out desc,
 * slug asc) across all domains.
 */
function selectBounded(scan: ScanResult, onlySlugs?: string[]): ScoredCandidate[] {
  const approved = onlySlugs ? new Set(onlySlugs) : undefined;
  const eligible = scan.scored.filter(
    (c) =>
      c.classification === 'business' &&
      c.ranking.score >= scan.config.minScore &&
      (!approved || approved.has(c.slug)),
  );

  // Deterministic order within each domain bucket.
  const ordered = [...eligible].sort(compareCandidates);
  const perDomain = new Map<string, number>();
  const selected: ScoredCandidate[] = [];
  for (const candidate of ordered) {
    const count = perDomain.get(candidate.domain) ?? 0;
    if (count >= scan.config.maxPerDomain) continue;
    perDomain.set(candidate.domain, count + 1);
    selected.push(candidate);
  }
  return selected;
}

function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.ranking.score !== a.ranking.score) return b.ranking.score - a.ranking.score;
  if (b.ranking.fanOut !== a.ranking.fanOut) return b.ranking.fanOut - a.ranking.fanOut;
  return a.slug.localeCompare(b.slug);
}

/**
 * Run the proposal engine end to end: load artifacts, classify (cheap pass),
 * select a bounded business-only seed, then — for the selection ONLY — infer
 * grain/pattern/outputs/invariants and run the Certifier, write drafts, and
 * store verdicts. Returns a deterministic, ranked summary.
 *
 * Plumbing/niche models are EXCLUDED from generation (never written), and the
 * expensive Pass-2 work (inference + Certifier) runs only on the bounded
 * selection — at 10k models this is hundreds of inferences, not thousands.
 */
export function propose(options: ProposeOptions): ProposeSummary {
  const { projectRoot, dbtManifestPath } = options;
  const owner = options.owner ?? '';
  const config = resolveProposeConfig(options.config);

  // ── Pass 1: cheap classify + score over ALL models ───────────────────────
  const scan = scanModels(dbtManifestPath, config);

  // Bounded, business-only selection (honors onlySlugs / approved scope).
  const selection = selectBounded(scan, options.onlySlugs);

  // ── Pass 2: expensive inference + Certifier on the SELECTION only ─────────
  const certifier = new Certifier();
  const proposals: ProposalResult[] = [];

  for (const candidate of selection) {
    const { model, slug, domain, owner: metaOwner, classification, evidence } = candidate;
    const inference = buildInference(model, scan.artifacts, scan.metricModels.has(model.name.toLowerCase()));

    // Build the would-be draft path (matches the draft-writer's resolution).
    const draftRelPath = resolveDraftRelPath(projectRoot, domain, slug);
    const record = toBlockRecord(slug, domain, owner || metaOwner || '', model, inference, draftRelPath);
    const verdict = certifier.evaluate(record);

    proposals.push({
      model: model.name,
      slug,
      domain,
      classification,
      evidence,
      owner: metaOwner,
      inference,
      ranking: candidate.ranking,
      certification: {
        certified: false,
        errors: verdict.errors,
        warnings: verdict.warnings,
      },
    });
  }

  // Rank: score desc, then fan-out desc, then name asc for determinism.
  proposals.sort((a, b) => {
    if (b.ranking.score !== a.ranking.score) return b.ranking.score - a.ranking.score;
    if (b.ranking.fanOut !== a.ranking.fanOut) return b.ranking.fanOut - a.ranking.fanOut;
    return a.slug.localeCompare(b.slug);
  });

  const allSlugs = proposals.map((p) => p.slug);
  const existingSlugs = options.existingBlockSlugs ?? deriveExistingSlugs(projectRoot, allSlugs);

  let draftsWritten = 0;
  let draftsSkipped = 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  for (const proposal of proposals) {
    if (existingSlugs.has(proposal.slug)) {
      proposal.skipped = 'A block for this model already exists; not overwriting.';
      draftsSkipped++;
      continue;
    }
    if (draftsWritten >= limit) {
      proposal.skipped = 'Above --limit; re-run to draft lower-ranked models.';
      draftsSkipped++;
      continue;
    }
    if (options.dryRun) {
      draftsWritten++; // counted as "would write" for the summary
      continue;
    }

    const model = scan.artifacts.models.find((m) => m.name === proposal.model)!;
    // Optional AI enrichment overrides only human-facing content; structure
    // (sql/grain/outputs/invariants) stays deterministic. Falls back to dbt content.
    const enriched = options.enrichedBySlug?.get(proposal.slug);
    const enrichedExamples = enriched?.examples?.length
      ? enriched.examples.map((question) => ({ question }))
      : undefined;

    // Metric-backed model → emit ONE metric-bound semantic block per governed
    // metric it backs. The source stores canonical metrics/dimensions meaning;
    // compiled SQL remains separate execution evidence. Falls back to the custom
    // block below when a model backs no usable measures.
    const metricBlocks = proposal.inference.pattern === 'metric_wrapper'
      ? buildMetricWrapperBlocks(model, scan.artifacts)
      : [];
    if (metricBlocks.length > 0) {
      let firstPath: string | undefined;
      let wroteAny = false;
      for (const mb of metricBlocks) {
        const slug = blockSlug(mb.metricName);
        if (existingSlugs.has(slug)) { draftsSkipped++; continue; }
        const metricRecord: ProposedDraftRecord = {
          slug,
          domain: proposal.domain,
          owner: owner || proposal.owner || '',
          description: mb.description?.trim() || `Governed "${mb.metricName}" metric from dbt model ${proposal.model}.`,
          sql: mb.sql,
          blockType: 'semantic',
          metricRef: mb.metricName,
          dimensions: mb.dimensions,
          pattern: 'metric_wrapper',
          grain: mb.dimensions.length > 0 ? mb.dimensions.join(' + ') : proposal.inference.grain,
          entities: proposal.inference.entities,
          declaredOutputs: [...mb.dimensions, mb.alias],
          // App-ready: the metric's dimensions become dashboard filters.
          ...deriveBlockFilters(mb.dimensions),
          llmContext: `Wraps the governed semantic metric "${mb.metricName}". Use this for "${mb.metricName.replace(/_/g, ' ')}" questions.`,
          invariants: [],
          examples: [{ question: `What is ${mb.metricName.replace(/_/g, ' ')}?` }],
          tags: ['proposed', 'from-dbt', 'metric'],
          reviewCadence: 'quarterly',
          sourceModel: proposal.model,
          sourceSystems: [model.schema, model.database].filter((v): v is string => Boolean(v)),
          certification: { certified: false, errors: [], warnings: [] },
        };
        const written = upsertProposedDraft(projectRoot, metricRecord);
        existingSlugs.add(slug);
        if (written.created) { draftsWritten++; wroteAny = true; firstPath ??= written.path; }
      }
      proposal.path = firstPath;
      if (!wroteAny) {
        proposal.skipped = 'Metric blocks for this model already exist; not overwriting.';
        draftsSkipped++;
      }
      continue;
    }

    const draftRecord: ProposedDraftRecord = {
      slug: proposal.slug,
      domain: proposal.domain,
      owner: owner || proposal.owner || '',
      // A human-authored dbt description is authoritative; AI only fills the gap
      // when dbt has none. (llmContext/examples are templated deterministically, so
      // AI enrichment improves on them when available.)
      description:
        model.description?.trim() ||
        enriched?.description?.trim() ||
        `Draft governance block proposed from dbt model ${proposal.model}.`,
      sql: buildBusinessQuery(model, proposal.inference, scan.artifacts),
      pattern: proposal.inference.pattern,
      grain: proposal.inference.grain,
      entities: proposal.inference.entities,
      declaredOutputs: proposal.inference.declaredOutputs,
      // App-ready: a flat/entity block can be filtered by any of its output columns.
      ...deriveBlockFilters(proposal.inference.declaredOutputs),
      llmContext: enriched?.llmContext ?? proposal.inference.llmContext,
      invariants: proposal.inference.invariants,
      examples: enrichedExamples ?? proposal.inference.examples,
      tags: proposal.inference.tags,
      reviewCadence: 'quarterly',
      sourceModel: proposal.model,
      sourceSystems: [model.schema, model.database].filter((v): v is string => Boolean(v)),
      certification: proposal.certification,
    };
    const written = upsertProposedDraft(projectRoot, draftRecord);
    proposal.path = written.path;
    if (written.created) draftsWritten++;
    else {
      proposal.skipped = 'A block for this model already exists; not overwriting.';
      draftsSkipped++;
    }
  }

  return {
    projectName: scan.artifacts.projectName,
    modelsScanned: scan.totals.modelsScanned,
    businessModels: scan.totals.businessModels,
    plumbingExcluded: scan.totals.plumbingExcluded,
    metricsFound: scan.totals.metricsFound,
    proposalsRanked: proposals.length,
    draftsWritten,
    draftsSkipped,
    config,
    proposals,
  };
}

// ─── Deterministic PLAN (classify → plan → approve) ─────────────────────────

export interface ProposePlanCandidate {
  model: string;
  slug: string;
  score: number;
  classification: Classification;
  owner?: string;
  /** Human-readable signals (e.g. "feeds 2 exposures", "marts/ folder"). */
  evidence: string[];
  /** Optional cheap-pass grain/pattern hints (may be omitted in the plan). */
  grain?: string;
  pattern?: ProposedPattern;
  /**
   * OPTIONAL "transparent preview" fields (spec 14, part A). Left undefined by
   * the cheap `proposePlan()` so the plan stays O(N) and Certifier-free for all
   * candidates. The `/api/propose/preview?slug=` endpoint fills them for ONE
   * candidate by running real SQL generation + the Certifier + (best-effort) AI
   * enrichment, so the UI can show the actual SQL/logic before a human commits.
   */
  sqlPreview?: string;
  description?: string;
  llmContext?: string;
  examples?: string[];
  outputs?: string[];
  certifierVerdict?: { blocking: string[]; warnings: string[]; ready: boolean };
}

export interface ProposePlanDomain {
  name: string;
  owner?: string;
  modelCount: number;
  candidates: ProposePlanCandidate[];
}

export interface ProposePlan {
  totals: {
    modelsScanned: number;
    businessModels: number;
    plumbingExcluded: number;
    metricsFound: number;
  };
  willGenerate: number;
  willSkip: number;
  domains: ProposePlanDomain[];
  /** Resolved propose config used to build the plan. */
  config: ProposeConfig;
}

export interface ProposePlanOptions {
  config?: ProposeConfigInput | null;
  /** When true, omit cheap grain/pattern hints (pure classify-only plan). */
  skipHints?: boolean;
}

/**
 * Build a deterministic PLAN of what `propose` WOULD generate — and writes
 * NOTHING. Reuses the cheap Pass-1 scan + bounded selection so the plan is an
 * exact preview of the generated scope. Grain/pattern hints are cheap and
 * optional (folder/column heuristics, no Certifier). Same input → same plan.
 */
export function proposePlan(
  projectRoot: string,
  dbtManifestPath: string,
  options: ProposePlanOptions = {},
): ProposePlan {
  void projectRoot; // reserved for future per-project overrides; plan writes nothing.
  const config = resolveProposeConfig(options.config);
  const scan = scanModels(dbtManifestPath, config);
  const selection = selectBounded(scan);

  // Group selection into domains (stable order: by domain name asc).
  const byDomain = new Map<string, ScoredCandidate[]>();
  for (const candidate of selection) {
    const list = byDomain.get(candidate.domain) ?? [];
    list.push(candidate);
    byDomain.set(candidate.domain, list);
  }

  const domains: ProposePlanDomain[] = [...byDomain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, candidates]) => {
      const ordered = [...candidates].sort(compareCandidates);
      const owner = ordered.find((c) => c.owner)?.owner;
      return {
        name,
        owner,
        modelCount: ordered.length,
        candidates: ordered.map((c) => toPlanCandidate(c, scan, options.skipHints)),
      };
    });

  return {
    totals: {
      modelsScanned: scan.totals.modelsScanned,
      businessModels: scan.totals.businessModels,
      plumbingExcluded: scan.totals.plumbingExcluded,
      metricsFound: scan.totals.metricsFound,
    },
    willGenerate: selection.length,
    // What we scanned but won't seed: everything that isn't in the bounded
    // selection (plumbing + niche + business beyond the per-domain cap).
    willSkip: scan.totals.modelsScanned - selection.length,
    domains,
    config,
  };
}

/** Cheap plan candidate. Grain/pattern are optional, derived without Certifier. */
function toPlanCandidate(
  candidate: ScoredCandidate,
  scan: ScanResult,
  skipHints?: boolean,
): ProposePlanCandidate {
  const base: ProposePlanCandidate = {
    model: candidate.model.name,
    slug: candidate.slug,
    score: candidate.ranking.score,
    classification: candidate.classification,
    owner: candidate.owner,
    evidence: candidate.evidence,
  };
  if (skipHints) return base;

  // Cheap hints: grain from columns + pattern from semantic/folder heuristics.
  const columns = effectiveColumns(candidate.model, scan.artifacts);
  const grain = inferGrain(candidate.model, columns);
  const hasMetric = scan.metricModels.has(candidate.model.name.toLowerCase());
  const pattern = inferPattern(candidate.model, columns, grain, hasMetric);
  return { ...base, grain, pattern };
}

/** Mirror of the draft-writer's path resolution (for the certifier gitPath). */
function resolveDraftRelPath(projectRoot: string, domain: string, slug: string): string {
  if (domain && existsSync(join(projectRoot, 'domains', domain))) {
    return `domains/${domain}/blocks/_drafts/${slug}.dql`;
  }
  return `blocks/_drafts/${slug}.dql`;
}

// ─── Transparent PLAN PREVIEW for ONE candidate (spec 14, part A) ───────────

export interface ProposePreviewOptions {
  config?: ProposeConfigInput | null;
  /** Default owner for the Certifier verdict (so "Missing owner" is suppressed). */
  owner?: string;
  /**
   * Optional pre-computed AI enrichment for this slug. When present, its
   * description/llmContext/examples override the deterministic dbt-derived
   * content. The engine never calls a provider itself.
   */
  enriched?: EnrichedContent;
}

/**
 * Build the FILLED preview for a single candidate slug: real aggregation/
 * projection SQL (via `buildBusinessQuery`, NOT select-*), declared outputs,
 * description, llmContext, examples, and the Certifier verdict
 * ({ blocking, warnings, ready }). Writes NOTHING.
 *
 * This is the lazy/expensive path: `proposePlan()` stays cheap for all
 * candidates; this runs inference + SQL generation + the Certifier for ONE slug
 * only. Returns `undefined` when the slug is not part of the bounded,
 * business-only selection (so the caller can 404).
 */
export function buildProposePreview(
  projectRoot: string,
  dbtManifestPath: string,
  slug: string,
  options: ProposePreviewOptions = {},
): ProposePlanCandidate | undefined {
  const config = resolveProposeConfig(options.config);
  const scan = scanModels(dbtManifestPath, config);
  const selection = selectBounded(scan);
  const candidate = selection.find((c) => c.slug === slug);
  if (!candidate) return undefined;

  const { model, domain, owner: metaOwner, classification, evidence, ranking } = candidate;
  const hasMetric = scan.metricModels.has(model.name.toLowerCase());
  const inference = buildInference(model, scan.artifacts, hasMetric);

  // Real SQL (aggregation for metric-backed models, narrowed projection otherwise).
  const sqlPreview = buildBusinessQuery(model, inference, scan.artifacts);

  // Certifier verdict for the would-be draft (owner stamped so "Missing owner"
  // is not a phantom strike when an owner is resolvable).
  const draftRelPath = resolveDraftRelPath(projectRoot, domain, slug);
  const owner = options.owner || metaOwner || '';
  const record = toBlockRecord(slug, domain, owner, model, inference, draftRelPath);
  const verdict = new Certifier().evaluate(record);

  // Content: AI enrichment overrides best-effort; else deterministic dbt-derived.
  const description =
    model.description?.trim() ||
    options.enriched?.description?.trim() ||
    `Draft governance block proposed from dbt model ${model.name}.`;
  const llmContext = options.enriched?.llmContext ?? inference.llmContext;
  const examples = options.enriched?.examples?.length
    ? options.enriched.examples
    : inference.examples.map((ex) => ex.question);

  return {
    model: model.name,
    slug,
    score: ranking.score,
    classification,
    owner: metaOwner,
    evidence,
    grain: inference.grain,
    pattern: inference.pattern,
    sqlPreview,
    description,
    llmContext,
    examples,
    outputs: inference.declaredOutputs,
    certifierVerdict: {
      blocking: verdict.errors.map((e) => e.message),
      warnings: verdict.warnings.map((w) => w.message),
      ready: verdict.errors.length === 0,
    },
  };
}

// ---- small word helpers (intentionally minimal — no NLP dependency) ----

function stripModelPrefix(name: string): string {
  return name.replace(/^(stg_|int_|fct_|fact_|f_|dim_|d_|agg_|mart_|rpt_)/i, '');
}

function singularize(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/ses$/i.test(word)) return word.replace(/es$/i, '');
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.replace(/s$/i, '');
  return word;
}

function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies');
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}
