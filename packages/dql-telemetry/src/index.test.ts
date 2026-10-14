import { describe, expect, it, vi } from 'vitest';
import { track } from './index.js';

describe('telemetry', () => {
  it('does nothing when disabled', async () => {
    const fetchSpy = vi.fn();
    await track({ name: 'cli.command' }, { fetch: fetchSpy as unknown as typeof fetch, enabled: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('respects DO_NOT_TRACK even when enabled', async () => {
    process.env.DO_NOT_TRACK = '1';
    const fetchSpy = vi.fn();
    await track({ name: 'cli.command' }, { fetch: fetchSpy as unknown as typeof fetch, enabled: true, endpoint: 'http://x' });
    expect(fetchSpy).not.toHaveBeenCalled();
    delete process.env.DO_NOT_TRACK;
  });

  it('respects ZLENS_TELEMETRY_DISABLED', async () => {
    process.env.ZLENS_TELEMETRY_DISABLED = '1';
    const fetchSpy = vi.fn();
    await track({ name: 'cli.command' }, { fetch: fetchSpy as unknown as typeof fetch, enabled: true, endpoint: 'http://x' });
    expect(fetchSpy).not.toHaveBeenCalled();
    delete process.env.ZLENS_TELEMETRY_DISABLED;
  });

  it('posts payload with event name, version, and props when enabled', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    await track(
      { name: 'cli.command', props: { command: 'init', success: true }, durationMs: 42 },
      {
        fetch: fetchSpy as unknown as typeof fetch,
        enabled: true,
        endpoint: 'http://x',
        anonymousId: 'abc',
        version: '1.0.0',
      },
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://x');
    const body = JSON.parse(opts.body);
    expect(body.event).toBe('cli.command');
    expect(body.version).toBe('1.0.0');
    expect(body.props.command).toBe('init');
    expect(body.durationMs).toBe(42);
    expect(body.anonymousId).toBe('abc');
  });

  it('swallows fetch errors', async () => {
    const errors: unknown[] = [];
    await track(
      { name: 'cli.command' },
      {
        fetch: vi.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch,
        enabled: true,
        endpoint: 'http://x',
        anonymousId: 'abc',
        onError: (e) => errors.push(e),
      },
    );
    expect(errors).toHaveLength(1);
  });
});
