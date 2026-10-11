import { describe, expect, it } from 'vitest';
import { prefillCertificationMetadata } from './certification-prefill.js';

const skeleton = 'block "x" {\n  status = "draft"\n}\n';
const sql = 'SELECT adjuster_name, COUNT(*) AS n FROM claims GROUP BY adjuster_name';
const known = [{ relation: 'claims', columns: ['claim_id', 'adjuster_id', 'adjuster_name'] }];

describe('prefill suggests the identity key for a labels-only grouping', () => {
  it('suggests the key and leaves the SQL alone', () => {
    const withSql = 'block "x" {\n  status = "draft"\n  query = """\n' + sql + '\n"""\n}\n';
    const result = prefillCertificationMetadata(withSql, { knownRelations: known });
    expect(result.identityGap?.key).toBe('adjuster_id');
    expect(result.source).toContain(sql);
    expect(result.source).not.toMatch(/GROUP BY adjuster_id/);
  });

  it('works from the answer SQL when the draft has no query', () => {
    expect(prefillCertificationMetadata(skeleton, { sql, knownRelations: known }).identityGap?.key).toBe('adjuster_id');
  });

  it('suggests nothing for a keyed grouping or no SQL', () => {
    const keyed = 'SELECT adjuster_id, adjuster_name, COUNT(*) AS n FROM claims GROUP BY adjuster_id, adjuster_name';
    expect(prefillCertificationMetadata(skeleton, { sql: keyed, knownRelations: known }).identityGap).toBeUndefined();
    expect(prefillCertificationMetadata(skeleton, {}).identityGap).toBeUndefined();
  });
});
