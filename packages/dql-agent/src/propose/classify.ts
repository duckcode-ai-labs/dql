/**
 * Convention-agnostic, deterministic business-layer classifier for `zlens propose`.
 *
 * Real enterprise dbt repos (1k–10k models) are NOT organized like jaffle-shop:
 * naming conventions vary, folders vary, some teams lean entirely on `meta`. So
 * the classifier uses a weighted CASCADE from the most authoritative signal to
 * the weakest fallback, and records human-readable `evidence` for every decision
 * so a reviewer can see *why* a model was kept or skipped:
 *
 *   1. dbt `meta`          — meta.dql.business (bool), meta.layer/domain/owner
 *   2. exposure linkage    — model feeds a dbt exposure  → business
 *   3. semantic binding    — model backs a MetricFlow metric/measure → business
 *   4. folder / fqn path   — marts/core/reporting ⇒ business; staging/… ⇒ plumbing
 *   5. tags                — mart/reporting/certified vs staging/base
 *   6. name prefix/suffix  — stg_/int_/base_ (LAST RESORT only)
 *
 * `plumbing` models are EXCLUDED from generation (not merely ranked down).
 * `niche` is "not obviously business, not obviously plumbing" — also excluded
 * from the bounded seed, but kept in the plan totals so the count is honest.
 *
 * This module is 100% deterministic: no LLM, reproducible offline, auditable.
 */

import type { DbtModelNode } from './dbt-artifacts.js';
import type { ProposeConfig } from './config.js';

export type Classification = 'business' | 'plumbing' | 'niche';

export interface ClassifierContext {
  /** uniqueIds that feed at least one dbt exposure. */
  exposureLinked: Set<string>;
  /** Lowercased model names that back a semantic metric/measure. */
  metricModels: Set<string>;
  config: ProposeConfig;
}

export interface ClassificationResult {
  classification: Classification;
  /** Resolved domain label for grouping (already cascade-derived). */
  domain: string;
  /** Owner stamped from meta.owner when present. */
  owner?: string;
  /** Human-readable signals that drove the decision (highest-priority first). */
  evidence: string[];
}

// Name prefixes/suffixes are the LAST resort. Kept narrow on purpose.
const PLUMBING_NAME_RE = /^(stg_|int_|base_|raw_)|(_stg|_int|_base)$/i;
const BUSINESS_NAME_RE = /^(dim_|fct_|fact_|mart_|rpt_|report_|agg_)/i;

const BUSINESS_TAGS = new Set(['mart', 'marts', 'reporting', 'certified', 'core', 'curated']);
const PLUMBING_TAGS = new Set(['staging', 'stg', 'base', 'intermediate', 'int', 'raw', 'source']);

