/**
 * Grounded-SQL metadata tools (spec 15.5) — thin wrappers over the dbt catalog
 * + the shared sql-grounding so EXTERNAL agents look up the same context the
 * notebook build path uses:
 *
 *   - `search_metadata`   — rank dbt tables relevant to a request, with their
 *                           qualified relation + {{ ref() }} form.
 *   - `get_table_schema`  — the qualified relation, {{ ref() }} form, real
 *                           columns + types, and join keys for a table.
 *   - `validate_sql`      — validate a SQL string references ONLY known
 *                           relations/columns, returning the precise miss.
 *
 * All three load dbt artifacts read-only and never write. They degrade
 * gracefully (a clear hint) when no dbt manifest is present.
 */

import { resolveDbtManifestPath } from '@zlens/core';
import {
  buildSchemaGrounding,
  loadDbtArtifacts,
  relationKeys,
  selectRelevantModels,
  validateSqlAgainstGrounding,
  validateAnalyticalSql,
  planAnalyticalPath,
  assessAnalyticalRelationship,
  resolveDomainContextEnvelope,
  type DbtArtifacts,
} from '@zlens/agent';
import type { DQLContext } from '../context.js';
import { zodInputShapeForTool } from '../tool-schema.js';

/** Load dbt artifacts for the project, or undefined when no manifest exists. */
function loadArtifacts(ctx: DQLContext): DbtArtifacts | undefined {
  const manifestPath = resolveDbtManifestPath(ctx.projectRoot);
  if (!manifestPath) return undefined;
  try {
    return loadDbtArtifacts(manifestPath);
  } catch {
    return undefined;
  }
}

const NO_MANIFEST_HINT =
  'No dbt manifest was found. Run `dbt compile`/`dbt build` (or `zlens sync dbt`) so target/manifest.json exists.';

// ─── search_metadata ──────────────────────────────────────────────────────────

export const searchMetadataInput = zodInputShapeForTool('search_metadata');

export async function searchMetadata(ctx: DQLContext, args: { query: string; limit?: number }) {
  const artifacts = loadArtifacts(ctx);
  if (!artifacts) return { tables: [], hint: NO_MANIFEST_HINT };
  const topK = args.limit ?? 12;
  const relevant = await selectRelevantModels(artifacts, args.query, { topK });
  const grounding = buildSchemaGrounding(artifacts, relevant, { limit: topK });
  return {
    total: grounding.tables.length,
    tables: grounding.tables.map((table) => ({
      name: table.name,
      qualifiedRelation: table.qualifiedRelation,
      refForm: table.refForm ?? null,
      kind: table.kind,
      columnCount: table.columns.length,
      certifiedBlock: table.certifiedBlock ?? false,
    })),
  };
}

// ─── get_table_schema ─────────────────────────────────────────────────────────

export const getTableSchemaInput = zodInputShapeForTool('get_table_schema');

export function getTableSchema(ctx: DQLContext, args: { table: string }) {
  const artifacts = loadArtifacts(ctx);
  if (!artifacts) return { found: false, hint: NO_MANIFEST_HINT };
  // Ground the whole project so we can look up any relation and surface joins.
  const grounding = buildSchemaGrounding(artifacts, undefined, { limit: 500 });
  const keys = relationKeys(args.table);
  const table = keys.map((key) => grounding.byKey.get(key)).find(Boolean);
  if (!table) {
    return {
      found: false,
      hint: `Table "${args.table}" was not found. Use search_metadata to discover available relations.`,
    };
  }
  const joinKeys = grounding.joinKeys.filter(
    (join) =>
      join.leftRelation === table.qualifiedRelation || join.rightRelation === table.qualifiedRelation,
  );
  return {
    found: true,
    name: table.name,
    qualifiedRelation: table.qualifiedRelation,
    refForm: table.refForm ?? null,
    kind: table.kind,
    certifiedBlock: table.certifiedBlock ?? false,
    columns: table.columns.map((column) => ({ name: column.name, type: column.type ?? null, description: column.description ?? null })),
    joinKeys: joinKeys.map((join) => ({
      leftRelation: join.leftRelation,
      leftColumn: join.leftColumn,
      rightRelation: join.rightRelation,
      rightColumn: join.rightColumn,
      reason: join.reason,
      authorization: 'suggestion_only',
    })),
    governedRelationships: Object.values(ctx.manifest.modeling?.relationships ?? {})
      .filter((relationship) => {
        const entities = ctx.manifest.modeling?.entities ?? {};
        const fromNode = ctx.manifest.dbtProvenance?.nodes[entities[relationship.from]?.dbtUniqueId ?? ''];
        const toNode = ctx.manifest.dbtProvenance?.nodes[entities[relationship.to]?.dbtUniqueId ?? ''];
        return [fromNode?.name, fromNode?.relation, toNode?.name, toNode?.relation]
          .filter(Boolean)
          .some((value) => relationKeys(String(value)).some((key) => keys.includes(key)));
      })
      .map((relationship) => {
        const decision = assessAnalyticalRelationship(relationship, ctx.manifest);
        return {
          id: relationship.id,
          from: relationship.from,
          to: relationship.to,
          keys: relationship.keys,
          cardinality: relationship.cardinality,
          fanout: relationship.fanout,
          automaticJoinAllowed: relationship.automaticJoinAllowed,
          executableJoin: decision.executable,
          policyCode: decision.code ?? null,
          policyReason: decision.message,
          staleCertification: relationship.staleCertification,
        };
      }),
  };
}

