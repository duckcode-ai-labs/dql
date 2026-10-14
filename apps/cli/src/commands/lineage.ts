/**
 * `zlens lineage` — Answer-layer lineage analysis.
 *
 * Shows how data flows from source tables through blocks, semantic metrics,
 * domains, and charts. Tracks trust chains and cross-domain impacts.
 *
 * Usage:
 *   zlens lineage [path]                    Show full lineage graph summary
 *   zlens lineage <name> [path]             Show upstream/downstream for a block, table, or metric
 *   zlens lineage --term <name> [path]      Show lineage for a business term
 *   zlens lineage --business-360 <name>     Show business definition, sources, consumers, and gaps
 *   zlens lineage --business [name] [path]  Show business lineage, optionally focused on a view
 *   zlens lineage --table <name> [path]     Show lineage for a specific source table
 *   zlens lineage --metric <name> [path]    Show lineage for a specific metric
 *   zlens lineage --domain <name> [path]    Show lineage within a domain
 *   zlens lineage cross-domain [--domain <name>]
 *                                         Show cross-domain boundary flows
 *   zlens lineage --impact <name> [path]    Impact analysis: what breaks if this node changes?
 *   zlens lineage --trust-chain <from> <to> Show trust chain between two blocks
 *   zlens lineage --search <term> [path]    Search lineage nodes by name
 *   zlens lineage --focus <name> [path]     Show a focused lineage subgraph
 *   zlens lineage --dashboard <name> [path] Show lineage for a dashboard/notebook
 *   zlens lineage --dbt [path]              Show the dbt portion of lineage
 *   zlens lineage --export [path]           Export lineage as JSON
 *   zlens lineage --no-manifest             Force live scan (skip dql-manifest.json)
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import {
  Parser,
  loadSemanticLayerFromDir,
  buildLineageGraph,
  buildManifest,
  analyzeImpact,
  buildTrustChain,
  detectDomainFlows,
  getDomainTrustOverview,
  LineageGraph,
  queryLineage,
  queryBusiness360,
  type LineageBlockInput,
  type LineageMetricInput,
  type LineageDimensionInput,
  type LineageNode,
  type Business360Asset,
  type Business360Result,
} from '@zlens/core';
import type { CLIFlags } from '../args.js';

export async function runLineage(
  blockNameOrPath: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  // Collect all args and separate flags from positional args
  const allArgs = [...(blockNameOrPath ? [blockNameOrPath] : []), ...rest];
  const noManifest = allArgs.includes('--no-manifest');
  const positionalArgs = allArgs.filter((a) => !a.startsWith('-'));
  const flagArgs = allArgs.filter((a) => a.startsWith('-'));

  // Re-derive blockNameOrPath from the first non-flag positional arg
  const effectiveBlockArg = positionalArgs[0] ?? null;

  // Determine project root — check for dql.config.json
  const candidateRoot = resolve(
    positionalArgs.find((r) => existsSync(join(resolve(r), 'dql.config.json')))
    ?? '.',
  );

  const projectRoot = existsSync(join(candidateRoot, 'dql.config.json'))
    ? candidateRoot
    : resolve('.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error('No ZLens project found (missing dql.config.json). Run from a project root or pass a project path.');
    process.exitCode = 1;
    return;
  }

  // Build the lineage graph — prefer manifest if available
  const graph = noManifest
    ? buildProjectLineage(projectRoot)
    : loadFromManifestOrScan(projectRoot);

  if (graph.nodeCount === 0) {
    console.log('\n  No lineage data found.');
    console.log('  Run `zlens compile` to generate the project manifest, or add blocks in blocks/.\n');
    return;
  }

  // Route to the right subcommand based on flags
  const business360Idx = allArgs.indexOf('--business-360');
  const business360AliasIdx = allArgs.indexOf('--360');
  const effectiveBusiness360Idx = business360Idx >= 0 ? business360Idx : business360AliasIdx;
  if (effectiveBusiness360Idx >= 0 && allArgs[effectiveBusiness360Idx + 1]) {
    const focus = allArgs[effectiveBusiness360Idx + 1];
    const result = queryBusiness360(graph, focus);
    if (!result) {
      console.error(`"${focus}" not found in lineage graph.`);
      process.exitCode = 1;
      return;
    }
    if (flags.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    return printBusiness360(result);
  }

  if (allArgs.includes('cross-domain') || allArgs.includes('--cross-domain')) {
    return printCrossDomainLineage(graph, flags);
  }

  if (flags.format === 'json' || allArgs.includes('--export')) {
    console.log(JSON.stringify(graph.toJSON(), null, 2));
    return;
  }

  // --impact <name>
  const impactIdx = allArgs.indexOf('--impact');
  if (impactIdx >= 0 && allArgs[impactIdx + 1]) {
    const nodeId = resolveNodeId(graph, allArgs[impactIdx + 1]);
    if (!nodeId) {
      console.error(`"${allArgs[impactIdx + 1]}" not found in lineage graph.`);
      process.exitCode = 1;
      return;
    }
    return printImpactAnalysis(graph, nodeId, flags);
  }

  // --trust-chain <from> <to>
  const trustIdx = allArgs.indexOf('--trust-chain');
  if (trustIdx >= 0 && allArgs[trustIdx + 1] && allArgs[trustIdx + 2]) {
    return printTrustChain(graph, allArgs[trustIdx + 1], allArgs[trustIdx + 2], flags);
  }

  const searchIdx = allArgs.indexOf('--search');
  if (searchIdx >= 0 && allArgs[searchIdx + 1]) {
    return printSearchResults(graph, allArgs[searchIdx + 1]);
  }

  const focusIdx = allArgs.indexOf('--focus');
  if (focusIdx >= 0 && allArgs[focusIdx + 1]) {
    return printFocusedLineage(graph, allArgs[focusIdx + 1]);
  }

  const dashboardIdx = allArgs.indexOf('--dashboard');
  if (dashboardIdx >= 0 && allArgs[dashboardIdx + 1]) {
    return printFocusedLineage(graph, `dashboard:${allArgs[dashboardIdx + 1]}`);
  }

  const termIdx = allArgs.indexOf('--term');
  if (termIdx >= 0 && allArgs[termIdx + 1]) {
    return printNodeLineage(graph, `term:${allArgs[termIdx + 1]}`, flags);
  }

  const businessIdx = allArgs.indexOf('--business');
  if (businessIdx >= 0) {
    const maybeName = allArgs[businessIdx + 1];
    if (maybeName && !maybeName.startsWith('-')) {
      const nodeId = resolveNodeId(graph, maybeName) ?? `business_view:${maybeName}`;
      return printBusinessLineageFor(graph, nodeId);
    }
    return printBusinessLineage(graph);
  }

  if (allArgs.includes('--dbt')) {
    const result = queryLineage(graph, { types: ['dbt_model', 'dbt_source'] });
    console.log(JSON.stringify(result.graph, null, 2));
    return;
  }

  // --domain <name>
  if (flags.domain) {
    return printDomainLineage(graph, flags.domain, flags);
  }

  // --table <name>
  const tableIdx = allArgs.indexOf('--table');
  if (tableIdx >= 0 && allArgs[tableIdx + 1]) {
    return printNodeLineage(graph, `table:${allArgs[tableIdx + 1]}`, flags);
  }

  // --metric <name>
  const metricIdx = allArgs.indexOf('--metric');
  if (metricIdx >= 0 && allArgs[metricIdx + 1]) {
    return printNodeLineage(graph, `metric:${allArgs[metricIdx + 1]}`, flags);
  }

  // Specific node — smart lookup: try block, then table, then metric
  if (effectiveBlockArg && resolve(effectiveBlockArg) !== projectRoot) {
    const nodeId = resolveNodeId(graph, effectiveBlockArg);
    if (!nodeId) {
      console.error(`"${effectiveBlockArg}" not found in lineage graph.`);
      console.error('  Hint: use --table <name> or --metric <name> for explicit lookup.');
      process.exitCode = 1;
      return;
    }
    return printNodeLineage(graph, nodeId, flags);
  }

  // Default: show full summary
  return printSummary(graph, flags);
}

/** Load lineage from dql-manifest.json if available, otherwise scan live. */
function loadFromManifestOrScan(projectRoot: string): LineageGraph {
  const manifestPath = join(projectRoot, 'dql-manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (manifest.lineage?.nodes && manifest.lineage?.edges) {
        return LineageGraph.fromJSON({
          nodes: manifest.lineage.nodes,
          edges: manifest.lineage.edges,
        });
      }
    } catch {
      // Fall through to live scan
    }
  }
  return buildProjectLineage(projectRoot);
}