function lower(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Read the `dql` sub-object from a model's meta (config.meta is a fallback). */
function dqlMeta(model: DbtModelNode): Record<string, unknown> {
  const direct = asRecord(model.meta.dql);
  if (Object.keys(direct).length > 0) return direct;
  const configMeta = asRecord((model.config as Record<string, unknown>).meta);
  return asRecord(configMeta.dql);
}

function metaString(model: DbtModelNode, key: string): string | undefined {
  const direct = lower(model.meta[key]);
  if (direct) return direct;
  const configMeta = asRecord((model.config as Record<string, unknown>).meta);
  return lower(configMeta[key]);
}

/** Owner from meta.owner / meta.dql.owner (un-lowercased — it's an identity). */
export function metaOwner(model: DbtModelNode): string | undefined {
  const dql = dqlMeta(model);
  const candidates = [dql.owner, model.meta.owner, asRecord((model.config as Record<string, unknown>).meta).owner];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return undefined;
}

/**
 * Resolve a model's domain label deterministically with the same cascade
 * priority as classification: meta.domain → meta.layer/group → folder → fqn.
 * Falls back to the pre-computed `domainHint` from the artifacts reader.
 */
export function resolveDomain(model: DbtModelNode): string {
  const dql = dqlMeta(model);
  const candidate =
    lower(dql.domain) ??
    metaString(model, 'domain') ??
    metaString(model, 'group') ??
    (model.domainHint ? model.domainHint.toLowerCase() : undefined) ??
    (model.folder ? model.folder.toLowerCase() : undefined);
  return normalizeDomain(candidate);
}

function normalizeDomain(value: string | undefined): string {
  const safe = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
  return safe || 'uncategorized';
}

/** True when `token` matches any configured layer token (folder OR tag). */
function matchesLayer(model: DbtModelNode, layers: string[]): boolean {
  const folder = model.folder?.toLowerCase();
  if (folder && layers.includes(folder)) return true;
  const path = model.path?.toLowerCase() ?? '';
  for (const layer of layers) {
    // Path segment match (e.g. "models/reporting/finance/...").
    if (path.includes(`/${layer}/`) || path.startsWith(`${layer}/`)) return true;
  }
  const tags = model.tags.map((t) => t.toLowerCase());
  return layers.some((layer) => tags.includes(layer));
}

/**
 * Classify a single model via the weighted cascade. Returns the classification,
 * the resolved domain, an optional owner, and the evidence chain.
 */
export function classifyModel(model: DbtModelNode, ctx: ClassifierContext): ClassificationResult {
  const evidence: string[] = [];
  const domain = resolveDomain(model);
  const owner = metaOwner(model);
  const config = ctx.config;

  // ── 1. dbt meta (authoritative) ──────────────────────────────────────────
  const dql = dqlMeta(model);
  if (typeof dql.business === 'boolean') {
    evidence.push(`meta.dql.business = ${dql.business}`);
    return { classification: dql.business ? 'business' : 'plumbing', domain, owner, evidence };
  }
  const metaLayer = lower(dql.layer) ?? metaString(model, 'layer');
  if (metaLayer) {
    if (config.businessLayers.includes(metaLayer)) {
      evidence.push(`meta.layer = "${metaLayer}" (business)`);
      return { classification: 'business', domain, owner, evidence };
    }
    if (config.excludeLayers.includes(metaLayer)) {
      evidence.push(`meta.layer = "${metaLayer}" (plumbing)`);
      return { classification: 'plumbing', domain, owner, evidence };
    }
  }

  // ── 2. exposure linkage ──────────────────────────────────────────────────
  if (ctx.exposureLinked.has(model.uniqueId)) {
    evidence.push('feeds a dbt exposure');
    return { classification: 'business', domain, owner, evidence };
  }

  // ── 3. semantic binding ──────────────────────────────────────────────────
  if (ctx.metricModels.has(model.name.toLowerCase())) {
    evidence.push('backs a semantic metric');
    return { classification: 'business', domain, owner, evidence };
  }

  // ── 4. folder / fqn path ─────────────────────────────────────────────────
  if (matchesLayer(model, config.businessLayers)) {
    const folder = model.folder?.toLowerCase();
    evidence.push(folder ? `${folder}/ folder (business layer)` : 'business-layer path');
    return { classification: 'business', domain, owner, evidence };
  }
  if (matchesLayer(model, config.excludeLayers)) {
    const folder = model.folder?.toLowerCase();
    evidence.push(folder ? `${folder}/ folder (plumbing layer)` : 'plumbing-layer path');
    return { classification: 'plumbing', domain, owner, evidence };
  }

  // ── 5. tags ──────────────────────────────────────────────────────────────
  const tags = model.tags.map((t) => t.toLowerCase());
  if (tags.some((t) => BUSINESS_TAGS.has(t))) {
    evidence.push(`tag: ${tags.find((t) => BUSINESS_TAGS.has(t))}`);
    return { classification: 'business', domain, owner, evidence };
  }
  if (tags.some((t) => PLUMBING_TAGS.has(t))) {
    evidence.push(`tag: ${tags.find((t) => PLUMBING_TAGS.has(t))}`);
    return { classification: 'plumbing', domain, owner, evidence };
  }

  // ── 6. name prefix/suffix (LAST RESORT) ──────────────────────────────────
  if (PLUMBING_NAME_RE.test(model.name)) {
    evidence.push(`name pattern "${model.name}" (plumbing prefix)`);
    return { classification: 'plumbing', domain, owner, evidence };
  }
  if (BUSINESS_NAME_RE.test(model.name)) {
    evidence.push(`name pattern "${model.name}" (business prefix)`);
    return { classification: 'business', domain, owner, evidence };
  }

  // No decisive signal → niche (excluded from the bounded seed, but counted).
  evidence.push('no business signal (folder/meta/exposure/semantic/tag/name)');
  return { classification: 'niche', domain, owner, evidence };
}
