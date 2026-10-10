import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddDbtMetricDrawer, canAddDbtMetric } from '../components/modeling/DbtFirstModelingPage';
import type { DbtFirstModelingResponse } from '../api/client';
import { themes } from '../themes/notebook-theme';
import type { HostUi } from './host-ui';

const hosted = (capabilities: Record<string, boolean>): HostUi => (
  { host: true, person: { id: 'u1', name: 'Cleo', kind: 'person' }, capabilities, links: [], answerActions: [] }
);

describe('Add metric needs project.write as well as dataset.author', () => {
  it('is offered in a draft space, where both are allowed', () => {
    expect(canAddDbtMetric(hosted({ 'project.read': true, 'dataset.author': true, 'project.write': true }))).toBe(true);
  });

  it('is hidden where the host refuses project.write, even if it allows dataset.author (Production follows main)', () => {
    expect(canAddDbtMetric(hosted({ 'project.read': true, 'dataset.author': true, 'project.write': false }))).toBe(false);
  });

  it('is hidden where the host refuses dataset.author', () => {
    expect(canAddDbtMetric(hosted({ 'project.read': true, 'dataset.author': false, 'project.write': true }))).toBe(false);
  });

  it('is always offered without a host (local OSS)', () => {
    expect(canAddDbtMetric({ host: false })).toBe(true);
  });
});

describe('synonyms are part of the previewed dbt YAML', () => {
  it('says the synonyms are saved in the dbt YAML, not as a separate glossary term', () => {
    const data = { snapshotId: 's', dbtProvenance: { nodes: {} }, modeling: { packages: {} } } as unknown as DbtFirstModelingResponse;
    const html = renderToStaticMarkup(<AddDbtMetricDrawer data={data} domain={null} snapshotId="s" t={themes.paper} onClose={() => undefined} onApplied={async () => undefined} />);
    expect(html).toContain('saved in the dbt YAML');
  });
});
