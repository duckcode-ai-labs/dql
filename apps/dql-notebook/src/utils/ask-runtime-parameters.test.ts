import { describe, expect, it } from 'vitest';
import type { DqlArtifactReference } from '@zlens/core/artifacts';
import { addAskResultFilter, askArtifactStateKey, askResultFilterCandidates } from './ask-runtime-parameters';

const artifact: DqlArtifactReference = {
  kind: 'semantic_block',
  name: 'customers_by_location',
  source: `block "customers_by_location" {
  type = "semantic"
  metrics = ["customers", "revenue"]
  dimensions = ["customer_name", "locations.location_name"]
  params {
    top_n: number = 10
  }
  parameterPolicy {
    top_n = "dynamic"
  }
  filterBindings {
    top_n = "limit"
  }
}`,
  metrics: ['customers', 'revenue'],
  dimensions: ['customer_name', 'locations.location_name'],
  parameters: [{
    name: 'top_n',
    type: 'number',
    required: false,
    default: 10,
    policy: 'dynamic',
    binding: { kind: 'limit' },
  }],
  parameterValues: { top_n: 10 },
  persistence: 'transient',
  trustState: 'review_required',
  compiledSql: 'SELECT old_result',
  executionReceipt: {
    sourceFingerprint: 'a'.repeat(64),
    compiledSqlFingerprint: 'b'.repeat(64),
    parameterFingerprint: 'c'.repeat(64),
    resultFingerprint: 'd'.repeat(64),
  },
};

const result = {
  columns: ['customer_name', 'location_name', 'customers', 'revenue'],
  rows: [
    { customer_name: 'Anthony Murillo', location_name: 'Philadelphia', customers: 1, revenue: 1832 },
    { customer_name: 'Rebecca Roberson', location_name: 'Brooklyn', customers: 1, revenue: 476 },
  ],
};

describe('Ask result-column runtime parameters', () => {
  it('offers semantic dimensions and excludes metric result columns', () => {
    expect(askResultFilterCandidates(artifact, result)).toEqual([
      { column: 'customer_name', field: 'customer_name', values: ['Anthony Murillo', 'Rebecca Roberson'] },
      { column: 'location_name', field: 'locations.location_name', values: ['Philadelphia', 'Brooklyn'] },
    ]);
  });

  it('adds a dynamic DQL filter binding and clears the obsolete receipt', () => {
    const added = addAskResultFilter(artifact, result, 'location_name', 'Philadelphia');
    expect(added.parameterName).toBe('location_name');
    expect(added.artifact.source).toContain('location_name: string = "Philadelphia"');
    expect(added.artifact.source).toContain('location_name = "dynamic"');
    expect(added.artifact.source).toContain('location_name = "locations.location_name"');
    expect(added.artifact.parameterValues).toEqual({ top_n: 10, location_name: 'Philadelphia' });
    expect(added.artifact.executionReceipt).toBeUndefined();
    expect(added.artifact.compiledSql).toBeUndefined();
  });

  it('does not offer extra filters for saved or SQL-backed artifacts', () => {
    expect(askResultFilterCandidates({ ...artifact, persistence: 'saved' }, result)).toEqual([]);
    expect(askResultFilterCandidates({ ...artifact, kind: 'sql_block' }, result)).toEqual([]);
  });

  it('does not reset a transient parameter when an equivalent artifact object is rebuilt', () => {
    const equivalent = {
      ...artifact,
      parameters: artifact.parameters?.map((parameter) => ({ ...parameter })),
      parameterValues: { ...artifact.parameterValues },
      executionReceipt: { ...artifact.executionReceipt! },
    };
    expect(equivalent).not.toBe(artifact);
    expect(askArtifactStateKey(equivalent)).toBe(askArtifactStateKey(artifact));
    expect(askArtifactStateKey({
      ...equivalent,
      parameterValues: { ...equivalent.parameterValues, top_n: 9 },
    })).not.toBe(askArtifactStateKey(artifact));
  });
});
