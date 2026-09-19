/**
 * Draft a model from the warehouse itself (RFC 0007, `dql model discover` in
 * warehouse-first and hybrid modeling).
 *
 * The warehouse catalog snapshot already holds what a person would use to
 * draw the map by hand: tables and their comments, declared primary and
 * foreign keys, view definitions that join tables, and column names that say
 * which table they point at. This turns that evidence into draft domains,
 * entities and relationships, each relationship citing why it was proposed.
 * Optionally it asks the warehouse how each join behaves, with the same one
 * statement the Modeling page's Validate uses, and proposes the cardinality it
 * saw. Everything stays a draft: AI and heuristics draft, people certify.
 */

import {
  resolveWarehouseRelation,
  type DQLManifest,
  type ManifestFanoutPolicy,
  type ManifestRelationshipCardinality,
  type ManifestRelationshipValidationEvidence,
  type ModelingAuthoringChange,
  type WarehouseCatalogRelationV1,
  type WarehouseCatalogSnapshotV1,
} from '@duckcodeailabs/dql-core';
import { profileRelationshipOnWarehouse, suggestRelationshipKeys } from '@duckcodeailabs/dql-agent';

export type RelationshipEvidenceSource = 'declared_foreign_key' | 'view_join' | 'query_history' | 'shared_key' | 'named_for_table' | 'same_name';

/** A join seen in the warehouse's recent query history, and how often. */
export interface ObservedJoin {
  left: { relation: string; column: string };
  right: { relation: string; column: string };
  count: number;
}

export interface DiscoveredDomain {
  id: string;
  name: string;
  /** Already a Domain Package in the project. */
  existing: boolean;
}

export interface DiscoveredEntity {
  id: string;
  domain: string;
  relationId: string;
  relation: string;
  kind: WarehouseCatalogRelationV1['kind'];
  businessName: string;
  description?: string;
  grain?: string;
  keys: string[];
  /** Where the grain came from: a declared primary key, or a naming-convention column the warehouse showed unique. */
  grainSource?: 'primary_key' | 'unique_column';
  /** A naming-convention key not yet shown unique; the grain stays unset until it is. */
  grainCandidate?: string;
  /** The qualified id of the entity that already binds this relation. */
  existing?: string;
}

export interface DiscoveredRelationship {
  id: string;
  domain: string;
  from: string;
  to: string;
  fromDomain: string;
  toDomain: string;
  fromRelation: string;
  toRelation: string;
  keys: Array<{ from: string; to: string }>;
  evidence: Array<{ source: RelationshipEvidenceSource; reason: string }>;
  cardinality: ManifestRelationshipCardinality;
  fanout: ManifestFanoutPolicy;
  /** From the warehouse, when discovery ran with validation. */
  validation?: ManifestRelationshipValidationEvidence;
  /** Why validation could not run for this relationship. */
  validationError?: string;
}

export interface WarehouseDiscoveryReport {
  catalogFingerprint: string;
  capturedAt: string;
  relations: number;
  domains: DiscoveredDomain[];
  entities: DiscoveredEntity[];
  relationships: DiscoveredRelationship[];
  /** Relationships already modeled, left alone. */
  existingRelationships: number;
  /** The modeled joins as `<relation id>|<relation id>|<from>=<to>` (lower case), so later checks leave them alone too. */
  modeledJoins?: string[];
  validated: boolean;
  /** Opt-in query-history evidence: how much was read, or why it could not be. */
  queryHistory?: { statements: number; joins: number } | { error: string };
}

const EVIDENCE_ORDER: RelationshipEvidenceSource[] = ['declared_foreign_key', 'view_join', 'query_history', 'shared_key', 'named_for_table', 'same_name'];
/** Column types that are never join keys: measures, flags and timestamps. */
const NON_KEY_TYPE = /^(double|float|real|decimal|numeric|money|bool|boolean|date|time|timestamp|datetime|interval|json|jsonb|blob|bytea|array|struct|map)/i;
/** A name shared by this many tables or more is an audit or housekeeping column, not a key. */
const MAX_TABLES_SHARING_A_KEY = 12;
/** Share of the referencing side's values that may be missing on the unique side. */
const MAX_UNMATCHED_SHARE = 0.05;

/**
 * Whether reading a relation costs no more than reading a table: a base
 * table, or a view that only projects one relation (no join, grouping,
 * aggregate, window or union). A view that joins or aggregates can take
 * minutes to compute, so the data checks leave it out; its joins are still
 * drafted from declared keys, view SQL and names, for a person to validate.
 */
