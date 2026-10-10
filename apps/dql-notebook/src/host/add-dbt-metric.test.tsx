import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddDbtMetricDrawer } from '../components/modeling/DbtFirstModelingPage';
import type { DbtFirstModelingResponse } from '../api/client';
import { themes } from '../themes/notebook-theme';
import { hostReadOnly, readOnlyReason, type HostUi } from './host-ui';

const data = {
  snapshotId: 'snapshot-1',
  dbtProvenance: { nodes: { 'model.harbor.claims': { uniqueId: 'model.harbor.claims', name: 'claims', resourceType: 'model' } } },
  modeling: { packages: {} },
} as unknown as DbtFirstModelingResponse;

const hosted = (capabilities: Record<string, boolean>, refusals?: HostUi['refusals']): HostUi => (
  { host: true, person: { id: 'u1', name: 'Cleo', kind: 'person' }, capabilities, links: [], answerActions: [], ...(refusals ? { refusals } : {}) }
);

describe('Add metric (dbt-first Modeling)', () => {
  it('opens on a form that previews the dbt YAML first and says dbt owns the metric', () => {
    const html = renderToStaticMarkup(
      <AddDbtMetricDrawer data={data} domain="claims" snapshotId="snapshot-1" t={themes.paper} onClose={() => undefined} onApplied={async () => undefined} />,
    );
    expect(html).toContain('Add metric');
    expect(html).toContain('dbt/MetricFlow owns it');
    expect(html).toContain('Preview dbt YAML');
    expect(html).not.toContain('Apply to dbt');
    expect(html).toContain('>claims<');
    for (const label of ['Aggregation', 'Column', 'Metric name', 'Also known as']) expect(html).toContain(label);
  });

  it('is read-only when the host refuses dataset.author, the action its routes are checked as (see dbt-metric-routes.test.ts)', () => {
    const draft = { label: 'Open my draft space', href: '/e/draft' };
    const production = hosted({ 'project.read': true }, { 'dataset.author': { reason: 'Production follows main.', next: draft } });
    expect(hostReadOnly(production, 'domains')).toBe(true);
    expect(readOnlyReason(production, 'domains')).toBe('Production follows main.');
    // In a draft space the same person may author, so the button is offered.
    expect(hostReadOnly(hosted({ 'project.read': true, 'dataset.author': true }), 'domains')).toBe(false);
    // Without a host (local OSS) it is always editable.
    expect(hostReadOnly({ host: false }, 'domains')).toBe(false);
  });
});