/** Discover all blocks and semantic layer definitions and build the lineage graph. */
function buildProjectLineage(projectRoot: string): LineageGraph {
  const dbtManifestPath = resolveDbtManifestPath(projectRoot);
  try {
    const manifest = buildManifest({ projectRoot, dbtManifestPath });
    return LineageGraph.fromJSON({
      nodes: manifest.lineage.nodes as any,
      edges: manifest.lineage.edges as any,
    });
  } catch {
    const blocks: LineageBlockInput[] = [];
    const metrics: LineageMetricInput[] = [];
    const dimensions: LineageDimensionInput[] = [];

    const dirs = ['blocks', 'dashboards', 'workbooks'];
    for (const dir of dirs) {
      const dirPath = join(projectRoot, dir);
      if (!existsSync(dirPath)) continue;

      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isFile() || extname(entry.name) !== '.dql') continue;
        const filePath = join(dirPath, entry.name);

        try {
          const source = readFileSync(filePath, 'utf-8');
          const parser = new Parser(source, `${dir}/${entry.name}`);
          const ast = parser.parse();

          for (const stmt of ast.statements) {
            const block = stmt as any;
            if (block.kind !== 'BlockDecl') continue;

            blocks.push({
              name: block.name,
              sql: block.query?.rawSQL ?? '',
              domain: extractBlockProperty(block, 'domain'),
              owner: extractBlockProperty(block, 'owner'),
              status: extractBlockProperty(block, 'status') as any,
              blockType: block.blockType,
              metricRef: block.metricRef,
              chartType: extractVisualizationChart(block),
            });
          }
        } catch {
          // Skip unparseable files
        }
      }
    }

    const semanticDir = join(projectRoot, 'semantic-layer');
    if (existsSync(semanticDir)) {
      try {
        const layer = loadSemanticLayerFromDir(semanticDir);
        for (const metric of layer.listMetrics()) {
          metrics.push({
            name: metric.name,
            table: metric.table,
            domain: metric.domain,
            type: metric.type,
          });
        }
        for (const dim of layer.listDimensions()) {
          dimensions.push({
            name: dim.name,
            table: dim.table,
          });
        }
      } catch {
        // Non-fatal
      }
    }

    return buildLineageGraph(blocks, metrics, dimensions);
  }
}

