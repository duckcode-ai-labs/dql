import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  buildManifest,
  DataLexContractRegistry,
  loadProjectConfig,
  resolveDbtManifestPath,
  SemanticLayer,
  resolveSemanticLayerWithDiagnostics,
  LineageGraph,
  type DQLManifest,
  type LineageEdgeType,
  type LineageLayer,
  type LineageNodeType,
} from '@zlens/core';

export interface DQLContextOptions {
  projectRoot: string;
  dqlVersion?: string;
  /**
   * Optional override for the DataLex manifest path. Defaults to
   * `<projectRoot>/datalex-manifest.json`. The registry is consulted by
   * tools that enforce datalex_contract bindings (e.g. query-via-block).
   */
  datalexManifestPath?: string;
}

/**
 * Shared read-only view over a ZLens project.
 *
 * Loads the manifest + semantic layer once per MCP session. Tools call
 * {@link refresh} between turns if they need to see edits.
 */
export class DQLContext {
  readonly projectRoot: string;
  private readonly dqlVersion: string;
  private readonly datalexManifestPath: string;
  private _manifest: DQLManifest | null = null;
  private _semanticLayer: SemanticLayer | null = null;
  private _lineage: LineageGraph | null = null;
  private _datalexRegistry: DataLexContractRegistry | null = null;

  constructor(options: DQLContextOptions) {
    this.projectRoot = options.projectRoot;
    this.dqlVersion = options.dqlVersion ?? 'mcp';
    this.datalexManifestPath =
      options.datalexManifestPath ?? join(options.projectRoot, 'datalex-manifest.json');
  }

  get manifest(): DQLManifest {
    if (!this._manifest) this.refresh();
    return this._manifest!;
  }

  get semanticLayer(): SemanticLayer {
    if (!this._semanticLayer) this.refresh();
    return this._semanticLayer!;
  }

  get lineageGraph(): LineageGraph {
    if (!this._lineage) this._lineage = buildGraphFromManifest(this.manifest);
    return this._lineage;
  }

  /**
   * Lazily-loaded registry of DataLex contracts for enforcing
   * `datalex_contract` references on certified blocks. Tools call
   * `registry.isLoaded()` to check whether a manifest was found before
   * gating on resolution; that lets MCP work in projects that haven't
   * adopted DataLex yet.
   */
  get datalexRegistry(): DataLexContractRegistry {
    if (!this._datalexRegistry) {
      this._datalexRegistry = new DataLexContractRegistry({
        manifestPath: this.datalexManifestPath,
      });
    }
    return this._datalexRegistry;
  }

  refresh(): void {
    const dbtManifestPath = resolveDbtManifestPath(this.projectRoot) ?? undefined;
    this._manifest = buildManifest({
      projectRoot: this.projectRoot,
      dqlVersion: this.dqlVersion,
      dbtManifestPath,
    });

    const config = loadProjectConfig(this.projectRoot);
    const semanticConfig = config.semanticLayer?.provider
      ? config.semanticLayer as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0]
      : config.semanticLayer?.path
        ? { provider: 'dql' as const, path: config.semanticLayer.path }
        : undefined;
    const resolved = resolveSemanticLayerWithDiagnostics(semanticConfig, this.projectRoot);
    if (resolved.layer) {
      this._semanticLayer = resolved.layer;
    } else if (config.dbt?.projectDir) {
      this._semanticLayer = resolveSemanticLayerWithDiagnostics({
        provider: 'dbt',
        projectPath: config.dbt.projectDir,
      }, this.projectRoot).layer ?? new SemanticLayer();
    } else {
      this._semanticLayer = new SemanticLayer();
    }

    this._lineage = null;
    this._datalexRegistry?.reload();
  }
}

function buildGraphFromManifest(manifest: DQLManifest): LineageGraph {
  const graph = new LineageGraph();
  for (const node of manifest.lineage.nodes) {
    graph.addNode({
      id: node.id,
      type: node.type as LineageNodeType,
      name: node.name,
      layer: node.layer as LineageLayer | undefined,
      domain: node.domain,
      owner: node.owner,
      status: node.status as 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification' | undefined,
      metadata: {
        ...(node.metadata ?? {}),
        ...(node.filePath ? { filePath: node.filePath } : {}),
      },
      columns: node.columns,
    });
  }
  for (const edge of manifest.lineage.edges) {
    graph.addEdge({
      source: edge.source,
      target: edge.target,
      type: edge.type as LineageEdgeType,
      sourceDomain: edge.sourceDomain,
      targetDomain: edge.targetDomain,
    });
  }
  return graph;
}

/** Walk up from `startDir` until a `dql.config.json` is found, else return `startDir`. */
export function findProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, 'dql.config.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}
