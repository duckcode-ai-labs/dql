/**
 * Impact analysis + re-certification gating for DQL's answer layer.
 *
 * DQL composition is unbounded freeform `ref()`. The safety net: when a block
 * changes, you must know what downstream *certified* work it invalidates.
 *
 * Given changed block name(s) — from `zlens diff` or explicit input — this module:
 *   1. walks the dependency DAG **downstream** to the full transitive set,
 *   2. flags the cross-domain edges that get invalidated,
 *   3. computes the resulting `domainTrust` delta,
 *   4. produces a **required re-cert** list (certified downstream depending on
 *      a changed block's semantics).
 *
 * It also classifies whether a given block change is *semantic* (affects what
 * the block computes) or purely cosmetic (description/owner/tag/viz only).
 * The classification is **conservative**: when unsure, treat the change as
 * semantic so re-cert is required rather than silently skipped.
 *
 * This is the LOCAL engine. It does not manage org-wide workflow, approvals,
 * audit, or auto-re-certification — that is the cloud product.
 */

import type { LineageGraph, LineageNode, LineageEdge } from './lineage-graph.js';
import type { DiffChange, FieldChange } from '../format/diff.js';
import { detectDomainFlows, getDomainTrustOverview } from './domain-lineage.js';

// ---- Semantic-change classification ----

/**
 * Block-diff field paths that are **non-semantic**: they describe or annotate
 * the block but do not change what it computes. A change confined entirely to
 * these fields does not invalidate certification.
 *
 * Everything else (query, params, metric refs, tests, domain, type, business
 * rules, visualization, …) is treated as semantic. This is deliberately a
 * deny-list of known-cosmetic fields rather than an allow-list of semantic
 * ones, so an unrecognized/new field defaults to "semantic" → needs re-cert.
 */
const NON_SEMANTIC_BLOCK_FIELDS = new Set<string>([
  'description',
  'owner',
  'tags',
  'businessOutcome',
  'businessOwner',
  'decisionUse',
  'reviewCadence',
  'caveats',
]);

/** Reason a changed block was (or was not) classified as a semantic change. */
export type SemanticVerdict = 'semantic' | 'non-semantic';

export interface ChangedBlock {
  /** Block name (matches `block:<name>` in the lineage graph). */
  name: string;
  /**
   * Optional exact lineage node id. When omitted, impact analysis keeps the
   * historic block-only behavior and resolves `block:${name}`.
   */
  nodeId?: string;
  /** Whether the change affects what the block computes. */
  verdict: SemanticVerdict;
  /** Field paths that changed (for block-changed diffs). */
  changedFields: string[];
  /** True when the block was added or removed (always semantic). */
  structural: boolean;
}

/**
 * Classify a single block-level `DiffChange` as semantic or non-semantic.
 *
 * - Added/removed blocks are always semantic (structural).
 * - A changed block is non-semantic only when **every** changed field is in
 *   {@link NON_SEMANTIC_BLOCK_FIELDS}. A single unrecognized or semantic field
 *   makes the whole change semantic (conservative default).
 */
export function classifyBlockChange(change: DiffChange): ChangedBlock | null {
  switch (change.kind) {
    case 'block-added':
    case 'block-removed':
      return { name: change.name, verdict: 'semantic', changedFields: [], structural: true };
    case 'block-changed': {
      const fields = change.fields.map((f: FieldChange) => f.path);
      const allCosmetic = fields.length > 0 && fields.every((p) => isNonSemanticField(p));
      return {
        name: change.name,
        verdict: allCosmetic ? 'non-semantic' : 'semantic',
        changedFields: fields,
        structural: false,
      };
    }
    default:
      return null;
  }
}

/** A field path is non-semantic when its leading segment is a known cosmetic field. */
function isNonSemanticField(path: string): boolean {
  // `tags`, `description`, … are top-level; `params.region`, `tests[..]`,
  // `visualization.title`, `query` are semantic. Only the exact known cosmetic
  // field names count as non-semantic.
  return NON_SEMANTIC_BLOCK_FIELDS.has(path);
}

