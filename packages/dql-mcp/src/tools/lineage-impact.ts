import {
  queryLineage,
  queryCompleteLineagePaths,
  computeImpact,
  type ChangedBlock,
} from '@zlens/core';
import type { DQLContext } from '../context.js';
import { zodInputShapeForTool } from '../tool-schema.js';

const DEFAULT_LINEAGE_NODE_LIMIT = 80;
const DEFAULT_LINEAGE_EDGE_LIMIT = 120;
const DEFAULT_LINEAGE_PATH_LIMIT = 20;
const DEFAULT_IMPACT_ITEM_LIMIT = 50;

export const lineageImpactInput = zodInputShapeForTool('lineage_impact');

export function lineageImpact(
  ctx: DQLContext,
  args: {
    focus: string;
    upstreamDepth?: number;
    downstreamDepth?: number;
    nodeLimit?: number;
    edgeLimit?: number;
    pathLimit?: number;
    paths?: boolean;
    recert?: boolean;
    nonSemantic?: boolean;
  },
) {
  const graph = ctx.lineageGraph;
  let result = queryLineage(graph, {
    focus: args.focus,
    upstreamDepth: args.upstreamDepth,
    downstreamDepth: args.downstreamDepth,
  });

  if (!result.focalNode) {
    // People name a table without its schema or node prefix ("orders" for
    // `table:dev.orders`, `dbt_model:orders`). Use the one node it names.
    const candidates = nodesNamed(graph.getAllNodes(), args.focus);
    if (candidates.length === 1) {
      result = queryLineage(graph, { focus: candidates[0]!.id, upstreamDepth: args.upstreamDepth, downstreamDepth: args.downstreamDepth });
    } else {
      const suggestions = candidates.length > 1
        ? candidates
        : graph.getAllNodes().filter((node) => `${node.id} ${node.name}`.toLowerCase().includes(args.focus.trim().toLowerCase()));
      return {
        error: `No node matches "${args.focus}".${suggestions.length
          ? ` ${candidates.length > 1 ? 'It could be' : 'Close matches'}: ${suggestions.slice(0, 12).map((node) => node.id).join(', ')}. Pass one of these ids as focus.`
          : ' Use an id such as block:<name>, dbt_model:<name>, table:<schema.table> or app:<id>.'}`,
      };
    }
    if (!result.focalNode) return { error: `No node matches "${args.focus}".` };
  }
  const nodeLimit = boundedLimit(args.nodeLimit, DEFAULT_LINEAGE_NODE_LIMIT, 1, 500);
  const edgeLimit = boundedLimit(args.edgeLimit, DEFAULT_LINEAGE_EDGE_LIMIT, 1, 1000);
  const pathLimit = boundedLimit(args.pathLimit, DEFAULT_LINEAGE_PATH_LIMIT, 1, 100);
  const nodes = boundArray(result.graph.nodes, nodeLimit);
  const edges = boundArray(result.graph.edges, edgeLimit);

  const response: Record<string, unknown> = {
    focalNode: result.focalNode,
    nodeCount: result.graph.nodes.length,
    edgeCount: result.graph.edges.length,
    returnedNodeCount: nodes.items.length,
    returnedEdgeCount: edges.items.length,
    nodes: nodes.items,
    edges: edges.items,
    summary: summarizeLineageGraph(result.graph.nodes),
    truncation: {
      nodeLimit,
      edgeLimit,
      nodesTruncated: nodes.truncated,
      edgesTruncated: edges.truncated,
      omittedNodeCount: nodes.omitted,
      omittedEdgeCount: edges.omitted,
    },
  };

  if (args.paths) {
    const paths = queryCompleteLineagePaths(graph, result.focalNode.id, { maxPaths: pathLimit });
    if (paths) {
      const upstreamPaths = boundArray(paths.upstreamPaths, pathLimit);
      const downstreamPaths = boundArray(paths.downstreamPaths, pathLimit);
      response.upstreamPathCount = paths.upstreamPaths.length;
      response.downstreamPathCount = paths.downstreamPaths.length;
      response.upstreamPaths = upstreamPaths.items.map(formatPath);
      response.downstreamPaths = downstreamPaths.items.map(formatPath);
      response.layerSummary = paths.layerSummary;
      response.pathTruncation = {
        pathLimit,
        upstreamPathsTruncated: upstreamPaths.truncated,
        downstreamPathsTruncated: downstreamPaths.truncated,
        omittedUpstreamPathCount: upstreamPaths.omitted,
        omittedDownstreamPathCount: downstreamPaths.omitted,
      };
    }
  }

  // Re-cert impact: treat the focal block as changed and compute the
  // downstream invalidation + required re-cert list. Mirrors the
  // `zlens diff --impact` CLI gate, surfaced structurally for agents.
  if (args.recert) {
    const changed: ChangedBlock = {
      name: result.focalNode.name,
      nodeId: result.focalNode.id,
      verdict: args.nonSemantic ? 'non-semantic' : 'semantic',
      changedFields: [],
      structural: false,
    };
    const impact = computeImpact(graph, [changed]);
    const changedBlocks = boundArray(impact.changedBlocks, DEFAULT_IMPACT_ITEM_LIMIT);
    const semanticChanges = boundArray(impact.semanticChanges, DEFAULT_IMPACT_ITEM_LIMIT);
    const downstream = boundArray(impact.downstream, DEFAULT_IMPACT_ITEM_LIMIT);
    const crossDomainImpacts = boundArray(impact.crossDomainImpacts, DEFAULT_IMPACT_ITEM_LIMIT);
    const requiresRecert = boundArray(impact.requiresRecert, DEFAULT_IMPACT_ITEM_LIMIT);
    const domainTrustDelta = boundArray(impact.domainTrustDelta, DEFAULT_IMPACT_ITEM_LIMIT);
    response.impactSummary = {
      changedBlockCount: impact.changedBlocks.length,
      semanticChangeCount: impact.semanticChanges.length,
      downstreamCount: impact.downstream.length,
      crossDomainImpactCount: impact.crossDomainImpacts.length,
      requiresRecertCount: impact.requiresRecert.length,
      domainTrustDeltaCount: impact.domainTrustDelta.length,
      hasCertifiedInvalidation: impact.hasCertifiedInvalidation,
      itemLimit: DEFAULT_IMPACT_ITEM_LIMIT,
      truncated: changedBlocks.truncated
        || semanticChanges.truncated
        || downstream.truncated
        || crossDomainImpacts.truncated
        || requiresRecert.truncated
        || domainTrustDelta.truncated,
    };
    response.impact = {
      changedBlocks: changedBlocks.items,
      semanticChanges: semanticChanges.items,
      downstream: downstream.items,
      crossDomainImpacts: crossDomainImpacts.items,
      requiresRecert: requiresRecert.items,
      domainTrustDelta: domainTrustDelta.items,
      hasCertifiedInvalidation: impact.hasCertifiedInvalidation,
    };
  }

  return response;
}

