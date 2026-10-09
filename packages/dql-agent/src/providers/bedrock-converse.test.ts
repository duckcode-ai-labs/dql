import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bedrockConverseTransport,
  createBedrockConverseProvider,
  setProviderUsageListener,
  supportsReasoningEffort,
  type ProviderUsageLine,
} from './index.js';
import { prepareProviderWireEnvelopeForDispatch } from '../provider-egress.js';

const AWS_EXAMPLE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const NOW = () => new Date('2026-10-08T12:00:00Z');
const NOVA = 'amazon.nova-pro-v1:0';
const CONVERSE_URL = 'https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse';

const reply = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const failure = (status: number, type: string, message: string) =>
  new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json', 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/` } });

function provider(extra: Partial<Parameters<typeof createBedrockConverseProvider>[0]> = {}) {
  return createBedrockConverseProvider({ region: 'us-east-1', model: NOVA, credentials: async () => AWS_EXAMPLE, now: NOW, ...extra });
}

function stubFetch(...responses: Response[]) {
  const queue = [...responses];
  const fetch = vi.fn(async () => queue.shift() ?? new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const sent = (fetch: ReturnType<typeof stubFetch>, call = 0) => {
  const [url, init] = fetch.mock.calls[call] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, any> };
};

afterEach(() => {
  vi.unstubAllGlobals();
  setProviderUsageListener(null);
});

describe('Bedrock Converse: the signed request', () => {
  it('posts to /converse with the model id URL-encoded, signed for bedrock', async () => {
    const prepared = await bedrockConverseTransport({ region: 'us-east-1', credentials: async () => AWS_EXAMPLE, now: NOW })
      .prepare({ url: 'ignored', body: { model: NOVA, messages: [] }, headers: {} });
    expect(prepared.url).toBe(CONVERSE_URL);
    expect(new URL(prepared.url).host).toBe('bedrock-runtime.us-east-1.amazonaws.com');
    expect(JSON.parse(prepared.body)).toEqual({ messages: [] });
    expect(prepared.headers['x-amz-date']).toBe('20261008T120000Z');
    expect(prepared.headers['content-type']).toBe('application/json');
    expect(prepared.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261008\/us-east-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  it('signs a session token and supports inference profile and gpt-oss ids', async () => {
    const transport = bedrockConverseTransport({ region: 'us-west-2', credentials: async () => ({ ...AWS_EXAMPLE, sessionToken: 'tok' }), now: NOW });
    const profile = await transport.prepare({ url: 'x', body: { model: 'us.amazon.nova-pro-v1:0' }, headers: {} });
    expect(profile.url).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/model/us.amazon.nova-pro-v1%3A0/converse');
    expect(profile.headers['x-amz-security-token']).toBe('tok');
    expect(profile.headers.authorization).toContain('SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token');
    const oss = await transport.prepare({ url: 'x', body: { model: 'openai.gpt-oss-120b-1:0' }, headers: {} });
    expect(oss.url).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/model/openai.gpt-oss-120b-1%3A0/converse');
  });

  it('refuses a missing model and a streamed request', async () => {
    const transport = bedrockConverseTransport({ region: 'us-east-1', credentials: async () => AWS_EXAMPLE });
    await expect(transport.prepare({ url: 'x', body: {}, headers: {} })).rejects.toThrow('model id');
    await expect(transport.prepare({ url: 'x', body: { model: NOVA, stream: true }, headers: {} })).rejects.toThrow('streaming');
  });

  it('puts the guardrail in the body of every call', async () => {
    const fetch = stubFetch(reply({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' }));
    await provider({ guardrail: { id: 'gr-abc123', version: '2' } }).generate([{ role: 'user', content: 'hi' }]);
    expect(sent(fetch).body.guardrailConfig).toEqual({ guardrailIdentifier: 'gr-abc123', guardrailVersion: '2' });
  });
});

describe('Bedrock Converse: a text answer', () => {
  it('maps system, messages and limits, and sends nothing Claude-only', async () => {
    const fetch = stubFetch(reply({ output: { message: { role: 'assistant', content: [{ text: 'Revenue rose 8%.' }] } }, stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } }));
    const text = await provider({ inference: { topP: 0.9, stopSequences: ['END'] } }).generate(
      [
        { role: 'system', content: 'You are a careful analyst.' },
        { role: 'user', content: 'Why?' },
        { role: 'user', content: 'Be brief.' },
        { role: 'assistant', content: 'Because.' },
        { role: 'user', content: 'And?' },
      ],
      { maxTokens: 300, temperature: 0.1, reasoningEffort: 'high' },
    );
    expect(text).toBe('Revenue rose 8%.');
    const { url, init, body } = sent(fetch);
    expect(url).toBe(CONVERSE_URL);
    expect(init.method).toBe('POST');
    expect(body).toEqual({
      system: [{ text: 'You are a careful analyst.' }],
      messages: [
        { role: 'user', content: [{ text: 'Why?' }, { text: 'Be brief.' }] },
        { role: 'assistant', content: [{ text: 'Because.' }] },
        { role: 'user', content: [{ text: 'And?' }] },
      ],
      inferenceConfig: { maxTokens: 300, temperature: 0.1, topP: 0.9, stopSequences: ['END'] },
    });
    expect(JSON.stringify(body)).not.toMatch(/anthropic_version|output_config|thinking|reasoning/);
  });

  it('reports reasoning effort as unsupported', () => {
    expect(supportsReasoningEffort('bedrock', NOVA)).toBe(false);
    expect(supportsReasoningEffort('bedrock', 'openai.gpt-oss-120b-1:0')).toBe(false);
  });

  it('is available, and has no stream of its own (callers fall back to one whole delta)', async () => {
    const p = provider();
    expect(await p.available()).toBe(true);
    expect(p.generateStream).toBeUndefined();
  });

  it('tells the dispatch observer the model and the exact envelope', async () => {
    stubFetch(reply({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' }));
    const events: any[] = [];
    await provider().generate([{ role: 'user', content: 'hi' }], { onProviderDispatch: (event) => { events.push(event); return event.envelope; } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: 'bedrock', operation: 'generate', attemptIndex: 1, envelope: { model: NOVA } });
  });
});

describe('Bedrock Converse: the tool loop', () => {
  const lookup = {
    name: 'lookup_metric',
    description: 'Look up a governed metric.',
    inputSchema: { type: 'object', properties: { metric: { type: 'string' } }, required: ['metric'] },
    run: vi.fn(async (args: unknown) => ({ metric: (args as { metric: string }).metric, value: 42 })),
  };

  it('runs tool_use -> toolResult -> final answer', async () => {
    lookup.run.mockClear();
    const fetch = stubFetch(
      reply({
        output: { message: { role: 'assistant', content: [{ text: 'Let me check.' }, { toolUse: { toolUseId: 'tu-1', name: 'lookup_metric', input: { metric: 'revenue' } } }] } },
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      }),
      reply({ output: { message: { role: 'assistant', content: [{ text: 'Revenue is 42.' }] } }, stopReason: 'end_turn', usage: { inputTokens: 160, outputTokens: 6, totalTokens: 166 } }),
    );
    const calls: string[] = [];
    const out = await provider().generateWithTools(
      [{ role: 'system', content: 'Use tools.' }, { role: 'user', content: 'What is revenue?' }],
      [lookup],
      { onToolCall: (event) => calls.push(event.name) },
    );
    expect(out).toBe('Revenue is 42.');
    expect(lookup.run).toHaveBeenCalledWith({ metric: 'revenue' });
    expect(calls).toEqual(['lookup_metric']);

    const first = sent(fetch, 0).body;
    expect(first.toolConfig).toEqual({
      tools: [{ toolSpec: { name: 'lookup_metric', description: 'Look up a governed metric.', inputSchema: { json: lookup.inputSchema } } }],
    });
    const second = sent(fetch, 1).body;
    expect(second.messages).toEqual([
      { role: 'user', content: [{ text: 'What is revenue?' }] },
      { role: 'assistant', content: [{ text: 'Let me check.' }, { toolUse: { toolUseId: 'tu-1', name: 'lookup_metric', input: { metric: 'revenue' } } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 'tu-1', content: [{ text: '{"metric":"revenue","value":42}' }] } }] },
    ]);
    expect(second.toolConfig).toBeDefined();
  });

  it('returns a failing tool as an error result and lets the model answer', async () => {
    const failing = { ...lookup, run: vi.fn(async () => { throw new Error('no such metric'); }) };
    const fetch = stubFetch(
      reply({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu-9', name: 'lookup_metric', input: { metric: 'x' } } }] } }, stopReason: 'tool_use' }),
      reply({ output: { message: { role: 'assistant', content: [{ text: 'It does not exist.' }] } }, stopReason: 'end_turn' }),
    );
    const out = await provider().generateWithTools([{ role: 'user', content: 'x?' }], [failing]);
    expect(out).toBe('It does not exist.');
    const result = sent(fetch, 1).body.messages[2].content[0].toolResult;
    expect(result.content[0].text).toContain('no such metric');
    // `status` is documented for Anthropic models only.
    expect(result.status).toBeUndefined();
  });

  it('sends status:error for an Anthropic model through Converse', async () => {
    const failing = { ...lookup, run: vi.fn(async () => { throw new Error('boom'); }) };
    const fetch = stubFetch(
      reply({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu-2', name: 'lookup_metric', input: {} } }] } }, stopReason: 'tool_use' }),
      reply({ output: { message: { role: 'assistant', content: [{ text: 'done' }] } }, stopReason: 'end_turn' }),
    );
    await provider({ model: 'us.anthropic.claude-sonnet-5-v1:0' }).generateWithTools([{ role: 'user', content: 'x?' }], [failing]);
    expect(sent(fetch, 1).body.messages[2].content[0].toolResult.status).toBe('error');
  });

  it('forces one tool with toolChoice when the host narrows to a terminal action', async () => {
    const finish = { name: 'finish_answer', description: 'Finish.', inputSchema: { type: 'object' }, run: vi.fn(async () => ({ finished: true })) };
    const fetch = stubFetch(reply({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'f1', name: 'finish_answer', input: {} } }] } }, stopReason: 'tool_use' }));
    const out = await provider().generateWithTools([{ role: 'user', content: 'go' }], [lookup, finish], {
      getCurrentToolPolicy: () => ({ allowedToolNames: ['lookup_metric', 'finish_answer'], terminalActionToolNames: ['finish_answer'], instruction: 'Finish now.' }),
    });
    expect(finish.run).toHaveBeenCalled();
    expect(out).toBe('');
    const body = sent(fetch).body;
    expect(body.toolConfig.toolChoice).toEqual({ tool: { name: 'finish_answer' } });
    // Like the OpenAI loop: the list stays whole, toolChoice does the forcing.
    expect(body.toolConfig.tools.map((t: any) => t.toolSpec.name)).toEqual(['lookup_metric', 'finish_answer']);
    expect(body.system).toEqual([{ text: 'Finish now.' }]);
  });

  it('does not run a tool whose input was cut off by max_tokens', async () => {
    lookup.run.mockClear();
    stubFetch(reply({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'c1', name: 'lookup_metric', input: {} } }] } }, stopReason: 'max_tokens' }));
    await expect(provider().generateWithTools([{ role: 'user', content: 'x' }], [lookup])).rejects.toThrow('ran out of output tokens');
    expect(lookup.run).not.toHaveBeenCalled();
  });

  it('closes with an answer when the tool budget is spent', async () => {
    const use = (id: string) => reply({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: id, name: 'lookup_metric', input: { metric: 'm' } } }] } }, stopReason: 'tool_use' });
    const fetch = stubFetch(
      use('a'),
      use('b'),
      reply({ output: { message: { role: 'assistant', content: [{ text: 'Best answer so far.' }] } }, stopReason: 'end_turn' }),
    );
    const out = await provider().generateWithTools([{ role: 'user', content: 'x' }], [lookup], { maxToolCalls: 1, maxProviderDispatches: 6 });
    expect(out).toBe('Best answer so far.');
    // The closing send still declares the tools: Converse requires it once the history holds tool blocks.
    expect(sent(fetch, 2).body.toolConfig).toBeDefined();
  });

  it('answers plainly with no tools', async () => {
    const fetch = stubFetch(reply({ output: { message: { role: 'assistant', content: [{ text: 'plain' }] } }, stopReason: 'end_turn' }));
    expect(await provider().generateWithTools([{ role: 'user', content: 'x' }], [])).toBe('plain');
    expect(sent(fetch).body.toolConfig).toBeUndefined();
  });
});