/**
 * Extract the set of changed blocks from a diff report's changes, classifying
 * each as semantic or non-semantic. Non-block changes (dashboards, workbooks,
 * cells, notebooks) are ignored here — impact is keyed off block identity.
 */
export function changedBlocksFromDiff(changes: DiffChange[]): ChangedBlock[] {
  const out: ChangedBlock[] = [];
  for (const change of changes) {
    const classified = classifyBlockChange(change);
    if (classified) out.push(classified);
  }
  return out;
}

// ---- Impact report types ----

export interface ImpactedNode {
  id: string;
  type: string;
  name: string;
  domain?: string;
  status?: string;
  owner?: string;
}

export interface CrossDomainImpact {
  from: string;
  to: string;
  /** Invalidated boundary edges: source feeds a target in another domain. */
  edges: Array<{ source: string; target: string }>;
}

export interface DomainTrustDelta {
  domain: string;
  /** Certified count before vs. after re-cert demotions. */
  certifiedBefore: number;
  certifiedAfter: number;
  total: number;
  trustBefore: number;
  trustAfter: number;
  /** trustAfter - trustBefore (≤ 0). */
  delta: number;
}

export interface RecertItem {
  id: string;
  type: string;
  name: string;
  domain?: string;
  owner?: string;
  status?: string;
  filePath?: string;
  recommendedStatus?: 'pending_recertification';
  /** The changed block(s) whose semantics this artifact transitively depends on. */
  invalidatedBy: string[];
}

export interface ImpactReport {
  /** Changed blocks that were analyzed (semantic + non-semantic). */
  changedBlocks: ChangedBlock[];
  /** Changed blocks with a semantic verdict — only these propagate impact. */
  semanticChanges: string[];
  /** Full transitive downstream set across all semantic changes (excludes domain nodes). */
  downstream: ImpactedNode[];
  /** Cross-domain edges inside the invalidated zone, grouped by from→to. */
  crossDomainImpacts: CrossDomainImpact[];
  /** Certified artifacts that must be re-certified. */
  requiresRecert: RecertItem[];
  /** Per-domain trust delta caused by demoting the re-cert set. */
  domainTrustDelta: DomainTrustDelta[];
  /** True when certified downstream is invalidated and not already pending re-cert. */
  hasCertifiedInvalidation: boolean;
}

// ---- Impact engine ----

export interface ComputeImpactOptions {
  /**
   * When true (default), a re-cert is only required for downstream nodes still
   * marked `certified`. Nodes already `pending_recertification` are reported in
   * the downstream set but do not, on their own, trip the gate — they are
   * already flagged. Set false to also count `pending_recertification`.
   */
  ignoreAlreadyPending?: boolean;
}

/**
 * Compute the impact of a set of changed blocks against a lineage graph.
 *
 * Only blocks with a **semantic** verdict propagate downstream impact; a purely
 * cosmetic change (description/owner/tag only) produces an empty downstream set
 * and never trips the re-cert gate.
 */
