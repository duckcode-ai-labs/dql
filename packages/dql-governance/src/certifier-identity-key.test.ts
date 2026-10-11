import { describe, expect, it } from 'vitest';
import { groupingIdentityGapOfSql } from '@duckcodeailabs/dql-core';
import type { BlockRecord } from '@duckcodeailabs/dql-project';
import { BUILTIN_RULES, Certifier } from './certifier.js';

const block = {
  id: 'b1', name: 'claims_by_adjuster', domain: 'claims', type: 'custom', version: '1.0.0', status: 'draft',
  gitRepo: '', gitPath: 'blocks/claims_by_adjuster.dql', gitCommitSha: '', owner: 'lena', tags: ['claims'], dependencies: [], usedInCount: 0,
  createdAt: new Date(), updatedAt: new Date(),
} as BlockRecord;

const SQL = 'SELECT adjuster_name, COUNT(*) AS n FROM claims GROUP BY adjuster_name';
const known = [{ relation: 'claims', columns: ['adjuster_id', 'adjuster_name'] }];
const passingTests = { passed: 1, failed: 0, skipped: 0, duration: 1, assertions: [], runAt: new Date() };

describe('groups-by-identity-key rule', () => {
  it('warns with the key but does not block certification', () => {
    const result = new Certifier().evaluate(block, passingTests, { groupingIdentityGap: groupingIdentityGapOfSql(SQL, known) });
    const warning = result.warnings.find((entry) => entry.rule === 'Block groups by an identity key');
    expect(warning?.message).toContain('Add adjuster_id (the key) to SELECT and GROUP BY.');
    expect(result.errors.some((entry) => entry.rule === 'Block groups by an identity key')).toBe(false);
  });

  it('is silent when the block is keyed or the grouping was not checked', () => {
    const keyed = groupingIdentityGapOfSql('SELECT adjuster_id, adjuster_name, COUNT(*) AS n FROM claims GROUP BY adjuster_id, adjuster_name', known);
    for (const context of [{ groupingIdentityGap: keyed }, undefined]) {
      const result = new Certifier().evaluate(block, passingTests, context);
      expect(result.warnings.some((entry) => entry.rule === 'Block groups by an identity key')).toBe(false);
    }
  });

  it('is a warning in the built-in rule set', () => {
    expect(BUILTIN_RULES.find((rule) => rule.id === 'groups-by-identity-key')?.severity).toBe('warning');
  });
});