function formatPath(path: { nodes: Array<{ id: string; name: string; type: string }>; layers: string[] }) {
  return {
    chain: path.nodes.map((n) => `${n.type}:${n.name}`).join(' → '),
    layers: path.layers,
  };
}

function boundArray<T>(items: T[], limit: number): { items: T[]; truncated: boolean; omitted: number } {
  const bounded = items.slice(0, limit);
  return {
    items: bounded,
    truncated: items.length > bounded.length,
    omitted: Math.max(0, items.length - bounded.length),
  };
}

function boundedLimit(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function summarizeLineageGraph(nodes: Array<{ type: string; domain?: string }>) {
  const byType: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  for (const node of nodes) {
    byType[node.type] = (byType[node.type] ?? 0) + 1;
    if (node.domain) byDomain[node.domain] = (byDomain[node.domain] ?? 0) + 1;
  }
  return { byType, byDomain };
}

/** Nodes a bare name refers to: the id after its type prefix, or the last part of a dotted name. */
function nodesNamed<T extends { id: string; name: string }>(nodes: T[], focus: string): T[] {
  const wanted = focus.trim().toLowerCase();
  if (!wanted) return [];
  const tail = (value: string) => value.toLowerCase().split(':').pop()!.split('.').pop()!;
  const exact = nodes.filter((node) => node.name.toLowerCase() === wanted || node.id.toLowerCase().split(':').slice(1).join(':') === wanted);
  if (exact.length > 0) return exact;
  return nodes.filter((node) => tail(node.id) === wanted || tail(node.name) === wanted);
}
