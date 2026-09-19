import { describe, expect, it } from 'vitest';
import type { DQLManifest } from '@duckcodeailabs/dql-core';
import { catalogKeyTypes, relationshipEvidenceFromRow, relationshipValidationSql, validateRelationshipOnWarehouse } from './relationship-validation.js';

const quote = (identifier: string) => `"${identifier}"`;
const spec = { fromRelation: 'analytics.marts.fct_orders', toRelation: 'analytics.marts.dim_customers', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one' as const, fanout: 'safe' as const };
const passingRow = { from_rows: 10, to_rows: 5, joined_rows: 10, from_null_keys: 0, to_null_keys: 0, unmatched_from: 0, max_from_per_key: 5, max_to_per_key: 1 };

describe('the one relationship proof', () => {
  it('asks the warehouse one statement: counts, null keys, rows per key on both sides, joined rows and rows the join would drop', () => {
    const sql = relationshipValidationSql(spec, quote);
    expect(sql).toContain('FROM "analytics"."marts"."fct_orders" f');
    expect(sql).toContain('JOIN "analytics"."marts"."dim_customers" t ON f."customer_id" = t."customer_id"');
    expect(sql).toContain('LEFT JOIN "analytics"."marts"."dim_customers" t ON f."customer_id" = t."customer_id" WHERE t."customer_id" IS NULL');
    for (const column of ['from_rows', 'to_rows', 'joined_rows', 'from_null_keys', 'to_null_keys', 'unmatched_from', 'max_from_per_key', 'max_to_per_key']) expect(sql).toContain(`AS ${column}`);
    expect(() => relationshipValidationSql({ ...spec, keys: [{ from: 'customer_id; drop table x', to: 'customer_id' }] }, quote)).toThrow();
    // The text (and so every existing proof's query fingerprint) is the same on every engine but
    // MySQL/MariaDB, where `rows` is reserved and the inner alias is renamed; the columns read back are unchanged.
    expect(relationshipValidationSql(spec, quote, 'snowflake')).toBe(sql);
    expect(sql).toContain('COUNT(*) AS rows');
    const mysql = relationshipValidationSql(spec, (identifier) => `\`${identifier}\``, 'mysql');
    expect(mysql).not.toMatch(/\bAS rows\b|\.rows\b/);
    expect(mysql).toContain('from_counts.row_total AS from_rows');
  });
  it('reads the same evidence whoever ran it, and the declared cardinality decides pass or fail', async () => {
    const checkedAt = new Date('2026-09-09T00:00:00.000Z');
    const sql = relationshipValidationSql(spec, quote);
    const direct = relationshipEvidenceFromRow(passingRow, spec, sql, checkedAt);
    const viaWarehouse = await validateRelationshipOnWarehouse(spec, async () => ({ rows: [passingRow] }), quote, checkedAt);
    expect(viaWarehouse).toEqual(direct);
    expect(direct).toMatchObject({ status: 'passed', fromRows: 10, toRows: 5, joinedRows: 10, unmatchedFrom: 0, maxToPerKey: 1 });
    // Upper-cased columns (Snowflake) read the same.
    const upper = Object.fromEntries(Object.entries(passingRow).map(([key, value]) => [key.toUpperCase(), value]));
    expect(relationshipEvidenceFromRow(upper, spec, sql, checkedAt)).toEqual(direct);
    // Two customers per key is not many_to_one; the evidence says so instead of hiding it.
    expect(relationshipEvidenceFromRow({ ...passingRow, max_to_per_key: 2 }, spec, sql, checkedAt).status).toBe('failed');
    expect(relationshipEvidenceFromRow(passingRow, { ...spec, fanout: 'attribution_required' }, sql, checkedAt).status).toBe('failed');
  });
  it('the proof fingerprint changes when a key data type changes, and is unchanged by types nobody knows', () => {
    const sql = relationshipValidationSql(spec, quote);
    const untyped = relationshipEvidenceFromRow(passingRow, spec, sql).proofFingerprint;
    const unknownTypes = relationshipEvidenceFromRow(passingRow, { ...spec, keyTypes: [{}] }, sql).proofFingerprint;
    const integer = relationshipEvidenceFromRow(passingRow, { ...spec, keyTypes: [{ from: 'integer', to: 'integer' }] }, sql).proofFingerprint;
    const varchar = relationshipEvidenceFromRow(passingRow, { ...spec, keyTypes: [{ from: 'integer', to: 'varchar' }] }, sql).proofFingerprint;
    expect(unknownTypes).toBe(untyped);
    expect(integer).not.toBe(untyped);
    expect(varchar).not.toBe(integer);
    expect(relationshipEvidenceFromRow(passingRow, { ...spec, keyTypes: [{ from: 'INTEGER', to: 'Integer' }] }, sql).proofFingerprint).toBe(integer);
  });
});

describe('catalogKeyTypes', () => {
  const manifest = {
    dbtProvenance: {
      manifestPath: '/project/target/manifest.json',
      nodes: {
        'model.commerce.fct_orders': { uniqueId: 'model.commerce.fct_orders', relation: 'analytics.marts.fct_orders' },
        'model.commerce.dim_customers': { uniqueId: 'model.commerce.dim_customers', relation: 'ANALYTICS.MARTS.DIM_CUSTOMERS' },
      },
    },
  } as unknown as DQLManifest;
  const catalog = {
    nodes: {
      'model.commerce.fct_orders': { columns: { customer_id: { type: 'INTEGER' }, order_id: { type: 'VARCHAR' } } },
      'model.commerce.dim_customers': { columns: { CUSTOMER_ID: { type: 'NUMBER(38,0)' } } },
    },
  };
  it('reads the join keys\' types from the catalog beside the manifest, matching relations and columns case-insensitively', () => {
    const paths: string[] = [];
    const types = catalogKeyTypes(manifest, spec, (path) => { paths.push(path); return catalog; });
    expect(paths).toEqual(['/project/target/catalog.json']);
    expect(types).toEqual([{ from: 'integer', to: 'number(38,0)' }]);
  });
  it('leaves every type unknown when the catalog, the manifest or the relation is missing', () => {
    expect(catalogKeyTypes(manifest, spec, () => undefined)).toEqual([{}]);
    expect(catalogKeyTypes(undefined, spec, () => catalog)).toEqual([{}]);
    expect(catalogKeyTypes(manifest, { ...spec, toRelation: 'analytics.marts.dim_products' }, () => catalog)).toEqual([{ from: 'integer', to: undefined }]);
  });
  it('reads a warehouse relation\'s key types from the warehouse catalog snapshot (RFC 0007)', () => {
    const warehouseManifest = {
      dbtProvenance: {
        manifestPath: '',
        warehouseCatalogPath: '.dql/warehouse-catalog.json',
        nodes: {
          'warehouse.analytics.marts.fct_orders': { uniqueId: 'warehouse.analytics.marts.fct_orders', resourceType: 'warehouse', relation: 'analytics.marts.fct_orders' },
          'warehouse.analytics.marts.dim_customers': { uniqueId: 'warehouse.analytics.marts.dim_customers', resourceType: 'warehouse', relation: 'ANALYTICS.MARTS.DIM_CUSTOMERS' },
        },
      },
    } as unknown as DQLManifest;
    const snapshot = {
      relations: [
        { id: 'warehouse.analytics.marts.fct_orders', columns: [{ name: 'CUSTOMER_ID', type: 'BIGINT' }] },
        { id: 'warehouse.analytics.marts.dim_customers', columns: [{ name: 'customer_id', type: 'BIGINT' }] },
      ],
    };
    const paths: string[] = [];
    expect(catalogKeyTypes(warehouseManifest, spec, (path) => { paths.push(path); return snapshot; }, '/project')).toEqual([{ from: 'bigint', to: 'bigint' }]);
    expect(paths).toEqual(['/project/.dql/warehouse-catalog.json']);
    // Without the project root the snapshot cannot be found; nothing is guessed.
    expect(catalogKeyTypes(warehouseManifest, spec, () => snapshot)).toEqual([{}]);
  });
});
