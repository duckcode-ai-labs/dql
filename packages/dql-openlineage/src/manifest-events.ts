/**
 * Build OpenLineage events from a compiled DQL manifest.
 *
 * Turns a `zlens compile` artifact into a START/COMPLETE event series that
 * hydrates a Marquez / DataHub / Atlan / Monte Carlo backend with the
 * project's lineage graph: dbt sources → dbt models → DataLex contracts →
 * DQL blocks → apps.
 *
 * Use {@link buildEventsFromManifest} for tests / inspection (returns a
 * pure array of events) and {@link emitProjectSnapshot} to actually POST
 * to the configured backend.
 */

import { randomUUID } from 'node:crypto';

import type { LineageDataset, LineageEvent, LineageJob, OpenLineageEmitter } from './index.js';

/**
 * Subset of `@zlens/core` `DQLManifest` consumed here. Kept
 * structural to avoid a circular package dep — dql-openlineage stays
 * dependency-free.
 */
export interface ManifestProjection {
  blocks?: Record<string, ManifestBlockProjection>;
  /** Optional dbt model index, when the manifest exposes one. */
  dbtModels?: Record<string, ManifestDbtModelProjection>;
  /** Optional DataLex contracts surface (forwarded by the manifest builder). */
  datalexContracts?: ManifestDataLexContractProjection[];
}

export interface ManifestBlockProjection {
  name: string;
  status?: string;
  filePath?: string;
  domain?: string;
  owner?: string;
  blockType?: string;
  description?: string;
  /** Tables the block reads from (output of the lineage table extractor). */
  tableDependencies?: string[];
  /** Block-to-block ref() edges. */
  refDependencies?: string[];
  /** Optional reference to a DataLex contract id. */
  datalexContract?: string;
  /** Column-level outputs from the v2.4 column-lineage pipeline. */
  outputs?: Array<{
    name: string;
    isAggregate?: boolean;
    aggregateFn?: string;
    sources: Array<{ table: string; column: string }>;
    unresolved?: boolean;
  }>;
}

export interface ManifestDbtModelProjection {
  name: string;
  schema?: string;
  database?: string;
}

export interface ManifestDataLexContractProjection {
  id: string;
  domain?: string;
  entity?: string;
  version?: number;
}

export interface BuildEventsOptions {
  /** OpenLineage namespace; defaults to `dql`. Producer-side default. */
  namespace?: string;
  /** ISO-8601 timestamp; defaults to `new Date().toISOString()`. */
  eventTime?: string;
  /**
   * Run id supplier. Defaults to a per-event UUID. Tests pass a counter
   * so output is deterministic.
   */
  newRunId?: () => string;
  /** Filter blocks by status; defaults to ['certified']. */
  blockStatuses?: string[];
}

/** OpenLineage dataset name conventions for DQL artifacts. */
export const datasetNames = {
  dbtModel(modelName: string): string {
    return `dbt.${modelName}`;
  },
  dataLexContract(contractId: string): string {
    return `datalex.${contractId}`;
  },
  dqlBlock(blockName: string): string {
    return `dql.block.${blockName.replace(/\s+/g, '_').toLowerCase()}`;
  },
};

/** OpenLineage job name conventions. */
export const jobNames = {
  blockRun(blockName: string): string {
    return `dql.block_run.${blockName.replace(/\s+/g, '_').toLowerCase()}`;
  },
};

export function buildEventsFromManifest(
  manifest: ManifestProjection,
  options: BuildEventsOptions = {},
): LineageEvent[] {
  const namespace = options.namespace ?? 'dql';
  const eventTime = options.eventTime ?? new Date().toISOString();
  const allowedStatuses = new Set(options.blockStatuses ?? ['certified']);
  const newRunId = options.newRunId ?? randomUUID;

  const events: LineageEvent[] = [];
  const blocks = manifest.blocks ? Object.values(manifest.blocks) : [];

  for (const block of blocks) {
    if (block.status && !allowedStatuses.has(block.status)) continue;
    const job: LineageJob = {
      namespace,
      name: jobNames.blockRun(block.name),
      facets: blockJobFacets(block),
    };
    const inputs = blockInputs(block, namespace);
    const outputs = blockOutputs(block, namespace);
    const runId = newRunId();

    events.push(makeEvent('START', namespace, eventTime, job, runId, inputs, outputs));
    events.push(makeEvent('COMPLETE', namespace, eventTime, job, runId, inputs, outputs));
  }

  return events;
}

