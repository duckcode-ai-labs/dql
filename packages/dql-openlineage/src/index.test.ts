import { describe, expect, it, vi } from 'vitest';
import { createEmitter, resolveConfig } from './index.js';

describe('OpenLineage emitter', () => {
  it('drops events when disabled', async () => {
    const fetchSpy = vi.fn();
    const emitter = createEmitter({ fetch: fetchSpy as unknown as typeof fetch });
    await emitter.emit({
      eventType: 'START',
      eventTime: '2026-01-01T00:00:00Z',
      job: { namespace: 'test', name: 'x' },
      run: { runId: 'r' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts to the configured url when enabled', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const emitter = createEmitter({
      enabled: true,
      url: 'http://localhost:5000/api/v1/lineage',
      namespace: 'test',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await emitter.emit({
      eventType: 'START',
      eventTime: '2026-01-01T00:00:00Z',
      job: { namespace: 'test', name: 'block.x' },
      run: { runId: 'r-1' },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:5000/api/v1/lineage');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.producer).toContain('duckcode-ai-labs/zlens');
    expect(body.job.name).toBe('block.x');
  });

  it('wrap emits START + COMPLETE on success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const emitter = createEmitter({
      enabled: true,
      url: 'http://x',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const result = await emitter.wrap(
      { namespace: 'test', name: 'j' },
      'run-1',
      { inputs: [{ namespace: 'test', name: 'in' }] },
      async () => 42,
    );
    expect(result).toBe(42);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const types = fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body).eventType);
    expect(types).toEqual(['START', 'COMPLETE']);
  });

  it('wrap emits START + FAIL on error and re-throws', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const emitter = createEmitter({
      enabled: true,
      url: 'http://x',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await expect(
      emitter.wrap({ namespace: 't', name: 'j' }, 'r', {}, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const types = fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body).eventType);
    expect(types).toEqual(['START', 'FAIL']);
  });

  it('swallows fetch failures via onError', async () => {
    const errors: unknown[] = [];
    const emitter = createEmitter({
      enabled: true,
      url: 'http://x',
      fetch: vi.fn().mockRejectedValue(new Error('net down')) as unknown as typeof fetch,
      onError: (e) => errors.push(e),
    });
    // Must not throw.
    await emitter.emit({
      eventType: 'START',
      eventTime: 'now',
      job: { namespace: 't', name: 'j' },
      run: { runId: 'r' },
    });
    expect(errors).toHaveLength(1);
  });

  it('resolveConfig honors ZLENS_OPENLINEAGE_DISABLED', () => {
    const prev = process.env.ZLENS_OPENLINEAGE_DISABLED;
    process.env.ZLENS_OPENLINEAGE_DISABLED = '1';
    const cfg = resolveConfig({ enabled: true, url: 'http://x' });
    expect(cfg.enabled).toBe(false);
    if (prev === undefined) delete process.env.ZLENS_OPENLINEAGE_DISABLED;
    else process.env.ZLENS_OPENLINEAGE_DISABLED = prev;
  });
});
