import type { DbtNodeAuthoringDetail } from '@zlens/core';
import type { DbtModelInventoryItem } from '../../api/client';
import type { GovernanceStatus, SchemaColumn, SchemaTable } from '../../store/types';

export const DBT_DATABASE_PAGE_SIZE = 25;

export interface DbtDatabaseObject extends SchemaTable {
  dbtUniqueId: string;
  /** `warehouse` for a table or view read from the warehouse catalog (RFC 0007). */
  dbtResourceType: 'model' | 'source' | 'warehouse';
}

export type PhysicalDbtInventoryItem = DbtModelInventoryItem & { relation: string };

export function isPhysicalDbtInventoryItem(
  item: DbtModelInventoryItem,
): item is PhysicalDbtInventoryItem {
  return Boolean(item.relation?.trim());
}

/** Convert the bounded dbt inventory contract into the shared editor schema shape. */
export function dbtInventoryItemToTable(item: PhysicalDbtInventoryItem): DbtDatabaseObject {
  return {
    name: item.relation,
    path: item.relation,
    columns: [],
    source: 'database',
    objectType: item.resourceType === 'source' ? 'dbt_source' : item.resourceType === 'warehouse' ? 'table' : 'dbt_model',
    dbtUniqueId: item.uniqueId,
    dbtResourceType: item.resourceType,
    dbtSourcePath: item.sourcePath,
    governance: item.binding
      ? {
          domain: item.binding.domain,
          owner: item.binding.owner,
          status: normalizeGovernanceStatus(item.binding.status),
        }
      : undefined,
  };
}

/** Append a later page without duplicating relations or discarding lazy-loaded columns. */
export function mergeDbtDatabaseObjects(
  current: DbtDatabaseObject[],
  incoming: DbtDatabaseObject[],
): DbtDatabaseObject[] {
  const merged = new Map(current.map((table) => [table.dbtUniqueId, table] as const));
  for (const table of incoming) {
    const existing = merged.get(table.dbtUniqueId);
    merged.set(table.dbtUniqueId, existing
      ? {
          ...existing,
          ...table,
          columns: table.columns.length > 0 ? table.columns : existing.columns,
          expanded: existing.expanded,
        }
      : table);
  }
  return Array.from(merged.values());
}

/**
 * dbt owns names and documentation; the selected warehouse relation may add
 * physical types. Merge the two point-lookups case-insensitively, with no
 * account-wide column scan.
 */
export function mergeDbtAndWarehouseColumns(
  detail: DbtNodeAuthoringDetail,
  warehouseColumns: SchemaColumn[],
): SchemaColumn[] {
  const warehouseByName = new Map(
    warehouseColumns.map((column) => [column.name.toLowerCase(), column] as const),
  );
  const merged = detail.columns.map((column) => ({
    name: column.name,
    type: column.type ?? warehouseByName.get(column.name.toLowerCase())?.type ?? '',
  }));
  const seen = new Set(merged.map((column) => column.name.toLowerCase()));
  for (const column of warehouseColumns) {
    if (seen.has(column.name.toLowerCase())) continue;
    merged.push(column);
  }
  return merged;
}

export function databaseObjectDisplayName(relation: string): string {
  return relation.split('.').filter(Boolean).at(-1) ?? relation;
}

export function databaseObjectNamespace(relation: string): string {
  const parts = relation.split('.').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('.') : '';
}

function normalizeGovernanceStatus(value?: string): GovernanceStatus | undefined {
  if (value === 'draft' || value === 'review' || value === 'certified'
    || value === 'deprecated' || value === 'pending_recertification') return value;
  return undefined;
}
