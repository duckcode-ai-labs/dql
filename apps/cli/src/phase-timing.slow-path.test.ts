import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPhaseTimer, logSlowRequest } from './phase-timing.js';
import {
  CATALOG_TABLE_ROWS_TTL_MS,
  clearCatalogTableRowCache,
  resolveSemanticTableMapping,
} from './local-runtime.js';

describe('phase timer', () => {
  it('records names and durations in finish order and keeps a failing phase', async () => {
    let clock = 0;
    const timer = createPhaseTimer(() => clock);
    await timer.time('table mapping', () => { clock += 12; });
    await expect(timer.time('run_query', () => { clock += 40; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(timer.phases()).toEqual([
      { name: 'table_mapping', ms: 12 },
      { name: 'run_query', ms: 40 },
    ]);
    expect(timer.header()).toBe('table_mapping;dur=12, run_query;dur=40');
    expect(timer.elapsedMs()).toBe(52);
  });

  it('only reports a slow request, and never includes SQL or values', async () => {
    let clock = 0;
    const timer = createPhaseTimer(() => clock);
    await timer.time('run_query', () => { clock += 4_000; });
    expect(timer.slowLine('POST /x', 5_000)).toBeNull();
    await timer.time('evaluate_assertions', () => { clock += 2_000; });
    expect(timer.slowLine('POST /x', 5_000)).toBe(
      '[dql] slow request POST /x took 6000ms (run_query=4000ms evaluate_assertions=2000ms)',
    );
  });

  it('logs the line only when slow', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let clock = 0;
    const timer = createPhaseTimer(() => clock);
    logSlowRequest(timer, 'POST /x');
    clock = 9_000;
    logSlowRequest(timer, 'POST /x');
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

describe('catalog table listing cache', () => {
  afterEach(() => vi.useRealTimers());

  const layer = {
    listMetrics: () => [{ table: 'main.orders' }],
    listDimensions: () => [],
    listMeasures: () => [],
    listSemanticModels: () => [],
  } as never;
  const connection = { driver: 'duckdb', filepath: ':memory:' } as never;

  const makeExecutor = () => {
    const executeQuery = vi.fn(async () => ({ rows: [{ table_schema: 'main', table_name: 'orders' }] }));
    return { executor: { executeQuery } as never, executeQuery };
  };

  it('scans the catalog once for repeated and concurrent requests', async () => {
    const { executor, executeQuery } = makeExecutor();
    const [first, second] = await Promise.all([
      resolveSemanticTableMapping(executor, connection, layer),
      resolveSemanticTableMapping(executor, connection, layer),
    ]);
    const third = await resolveSemanticTableMapping(executor, connection, layer);
    expect(first).toEqual({ 'main.orders': 'main.orders' });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(executeQuery).toHaveBeenCalledTimes(1);
  });

  it('scans again after the listing expires or is cleared', async () => {
    vi.useFakeTimers();
    const { executor, executeQuery } = makeExecutor();
    await resolveSemanticTableMapping(executor, connection, layer);
    vi.setSystemTime(Date.now() + CATALOG_TABLE_ROWS_TTL_MS + 1);
    await resolveSemanticTableMapping(executor, connection, layer);
    expect(executeQuery).toHaveBeenCalledTimes(2);
    clearCatalogTableRowCache(executor);
    await resolveSemanticTableMapping(executor, connection, layer);
    expect(executeQuery).toHaveBeenCalledTimes(3);
  });

  it('does not remember a failed scan', async () => {
    const executeQuery = vi.fn()
      .mockRejectedValueOnce(new Error('warehouse down'))
      .mockResolvedValue({ rows: [{ table_schema: 'main', table_name: 'orders' }] });
    const executor = { executeQuery } as never;
    expect(await resolveSemanticTableMapping(executor, connection, layer)).toBeUndefined();
    expect(await resolveSemanticTableMapping(executor, connection, layer)).toEqual({ 'main.orders': 'main.orders' });
    expect(executeQuery).toHaveBeenCalledTimes(2);
  });
});
