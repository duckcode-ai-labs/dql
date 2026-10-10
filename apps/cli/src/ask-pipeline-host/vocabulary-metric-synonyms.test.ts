import { describe, expect, it } from 'vitest';
import type { SemanticLayer } from '@duckcodeailabs/dql-core';
import { buildVocabularyIndex } from '@duckcodeailabs/dql-agent';
import { buildVocabularySource } from './vocabulary-source.js';

/** A dbt metric's `config.meta.synonyms` reach Ask's vocabulary as aliases of the metric itself. */
describe('metric synonyms from dbt reach the Ask vocabulary', () => {
  const metric = {
    name: 'average_claimed_amount', cube: 'claims', semanticModelIds: ['claims'], metricType: 'simple', typeParams: { measure: { name: 'average_claimed_amount' } },
    label: 'Average claimed amount', description: '', sql: 'claimed_amount', type: 'avg', table: '', aggregation: 'simple', synonyms: ['avg claim', 'mean claim size'],
  };
  const layer = {
    listCubes: () => [{ name: 'claims', table: 'main.claims', dimensions: [{ name: 'reported_date', type: 'timestamp' }], measures: [{ name: 'average_claimed_amount' }] }],
    listMetrics: () => [metric],
    listMeasures: () => [{ name: 'average_claimed_amount', cube: 'claims', agg: 'average', expr: 'claimed_amount', label: 'Average claimed amount', description: '' }],
    listTimeDimensions: () => [],
    listDimensions: () => [],
    listEntities: () => [],
    listSemanticModels: () => [{ name: 'claims', defaults: { agg_time_dimension: 'reported_date' } }],
    findJoinPath: () => [],
    displayFormatFor: () => undefined,
  } as unknown as SemanticLayer;

  it('carries the synonyms on the metric entry as aliases', () => {
    const source = buildVocabularySource({ manifest: undefined, semanticLayer: layer, relations: [] } as never);
    const entry = source.metrics!.find((item) => item.name === 'average_claimed_amount')!;
    expect(entry.aliases).toEqual(['avg claim', 'mean claim size']);
    const index = buildVocabularyIndex(source);
    const found = index.entries.find((candidate) => candidate.kind === 'metric' && candidate.name === 'average_claimed_amount');
    expect(found?.aliases).toEqual(expect.arrayContaining(['avg claim', 'mean claim size']));
  });

  it('adds no aliases for a metric that has no synonyms', () => {
    const plain = { ...metric, synonyms: undefined };
    const source = buildVocabularySource({ manifest: undefined, semanticLayer: { ...layer, listMetrics: () => [plain] } as unknown as SemanticLayer, relations: [] } as never);
    expect(source.metrics!.find((item) => item.name === 'average_claimed_amount')!.aliases).toBeUndefined();
  });
});