describe('Bedrock Converse: the host egress sanitizer', () => {
  it('keeps system, the tool round trip and toolConfig when the host returns the sanitized envelope', async () => {
    const tool = {
      name: 'lookup_metric',
      description: 'Look up a governed metric.',
      inputSchema: { type: 'object', properties: { metric: { type: 'string', enum: ['revenue', 'cost'] } }, required: ['metric'] },
      run: async () => ({ value: 42 }),
    };
    const fetch = stubFetch(
      reply({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu-1', name: 'lookup_metric', input: { metric: 'revenue' } } }] } }, stopReason: 'tool_use' }),
      reply({ output: { message: { role: 'assistant', content: [{ text: 'Revenue is 42.' }] } }, stopReason: 'end_turn' }),
    );
    const out = await provider({ inference: { stopSequences: ['END'] } }).generateWithTools(
      [{ role: 'system', content: 'Use tools.' }, { role: 'user', content: 'What is revenue?' }],
      [tool],
      { onProviderDispatch: (event) => prepareProviderWireEnvelopeForDispatch(event.provider, event.envelope) },
    );
    expect(out).toBe('Revenue is 42.');
    const first = sent(fetch, 0).body;
    expect(first.system).toEqual([{ text: 'Use tools.' }]);
    expect(first.messages).toEqual([{ role: 'user', content: [{ text: 'What is revenue?' }] }]);
    expect(first.toolConfig.tools[0].toolSpec.inputSchema.json).toEqual(tool.inputSchema);
    expect(first.inferenceConfig.stopSequences).toEqual(['END']);
    const second = sent(fetch, 1).body;
    expect(second.messages[1].content[0].toolUse.input).toEqual({ metric: 'revenue' });
    expect(second.messages[2]).toEqual({ role: 'user', content: [{ toolResult: { toolUseId: 'tu-1', content: [{ text: '{"value":42}' }] } }] });
    expect(second.toolConfig.tools).toHaveLength(1);
  });
});

describe('Bedrock Converse: refused replies', () => {
  it('treats guardrail_intervened as an error, not an answer', async () => {
    stubFetch(reply({ output: { message: { role: 'assistant', content: [{ text: 'Sorry, the model cannot answer this.' }] } }, stopReason: 'guardrail_intervened' }));
    await expect(provider().generate([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      message: expect.stringContaining('Guardrail'),
      code: 'guardrail_intervened',
    });
  });

  it('treats content_filtered as an error in the tool loop too', async () => {
    stubFetch(reply({ output: { message: { role: 'assistant', content: [] } }, stopReason: 'content_filtered' }));
    const tool = { name: 't', description: 'd', inputSchema: {}, run: async () => ({}) };
    await expect(provider().generateWithTools([{ role: 'user', content: 'x' }], [tool])).rejects.toMatchObject({ code: 'content_filtered' });
  });

  it('returns what was said when the reply hit max_tokens', async () => {
    stubFetch(reply({ output: { message: { role: 'assistant', content: [{ text: 'Partial' }] } }, stopReason: 'max_tokens' }));
    expect(await provider().generate([{ role: 'user', content: 'x' }])).toBe('Partial');
  });
});

describe('Bedrock Converse: plain error messages', () => {
  const cases: Array<[number, string, string, RegExp]> = [
    [400, 'ValidationException', 'The provided model identifier is invalid.', /Bedrock rejected the request for amazon\.nova-pro-v1:0: The provided model identifier is invalid\./],
    [403, 'AccessDeniedException', 'User is not authorized', /Bedrock denied access to amazon\.nova-pro-v1:0 in us-east-1.*bedrock:InvokeModel.*model access/],
    [429, 'ThrottlingException', 'Too many requests', /throttling requests to amazon\.nova-pro-v1:0.*Try again shortly/],
    [404, 'ResourceNotFoundException', 'Could not resolve the foundation model', /cannot find amazon\.nova-pro-v1:0 in us-east-1/],
    [429, 'ModelNotReadyException', 'warming', /amazon\.nova-pro-v1:0 is not ready yet/],
    [503, 'ServiceUnavailableException', 'down', /Bedrock is temporarily unavailable/],
    [503, 'ServiceUnavailable', 'down', /Bedrock is temporarily unavailable/],
  ];
  it.each(cases)('maps %i %s', async (status, type, message, expected) => {
    stubFetch(failure(status, type, message));
    const error = await provider().generate([{ role: 'user', content: 'x' }]).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^bedrock: /);
    expect(error.message).toMatch(expected);
    expect(error.status).toBe(status);
  });

  it('reads the error type from the body when the header is absent', async () => {
    stubFetch(new Response(JSON.stringify({ __type: 'com.amazon.coral.service#ThrottlingException', message: 'slow down' }), { status: 429 }));
    await expect(provider().generate([{ role: 'user', content: 'x' }])).rejects.toThrow('throttling');
  });

  it('keeps AWS words for an unknown error and also maps it inside the tool loop', async () => {
    stubFetch(failure(424, 'ModelErrorException', 'model failed'), failure(403, 'AccessDeniedException', 'no'));
    await expect(provider().generate([{ role: 'user', content: 'x' }])).rejects.toThrow('bedrock: 424 ModelErrorException model failed');
    const tool = { name: 't', description: 'd', inputSchema: {}, run: async () => ({}) };
    await expect(provider().generateWithTools([{ role: 'user', content: 'x' }], [tool])).rejects.toThrow('denied access');
  });
});

describe('Bedrock Converse: usage', () => {
  it('records Converse usage, including cache tokens, against the bedrock provider', async () => {
    const lines: ProviderUsageLine[] = [];
    setProviderUsageListener((line) => lines.push(line));
    stubFetch(reply({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadInputTokens: 80, cacheWriteInputTokens: 10 },
    }));
    await provider().generate([{ role: 'user', content: 'x' }]);
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(lines[0]).toMatchObject({ provider: 'bedrock', model: NOVA, operation: 'generate', inputTokens: 120, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 10 });
  });

  it('records nothing when the reply has no usage block', async () => {
    const lines: ProviderUsageLine[] = [];
    setProviderUsageListener((line) => lines.push(line));
    stubFetch(reply({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' }));
    await provider().generate([{ role: 'user', content: 'x' }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lines).toEqual([]);
  });
});