function resolveDbtManifestPath(projectRoot: string): string | undefined {
  const candidate = join(projectRoot, 'target', 'manifest.json');
  return existsSync(candidate) ? candidate : undefined;
}

/** Extract a property value from a block — checks direct AST fields first, then properties array. */
function extractBlockProperty(block: any, propName: string): string | undefined {
  // The parser puts well-known fields (domain, owner, type) directly on the AST node
  if (block[propName] !== undefined && block[propName] !== null) {
    return String(block[propName]);
  }
  // Fall back to properties array for custom/extended properties
  if (!block.properties) return undefined;
  for (const prop of block.properties) {
    if (prop.key === propName && prop.value?.kind === 'Literal') {
      return String(prop.value.value);
    }
  }
  return undefined;
}

/** Extract chart type from a block's visualization config. */
function extractVisualizationChart(block: any): string | undefined {
  if (!block.visualization) return undefined;
  for (const prop of block.visualization.properties ?? []) {
    if (prop.key === 'chart' && prop.value?.kind === 'Literal') {
      return String(prop.value.value);
    }
  }
  return undefined;
}

// ---- Output formatters ----

function printSummary(graph: LineageGraph, _flags: CLIFlags): void {
  const nodes = graph.getAllNodes();
  const edges = graph.getAllEdges();
  const domains = graph.getDomains();

  const sourceTables = graph.getNodesByType('source_table');
  const blocks = graph.getNodesByType('block');
  const metrics = graph.getNodesByType('metric');
  const dimensions = graph.getNodesByType('dimension');
  const terms = graph.getNodesByType('term');
  const businessViews = graph.getNodesByType('business_view');
  const charts = graph.getNodesByType('chart');

  console.log('\n  ZLens Lineage Summary');
  console.log('  ' + '='.repeat(50));

  // Overview counts
  console.log(`\n  ${nodes.length} nodes, ${edges.length} edges, ${domains.length} domain(s)`);

  // Source Tables
  if (sourceTables.length > 0) {
    console.log(`\n  Source Tables (${sourceTables.length}):`);
    for (const t of sourceTables.sort((a, b) => a.name.localeCompare(b.name))) {
      const downstream = graph.getOutgoingEdges(t.id);
      const targets = [...new Set(downstream.map((e) => graph.getNode(e.target)?.name).filter(Boolean))];
      const arrow = targets.length > 0 ? ` -> ${targets.join(', ')}` : '';
      console.log(`    ${t.name}${arrow}`);
    }
  }

  // Blocks
  if (blocks.length > 0) {
    console.log(`\n  Blocks (${blocks.length}):`);
    for (const b of blocks.sort((a, b) => a.name.localeCompare(b.name))) {
      const parts: string[] = [];
      if (b.domain) parts.push(`domain: ${b.domain}`);
      if (b.owner) parts.push(`owner: ${b.owner}`);
      if (b.status) parts.push(b.status);
      const meta = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      console.log(`    ${b.name}${meta}`);

      // Show what this block reads from (upstream) — deduplicate by node id
      const incoming = graph.getIncomingEdges(b.id);
      const upstreamNames = [...new Set(
        incoming
          .map((e) => graph.getNode(e.source))
          .filter((n): n is LineageNode => n !== undefined && n.type !== 'domain')
          .map((n) => n.name),
      )];
      if (upstreamNames.length > 0) {
        console.log(`      reads from: ${upstreamNames.join(', ')}`);
      }

      // Show what this block feeds into (downstream) — deduplicate by node id
      const outgoing = graph.getOutgoingEdges(b.id);
      const downstreamNames = [...new Set(
        outgoing
          .map((e) => graph.getNode(e.target))
          .filter((n): n is LineageNode => n !== undefined && n.type !== 'domain')
          .map((n) => n.name),
      )];
      if (downstreamNames.length > 0) {
        console.log(`      feeds into: ${downstreamNames.join(', ')}`);
      }
    }
  }

  // Business Terms
  if (terms.length > 0) {
    console.log(`\n  Business Terms (${terms.length}):`);
    for (const term of terms.sort((a, b) => a.name.localeCompare(b.name))) {
      const targets = graph.getOutgoingEdges(term.id)
        .filter((e) => e.type === 'defines')
        .map((e) => graph.getNode(e.target))
        .filter((n): n is LineageNode => Boolean(n));
      const targetNames = targets.map((n) => `${nodeTypeLabel(n)}:${n.name}`);
      const domain = term.domain ? ` (${term.domain})` : '';
      console.log(`    ${term.name}${domain}${targetNames.length > 0 ? ` -> ${targetNames.join(', ')}` : ''}`);
    }
  }

  // Business Views
  if (businessViews.length > 0) {
    console.log(`\n  Business Views (${businessViews.length}):`);
    for (const view of businessViews.sort((a, b) => a.name.localeCompare(b.name))) {
      const upstream = graph.getIncomingEdges(view.id)
        .filter((e) => e.type === 'composes' || e.type === 'defines')
        .map((e) => graph.getNode(e.source))
        .filter((n): n is LineageNode => Boolean(n));
      const upstreamNames = upstream.map((n) => `${nodeTypeLabel(n)}:${n.name}`);
      const domain = view.domain ? ` (${view.domain})` : '';
      console.log(`    ${view.name}${domain}${upstreamNames.length > 0 ? ` <- ${upstreamNames.join(', ')}` : ''}`);
    }
  }

  // Metrics
  if (metrics.length > 0) {
    console.log(`\n  Metrics (${metrics.length}):`);
    for (const m of metrics.sort((a, b) => a.name.localeCompare(b.name))) {
      const incoming = graph.getIncomingEdges(m.id);
      const sources = incoming.map((e) => graph.getNode(e.source)?.name).filter(Boolean);
      const from = sources.length > 0 ? ` <- ${sources.join(', ')}` : '';
      const domain = m.domain ? ` (${m.domain})` : '';
      console.log(`    ${m.name}${domain}${from}`);
    }
  }

  // Dimensions
  if (dimensions.length > 0) {
    console.log(`\n  Dimensions (${dimensions.length}):`);
    for (const d of dimensions.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`    ${d.name}`);
    }
  }

  // Charts
  if (charts.length > 0) {
    console.log(`\n  Charts (${charts.length}):`);
    for (const c of charts.sort((a, b) => a.name.localeCompare(b.name))) {
      const incoming = graph.getIncomingEdges(c.id);
      const sources = incoming.map((e) => graph.getNode(e.source)?.name).filter(Boolean);
      const from = sources.length > 0 ? ` <- ${sources.join(', ')}` : '';
      console.log(`    ${c.name}${from}`);
    }
  }

  // Shared Table Correlation — blocks reading the same tables
  const tableReaders = new Map<string, string[]>();
  for (const t of sourceTables) {
    const downstream = graph.getOutgoingEdges(t.id)
      .map((e) => graph.getNode(e.target))
      .filter((n): n is LineageNode => n !== undefined && n.type === 'block');
    if (downstream.length >= 2) {
      tableReaders.set(t.name, downstream.map((n) => n.name));
    }
  }
  if (tableReaders.size > 0) {
    console.log(`\n  Shared Tables (${tableReaders.size}):`);
    for (const [table, readers] of [...tableReaders.entries()].sort()) {
      console.log(`    ${table} <- ${readers.join(', ')}`);
    }
  }

  // Data Flow DAG
  console.log('\n  Data Flow:');
  console.log('  ' + '-'.repeat(50));
  // Find root nodes (no incoming edges, excluding domain nodes)
  const roots = nodes.filter(
    (n) => n.type !== 'domain' && (graph.getIncomingEdges(n.id).length === 0),
  );
  const printed = new Set<string>();
  for (const root of roots.sort((a, b) => a.name.localeCompare(b.name))) {
    printDAGNode(graph, root, 0, printed);
  }
  // Print any remaining nodes not reachable from roots (cycles or disconnected)
  for (const node of nodes) {
    if (!printed.has(node.id) && node.type !== 'domain') {
      printDAGNode(graph, node, 0, printed);
    }
  }

  // Cross-domain flows
  const flows = detectDomainFlows(graph);
  if (flows.length > 0) {
    console.log('\n  Cross-Domain Flows:');
    for (const flow of flows) {
      console.log(`    ${flow.from} -> ${flow.to} (${flow.edges.length} edge(s))`);
    }
  }

  // Domain trust overview
  if (domains.length > 0) {
    console.log('\n  Domain Trust:');
    for (const domain of domains.sort()) {
      const overview = getDomainTrustOverview(graph, domain);
      if (overview.totalBlocks === 0) continue;
      const score = (overview.trustScore * 100).toFixed(0);
      console.log(`    ${domain}: ${overview.certified}/${overview.totalBlocks} certified (${score}% trust)`);
    }
  }

  console.log('');
}

