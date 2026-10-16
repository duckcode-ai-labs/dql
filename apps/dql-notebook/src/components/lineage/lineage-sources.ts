import type { LineageNode } from './lineage-constants';

/**
 * WHAT THE LINEAGE WAS BUILT FROM, read from the graph itself.
 *
 * The status bar used to say "Compiled from the dbt manifest" on every
 * project, including a warehouse-first one with no dbt at all, whose physical
 * nodes come from the synced warehouse catalog. The graph says which inputs
 * it holds: dbt nodes (`dbt_model`, `dbt_source`, ...) and entities bound to a
 * dbt unique id come from the dbt manifest; entities bound to a
 * `warehouse.<database>.<schema>.<name>` id come from the warehouse catalog
 * (RFC 0007). A hybrid project names both; dbt is named only when it is used.
 */
export interface LineageSources {
  dbtManifest: boolean;
  warehouseCatalog: boolean;
}

const DBT_UNIQUE_ID = /^(?:model|source|seed|snapshot|exposure|metric|semantic_model)\./;

function boundId(node: Pick<LineageNode, 'metadata'>): string | undefined {
  const metadata = node.metadata;
  const id = metadata?.dbtUniqueId ?? metadata?.uniqueId;
  return typeof id === 'string' ? id : undefined;
}

export function lineageSourcesOf(nodes: ReadonlyArray<Pick<LineageNode, 'type' | 'metadata'>>): LineageSources {
  let dbtManifest = false;
  let warehouseCatalog = false;
  for (const node of nodes) {
    const id = boundId(node);
    if (node.type.startsWith('dbt_') || (id !== undefined && DBT_UNIQUE_ID.test(id))) dbtManifest = true;
    if (id?.startsWith('warehouse.')) warehouseCatalog = true;
    if (dbtManifest && warehouseCatalog) break;
  }
  return { dbtManifest, warehouseCatalog };
}

/** The status bar's words for the sources. */
export function lineageSourcesLabel(sources: LineageSources): string {
  if (sources.dbtManifest && sources.warehouseCatalog) return 'Compiled from the dbt manifest and the synced warehouse catalog';
  if (sources.dbtManifest) return 'Compiled from the dbt manifest';
  if (sources.warehouseCatalog) return 'Compiled from the synced warehouse catalog';
  return 'Compiled from the project files';
}
