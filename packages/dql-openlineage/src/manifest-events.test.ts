import { describe, it, expect, vi } from 'vitest';

import { createEmitter } from './index.js';
import {
  buildEventsFromManifest,
  datasetNames,
  emitProjectSnapshot,
  jobNames,
  type ManifestBlockProjection,
  type ManifestProjection,
} from './manifest-events.js';

function block(overrides: Partial<ManifestBlockProjection> = {}): ManifestBlockProjection {
  return {
    name: 'Monthly Active Customers',
    status: 'certified',
    blockType: 'custom',
    domain: 'customer',
    owner: 'growth@example.com',
    filePath: 'blocks/customer/monthly_active_customers.dql',
    description: 'Distinct customers per calendar month.',
    tableDependencies: ['fct_orders'],
    refDependencies: [],
    outputs: [
      {
        name: 'order_month',
        sources: [{ table: 'fct_orders', column: 'ordered_at' }],
      },
      {
        name: 'monthly_active_customers',
        isAggregate: true,
        aggregateFn: 'COUNT',
        sources: [{ table: 'fct_orders', column: 'customer_id' }],
      },
    ],
    ...overrides,
  };
}

function manifest(blocks: ManifestBlockProjection[]): ManifestProjection {
  return {
    blocks: Object.fromEntries(blocks.map((b) => [b.name, b])),
  };
}