function printCrossDomainLineage(graph: LineageGraph, flags: CLIFlags): void {
  const domainFilter = flags.domain?.trim();
  const allFlows = detectDomainFlows(graph);
  const flows = domainFilter
    ? allFlows.filter((flow) => sameDomain(flow.from, domainFilter) || sameDomain(flow.to, domainFilter))
    : allFlows;
  const payload = {
    domain: domainFilter || null,
    summary: {
      flowCount: flows.length,
      edgeCount: flows.reduce((sum, flow) => sum + flow.edges.length, 0),
      domains: Array.from(new Set(flows.flatMap((flow) => [flow.from, flow.to]))).sort(),
    },
    flows: flows.map((flow) => ({
      from: flow.from,
      to: flow.to,
      edgeCount: flow.edges.length,
      sourceNodes: flow.sourceNodes
        .map((id) => graph.getNode(id))
        .filter((node): node is LineageNode => Boolean(node))
        .map(crossDomainNodePayload),
      targetNodes: flow.targetNodes
        .map((id) => graph.getNode(id))
        .filter((node): node is LineageNode => Boolean(node))
        .map(crossDomainNodePayload),
      edges: flow.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        type: edge.type,
        sourceDomain: edge.sourceDomain,
        targetDomain: edge.targetDomain,
      })),
    })),
  };

  if (flags.format === 'json') {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('\n  Cross-Domain Lineage');
  console.log('  ' + '='.repeat(50));
  if (domainFilter) console.log(`\n  Domain filter: ${domainFilter}`);
  if (flows.length === 0) {
    console.log('\n  No cross-domain flows found.');
    console.log('');
    return;
  }
  console.log(`\n  ${payload.summary.flowCount} flow(s), ${payload.summary.edgeCount} boundary edge(s)`);
  for (const flow of payload.flows) {
    console.log(`\n  ${flow.from} -> ${flow.to} (${flow.edgeCount} edge(s))`);
    for (const edge of flow.edges) {
      const source = graph.getNode(edge.source);
      const target = graph.getNode(edge.target);
      console.log(`    ${source ? nodeTypeLabel(source) : 'node'}:${source?.name ?? edge.source} -> ${target ? nodeTypeLabel(target) : 'node'}:${target?.name ?? edge.target}`);
    }
  }
  console.log('');
}