export function computeImpact(
  graph: LineageGraph,
  changedBlocks: ChangedBlock[],
  options: ComputeImpactOptions = {},
): ImpactReport {
  const ignoreAlreadyPending = options.ignoreAlreadyPending ?? true;

  const semantic = changedBlocks.filter((b) => b.verdict === 'semantic');
  const semanticNames = semantic.map((b) => b.name);

  // Resolve each changed block to its graph node id. A changed block may not
  // exist in the graph (e.g. removed, or never compiled) — skip those for the
  // downstream walk but keep them in the report.
  const sourceIds: string[] = [];
  const sourceNameById = new Map<string, string>();
  for (const block of semantic) {
    const id = block.nodeId ?? `block:${block.name}`;
    if (graph.getNode(id)) {
      sourceIds.push(id);
      sourceNameById.set(id, block.name);
    }
  }

  // Full transitive downstream union. Track which changed block(s) reach each
  // downstream node so the re-cert list can attribute invalidations precisely.
  const downstreamById = new Map<string, LineageNode>();
  const reachedBy = new Map<string, Set<string>>();
  for (const id of sourceIds) {
    const blockName = sourceNameById.get(id)!;
    for (const node of graph.descendants(id)) {
      if (node.type === 'domain') continue;
      downstreamById.set(node.id, node);
      const set = reachedBy.get(node.id) ?? new Set<string>();
      set.add(blockName);
      reachedBy.set(node.id, set);
    }
  }

  const downstream: ImpactedNode[] = [...downstreamById.values()]
    .map(toImpactedNode)
    .sort((a, b) => a.id.localeCompare(b.id));

  // Cross-domain edges fully contained in the invalidated zone (source = a
  // changed block or a downstream node; target = a downstream node).
  const zoneIds = new Set<string>([...sourceIds, ...downstreamById.keys()]);
  const crossDomainImpacts = collectCrossDomainImpacts(graph, zoneIds);

  // Re-cert list: certified downstream nodes invalidated by a semantic change.
  const requiresRecert: RecertItem[] = [];
  for (const node of downstreamById.values()) {
    if (node.status !== 'certified') {
      if (!(node.status === 'pending_recertification' && !ignoreAlreadyPending)) continue;
    }
    requiresRecert.push({
      id: node.id,
      type: node.type,
      name: node.name,
      domain: node.domain,
      owner: node.owner,
      status: node.status,
      filePath: typeof node.metadata?.filePath === 'string' ? node.metadata.filePath : undefined,
      recommendedStatus: 'pending_recertification',
      invalidatedBy: [...(reachedBy.get(node.id) ?? new Set())].sort(),
    });
  }
  requiresRecert.sort((a, b) => a.id.localeCompare(b.id));

  const domainTrustDelta = computeDomainTrustDelta(graph, requiresRecert);

  return {
    changedBlocks,
    semanticChanges: semanticNames,
    downstream,
    crossDomainImpacts,
    requiresRecert,
    domainTrustDelta,
    hasCertifiedInvalidation: requiresRecert.length > 0,
  };
}

function toImpactedNode(node: LineageNode): ImpactedNode {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    domain: node.domain,
    status: node.status,
    owner: node.owner,
  };
}

/**
 * Collect cross-domain edges whose source and target both lie inside the
 * invalidated zone, grouped by `from → to` domain pair.
 */
function collectCrossDomainImpacts(graph: LineageGraph, zoneIds: Set<string>): CrossDomainImpact[] {
  const byPair = new Map<string, CrossDomainImpact>();
  for (const edge of graph.getCrossDomainEdges()) {
    if (!zoneIds.has(edge.source) || !zoneIds.has(edge.target)) continue;
    const from = edge.sourceDomain ?? graph.getNode(edge.source)?.domain ?? '(unknown)';
    const to = edge.targetDomain ?? graph.getNode(edge.target)?.domain ?? '(unknown)';
    const key = `${from}→${to}`;
    let impact = byPair.get(key);
    if (!impact) {
      impact = { from, to, edges: [] };
      byPair.set(key, impact);
    }
    impact.edges.push({ source: edge.source, target: edge.target });
  }
  return [...byPair.values()].sort((a, b) => `${a.from}→${a.to}`.localeCompare(`${b.from}→${b.to}`));
}

/**
 * Compute the per-domain `domainTrust` delta that results from demoting every
 * re-cert artifact out of `certified`. The "before" view uses the live graph;
 * the "after" view recomputes trust as if each re-cert block were no longer
 * certified (it would become `pending_recertification`).
 *
 * Only block-typed re-cert items affect trust scores, mirroring
 * {@link getDomainTrustOverview} which counts blocks only.
 */
