/**
 * Multi-granularity lineage graph for DQL's answer layer.
 *
 * Tracks data flow from source tables through blocks, semantic metrics,
 * domains, and charts — the full "trust chain" from raw data to rendered answer.
 */

// ---- Node Types ----

export type LineageNodeType =
  | 'source_table'
  | 'dbt_model'
  | 'dbt_source'
  | 'term'
  | 'block'
  | 'business_view'
  | 'metric'
  | 'dimension'
  | 'domain'
  | 'chart'
  | 'notebook'
  | 'dashboard'
  | 'app';

/** Conceptual layer a node belongs to in the lineage flow. */
export type LineageLayer = 'source' | 'transform' | 'answer' | 'consumption';

/** Map from node type to its default lineage layer. */
const NODE_TYPE_TO_LAYER: Record<LineageNodeType, LineageLayer> = {
  source_table: 'source',
  dbt_source: 'source',
  dbt_model: 'transform',
  term: 'answer',
  block: 'answer',
  business_view: 'answer',
  metric: 'answer',
  dimension: 'answer',
  domain: 'answer',
  chart: 'consumption',
  notebook: 'consumption',
  dashboard: 'consumption',
  app: 'consumption',
};

/** Get the default layer for a node type. */
export function getLayerForNodeType(type: LineageNodeType): LineageLayer {
  return NODE_TYPE_TO_LAYER[type];
}

export interface LineageNode {
  /** Unique identifier (e.g., "block:revenue_by_segment", "metric:total_revenue") */
  id: string;
  type: LineageNodeType;
  name: string;
  /** Conceptual layer in the lineage flow (source → transform → answer → consumption) */
  layer?: LineageLayer;
  /** Business domain this node belongs to */
  domain?: string;
  /** Certification status (for blocks) */
  status?: 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification';
  /** Owner of the block/metric */
  owner?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Optional table-level column metadata */
  columns?: Array<{ name: string; type?: string; description?: string }>;
}

// ---- Edge Types ----

export type LineageEdgeType =
  | 'reads_from'       // block reads from a table
  | 'feeds_into'       // block's output feeds into another block
  | 'defines'          // business term defines a block or business view
  | 'composes'         // block/business view is composed into a business view
  | 'aggregates'       // metric aggregates from a table/block
  | 'visualizes'       // chart visualizes a block/metric
  | 'depends_on'       // dbt model/source dependency edge
  | 'contains'         // dashboard contains a block/chart
  | 'crosses_domain'   // data crosses a domain boundary
  | 'certified_by'     // block certified by a person/process
  | 'replaced_by';     // deprecated block → the block that replaces it (not data flow)

/**
 * True for edges that carry data or composition. `replaced_by` records a
 * retirement, not a dependency, so impact/ancestor/descendant walks skip it.
 */
export function isDataFlowEdge(edge: Pick<LineageEdge, 'type'>): boolean {
  return edge.type !== 'replaced_by';
}

export interface LineageEdge {
  source: string; // node id
  target: string; // node id
  type: LineageEdgeType;
  /** For crosses_domain: source and target domain names */
  sourceDomain?: string;
  targetDomain?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ---- Graph ----

export interface LineageGraphJSON {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export class LineageGraph {
  private nodes = new Map<string, LineageNode>();
  private edges: LineageEdge[] = [];
  /** Outgoing edges: source → edges */
  private outgoing = new Map<string, LineageEdge[]>();
  /** Incoming edges: target → edges */
  private incoming = new Map<string, LineageEdge[]>();

  /** Add a node to the graph. Updates if already exists. */
  addNode(node: LineageNode): void {
    this.nodes.set(node.id, node);
    if (!this.outgoing.has(node.id)) this.outgoing.set(node.id, []);
    if (!this.incoming.has(node.id)) this.incoming.set(node.id, []);
  }

  /** Add an edge to the graph. Deduplicates by source+target+type. */
  addEdge(edge: LineageEdge): void {
    // Deduplicate: skip if an identical edge (same source, target, type) exists
    const existing = this.outgoing.get(edge.source);
    if (existing?.some((e) => e.target === edge.target && e.type === edge.type)) {
      return;
    }

    this.edges.push(edge);

    // Ensure adjacency lists exist even if nodes weren't added explicitly
    if (!this.outgoing.has(edge.source)) this.outgoing.set(edge.source, []);
    if (!this.incoming.has(edge.target)) this.incoming.set(edge.target, []);

    this.outgoing.get(edge.source)!.push(edge);
    this.incoming.get(edge.target)!.push(edge);
  }

  /** Get a node by ID. */
  getNode(id: string): LineageNode | undefined {
    return this.nodes.get(id);
  }