// ─── validate_sql ─────────────────────────────────────────────────────────────

export const validateSqlInput = zodInputShapeForTool('validate_sql');

export async function validateSql(ctx: DQLContext, args: { sql: string; query?: string }) {
  const artifacts = loadArtifacts(ctx);
  if (!artifacts) {
    return { ok: false, code: 'no_schema', error: NO_MANIFEST_HINT, warnings: [] };
  }
  // Ground broadly (so a valid table is never wrongly flagged), optionally
  // ordered by the original request.
  const relevant = args.query ? await selectRelevantModels(artifacts, args.query, { topK: 500 }) : undefined;
  const grounding = buildSchemaGrounding(artifacts, relevant, { limit: 500 });
  const result = validateSqlAgainstGrounding(args.sql, grounding);
  if (result.ok) {
    const analyticalPolicy = validateAnalyticalSql(args.sql, ctx.manifest);
    if (!analyticalPolicy.safe) {
      return {
        ok: false,
        code: analyticalPolicy.code,
        error: analyticalPolicy.message,
        warnings: result.warnings,
        referencedRelations: result.referencedRelations,
        analyticalPolicy,
      };
    }
    return { ok: true, warnings: result.warnings, referencedRelations: result.referencedRelations, analyticalPolicy };
  }
  return {
    ok: false,
    code: result.code,
    error: result.error,
    warnings: result.warnings,
    referencedRelations: result.referencedRelations,
    offending: result.offending ?? null,
  };
}

export function resolveAnalyticalPath(ctx: DQLContext, args: {
  entities: string[];
  ownerDomain?: string;
  purpose?: string;
  measureEntities?: string[];
  dimensionEntities?: string[];
}) {
  const domainContext = args.ownerDomain
    ? resolveDomainContextEnvelope({
        manifest: ctx.manifest,
        activeDomain: args.ownerDomain,
        purpose: args.purpose,
        source: 'explicit_api',
      })
    : undefined;
  return planAnalyticalPath(ctx.manifest, {
    entityIds: args.entities,
    ownerDomain: args.ownerDomain,
    purpose: args.purpose,
    domainContext,
    measureEntities: args.measureEntities,
    dimensionEntities: args.dimensionEntities,
  });
}

export function explainRelationshipProof(ctx: DQLContext, args: { relationshipId: string }) {
  const relationships = ctx.manifest.modeling?.relationships ?? {};
  const direct = relationships[args.relationshipId];
  const matches = direct ? [direct] : Object.values(relationships).filter((value) =>
    value.qualifiedId === args.relationshipId || value.localId === args.relationshipId);
  const relationship = matches.length === 1 ? matches[0] : undefined;
  if (!relationship) {
    return { found: false, error: `Relationship "${args.relationshipId}" was not found in manifest v3.` };
  }
  const entities = ctx.manifest.modeling?.entities ?? {};
  const from = entities[relationship.from];
  const to = entities[relationship.to];
  const exports = ctx.manifest.modeling?.interfaces?.exports ?? {};
  const imports = ctx.manifest.modeling?.interfaces?.imports ?? {};
  const policy = assessAnalyticalRelationship(relationship, ctx.manifest);
  return {
    found: true,
    relationship,
    endpoints: {
      from: from ? { ...from, dbt: ctx.manifest.dbtProvenance?.nodes[from.dbtUniqueId] } : undefined,
      to: to ? { ...to, dbt: ctx.manifest.dbtProvenance?.nodes[to.dbtUniqueId] } : undefined,
    },
    interfaces: (relationship.importRefs ?? []).map((exportRef) => ({
      export: exports[exportRef],
      imports: Object.values(imports).filter((value) => value.exportRef === exportRef),
    })),
    decision: policy.executable ? 'automatic_join_allowed' : 'blocked_or_review_required',
    policy,
  };
}