/**
 * Emit a complete project snapshot through the supplied emitter. Each
 * certified block produces a START / COMPLETE pair so a backend like
 * Marquez can reconstruct the full lineage graph in one pass.
 */
export async function emitProjectSnapshot(
  emitter: OpenLineageEmitter,
  manifest: ManifestProjection,
  options: BuildEventsOptions = {},
): Promise<{ emitted: number }> {
  const events = buildEventsFromManifest(manifest, options);
  for (const event of events) {
    await emitter.emit({
      eventType: event.eventType,
      eventTime: event.eventTime,
      job: event.job,
      run: event.run,
      inputs: event.inputs,
      outputs: event.outputs,
    });
  }
  return { emitted: events.length };
}

function blockJobFacets(block: ManifestBlockProjection): Record<string, unknown> | undefined {
  const facets: Record<string, unknown> = {};
  if (block.description) {
    facets.documentation = {
      _producer: 'https://github.com/duckcode-ai-labs/dql',
      _schemaURL:
        'https://openlineage.io/spec/facets/1-0-0/DocumentationJobFacet.json',
      description: block.description,
    };
  }
  if (block.owner) {
    facets.ownership = {
      _producer: 'https://github.com/duckcode-ai-labs/dql',
      _schemaURL:
        'https://openlineage.io/spec/facets/1-0-0/OwnershipJobFacet.json',
      owners: [{ name: block.owner }],
    };
  }
  return Object.keys(facets).length > 0 ? facets : undefined;
}

function blockInputs(
  block: ManifestBlockProjection,
  namespace: string,
): LineageDataset[] {
  const datasets: LineageDataset[] = [];
  const seen = new Set<string>();

  for (const tbl of block.tableDependencies ?? []) {
    if (!tbl) continue;
    const name = datasetNames.dbtModel(tbl);
    if (seen.has(name)) continue;
    seen.add(name);
    datasets.push({ namespace, name });
  }
  for (const ref of block.refDependencies ?? []) {
    if (!ref) continue;
    const name = datasetNames.dqlBlock(ref);
    if (seen.has(name)) continue;
    seen.add(name);
    datasets.push({ namespace, name });
  }
  if (block.datalexContract) {
    const name = datasetNames.dataLexContract(stripContractVersion(block.datalexContract));
    if (!seen.has(name)) {
      seen.add(name);
      datasets.push({ namespace, name });
    }
  }
  return datasets;
}

function blockOutputs(
  block: ManifestBlockProjection,
  namespace: string,
): LineageDataset[] {
  const datasetName = datasetNames.dqlBlock(block.name);
  const facets: Record<string, unknown> = {};

  if (block.outputs && block.outputs.length > 0) {
    facets.schema = {
      _producer: 'https://github.com/duckcode-ai-labs/dql',
      _schemaURL:
        'https://openlineage.io/spec/facets/1-0-0/SchemaDatasetFacet.json',
      fields: block.outputs.map((c) => ({ name: c.name })),
    };
    const columnLineage: Record<string, { inputFields: Array<{ namespace: string; name: string; field: string }> }> = {};
    for (const col of block.outputs) {
      if (!col.sources || col.sources.length === 0) continue;
      columnLineage[col.name] = {
        inputFields: col.sources.map((src) => ({
          namespace,
          name: datasetNames.dbtModel(src.table),
          field: src.column,
        })),
      };
    }
    if (Object.keys(columnLineage).length > 0) {
      facets.columnLineage = {
        _producer: 'https://github.com/duckcode-ai-labs/dql',
        _schemaURL:
          'https://openlineage.io/spec/facets/1-0-0/ColumnLineageDatasetFacet.json',
        fields: columnLineage,
      };
    }
  }
  return [
    {
      namespace,
      name: datasetName,
      facets: Object.keys(facets).length > 0 ? facets : undefined,
    },
  ];
}

function stripContractVersion(ref: string): string {
  const at = ref.indexOf('@');
  return at === -1 ? ref : ref.slice(0, at);
}

function makeEvent(
  eventType: 'START' | 'COMPLETE' | 'FAIL' | 'ABORT',
  namespace: string,
  eventTime: string,
  job: LineageJob,
  runId: string,
  inputs: LineageDataset[],
  outputs: LineageDataset[],
): LineageEvent {
  return {
    eventType,
    eventTime,
    producer: 'https://github.com/duckcode-ai-labs/dql',
    schemaURL:
      'https://openlineage.io/spec/2-0-0/OpenLineage.json#/definitions/RunEvent',
    job,
    run: { runId },
    inputs,
    outputs,
  };
}
