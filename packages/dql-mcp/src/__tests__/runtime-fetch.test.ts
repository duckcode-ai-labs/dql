import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchRuntime, RuntimeTimeoutError, runtimeUnreachableMessage } from '../runtime-fetch.js';
import { compactContextPack } from '../tools/kg.js';

describe('runtime calls never hang an agent', () => {
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  const previous = process.env.ZLENS_MCP_RUNTIME_TIMEOUT_MS;

  afterEach(async () => {
    if (previous === undefined) delete process.env.ZLENS_MCP_RUNTIME_TIMEOUT_MS;
    else process.env.ZLENS_MCP_RUNTIME_TIMEOUT_MS = previous;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
  });

  it('ends a call to a runtime that accepts the connection but never answers, with a clear message', async () => {
    server = createServer((socket) => { sockets.add(socket); });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;
    process.env.ZLENS_MCP_RUNTIME_TIMEOUT_MS = '300';
    const started = Date.now();
    const error = await fetchRuntime(`http://127.0.0.1:${port}/api/health`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeTimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(runtimeUnreachableMessage(`http://127.0.0.1:${port}`, '/p', error)).toMatch(/did not answer.*ZLENS_MCP_RUNTIME_TIMEOUT_MS/);
  });

  it('tells the agent how to start the workbench when nothing listens', () => {
    expect(runtimeUnreachableMessage('http://127.0.0.1:3474', '/work/jaffle', new Error('ECONNREFUSED'), 'Running a block needs it'))
      .toMatch(/Could not reach the ZLens runtime at http:\/\/127\.0\.0\.1:3474\. Running a block needs it running — start the workbench with `zlens notebook \/work\/jaffle`/);
  });
});

describe('inspect_metadata_context stays inside what a client accepts', () => {
  it('keeps what SQL needs and summarizes the retrieval diagnostics and the long tail', () => {
    const pack = {
      id: 'ctx_1',
      allowedSqlContext: { relations: [{ relation: 'dev.orders', columns: [{ name: 'order_id' }] }], sourceBlockSql: [] },
      routeDecision: { route: 'generated_sql' },
      objects: Array.from({ length: 100 }, (_, index) => ({ objectKey: `k${index}`, objectType: 'dbt_model', name: `m${index}`, payload: { big: 'x'.repeat(2_000) } })),
      edges: Array.from({ length: 200 }, (_, index) => ({ from: `k${index}`, to: 'k0' })),
      retrievalDiagnostics: { strategy: 'hybrid', selectedJoinPaths: [{ leftRelation: 'dev.orders' }], meaningEvidence: Array.from({ length: 500 }, () => ({ text: 'y'.repeat(300) })), lanes: { a: [1, 2] } },
    };
    const compact = compactContextPack(pack) as typeof pack & { objectsOmitted?: number; edgesOmitted?: number; retrievalDiagnostics: Record<string, unknown> };
    expect(compact.id).toBe('ctx_1');
    expect(compact.allowedSqlContext).toEqual(pack.allowedSqlContext);
    expect(compact.routeDecision).toEqual(pack.routeDecision);
    expect(compact.retrievalDiagnostics.selectedJoinPaths).toEqual(pack.retrievalDiagnostics.selectedJoinPaths);
    expect(compact.retrievalDiagnostics).not.toHaveProperty('meaningEvidence');
    expect(compact.retrievalDiagnostics.counts).toMatchObject({ meaningEvidence: 500 });
    expect(compact.objects).toHaveLength(30);
    expect(compact.objectsOmitted).toBe(70);
    expect(compact.edgesOmitted).toBe(180);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(pack).length / 5);
  });
});