  /** Get all nodes. */
  getAllNodes(): LineageNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Visit nodes in deterministic insertion order without materializing the
   * graph. Returning `false` stops the walk and returns `false`; a completed
   * visit returns `true`. Callers that need a cap/cancellation boundary must
   * enforce it from the visitor rather than using `getAllNodes()`.
   */
  visitNodes(visitor: (node: LineageNode) => boolean | void): boolean {
    for (const node of this.nodes.values()) {
      if (visitor(node) === false) return false;
    }
    return true;
  }

  /** Get all edges. */
  getAllEdges(): LineageEdge[] {
    return [...this.edges];
  }

  /** Get nodes by type. */
  getNodesByType(type: LineageNodeType): LineageNode[] {
    return [...this.nodes.values()].filter((n) => n.type === type);
  }

  /** Get nodes by lineage layer. */
  getNodesByLayer(layer: LineageLayer): LineageNode[] {
    return [...this.nodes.values()].filter((n) => (n.layer ?? getLayerForNodeType(n.type)) === layer);
  }

  /** Get nodes by domain. */
  getNodesByDomain(domain: string): LineageNode[] {
    return [...this.nodes.values()].filter((n) => n.domain === domain);
  }

  /** Get all unique domains in the graph. */
  getDomains(): string[] {
    const domains = new Set<string>();
    for (const node of this.nodes.values()) {
      if (node.domain) domains.add(node.domain);
    }
    return [...domains];
  }

  /** Get outgoing edges from a node. */
  getOutgoingEdges(nodeId: string): LineageEdge[] {
    return this.outgoing.get(nodeId) ?? [];
  }

  /** Get incoming edges to a node. */
  getIncomingEdges(nodeId: string): LineageEdge[] {
    return this.incoming.get(nodeId) ?? [];
  }

  /**
   * Get all ancestors (upstream) of a node via BFS.
   * Follows incoming edges backwards.
   */
  ancestors(nodeId: string): LineageNode[] {
    const visited = new Set<string>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of this.incoming.get(current) ?? []) {
        if (!isDataFlowEdge(edge)) continue;
        if (!visited.has(edge.source)) {
          visited.add(edge.source);
          queue.push(edge.source);
        }
      }
    }

    return [...visited].map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  /**
   * Get all descendants (downstream) of a node via BFS.
   * Follows outgoing edges forward.
   */
  descendants(nodeId: string): LineageNode[] {
    const visited = new Set<string>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of this.outgoing.get(current) ?? []) {
        if (!isDataFlowEdge(edge)) continue;
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push(edge.target);
        }
      }
    }

    return [...visited].map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  /**
   * Find the shortest path between two nodes (BFS).
   * Returns node IDs in order, or empty array if no path exists.
   */
  pathBetween(fromId: string, toId: string): string[] {
    if (fromId === toId) return [fromId];
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return [];

    const visited = new Set<string>([fromId]);
    const parent = new Map<string, string>();
    const queue = [fromId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of this.outgoing.get(current) ?? []) {
        if (!isDataFlowEdge(edge)) continue;
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          parent.set(edge.target, current);
          if (edge.target === toId) {
            // Reconstruct path
            const path: string[] = [toId];
            let node = toId;
            while (parent.has(node)) {
              node = parent.get(node)!;
              path.unshift(node);
            }
            return path;
          }
          queue.push(edge.target);
        }
      }
    }

    return []; // No path found
  }

  /**
   * Extract a subgraph containing only nodes matching a filter and
   * edges between those nodes.
   */
  subgraph(filter: (node: LineageNode) => boolean): LineageGraph {
    const sub = new LineageGraph();
    const included = new Set<string>();

    for (const node of this.nodes.values()) {
      if (filter(node)) {
        sub.addNode(node);
        included.add(node.id);
      }
    }

    for (const edge of this.edges) {
      if (included.has(edge.source) && included.has(edge.target)) {
        sub.addEdge(edge);
      }
    }

    return sub;
  }

  /**
   * Get edges that cross domain boundaries.
   */
  getCrossDomainEdges(): LineageEdge[] {
    return this.edges.filter((e) => e.type === 'crosses_domain');
  }

  /** Serialize the graph to JSON. */
  toJSON(): LineageGraphJSON {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges],
    };
  }

  /** Deserialize a graph from JSON. */
  static fromJSON(json: LineageGraphJSON): LineageGraph {
    const graph = new LineageGraph();
    for (const node of json.nodes) {
      graph.addNode(node);
    }
    for (const edge of json.edges) {
      graph.addEdge(edge);
    }
    return graph;
  }

  /** Number of nodes in the graph. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Number of edges in the graph. */
  get edgeCount(): number {
    return this.edges.length;
  }
}