export function cheapToRead(relation: WarehouseCatalogRelationV1): boolean {
  if (relation.kind === 'table') return true;
  if (relation.kind !== 'view' || !relation.viewSql) return false;
  const body = relation.viewSql.replace(/'[^']*'/g, "''");
  return !/\b(join|group\s+by|having|distinct|union|intersect|except|over\s*\(|window)\b/i.test(body)
    && !/\b(sum|count|avg|min|max|median|array_agg|string_agg|listagg|group_concat)\s*\(/i.test(body)
    && (body.match(/\bfrom\b/gi) ?? []).length === 1;
}
/** A join seen fewer times than this in query history is noise, not evidence. */
const MIN_OBSERVED_JOINS = 2;
const GENERIC_SCHEMAS = new Set(['main', 'public', 'dbo', 'default']);
const TABLE_PREFIX = /^(stg|dim|fct|fact|int|base|raw|src|tbl|vw|v)_+/i;

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(cleaned) ? cleaned : `t_${cleaned || 'relation'}`;
}

function singular(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('sses') || name.endsWith('xes') || name.endsWith('ches') || name.endsWith('shes')) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

function baseName(relation: WarehouseCatalogRelationV1): string {
  return singular(relation.name.toLowerCase().replace(TABLE_PREFIX, ''));
}

function titleCase(value: string): string {
  return value.split(/[_\s]+/).filter(Boolean).map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(' ');
}

function columnNamed(relation: WarehouseCatalogRelationV1, name: string): string | undefined {
  return relation.columns.find((column) => column.name.toLowerCase() === name.toLowerCase())?.name;
}

/** Draft domains, entities and relationships from the catalog snapshot. Pure: reads nothing else. */
export function discoverWarehouseModel(input: {
  snapshot: WarehouseCatalogSnapshotV1;
  manifest?: DQLManifest;
  /** Put every entity into this one domain. */
  domain?: string;
  /** Names the domain of a generic schema such as `main` or `public`. */
  projectName?: string;
  /** Existing Domain Package ids. */
  existingDomains?: Iterable<string>;
  /** Opt-in: joins seen in recent query history. */
  observedJoins?: ObservedJoin[];
}): WarehouseDiscoveryReport {
  const { snapshot } = input;
  const existingDomains = new Set(input.existingDomains ?? []);
  const boundEntities = new Map<string, { qualifiedId: string; localId: string; domain: string }>();
  for (const entity of Object.values(input.manifest?.modeling?.entities ?? {})) {
    if (entity.dbtUniqueId) boundEntities.set(entity.dbtUniqueId, { qualifiedId: entity.qualifiedId ?? entity.id, localId: entity.localId ?? entity.id, domain: entity.domain });
  }

  const domainOf = (relation: WarehouseCatalogRelationV1): string => {
    if (input.domain) return slug(input.domain);
    const schema = relation.schema?.toLowerCase();
    if (!schema || GENERIC_SCHEMAS.has(schema)) return slug(input.projectName ?? 'warehouse');
    return slug(schema);
  };

  // Entities: one per relation, named for what a row is.
  const entities: DiscoveredEntity[] = [];
  const byRelationId = new Map<string, DiscoveredEntity>();
  const usedIds = new Map<string, Set<string>>();
  for (const relation of snapshot.relations) {
    const bound = boundEntities.get(relation.id);
    const domain = bound?.domain ?? domainOf(relation);
    const taken = usedIds.get(domain) ?? new Set<string>();
    usedIds.set(domain, taken);
    let id = bound?.localId ?? slug(baseName(relation));
    if (!bound && taken.has(id)) id = slug(relation.name);
    if (!bound && taken.has(id)) id = slug(`${relation.schema ?? ''}_${relation.name}`);
    taken.add(id);
    const primaryKey = relation.primaryKey ?? [];
    const candidate = primaryKey.length === 0
      ? columnNamed(relation, `${baseName(relation)}_id`) ?? columnNamed(relation, 'id')
      : undefined;
    const entity: DiscoveredEntity = {
      id,
      domain,
      relationId: relation.id,
      relation: relation.relation,
      kind: relation.kind,
      businessName: titleCase(baseName(relation)),
      ...(relation.comment ? { description: relation.comment } : {}),
      ...(primaryKey.length ? { grain: primaryKey.join(', '), grainSource: 'primary_key' as const } : {}),
      keys: primaryKey,
      ...(candidate ? { grainCandidate: candidate } : {}),
      ...(bound ? { existing: bound.qualifiedId } : {}),
    };
    entities.push(entity);
    byRelationId.set(relation.id, entity);
  }

  // Relationships: many-to-one from the table that holds the reference.
  const candidates = new Map<string, DiscoveredRelationship>();
  const identifyingKey = (relation: WarehouseCatalogRelationV1, columns: string[]): boolean => {
    const pk = (relation.primaryKey ?? []).map((column) => column.toLowerCase()).sort().join(',');
    return pk.length > 0 && pk === columns.map((column) => column.toLowerCase()).sort().join(',');
  };
  const propose = (
    from: WarehouseCatalogRelationV1,
    to: WarehouseCatalogRelationV1,
    keys: Array<{ from: string; to: string }>,
    source: RelationshipEvidenceSource,
    reason: string,
  ): void => {
    if (from.id === to.id || keys.length === 0) return;
    const fromEntity = byRelationId.get(from.id)!;
    const toEntity = byRelationId.get(to.id)!;
    const signature = `${from.id}|${to.id}|${keys.map((pair) => `${pair.from.toLowerCase()}=${pair.to.toLowerCase()}`).sort().join('&')}`;
    const current = candidates.get(signature);
    if (current) {
      if (!current.evidence.some((item) => item.source === source)) current.evidence.push({ source, reason });
      return;
    }
    const toIsIdentified = identifyingKey(to, keys.map((pair) => pair.to));
    candidates.set(signature, {
      id: '',
      domain: fromEntity.domain,
      from: fromEntity.id,
      to: toEntity.id,
      fromDomain: fromEntity.domain,
      toDomain: toEntity.domain,
      fromRelation: from.relation,
      toRelation: to.relation,
      keys,
      evidence: [{ source, reason }],
      // A reference to the other table's declared key reads many-to-one; the
      // warehouse profile confirms or corrects it.
      cardinality: toIsIdentified ? 'many_to_one' : 'unknown',
      fanout: toIsIdentified ? 'safe' : 'unknown',
    });
  };

  for (const relation of snapshot.relations) {
    for (const foreignKey of relation.foreignKeys ?? []) {
      const target = resolveWarehouseRelation(snapshot, foreignKey.references.relation).relation;
      if (!target || foreignKey.columns.length !== foreignKey.references.columns.length) continue;
      propose(relation, target, foreignKey.columns.map((column, index) => ({ from: column, to: foreignKey.references.columns[index]! })), 'declared_foreign_key', `${relation.name} declares a foreign key${foreignKey.name ? ` (${foreignKey.name})` : ''} on ${foreignKey.columns.join(', ')} to ${target.name}`);
    }
  }

  for (const view of snapshot.relations) {
    if (!view.viewSql) continue;
    for (const join of viewJoins(view.viewSql)) {
      const left = resolveWarehouseRelation(snapshot, join.left.relation).relation;
      const right = resolveWarehouseRelation(snapshot, join.right.relation).relation;
      if (!left || !right || left.id === right.id) continue;
      if (!columnNamed(left, join.left.column) || !columnNamed(right, join.right.column)) continue;
      const leftKey = columnNamed(left, join.left.column)!;
      const rightKey = columnNamed(right, join.right.column)!;
      // The side joined on its own declared key is the "one" side.
      const [from, to, keys] = identifyingKey(left, [leftKey]) && !identifyingKey(right, [rightKey])
        ? [right, left, [{ from: rightKey, to: leftKey }]] as const
        : [left, right, [{ from: leftKey, to: rightKey }]] as const;
      propose(from, to, [...keys], 'view_join', `view ${view.name} joins ${from.name}.${keys[0]!.from} = ${to.name}.${keys[0]!.to}`);
    }
  }

  // Query history (opt-in): joins people already run, seen often enough.
  for (const observed of input.observedJoins ?? []) {
    if (observed.count < MIN_OBSERVED_JOINS) continue;
    const left = resolveWarehouseRelation(snapshot, observed.left.relation).relation;
    const right = resolveWarehouseRelation(snapshot, observed.right.relation).relation;
    if (!left || !right || left.id === right.id) continue;
    const leftKey = columnNamed(left, observed.left.column);
    const rightKey = columnNamed(right, observed.right.column);
    if (!leftKey || !rightKey) continue;
    const [from, to, keys] = identifyingKey(left, [leftKey]) && !identifyingKey(right, [rightKey])
      ? [right, left, [{ from: rightKey, to: leftKey }]] as const
      : [left, right, [{ from: leftKey, to: rightKey }]] as const;
    propose(from, to, [...keys], 'query_history', `recent queries joined ${from.name}.${keys[0]!.from} = ${to.name}.${keys[0]!.to} ${observed.count} times`);
  }

  // Naming: `customer_id` on orders points at customers.
  const byBaseName = new Map<string, WarehouseCatalogRelationV1[]>();
  for (const relation of snapshot.relations) {
    // Views count as much as tables: dbt builds models as views by default.
    const name = baseName(relation);
    byBaseName.set(name, [...(byBaseName.get(name) ?? []), relation]);
  }
  for (const relation of snapshot.relations) {
    // Views count as much as tables: dbt builds models as views by default.
    for (const column of relation.columns) {
      const match = /^(.+?)_(id|key|code|number|no)$/i.exec(column.name);
      if (!match) continue;
      const named = singular(match[1]!.toLowerCase());
      const candidates = (byBaseName.get(named) ?? []).filter((target) => target.id !== relation.id);
      // `products` beats `stg_products` for product_id; otherwise an
      // ambiguous name (two schemas, two prefixes) is left for a person.
      const exact = candidates.filter((target) => singular(target.name.toLowerCase()) === named);
      const targets = exact.length === 1 ? exact : candidates;
      if (targets.length !== 1) continue;
      const target = targets[0]!;
      const suggestion = suggestRelationshipKeys({
        fromColumns: relation.columns.map((item) => item.name),
        toColumns: target.columns.map((item) => item.name),
        fromRelation: relation.relation,
        toRelation: target.relation,
      }).find((item) => item.keys.length === 1 && item.keys[0]!.from.toLowerCase() === column.name.toLowerCase() && item.source !== 'dbt_test');
      if (!suggestion) continue;
      // A shared name is evidence only when it is the other table's key.
      if (suggestion.source === 'same_name' && !identifyingKey(target, [suggestion.keys[0]!.to]) && baseName(target) !== singular(match[1]!.toLowerCase())) continue;
      propose(relation, target, suggestion.keys, suggestion.source as RelationshipEvidenceSource, suggestion.reason);
    }
  }

  // Leave relationships that are already modeled alone.
  const modeled = new Set<string>();
  for (const relationship of Object.values(input.manifest?.modeling?.relationships ?? {})) {
    const fromEntity = input.manifest?.modeling?.entities[relationship.from];
    const toEntity = input.manifest?.modeling?.entities[relationship.to];
    if (!fromEntity?.dbtUniqueId || !toEntity?.dbtUniqueId) continue;
    const keys = relationship.keys.map((pair) => `${pair.from.toLowerCase()}=${pair.to.toLowerCase()}`).sort().join('&');
    modeled.add(`${fromEntity.dbtUniqueId}|${toEntity.dbtUniqueId}|${keys}`);
    modeled.add(`${toEntity.dbtUniqueId}|${fromEntity.dbtUniqueId}|${relationship.keys.map((pair) => `${pair.to.toLowerCase()}=${pair.from.toLowerCase()}`).sort().join('&')}`);
  }
  const relationships: DiscoveredRelationship[] = [];
  const relationshipIds = new Map<string, Set<string>>();
  let existingRelationships = 0;
  for (const [signature, relationship] of [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (modeled.has(signature)) {
      existingRelationships += 1;
      continue;
    }
    relationship.evidence.sort((a, b) => EVIDENCE_ORDER.indexOf(a.source) - EVIDENCE_ORDER.indexOf(b.source));
    const taken = relationshipIds.get(relationship.domain) ?? new Set<string>();
    relationshipIds.set(relationship.domain, taken);
    let id = slug(`${relationship.from}_to_${relationship.to}`);
    if (taken.has(id)) id = slug(`${relationship.from}_to_${relationship.to}_by_${relationship.keys.map((pair) => pair.from).join('_')}`);
    taken.add(id);
    relationships.push({ ...relationship, id });
  }

  const domainIds = [...new Set(entities.map((entity) => entity.domain))].sort();
  return {
    catalogFingerprint: snapshot.fingerprint,
    capturedAt: snapshot.capturedAt,
    relations: snapshot.relations.length,
    domains: domainIds.map((id) => ({ id, name: titleCase(id), existing: existingDomains.has(id) })),
    entities,
    relationships,
    existingRelationships,
    modeledJoins: [...modeled].map((signature) => signature.toLowerCase()).sort(),
    validated: false,
  };
}

/**
 * Ask the warehouse how each drafted join behaves and whether a naming-key
 * grain is unique. One statement per relationship (the Modeling page's
 * Validate statement) and one per grain candidate; metadata-free aggregates
 * only, never row values.
 */
/**
 * Joins the data proves, for a warehouse that declares no keys. A column name
 * shared by several tables is a key where it is unique and never null in one
 * of them, and a join where the other tables' values are found there (at most
 * 5% missing). Names are only where to look: whether a column is a key is
 * decided by the data, never by how it is spelled. Aggregates only.
 */
export async function inferSharedKeyJoins(
  report: WarehouseDiscoveryReport,
  snapshot: WarehouseCatalogSnapshotV1,
  execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  quote: (identifier: string) => string,
  options: { maxChecks?: number } = {},
): Promise<WarehouseDiscoveryReport> {
  const quoteRelation = (relation: string) => relation.split('.').map(quote).join('.');
  // Tables and simple views alike (dbt builds models as views by default);
  // a view that joins or aggregates is left out of the data checks.
  const tables = snapshot.relations.filter((relation) => relation.columns.length > 0 && cheapToRead(relation));
  const holders = new Map<string, Array<{ relation: WarehouseCatalogRelationV1; column: string }>>();
  for (const relation of tables) {
    for (const column of relation.columns) {
      if (column.type && NON_KEY_TYPE.test(column.type)) continue;
      const key = column.name.toLowerCase();
      holders.set(key, [...(holders.get(key) ?? []), { relation, column: column.name }]);
    }
  }
  const shared = [...holders.entries()].filter(([, list]) => list.length >= 2 && list.length <= MAX_TABLES_SHARING_A_KEY);
  if (shared.length === 0) return report;
  let checks = 0;
  const budget = options.maxChecks ?? 400;
  const num = (row: Record<string, unknown>, name: string) => Number(row[name] ?? row[name.toUpperCase()]);

  // 1. Which shared columns are unique and never null in which tables: one statement per table.
  const unique = new Set<string>();
  const byTable = new Map<string, Array<{ relation: WarehouseCatalogRelationV1; column: string }>>();
  for (const [, list] of shared) for (const item of list) byTable.set(item.relation.id, [...(byTable.get(item.relation.id) ?? []), item]);
  for (const items of byTable.values()) {
    if (checks++ >= budget) break;
    const relation = items[0]!.relation;
    const parts = items.map((item, index) => `COUNT(${quote(item.column)}) AS nn_${index}, COUNT(DISTINCT ${quote(item.column)}) AS nd_${index}`);
    try {
      const row = (await execute(`SELECT COUNT(*) AS row_count, ${parts.join(', ')} FROM ${quoteRelation(relation.relation)}`)).rows[0] ?? {};
      const rows = num(row, 'row_count');
      items.forEach((item, index) => {
        if (rows > 0 && num(row, `nn_${index}`) === rows && num(row, `nd_${index}`) === rows) unique.add(`${relation.id}|${item.column.toLowerCase()}`);
      });
    } catch { /* a table that cannot be read proposes nothing */ }
  }

  // 2. Containment: the other tables' values are found in the unique side.
  const entityOf = new Map(report.entities.map((entity) => [entity.relationId, entity]));
  // Joins already drafted in this report, or already modeled, are left alone
  // (either direction), identified by table id.
  const relationIdOf = new Map(report.entities.map((entity) => [`${entity.domain}::${entity.id}`, entity.relationId]));
  const known = new Set<string>(report.modeledJoins ?? []);
  for (const item of report.relationships) {
    const fromId = relationIdOf.get(`${item.fromDomain}::${item.from}`);
    const toId = relationIdOf.get(`${item.toDomain}::${item.to}`);
    if (fromId && toId) known.add(`${fromId}|${toId}|${item.keys.map((pair) => `${pair.from}=${pair.to}`).join('&')}`.toLowerCase());
  }
  const added: DiscoveredRelationship[] = [];
  const referencedBy = new Map<string, number>();
  for (const [, list] of shared) {
    const targets = list.filter((item) => unique.has(`${item.relation.id}|${item.column.toLowerCase()}`));
    for (const target of targets) {
      for (const source of list) {
        if (source.relation.id === target.relation.id) continue;
        // Two tables unique on the same column (a subtype and its parent): the
        // smaller one points at the larger, checked the same way.
        const sourceUnique = unique.has(`${source.relation.id}|${source.column.toLowerCase()}`);
        if (sourceUnique && targets.length > 1 && (source.relation.rowCountEstimate ?? 0) > (target.relation.rowCountEstimate ?? 0)) continue;
        if (checks++ >= budget) break;
        try {
          const row = (await execute(`SELECT COUNT(${quote(source.column)}) AS referencing, COUNT(CASE WHEN ${quote(source.column)} IS NOT NULL AND ${quote(source.column)} NOT IN (SELECT ${quote(target.column)} FROM ${quoteRelation(target.relation.relation)} WHERE ${quote(target.column)} IS NOT NULL) THEN 1 END) AS unmatched FROM ${quoteRelation(source.relation.relation)}`)).rows[0] ?? {};
          const referencing = num(row, 'referencing');
          const unmatched = num(row, 'unmatched');
          if (!(referencing > 0) || unmatched > referencing * MAX_UNMATCHED_SHARE) continue;
          const from = entityOf.get(source.relation.id);
          const to = entityOf.get(target.relation.id);
          if (!from || !to) continue;
          const signature = `${source.relation.id}|${target.relation.id}|${source.column}=${target.column}`.toLowerCase();
          const reverse = `${target.relation.id}|${source.relation.id}|${target.column}=${source.column}`.toLowerCase();
          if (known.has(signature) || known.has(reverse)) continue;
          known.add(signature);
          referencedBy.set(`${target.relation.id}|${target.column.toLowerCase()}`, (referencedBy.get(`${target.relation.id}|${target.column.toLowerCase()}`) ?? 0) + 1);
          added.push({
            id: '',
            domain: from.domain,
            from: from.id,
            to: to.id,
            fromDomain: from.domain,
            toDomain: to.domain,
            fromRelation: source.relation.relation,
            toRelation: target.relation.relation,
            keys: [{ from: source.column, to: target.column }],
            evidence: [{ source: 'shared_key', reason: `${target.column} is unique in ${target.relation.name}, and ${referencing - unmatched} of ${referencing} ${source.relation.name} values are found there` }],
            cardinality: sourceUnique ? 'one_to_one' : 'many_to_one',
            fanout: 'safe',
          });
        } catch { /* an unreadable pair proposes nothing */ }
      }
    }
  }

  // 3. A table's grain is the unique column other tables point at (the most-referenced one).
  const entities = report.entities.map((entity) => {
    if (entity.grain) return entity;
    const referenced = [...referencedBy.entries()].filter(([key]) => key.startsWith(`${entity.relationId}|`)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (referenced.length === 0) return entity;
    const column = tables.find((relation) => relation.id === entity.relationId)?.columns.find((item) => `${entity.relationId}|${item.name.toLowerCase()}` === referenced[0]![0])?.name;
    return column ? { ...entity, grain: column, keys: [column], grainSource: 'unique_column' as const } : entity;
  });

  // Ids as discovery names them: `<from>_to_<to>`, with the key when a pair has several.
  const taken = new Map<string, Set<string>>();
  for (const item of report.relationships) taken.set(item.domain, new Set([...(taken.get(item.domain) ?? []), item.id]));
  for (const item of added) {
    const ids = taken.get(item.domain) ?? new Set<string>();
    taken.set(item.domain, ids);
    let id = slug(`${item.from}_to_${item.to}`);
    if (ids.has(id)) id = slug(`${item.from}_to_${item.to}_by_${item.keys[0]!.from}`);
    ids.add(id);
    item.id = id;
  }
  return { ...report, entities, relationships: [...report.relationships, ...added] };
}

export async function validateWarehouseDiscovery(
  report: WarehouseDiscoveryReport,
  snapshot: WarehouseCatalogSnapshotV1,
  execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  quote: (identifier: string) => string,
  options: { maxRelationships?: number } = {},
): Promise<WarehouseDiscoveryReport> {
  // Joins the data proves come first, then every draft is checked the same way.
  report = await inferSharedKeyJoins(report, snapshot, execute, quote);
  const typesOf = new Map(snapshot.relations.map((relation) => [relation.relation, new Map(relation.columns.map((column) => [column.name.toLowerCase(), column.type?.toLowerCase()]))]));
  const quoteRelation = (relation: string) => relation.split('.').map(quote).join('.');
  const relationById = new Map(snapshot.relations.map((relation) => [relation.relation, relation]));
  const cheap = (relation: string) => { const found = relationById.get(relation); return found ? cheapToRead(found) : false; };
  const entities: DiscoveredEntity[] = [];
  for (const entity of report.entities) {
    if (entity.grain || !entity.grainCandidate || !cheap(entity.relation)) {
      entities.push(entity);
      continue;
    }
    try {
      const column = quote(entity.grainCandidate);
      const row = (await execute(`SELECT COUNT(*) AS row_count, COUNT(${column}) AS non_null_count, COUNT(DISTINCT ${column}) AS distinct_count FROM ${quoteRelation(entity.relation)}`)).rows[0] ?? {};
      const rows = Number(row.row_count ?? row.ROW_COUNT);
      const unique = rows > 0 && Number(row.non_null_count ?? row.NON_NULL_COUNT) === rows && Number(row.distinct_count ?? row.DISTINCT_COUNT) === rows;
      entities.push(unique ? { ...entity, grain: entity.grainCandidate, keys: [entity.grainCandidate], grainSource: 'unique_column' } : entity);
    } catch {
      entities.push(entity);
    }
  }
  const limit = options.maxRelationships ?? 200;
  const relationships: DiscoveredRelationship[] = [];
  for (const [index, relationship] of report.relationships.entries()) {
    if (index >= limit) {
      relationships.push({ ...relationship, validationError: `not validated: discovery validates at most ${limit} relationships per run` });
      continue;
    }
    if (!cheap(relationship.fromRelation) || !cheap(relationship.toRelation)) {
      relationships.push({ ...relationship, validationError: 'not validated: a view that joins or aggregates is only checked when a person validates it' });
      continue;
    }
    try {
      const keyTypes = relationship.keys.map((pair) => ({ from: typesOf.get(relationship.fromRelation)?.get(pair.from.toLowerCase()), to: typesOf.get(relationship.toRelation)?.get(pair.to.toLowerCase()) }));
      const profile = await profileRelationshipOnWarehouse({ fromRelation: relationship.fromRelation, toRelation: relationship.toRelation, keys: relationship.keys, keyTypes }, execute, quote);
      relationships.push({ ...relationship, cardinality: profile.proposed.cardinality, fanout: profile.proposed.fanout, validation: profile.evidence });
    } catch (error) {
      relationships.push({ ...relationship, validationError: error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : String(error) });
    }
  }
  return { ...report, entities, relationships, validated: true };
}

/** The reviewed-change batch that writes a discovery report as drafts. Existing entities and domains are kept as they are. */
export function warehouseDiscoveryChanges(report: WarehouseDiscoveryReport, options: { owner?: string } = {}): ModelingAuthoringChange[] {
  const changes: ModelingAuthoringChange[] = [];
  for (const domain of report.domains) {
    if (domain.existing) continue;
    changes.push({ operation: 'upsert_domain', value: { id: domain.id, name: domain.name, ...(options.owner ? { owner: options.owner } : {}), description: 'Drafted from the warehouse catalog; review before governance use.' } });
  }
  for (const entity of report.entities) {
    if (entity.existing) continue;
    changes.push({
      operation: 'upsert_entity',
      value: {
        id: entity.id,
        domain: entity.domain,
        dbtModel: entity.relationId,
        businessName: entity.businessName,
        ...(entity.description ? { businessContext: entity.description } : {}),
        ...(entity.grain ? { grain: entity.grain, keys: entity.keys } : {}),
        status: 'draft',
      },
    });
  }
  for (const relationship of report.relationships) {
    const crossDomain = relationship.fromDomain !== relationship.toDomain;
    changes.push({
      operation: 'upsert_relationship',
      value: {
        id: relationship.id,
        domain: relationship.domain,
        // The relationship lives in the "from" entity's domain.
        from: relationship.from,
        to: crossDomain ? `${relationship.toDomain}::entity::${relationship.to}` : relationship.to,
        keys: relationship.keys,
        cardinality: relationship.cardinality,
        fanout: relationship.fanout,
        status: 'draft',
        ...(crossDomain ? { crossDomain: true } : {}),
        rationale: relationship.evidence.map((item) => item.reason).join('; '),
        ...(relationship.validation ? { validation: relationship.validation } : {}),
      },
    });
  }
  return changes;
}

interface ViewJoin {
  left: { relation: string; column: string };
  right: { relation: string; column: string };
}

/**
 * The equality joins a view's SQL states, as relation.column pairs. A small
 * reader for the common `FROM a [AS] x JOIN b [AS] y ON x.c = y.d` shape; a
 * statement it cannot read yields nothing rather than a guess.
 */
export function viewJoins(sql: string): ViewJoin[] {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  const identifier = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
  const qualified = `${identifier}(?:\\s*\\.\\s*${identifier}){0,2}`;
  const reserved = new Set(['on', 'using', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'where', 'group', 'order', 'limit', 'natural', 'lateral', 'union', 'having', 'window', 'qualify']);
  const aliases = new Map<string, string>();
  // The alias may not be a keyword: `FROM a JOIN b` has no alias, and reading
  // JOIN as one would swallow the next table.
  const notKeyword = `(?!(?:${[...reserved].join('|')})\\b)`;
  const tableRef = new RegExp(`\\b(?:from|join)\\s+(${qualified})(?:\\s+(?:as\\s+)?${notKeyword}(${identifier}))?`, 'gi');
  const clean = (value: string) => value.replace(/["`\[\]]/g, '').replace(/\s*\.\s*/g, '.');
  for (const match of text.matchAll(tableRef)) {
    const relation = clean(match[1]!);
    if (relation.startsWith('(')) continue;
    const alias = match[2] ? clean(match[2]) : undefined;
    aliases.set((alias ?? relation.split('.').pop()!).toLowerCase(), relation);
    aliases.set(relation.toLowerCase(), relation);
  }
  const joins: ViewJoin[] = [];
  const condition = new RegExp(`(${qualified})\\s*\\.\\s*(${identifier})\\s*=\\s*(${qualified})\\s*\\.\\s*(${identifier})`, 'g');
  for (const on of text.matchAll(/\bon\b(.*?)(?=\b(?:join|left|right|inner|full|cross|where|group|order|limit|union|having|qualify)\b|\)|$)/gi)) {
    for (const match of on[1]!.matchAll(condition)) {
      const leftRelation = aliases.get(clean(match[1]!).toLowerCase());
      const rightRelation = aliases.get(clean(match[3]!).toLowerCase());
      if (!leftRelation || !rightRelation) continue;
      joins.push({ left: { relation: leftRelation, column: clean(match[2]!) }, right: { relation: rightRelation, column: clean(match[4]!) } });
    }
  }
  return joins;
}

/**
 * The statement that lists recent query text a warehouse role can see, per
 * driver; undefined where the warehouse keeps no readable history.
 */
export function queryHistorySql(driver: string, options: { database?: string; location?: string; limit?: number } = {}): string | undefined {
  const limit = Math.max(1, Math.min(options.limit ?? 5_000, 20_000));
  const d = driver.toLowerCase();
  if (d === 'snowflake') {
    const db = options.database ? `"${options.database.replace(/"/g, '""')}".` : '';
    return `SELECT query_text FROM TABLE(${db}INFORMATION_SCHEMA.QUERY_HISTORY(RESULT_LIMIT => ${Math.min(limit, 10_000)})) WHERE execution_status = 'SUCCESS' AND query_type = 'SELECT' AND query_text ILIKE '%join%'`;
  }
  // pg_stat_statements keeps normalized text, with literals already replaced by $n.
  if (d === 'postgres' || d === 'postgresql') return `SELECT query AS query_text FROM pg_stat_statements WHERE query ILIKE '%join%' ORDER BY calls DESC LIMIT ${limit}`;
  if (d === 'databricks') return `SELECT statement_text AS query_text FROM system.query.history WHERE statement_type = 'SELECT' AND execution_status = 'FINISHED' AND lower(statement_text) LIKE '%join%' ORDER BY start_time DESC LIMIT ${limit}`;
  if (d === 'bigquery') {
    const region = `region-${(options.location ?? 'US').toLowerCase()}`;
    return `SELECT query AS query_text FROM \`${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT WHERE statement_type = 'SELECT' AND state = 'DONE' AND error_result IS NULL AND creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY) AND LOWER(query) LIKE '%join%' LIMIT ${limit}`;
  }
  return undefined;
}

/**
 * Count the equality joins in a set of query texts. The text is read in
 * memory and dropped: only which columns were joined, and how often, is kept.
 */
export function observedJoinsFromQueries(texts: Iterable<string>): ObservedJoin[] {
  const counts = new Map<string, ObservedJoin>();
  for (const text of texts) {
    const seen = new Set<string>();
    for (const join of viewJoins(text)) {
      const sides = [join.left, join.right].map((side) => ({ relation: side.relation.toLowerCase(), column: side.column.toLowerCase() }))
        .sort((a, b) => `${a.relation}.${a.column}`.localeCompare(`${b.relation}.${b.column}`));
      const signature = sides.map((side) => `${side.relation}.${side.column}`).join('=');
      // A statement counts once per join, however often it repeats the join.
      if (seen.has(signature)) continue;
      seen.add(signature);
      const current = counts.get(signature);
      if (current) current.count += 1;
      else counts.set(signature, { left: sides[0]!, right: sides[1]!, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}