function crossDomainNodePayload(node: LineageNode): {
  id: string;
  type: string;
  name: string;
  domain?: string;
  status?: string;
  owner?: string;
} {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    domain: node.domain,
    status: node.status,
    owner: node.owner,
  };
}

function sameDomain(left: string | undefined, right: string): boolean {
  return String(left ?? '').trim().toLowerCase() === right.trim().toLowerCase();
}

/** Recursively print DAG tree from a node. */
function printDAGNode(graph: LineageGraph, node: LineageNode, depth: number, printed: Set<string>): void {
  if (printed.has(node.id)) return;
  printed.add(node.id);

  const indent = '    ' + '  '.repeat(depth);
  const prefix = depth === 0 ? '' : '└── ';
  const typeLabel = node.type === 'source_table' ? 'table' : node.type;
  const badge = node.status === 'certified' ? ' ✓' : '';
  const domain = node.domain ? ` [${node.domain}]` : '';
  console.log(`${indent}${prefix}${typeLabel}:${node.name}${domain}${badge}`);

  // Get non-domain downstream
  const outgoing = graph.getOutgoingEdges(node.id);
  const children = outgoing
    .map((e) => graph.getNode(e.target))
    .filter((n): n is LineageNode => n !== undefined && n.type !== 'domain' && !printed.has(n.id));

  for (const child of children) {
    printDAGNode(graph, child, depth + 1, printed);
  }
}

/**
 * Resolve a user-provided name to a node ID by trying multiple type prefixes.
 * Priority: block > source_table > metric > dimension > chart > exact match.
 */
function resolveNodeId(graph: LineageGraph, name: string): string | null {
  // If the name already contains a colon, try it as-is
  if (name.includes(':') && graph.getNode(name)) return name;

  // Try common type prefixes in priority order
  const prefixes = ['block', 'business_view', 'dashboard', 'notebook', 'app', 'dbt_model', 'dbt_source', 'table', 'term', 'metric', 'dimension', 'chart', 'domain'];
  for (const prefix of prefixes) {
    const id = `${prefix}:${name}`;
    if (graph.getNode(id)) return id;
  }

  // Fuzzy match: search all nodes for a name match
  for (const node of graph.getAllNodes()) {
    if (node.name === name) return node.id;
  }

  return null;
}

function printBusinessLineage(graph: LineageGraph): void {
  const terms = graph.getNodesByType('term').sort((a, b) => a.name.localeCompare(b.name));
  const views = graph.getNodesByType('business_view').sort((a, b) => a.name.localeCompare(b.name));

  console.log('\n  Business Lineage');
  console.log('  ' + '='.repeat(50));
  console.log(`\n  ${terms.length} term(s), ${views.length} business view(s)`);

  if (terms.length > 0) {
    console.log('\n  Terms:');
    for (const term of terms) {
      const targets = graph.getOutgoingEdges(term.id)
        .filter((edge) => edge.type === 'defines')
        .map((edge) => graph.getNode(edge.target))
        .filter((node): node is LineageNode => Boolean(node));
      console.log(`    ${term.name}${term.domain ? ` (${term.domain})` : ''}`);
      if (targets.length > 0) {
        console.log(`      defines: ${targets.map((node) => `${nodeTypeLabel(node)}:${node.name}`).join(', ')}`);
      }
    }
  }

  if (views.length > 0) {
    console.log('\n  Business Views:');
    for (const view of views) {
      const composedFrom = graph.getIncomingEdges(view.id)
        .filter((edge) => edge.type === 'composes')
        .map((edge) => graph.getNode(edge.source))
        .filter((node): node is LineageNode => Boolean(node));
      const termsForView = graph.getIncomingEdges(view.id)
        .filter((edge) => edge.type === 'defines')
        .map((edge) => graph.getNode(edge.source))
        .filter((node): node is LineageNode => Boolean(node));
      const consumedBy = graph.descendants(view.id)
        .filter((node) => node.type === 'dashboard' || node.type === 'notebook' || node.type === 'app');
      console.log(`    ${view.name}${view.domain ? ` (${view.domain})` : ''}`);
      if (termsForView.length > 0) {
        console.log(`      terms: ${termsForView.map((node) => node.name).join(', ')}`);
      }
      if (composedFrom.length > 0) {
        console.log(`      composed from: ${composedFrom.map((node) => `${nodeTypeLabel(node)}:${node.name}`).join(', ')}`);
      }
      if (consumedBy.length > 0) {
        console.log(`      consumed by: ${consumedBy.map((node) => `${nodeTypeLabel(node)}:${node.name}`).join(', ')}`);
      }
    }
  }

  console.log('');
}

