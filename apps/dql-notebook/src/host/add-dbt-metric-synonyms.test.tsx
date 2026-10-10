import { describe, expect, it } from 'vitest';
import { dbtMetricSynonymTerm } from '../components/modeling/DbtFirstModelingPage';

describe('synonyms of a new dbt metric', () => {
  it('are saved unlinked while dbt has not parsed the metric, so the server accepts them', () => {
    const term = dbtMetricSynonymTerm({ label: '', metricName: 'average_claimed_amount', synonyms: ['avg claim'], domain: 'claims', linked: false });
    expect(term).toEqual({ name: 'Average Claimed Amount', termType: 'metric', synonyms: ['avg claim'], domain: 'claims' });
    expect(term).not.toHaveProperty('metricRefs');
  });

  it('are linked to the metric once dbt has parsed it', () => {
    const term = dbtMetricSynonymTerm({ label: 'Average claimed amount', metricName: 'average_claimed_amount', synonyms: ['avg claim'], domain: null, linked: true });
    expect(term).toEqual({ name: 'Average claimed amount', termType: 'metric', synonyms: ['avg claim'], metricRefs: ['average_claimed_amount'] });
  });
});