function computeDomainTrustDelta(graph: LineageGraph, requiresRecert: RecertItem[]): DomainTrustDelta[] {
  // Map domain → set of block names losing certified status.
  const demotedByDomain = new Map<string, number>();
  const affectedDomains = new Set<string>();
  for (const item of requiresRecert) {
    const node = graph.getNode(item.id);
    if (!node || node.type !== 'block') continue;
    const domain = node.domain ?? '(unassigned)';
    demotedByDomain.set(domain, (demotedByDomain.get(domain) ?? 0) + 1);
    affectedDomains.add(domain);
  }

  const deltas: DomainTrustDelta[] = [];
  for (const domain of affectedDomains) {
    const overview = getDomainTrustOverview(graph, domain);
    const total = overview.totalBlocks;
    const certifiedBefore = overview.certified;
    const demoted = demotedByDomain.get(domain) ?? 0;
    const certifiedAfter = Math.max(0, certifiedBefore - demoted);
    const trustBefore = total > 0 ? certifiedBefore / total : 0;
    const trustAfter = total > 0 ? certifiedAfter / total : 0;
    deltas.push({
      domain,
      certifiedBefore,
      certifiedAfter,
      total,
      trustBefore,
      trustAfter,
      delta: trustAfter - trustBefore,
    });
  }
  return deltas.sort((a, b) => a.domain.localeCompare(b.domain));
}

// ---- Convenience: full report from a diff ----

/**
 * One-shot helper: classify a diff's block changes and compute the impact
 * report in a single call.
 */
export function computeImpactFromDiff(
  graph: LineageGraph,
  changes: DiffChange[],
  options?: ComputeImpactOptions,
): ImpactReport {
  return computeImpact(graph, changedBlocksFromDiff(changes), options);
}

// ---- Text rendering ----

/** Render an impact report as human-readable text for the CLI. */
export function renderImpactText(report: ImpactReport): string {
  const lines: string[] = [];
  lines.push('  Impact Analysis');
  lines.push('  ' + '='.repeat(50));

  if (report.changedBlocks.length === 0) {
    lines.push('');
    lines.push('  No block changes detected.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('  Changed blocks:');
  for (const block of report.changedBlocks) {
    const tag = block.structural
      ? '(structural)'
      : block.verdict === 'non-semantic'
        ? '(non-semantic — no re-cert)'
        : '(semantic)';
    lines.push(`    ${block.name} ${tag}`);
  }

  lines.push('');
  lines.push(`  Transitive downstream affected: ${report.downstream.length}`);
  for (const node of report.downstream) {
    const badge = node.status === 'certified' ? ' [certified]' : node.status ? ` [${node.status}]` : '';
    const domain = node.domain ? ` (${node.domain})` : '';
    lines.push(`    - ${node.type}:${node.name}${domain}${badge}`);
  }

  if (report.crossDomainImpacts.length > 0) {
    lines.push('');
    lines.push('  Cross-domain edges invalidated:');
    for (const impact of report.crossDomainImpacts) {
      lines.push(`    ${impact.from} -> ${impact.to} (${impact.edges.length} edge(s))`);
    }
  }

  if (report.domainTrustDelta.length > 0) {
    lines.push('');
    lines.push('  domainTrust delta:');
    for (const d of report.domainTrustDelta) {
      const before = (d.trustBefore * 100).toFixed(0);
      const after = (d.trustAfter * 100).toFixed(0);
      const pts = (d.delta * 100).toFixed(0);
      lines.push(
        `    ${d.domain}: ${d.certifiedBefore}/${d.total} -> ${d.certifiedAfter}/${d.total} certified ` +
          `(${before}% -> ${after}%, ${pts} pts)`,
      );
    }
  }

  lines.push('');
  if (report.requiresRecert.length > 0) {
    lines.push(`  Requires re-certification (${report.requiresRecert.length}):`);
    for (const item of report.requiresRecert) {
      const owner = item.owner ? ` — ${item.owner}` : '';
      lines.push(`    ! ${item.name}${item.domain ? ` (${item.domain})` : ''}${owner}`);
      lines.push(`        invalidated by: ${item.invalidatedBy.join(', ')}`);
    }
  } else {
    lines.push('  No certified downstream invalidated. Re-cert not required.');
  }

  return lines.join('\n');
}