function printBusinessLineageFor(graph: LineageGraph, nodeId: string): void {
  const node = graph.getNode(nodeId);
  if (!node) {
    console.error(`"${nodeId}" not found in lineage graph.`);
    process.exitCode = 1;
    return;
  }

  const upstream = graph.ancestors(node.id).filter((n) => n.type !== 'domain');
  const downstream = graph.descendants(node.id).filter((n) => n.type !== 'domain');
  const sourceBlocks = node.type === 'block'
    ? [node]
    : upstream.filter((n) => n.type === 'block');
  const businessInputs = upstream.filter((n) => n.type === 'term' || n.type === 'business_view' || n.type === 'block');
  const finalConsumption = downstream.filter((n) => n.type === 'dashboard' || n.type === 'notebook' || n.type === 'app');

  console.log(`\n  Business Lineage: ${node.name}`);
  console.log('  ' + '='.repeat(50));
  console.log(`  Node: ${nodeTypeLabel(node)}:${node.name}${node.domain ? ` (${node.domain})` : ''}`);

  if (businessInputs.length > 0) {
    console.log('\n  Business Composition:');
    for (const input of businessInputs.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))) {
      console.log(`    ${nodeTypeLabel(input)}:${input.name}${input.domain ? ` (${input.domain})` : ''}`);
    }
  }

  if (sourceBlocks.length > 0) {
    console.log('\n  Technical Behind Blocks:');
    for (const block of sourceBlocks.sort((a, b) => a.name.localeCompare(b.name))) {
      const sources = graph.getIncomingEdges(block.id)
        .map((edge) => graph.getNode(edge.source))
        .filter((n): n is LineageNode => Boolean(n))
        .filter((n) => n.type === 'source_table' || n.type === 'dbt_model' || n.type === 'dbt_source' || n.type === 'metric' || n.type === 'dimension' || n.type === 'block');
      console.log(`    block:${block.name}`);
      if (sources.length > 0) {
        console.log(`      backed by: ${sources.map((source) => `${nodeTypeLabel(source)}:${source.name}`).join(', ')}`);
      }
    }
  }

  if (finalConsumption.length > 0) {
    console.log('\n  Final Consumption:');
    for (const output of finalConsumption.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))) {
      console.log(`    ${nodeTypeLabel(output)}:${output.name}`);
    }
  }

  console.log('');
}

function printBusiness360(result: Business360Result): void {
  const focus = result.focus;
  console.log(`\n  Business 360: ${focus.name}`);
  console.log('  ' + '='.repeat(50));
  console.log(`  Node: ${assetLabel(focus)}${focus.domain ? ` (${focus.domain})` : ''}`);

  const definitionItems = [
    ...result.businessDefinition.terms.filter((asset) => asset.id !== focus.id),
    ...result.businessDefinition.definedByTerms,
  ];
  if (definitionItems.length > 0 || result.businessDefinition.definedArtifacts.length > 0) {
    console.log('\n  Business Definition:');
    printAssetList('Terms', definitionItems);
    printAssetList('Defines', result.businessDefinition.definedArtifacts);
    printMetadataSummary(result.businessDefinition.metadata);
  }

  if (result.businessComposition.includedArtifacts.length > 0 || result.businessComposition.parentViews.length > 0) {
    console.log('\n  Business Composition:');
    printAssetList('Includes', result.businessComposition.includedArtifacts);
    printAssetList('Rolls up to', result.businessComposition.parentViews);
  }

  const sourceCount = result.technicalSources.sourceTables.length
    + result.technicalSources.dbtModels.length
    + result.technicalSources.dbtSources.length
    + result.technicalSources.upstreamBlocks.length;
  if (sourceCount > 0) {
    console.log('\n  Technical Sources:');
    printAssetList('Tables', result.technicalSources.sourceTables);
    printAssetList('dbt sources', result.technicalSources.dbtSources);
    printAssetList('dbt models', result.technicalSources.dbtModels);
    printAssetList('Upstream blocks', result.technicalSources.upstreamBlocks);
    console.log(`    upstream paths: ${result.technicalSources.upstreamPathCount}`);
  }

  const consumerCount = result.consumers.dashboards.length
    + result.consumers.apps.length
    + result.consumers.notebooks.length
    + result.consumers.downstreamViews.length
    + result.consumers.downstreamBlocks.length;
  if (consumerCount > 0) {
    console.log('\n  Consumers:');
    printAssetList('Dashboards', result.consumers.dashboards);
    printAssetList('Apps', result.consumers.apps);
    printAssetList('Notebooks', result.consumers.notebooks);
    printAssetList('Business views', result.consumers.downstreamViews);
    printAssetList('Blocks', result.consumers.downstreamBlocks);
  }

  if (result.replacementHistory.replaces.length > 0
    || result.replacementHistory.replacedBy.length > 0
    || result.replacementHistory.replacementRefs.length > 0) {
    console.log('\n  Replacement History:');
    printAssetList('Replaces', result.replacementHistory.replaces);
    printAssetList('Replaced by', result.replacementHistory.replacedBy);
    if (result.replacementHistory.replacementRefs.length > 0) {
      console.log(`    Declared refs: ${result.replacementHistory.replacementRefs.join(', ')}`);
    }
  }

  if (result.blockContracts.length > 0) {
    console.log('\n  Reusable Block Contracts:');
    for (const contract of result.blockContracts) {
      const parts = [
        `reusability: ${contract.reusability}`,
        contract.pattern ? `pattern: ${contract.pattern}` : '',
        contract.grain ? `grain: ${contract.grain}` : '',
      ].filter(Boolean);
      console.log(`    ${assetLabel(contract.block)}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`);
      if (contract.outputs.length > 0) console.log(`      outputs: ${contract.outputs.join(', ')}`);
      if (contract.dimensions.length > 0) console.log(`      dimensions: ${contract.dimensions.join(', ')}`);
      if (contract.allowedFilters.length > 0) console.log(`      filters: ${contract.allowedFilters.join(', ')}`);
      if (contract.parameterPolicy.length > 0) {
        console.log(`      parameters: ${contract.parameterPolicy.map((entry) => `${entry.name}=${entry.policy}`).join(', ')}`);
      }
      if (contract.filterBindings.length > 0) {
        console.log(`      bindings: ${contract.filterBindings.map((entry) => `${entry.filter}->${entry.binding}`).join(', ')}`);
      }
      if (contract.replacementFor.length > 0) console.log(`      replaces: ${contract.replacementFor.join(', ')}`);
    }
  }

  if (result.gaps.length > 0) {
    console.log('\n  Gaps:');
    for (const gap of result.gaps) {
      console.log(`    [${gap.severity}] ${gap.message}`);
    }
  }

  console.log(`\n  Evidence: ${result.evidence.nodes.length} node(s), ${result.evidence.edges.length} edge(s)`);
  console.log('');
}

