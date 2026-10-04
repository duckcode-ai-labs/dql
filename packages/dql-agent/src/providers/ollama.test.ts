import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from './ollama.js';
import { prepareProviderWireEnvelopeForDispatch } from '../provider-egress.js';
import type { ProviderDispatchEvent } from './types.js';

afterEach(() => vi.unstubAllGlobals());

describe('OllamaProvider physical dispatch accounting', () => {
  it('counts every POST endpoint attempt and sends the observed body', async () => {
    const bodies: unknown[] = [];
    const events: ProviderDispatchEvent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response('{}', { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return new Response('retry', { status: 500 });
      return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
    }));
    const provider = new OllamaProvider({ baseUrl: 'http://primary.test', model: 'local-test' });
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      maxProviderDispatches: 2,
      onProviderDispatch: (event) => {
        const envelope = prepareProviderWireEnvelopeForDispatch(event.provider, event.envelope);
        events.push({ ...event, envelope });
        return envelope;
      },
    })).resolves.toBe('ok');
    expect(bodies).toHaveLength(2);
    expect(events.map((event) => event.attemptIndex)).toEqual([1, 2]);
    expect(events).toHaveLength(bodies.length);
    expect(bodies).toEqual(events.map((event) => event.envelope));
  });

  // The provider makes at most two dispatches (its one base URL, then once more after a failed answer). A dispatch
  // beyond the run's budget is refused before it is sent.
  it('fails closed before a dispatch beyond the run\'s budget', async () => {
    const events: ProviderDispatchEvent[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (
      (init?.method ?? 'GET') === 'GET'
        ? new Response('{}', { status: 200 })
        : new Response('retry', { status: 500 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({ baseUrl: 'http://primary.test' });
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      maxProviderDispatches: 1,
      onProviderDispatch: (event) => { events.push(event); return event.envelope; },
    })).rejects.toThrow(/dispatch budget exhausted/i);
    expect(events).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'POST')).toHaveLength(1);
  });
});

describe('OllamaProvider talks to its one base URL only', () => {
  /** A fetch that records every address asked and answers like a machine where nothing listens. */
  function recordingFetch(answer: (url: URL, init?: RequestInit) => Response | Promise<Response> = () => { throw new TypeError('fetch failed'); }) {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      asked.push(url.origin);
      return answer(url, init);
    }));
    return asked;
  }
  const savedEnv = process.env.OLLAMA_BASE_URL;
  afterEach(() => { if (savedEnv === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = savedEnv; });

  it('when Ollama is not running there, says so plainly and asks no other address (no fallback host)', async () => {
    const asked = recordingFetch();
    const provider = new OllamaProvider({ baseUrl: 'http://127.0.0.1:9', model: 'llama3' });
    expect(provider.baseUrl).toBe('http://127.0.0.1:9');
    expect(provider.endpoints()).toEqual(['http://127.0.0.1:9']);
    expect(await provider.available()).toBe(false);
    await expect(provider.generate([{ role: 'user', content: 'the chart: West 1204' }])).rejects.toThrow('Ollama is not running at http://127.0.0.1:9.');
    await expect(provider.generateStream([{ role: 'user', content: 'the chart: West 1204' }], {}, () => undefined)).rejects.toThrow('Ollama is not running at http://127.0.0.1:9.');
    expect([...new Set(asked)]).toEqual(['http://127.0.0.1:9']);
  });

  it('with nothing configured, uses this machine only; OLLAMA_BASE_URL names the one address otherwise', async () => {
    delete process.env.OLLAMA_BASE_URL;
    const asked = recordingFetch();
    const local = new OllamaProvider();
    expect(local.baseUrl).toBe('http://127.0.0.1:11434');
    await expect(local.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow('Ollama is not running at http://127.0.0.1:11434.');
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434/';
    const named = new OllamaProvider();
    expect(named.baseUrl).toBe('http://ollama:11434');
    await expect(named.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow('Ollama is not running at http://ollama:11434.');
    expect([...new Set(asked)]).toEqual(['http://127.0.0.1:11434', 'http://ollama:11434']);
  });

  it('a daemon that answers is used at that address alone, even when it answers an error first', async () => {
    let posts = 0;
    const asked = recordingFetch((url) => {
      if (url.pathname === '/api/tags') return new Response('{"models":[]}', { status: 200 });
      posts += 1;
      return posts === 1 ? new Response('loading', { status: 503 }) : new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
    });
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
    expect(await provider.generate([{ role: 'user', content: 'hi' }])).toBe('ok');
    expect([...new Set(asked)]).toEqual(['http://localhost:11434']);
  });
});