describe('buildEventsFromManifest', () => {
  it('emits a START + COMPLETE pair per certified block', () => {
    let counter = 0;
    const events = buildEventsFromManifest(manifest([block()]), {
      eventTime: '2026-05-01T12:00:00Z',
      newRunId: () => `run-${++counter}`,
    });
    expect(events.map((e) => e.eventType)).toEqual(['START', 'COMPLETE']);
    expect(events[0].run.runId).toBe('run-1');
    expect(events[1].run.runId).toBe('run-1');
  });

  it('shares one run id across the START / COMPLETE pair for a block', () => {
    let counter = 0;
    const events = buildEventsFromManifest(manifest([block({ name: 'A' }), block({ name: 'B' })]), {
      newRunId: () => `r-${++counter}`,
    });
    expect(events).toHaveLength(4);
    expect(events[0].run.runId).toBe(events[1].run.runId);
    expect(events[2].run.runId).toBe(events[3].run.runId);
    expect(events[0].run.runId).not.toBe(events[2].run.runId);
  });

  it('skips non-certified blocks by default', () => {
    const events = buildEventsFromManifest(
      manifest([
        block({ name: 'Draft', status: 'draft' }),
        block({ name: 'Review', status: 'review' }),
        block({ name: 'Cert', status: 'certified' }),
      ]),
    );
    const jobs = new Set(events.map((e) => e.job.name));
    expect(jobs.has(jobNames.blockRun('Cert'))).toBe(true);
    expect(jobs.has(jobNames.blockRun('Draft'))).toBe(false);
    expect(jobs.has(jobNames.blockRun('Review'))).toBe(false);
  });

  it('honors blockStatuses override', () => {
    const events = buildEventsFromManifest(
      manifest([block({ name: 'Draft', status: 'draft' })]),
      { blockStatuses: ['draft', 'review', 'certified'] },
    );
    expect(events).toHaveLength(2);
    expect(events[0].job.name).toBe(jobNames.blockRun('Draft'));
  });

  it('lists table deps and ref deps as inputs', () => {
    const ev = buildEventsFromManifest(
      manifest([
        block({
          name: 'Composite',
          tableDependencies: ['fct_orders', 'dim_customers'],
          refDependencies: ['Monthly Revenue'],
        }),
      ]),
    )[0];
    const inputNames = ev.inputs?.map((d) => d.name) ?? [];
    expect(inputNames).toContain(datasetNames.dbtModel('fct_orders'));
    expect(inputNames).toContain(datasetNames.dbtModel('dim_customers'));
    expect(inputNames).toContain(datasetNames.dqlBlock('Monthly Revenue'));
  });

  it('adds the DataLex contract as an input dataset (version stripped)', () => {
    const ev = buildEventsFromManifest(
      manifest([
        block({
          name: 'WithContract',
          datalexContract: 'commerce.Customer.monthly_active_customers@2',
        }),
      ]),
    )[0];
    const inputNames = ev.inputs?.map((d) => d.name) ?? [];
    expect(inputNames).toContain(datasetNames.dataLexContract('commerce.Customer.monthly_active_customers'));
  });

  it('emits one output dataset per block with a schema facet', () => {
    const ev = buildEventsFromManifest(manifest([block()]))[0];
    expect(ev.outputs).toHaveLength(1);
    const out = ev.outputs?.[0];
    expect(out?.name).toBe(datasetNames.dqlBlock('Monthly Active Customers'));
    const schema = (out?.facets as Record<string, unknown> | undefined)?.schema as
      | { fields: Array<{ name: string }> }
      | undefined;
    expect(schema?.fields.map((f) => f.name)).toEqual([
      'order_month',
      'monthly_active_customers',
    ]);
  });

  it('emits a column-lineage facet that points back at the source columns', () => {
    const ev = buildEventsFromManifest(manifest([block()]))[0];
    const facets = (ev.outputs?.[0].facets ?? {}) as Record<string, unknown>;
    const columnLineage = facets.columnLineage as
      | {
          fields: Record<
            string,
            { inputFields: Array<{ namespace: string; name: string; field: string }> }
          >;
        }
      | undefined;
    expect(columnLineage?.fields.monthly_active_customers.inputFields).toEqual([
      {
        namespace: 'dql',
        name: datasetNames.dbtModel('fct_orders'),
        field: 'customer_id',
      },
    ]);
  });

  it('omits column-lineage facet when no outputs are populated', () => {
    const ev = buildEventsFromManifest(
      manifest([block({ outputs: undefined })]),
    )[0];
    const facets = (ev.outputs?.[0].facets ?? {}) as Record<string, unknown>;
    expect(facets.columnLineage).toBeUndefined();
  });

  it('attaches owner and description as job-level OpenLineage facets', () => {
    const ev = buildEventsFromManifest(manifest([block()]))[0];
    const facets = ev.job.facets as Record<string, unknown> | undefined;
    expect((facets?.documentation as { description: string } | undefined)?.description).toBe(
      'Distinct customers per calendar month.',
    );
    expect(((facets?.ownership as { owners: Array<{ name: string }> } | undefined)?.owners ?? [])).toEqual([
      { name: 'growth@example.com' },
    ]);
  });
});

describe('emitProjectSnapshot', () => {
  it('POSTs every event through the configured emitter', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const emitter = createEmitter({
      enabled: true,
      url: 'http://marquez.local:5000/api/v1/lineage',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const result = await emitProjectSnapshot(emitter, manifest([block()]), {
      newRunId: () => 'run-x',
    });
    expect(result.emitted).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const types = fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body).eventType);
    expect(types).toEqual(['START', 'COMPLETE']);
  });

  it('respects ZLENS_OPENLINEAGE_DISABLED (drops events silently)', async () => {
    const prev = process.env.ZLENS_OPENLINEAGE_DISABLED;
    process.env.ZLENS_OPENLINEAGE_DISABLED = '1';
    try {
      const fetchSpy = vi.fn();
      const emitter = createEmitter({
        enabled: true,
        url: 'http://marquez.local:5000/api/v1/lineage',
        fetch: fetchSpy as unknown as typeof fetch,
      });
      const result = await emitProjectSnapshot(emitter, manifest([block()]));
      // Buffer is built but emitter drops on the wire.
      expect(result.emitted).toBe(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ZLENS_OPENLINEAGE_DISABLED;
      else process.env.ZLENS_OPENLINEAGE_DISABLED = prev;
    }
  });
});