function printAssetList(label: string, assets: Business360Asset[]): void {
  if (assets.length === 0) return;
  console.log(`    ${label}: ${assets.map(assetLabel).join(', ')}`);
}

function assetLabel(asset: Business360Asset): string {
  const type = asset.type === 'source_table' ? 'table' : asset.type;
  const status = asset.status === 'certified' ? ' [certified]' : '';
  return `${type}:${asset.name}${status}`;
}

function printMetadataSummary(metadata: Record<string, unknown>): void {
  const summary = ['description', 'businessOutcome', 'termType']
    .map((key) => [key, metadata[key]] as const)
    .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string' && entry[1].length > 0);
  for (const [key, value] of summary) {
    console.log(`    ${key}: ${value}`);
  }
}

function nodeTypeLabel(node: LineageNode): string {
  if (node.type === 'source_table') return 'table';
  return node.type;
}

function printSearchResults(graph: LineageGraph, term: string): void {
  const result = queryLineage(graph, { search: term });
  console.log(`\n  Search: ${term}`);
  console.log('  ' + '='.repeat(50));
  if (!result.matches?.length) {
    console.log('  No lineage nodes matched.\n');
    return;
  }
  for (const match of result.matches) {
    const node = match.node;
    console.log(`  ${node.id}${node.domain ? ` [${node.domain}]` : ''}`);
  }
  console.log('');
}

