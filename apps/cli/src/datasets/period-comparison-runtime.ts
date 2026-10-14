import type { DatasetDescriptor, TileQuery } from '@zlens/core';
import {
  buildDatasetComparisonPlan,
  executeDatasetComparisonPlan,
  type DatasetComparisonPlanResult,
} from '@zlens/agent';

export class DatasetPeriodComparisonError extends Error {
  constructor(
    readonly code: 'DATASET_COMPARISON_UNSUPPORTED' | 'DATASET_COMPARISON_RESULT_INVALID' | 'DATASET_COMPARISON_CANCELLED',
    message: string,
  ) {
    super(message);
  }
}

export interface DatasetComparisonPeriodExecution<T> {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  receiptFingerprint: string;
  value: T;
}

/**
 * Execute the already-authorized period queries in a deterministic sequence,
 * then let the shared analytical graph align and calculate exact outputs.
 *
 * The caller supplies the target-bound executor so this helper never opens a
 * connection, changes a source route, or treats its graph receipt as source
 * authority. Sequential execution also keeps an aggregate Dataset's existing
 * scoped-read path coherent when it is used by the callback.
 */
export async function executeDatasetPeriodComparison<T>(input: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  snapshotId: string;
  referenceInstant: string;
  maxRows?: number;
  signal?: AbortSignal;
  executePeriod: (period: Extract<DatasetComparisonPlanResult, { status: 'ready' }>['periodQueries'][number]) => Promise<DatasetComparisonPeriodExecution<T>>;
}): Promise<{
  plan: Extract<DatasetComparisonPlanResult, { status: 'ready' }>;
  result: Extract<ReturnType<typeof executeDatasetComparisonPlan>, { status: 'completed' }>;
  periods: Array<{
    periodId: string;
    execution: DatasetComparisonPeriodExecution<T>;
  }>;
}> {
  throwIfAborted(input.signal);
  const plan = buildDatasetComparisonPlan({
    descriptor: input.descriptor,
    query: input.query,
    snapshotId: input.snapshotId,
    referenceInstant: input.referenceInstant,
    ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
  });
  if (plan.status !== 'ready') {
    throw new DatasetPeriodComparisonError('DATASET_COMPARISON_UNSUPPORTED', plan.reason);
  }

  const sourceResults: Parameters<typeof executeDatasetComparisonPlan>[0]['sourceResults'] = {};
  const periods: Array<{ periodId: string; execution: DatasetComparisonPeriodExecution<T> }> = [];
  for (const period of plan.periodQueries) {
    throwIfAborted(input.signal);
    const execution = await input.executePeriod(period);
    throwIfAborted(input.signal);
    sourceResults[`source:${period.periodId}`] = {
      columns: execution.columns,
      rows: execution.rows,
      receiptFingerprint: execution.receiptFingerprint,
    };
    periods.push({ periodId: period.periodId, execution });
  }
  const result = executeDatasetComparisonPlan({ plan, sourceResults });
  if (result.status !== 'completed') {
    throw new DatasetPeriodComparisonError('DATASET_COMPARISON_RESULT_INVALID', result.reason);
  }
  return { plan, result, periods };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DatasetPeriodComparisonError(
      'DATASET_COMPARISON_CANCELLED',
      'The Dataset comparison was superseded before all period results settled.',
    );
  }
}