function printFocusedLineage(graph: LineageGraph, focus: string): void {
  const result = queryLineage(graph, { focus });
  if (!result.focalNode) {
    console.error(`"${focus}" not found in lineage graph.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Focused Lineage: ${result.focalNode.name}`);
  console.log('  ' + '='.repeat(50));
  for (const node of result.graph.nodes.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${node.id}${node.domain ? ` [${node.domain}]` : ''}`);
  }
  if (result.graph.edges.length > 0) {
    console.log('\n  Edges:');
    for (const edge of result.graph.edges) {
      console.log(`    ${edge.source} -${edge.type}-> ${edge.target}`);
    }
  }
  console.log('');
}

function printNodeLineage(graph: LineageGraph, nodeId: string, _flags: CLIFlags): void {
  const node = graph.getNode(nodeId);

  if (!node) {
    console.error(`Node "${nodeId}" not found in lineage graph.`);
    process.exitCode = 1;
    return;
  }

  const typeLabel = node.type === 'source_table' ? 'Table' : node.type.charAt(0).toUpperCase() + node.type.slice(1);
  const ancestors = graph.ancestors(nodeId);
  const descendants = graph.descendants(nodeId);

  console.log(`\n  ${typeLabel} Lineage: ${node.name}`);
  console.log('  ' + '='.repeat(50));

  // Metadata
  const meta: string[] = [];
  if (node.type !== 'source_table') meta.push(`Type: ${node.type}`);
  if (node.domain) meta.push(`Domain: ${node.domain}`);
  if (node.status) meta.push(`Status: ${node.status}`);
  if (node.owner) meta.push(`Owner: ${node.owner}`);
  if (meta.length > 0) {
    for (const m of meta) console.log(`  ${m}`);
  }

  // Direct connections (immediate neighbors)
  const inEdges = graph.getIncomingEdges(nodeId);
  const outEdges = graph.getOutgoingEdges(nodeId);

  const directUpstream = [...new Set(
    inEdges
      .map((e) => graph.getNode(e.source))
      .filter((n): n is LineageNode => n !== undefined && n.type !== 'domain'),
  )];

  const directDownstream = [...new Set(
    outEdges
      .map((e) => graph.getNode(e.target))
      .filter((n): n is LineageNode => n !== undefined && n.type !== 'domain'),
  )];

  if (directUpstream.length > 0) {
    console.log(`\n  Direct Upstream (${directUpstream.length}):`);
    for (const n of directUpstream) {
      const badge = n.status === 'certified' ? ' [certified]' : '';
      const typePfx = n.type === 'source_table' ? 'table' : n.type;
      console.log(`    ${typePfx}:${n.name}${badge}${n.domain ? ` (${n.domain})` : ''}`);
    }
  }

  if (directDownstream.length > 0) {
    console.log(`\n  Direct Downstream (${directDownstream.length}):`);
    for (const n of directDownstream) {
      const badge = n.status === 'certified' ? ' [certified]' : '';
      const typePfx = n.type === 'source_table' ? 'table' : n.type;
      console.log(`    ${typePfx}:${n.name}${badge}${n.domain ? ` (${n.domain})` : ''}`);
    }
  }

  // Full transitive upstream/downstream (if different from direct)
  const transitiveUp = ancestors.filter((n) => n.type !== 'domain');
  const transitiveDown = descendants.filter((n) => n.type !== 'domain');

  if (transitiveUp.length > directUpstream.length) {
    console.log(`\n  All Upstream (${transitiveUp.length}):`);
    for (const a of transitiveUp) {
      const badge = a.status === 'certified' ? ' [certified]' : '';
      const typePfx = a.type === 'source_table' ? 'table' : a.type;
      const direct = directUpstream.some((d) => d.id === a.id) ? ' *' : '';
      console.log(`    ${typePfx}:${a.name}${badge}${a.domain ? ` (${a.domain})` : ''}${direct}`);
    }
  }

  if (transitiveDown.length > directDownstream.length) {
    console.log(`\n  All Downstream (${transitiveDown.length}):`);
    for (const d of transitiveDown) {
      const badge = d.status === 'certified' ? ' [certified]' : '';
      const typePfx = d.type === 'source_table' ? 'table' : d.type;
      const direct = directDownstream.some((dd) => dd.id === d.id) ? ' *' : '';
      console.log(`    ${typePfx}:${d.name}${badge}${d.domain ? ` (${d.domain})` : ''}${direct}`);
    }
  }

  // Data flow tree from this node
  if (transitiveDown.length > 0) {
    console.log('\n  Data Flow:');
    console.log('  ' + '-'.repeat(50));
    const printed = new Set<string>();
    printDAGNode(graph, node, 0, printed);
  }

  console.log('');
}

function printDomainLineage(graph: LineageGraph, domain: string, _flags: CLIFlags): void {
  const nodes = graph.getNodesByDomain(domain);
  const overview = getDomainTrustOverview(graph, domain);
  const flows = detectDomainFlows(graph);

  console.log(`\n  Domain Lineage: ${domain}`);
  console.log('  ' + '='.repeat(40));

  console.log(`\n  Blocks: ${overview.totalBlocks}`);
  console.log(`  Certified: ${overview.certified}`);
  console.log(`  Trust Score: ${(overview.trustScore * 100).toFixed(0)}%`);

  console.log(`\n  Nodes in domain (${nodes.length}):`);
  for (const node of nodes) {
    const badge = node.status === 'certified' ? ' [certified]' : '';
    console.log(`    ${node.type}:${node.name}${badge}`);
  }

  const inFlows = flows.filter((f) => f.to === domain);
  const outFlows = flows.filter((f) => f.from === domain);

  if (inFlows.length > 0) {
    console.log('\n  Data flows IN from:');
    for (const f of inFlows) {
      console.log(`    ${f.from} (${f.edges.length} edge(s))`);
    }
  }

  if (outFlows.length > 0) {
    console.log('\n  Data flows OUT to:');
    for (const f of outFlows) {
      console.log(`    ${f.to} (${f.edges.length} edge(s))`);
    }
  }

  console.log('');
}

function printImpactAnalysis(graph: LineageGraph, nodeId: string, _flags: CLIFlags): void {
  const node = graph.getNode(nodeId);
  if (!node) {
    console.error(`"${nodeId}" not found.`);
    process.exitCode = 1;
    return;
  }

  const impact = analyzeImpact(graph, nodeId);

  console.log(`\n  Impact Analysis: ${node.name}`);
  console.log('  ' + '='.repeat(40));
  console.log(`\n  Total downstream affected: ${impact.totalAffected}`);

  if (impact.domainImpacts.length > 0) {
    console.log('\n  By domain:');
    for (const di of impact.domainImpacts) {
      console.log(`    ${di.domain}: ${di.affectedNodes.length} node(s), ${di.certifiedBlocksAffected} certified`);
      for (const n of di.affectedNodes) {
        const badge = n.status === 'certified' ? ' [certified]' : '';
        console.log(`      - ${n.name}${badge}`);
      }
    }
  }

  if (impact.domainCrossings.length > 0) {
    console.log('\n  Domain boundaries crossed:');
    for (const dc of impact.domainCrossings) {
      console.log(`    ${dc.from} -> ${dc.to} (${dc.edgeCount} edge(s))`);
    }
  }

  console.log('');
}

function printTrustChain(graph: LineageGraph, fromBlock: string, toBlock: string, _flags: CLIFlags): void {
  const fromId = `block:${fromBlock}`;
  const toId = `block:${toBlock}`;

  if (!graph.getNode(fromId)) {
    console.error(`Block "${fromBlock}" not found.`);
    process.exitCode = 1;
    return;
  }
  if (!graph.getNode(toId)) {
    console.error(`Block "${toBlock}" not found.`);
    process.exitCode = 1;
    return;
  }

  const chain = buildTrustChain(graph, fromId, toId);

  if (!chain) {
    console.log(`\n  No path found from "${fromBlock}" to "${toBlock}".`);
    return;
  }

  console.log(`\n  Trust Chain: ${fromBlock} -> ${toBlock}`);
  console.log('  ' + '='.repeat(40));
  console.log(`\n  Trust Score: ${(chain.trustScore * 100).toFixed(0)}% (${chain.certifiedCount}/${chain.nodes.length} certified)`);

  console.log('\n  Chain:');
  for (let i = 0; i < chain.nodes.length; i++) {
    const n = chain.nodes[i];
    const icon = n.isTrustCheckpoint ? '[CERTIFIED]' : '[         ]';
    const domain = n.domain ? ` (${n.domain})` : '';
    const owner = n.owner ? ` — ${n.owner}` : '';
    const prefix = i === 0 ? '  ' : '    -> ';
    console.log(`  ${prefix}${icon} ${n.name}${domain}${owner}`);
  }

  if (chain.domainCrossings.length > 0) {
    console.log('\n  Domain boundaries:');
    for (const dc of chain.domainCrossings) {
      console.log(`    ${dc.from} -> ${dc.to}`);
    }
  }

  console.log('');
}
