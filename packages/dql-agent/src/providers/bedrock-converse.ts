import type {
  AgentProvider,
  AgentMessage,
  AgentToolDefinition,
  NativeToolLoopStop,
  NativeToolLoopResult,
  ProviderToolLoopOptions,
  ProviderRunOptions,
} from './types.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './types.js';
import { compactToolOutput } from './tool-output.js';
import { fetchProviderHttpDispatch, providerDispatchLimit, type ProviderHttpTransport } from './dispatch.js';
import { defaultAwsCredentials, signAwsRequest, type AwsCredentials } from './claude-cloud.js';
import { adoptProseAsFinishNarration, admittedToolNames } from '../agentic/tool-loop.js';
import { runGatedTool } from '../agentic/tool-gate.js';

/**
 * ANY AMAZON BEDROCK MODEL, THROUGH THE CONVERSE API (RFC 0010, slice HH-5).
 *
 * `claude-cloud.ts` sends Claude's own Messages format to InvokeModel, which
 * every other Bedrock model rejects. Converse is Bedrock's one request shape
 * for all models that support it (Amazon Nova, Meta Llama, Mistral, OpenAI
 * gpt-oss, Claude, ...), so the privacy rule — the model runs in the
 * customer's account and approved region — no longer depends on the vendor.
 * The Claude path in `claude-cloud.ts` is untouched; use this one for the rest.
 *
 * Built from the public docs:
 * - POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse
 *   (modelId URL-encoded: `amazon.nova-pro-v1:0` -> `amazon.nova-pro-v1%3A0`),
 *   signed with SigV4, service `bedrock`.
 * - Request: system:[{text}], messages:[{role, content:[blocks]}],
 *   inferenceConfig, toolConfig, guardrailConfig.
 * - Reply: output.message.content, stopReason, usage.
 * Answered whole; ConverseStream (AWS event-stream framing) is not built yet.
 * Not yet checked against the live service.
 */

type Block = Record<string, unknown>;
interface ConverseMessage { role: 'user' | 'assistant'; content: Block[] }

export interface BedrockConverseOptions {
  /** The Bedrock region, e.g. us-east-1. */
  region: string;
  /** In-region model id or Geo inference profile id, e.g. amazon.nova-pro-v1:0, us.amazon.nova-pro-v1:0. */
  model: string;
  /** Defaults to the environment / container credentials chain. */
  credentials?: () => Promise<AwsCredentials>;
  /** For tests and VPC endpoints: replaces https://bedrock-runtime.{region}.amazonaws.com. */
  endpoint?: string;
  /** An Amazon Bedrock Guardrail applied to every call (its id or ARN, and version). */
  guardrail?: { id: string; version: string };
  /** Optional sampling controls sent on every call. */
  inference?: { topP?: number; stopSequences?: string[] };
  now?: () => Date;
}

function cached<T extends { expiration?: Date }>(load: () => Promise<T>, marginMs = 60_000): () => Promise<T> {
  let value: T | undefined;
  return async () => {
    if (value && (!value.expiration || value.expiration.getTime() - marginMs > Date.now())) return value;
    value = await load();
    return value;
  };
}

/**
 * Where a Converse request goes and how it is signed. Takes the request the
 * provider built (with its `model` field), moves the model into the URL and
 * adds the guardrail, if any, to the body.
 */
export function bedrockConverseTransport(options: Omit<BedrockConverseOptions, 'model' | 'inference'>): ProviderHttpTransport {
  const credentials = cached(options.credentials ?? (() => defaultAwsCredentials()));
  const base = (options.endpoint ?? `https://bedrock-runtime.${options.region}.amazonaws.com`).replace(/\/$/, '');
  return {
    async prepare({ body }) {
      const { model, stream, ...rest } = body;
      if (typeof model !== 'string' || !model) throw new Error('bedrock: a model id is required');
      if (stream === true) throw new Error('bedrock: streaming is answered whole; use a provider with streaming off');
      const url = `${base}/model/${encodeURIComponent(model)}/converse`;
      const payload = JSON.stringify({
        ...rest,
        ...(options.guardrail ? { guardrailConfig: { guardrailIdentifier: options.guardrail.id, guardrailVersion: options.guardrail.version } } : {}),
      });
      const signed = signAwsRequest({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: payload,
        region: options.region,
        service: 'bedrock',
        credentials: await credentials(),
        ...(options.now ? { now: options.now() } : {}),
      });
      return { url, body: payload, headers: signed };
    },
  };
}

/** Any Bedrock model that supports Converse, answered whole. */
export function createBedrockConverseProvider(options: BedrockConverseOptions): BedrockConverseProvider {
  return new BedrockConverseProvider({
    model: options.model,
    region: options.region,
    transport: bedrockConverseTransport(options),
    ...(options.inference ? { inference: options.inference } : {}),
  });
}

// ── Errors ───────────────────────────────────────────────────────────────

const PLAIN_ERRORS: Record<string, (ctx: { model: string; region: string; detail: string }) => string> = {
  ValidationException: ({ model, detail }) => `Bedrock rejected the request for ${model}: ${detail}. Check the model id, and that this model supports tool use and the settings sent.`,
  AccessDeniedException: ({ model, region }) => `Bedrock denied access to ${model} in ${region}. The role needs bedrock:InvokeModel on it, and model access must be enabled for this account and region.`,
  ThrottlingException: ({ model }) => `Bedrock is throttling requests to ${model}. Try again shortly, or ask AWS for a higher quota.`,
  ResourceNotFoundException: ({ model, region }) => `Bedrock cannot find ${model} in ${region}. Check the model id (or inference profile id) and the region.`,
  ModelNotReadyException: ({ model }) => `${model} is not ready yet. Try again shortly.`,
  ServiceUnavailableException: () => 'Bedrock is temporarily unavailable. Try again shortly.',
};

/** The plain error for a failed Converse call; unknown types keep AWS's own words. */
async function converseError(res: Response, context: { model: string; region: string }): Promise<Error> {
  const text = await res.text().catch(() => res.statusText);
  let parsed: { message?: string; Message?: string; __type?: string; code?: string } = {};
  try { parsed = JSON.parse(text); } catch { /* not JSON: keep the raw text */ }
  const rawType = res.headers.get('x-amzn-errortype') ?? parsed.__type ?? parsed.code ?? '';
  // AWS sends "ValidationException:http://internal.amazon.com/..." or "com.amazon...#ValidationException".
  const type = rawType.split(':')[0]!.split('#').pop()!.trim();
  const detail = (parsed.message ?? parsed.Message ?? text).trim();
  const known = PLAIN_ERRORS[type === 'ServiceUnavailable' ? 'ServiceUnavailableException' : type];
  const message = known
    ? known({ ...context, detail })
    : `${res.status}${type ? ` ${type}` : ''} ${detail}`.trim();
  return Object.assign(new Error(`bedrock: ${message}`), { status: res.status, ...(type ? { bedrockErrorType: type } : {}) });
}

// ── Mapping ──────────────────────────────────────────────────────────────

/** Converse needs strictly alternating roles; adjacent turns of one role become one message. */
function pushTurn(turns: ConverseMessage[], role: 'user' | 'assistant', content: Block[]): void {
  if (content.length === 0) return;
  const last = turns[turns.length - 1];
  if (last && last.role === role) last.content.push(...content);
  else turns.push({ role, content: [...content] });
}

const hasText = (value: string | undefined): value is string => typeof value === 'string' && value.trim().length > 0;

/** System messages become the system array; the rest become alternating turns. Blank text is dropped (Converse rejects it). */
function toConverse(messages: AgentMessage[]): { system: Block[]; turns: ConverseMessage[] } {
  const system: Block[] = [];
  const turns: ConverseMessage[] = [];
  for (const message of messages) {
    if (!hasText(message.content)) continue;
    if (message.role === 'system') system.push({ text: message.content });
    else pushTurn(turns, message.role, [{ text: message.content }]);
  }
  // A conversation must open with a user turn.
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: [{ text: '(start)' }] });
  return { system, turns };
}

function inferenceConfig(options: ProviderRunOptions, extra?: BedrockConverseOptions['inference']): Record<string, unknown> {
  return {
    maxTokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: options.temperature ?? 0.2,
    ...(extra?.topP !== undefined ? { topP: extra.topP } : {}),
    ...(extra?.stopSequences?.length ? { stopSequences: extra.stopSequences } : {}),
  };
}

function toolConfig(tools: readonly AgentToolDefinition[], forced?: string): Record<string, unknown> {
  return {
    tools: tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.inputSchema } } })),
    ...(forced ? { toolChoice: { tool: { name: forced } } } : {}),
  };
}

interface ConverseReply {
  blocks: Block[];
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  stopReason?: string;
}

/**
 * Read one Converse reply. A reply the guardrail or a content filter replaced
 * is an error, never an answer: its text is the service's block message.
 */
function readReply(json: unknown, model: string): ConverseReply {
  const reply = json as { output?: { message?: { content?: Block[] } }; stopReason?: string };
  const stopReason = reply.stopReason;
  if (stopReason === 'guardrail_intervened' || stopReason === 'content_filtered') {
    throw Object.assign(
      new Error(`bedrock: ${model} did not answer: the ${stopReason === 'guardrail_intervened' ? 'Bedrock Guardrail' : 'content filter'} stopped the reply (${stopReason}).`),
      { code: stopReason },
    );
  }
  const blocks = reply.output?.message?.content ?? [];
  const text = blocks.map((block) => (typeof block.text === 'string' ? block.text : '')).join('');
  const toolUses = blocks.flatMap((block) => {
    const use = block.toolUse as { toolUseId?: unknown; name?: unknown; input?: unknown } | undefined;
    return use && typeof use.toolUseId === 'string' && typeof use.name === 'string'
      ? [{ id: use.toolUseId, name: use.name, input: use.input ?? {} }]
      : [];
  });
  return { blocks, text, toolUses, ...(stopReason ? { stopReason } : {}) };
}

// ── Provider ─────────────────────────────────────────────────────────────

export class BedrockConverseProvider implements AgentProvider {
  readonly name = 'bedrock' as const;
  private readonly defaultModel: string;
  private readonly region: string;
  private readonly transport: ProviderHttpTransport;
  private readonly inference?: BedrockConverseOptions['inference'];

  constructor(opts: { model: string; region: string; transport: ProviderHttpTransport; inference?: BedrockConverseOptions['inference'] }) {
    this.defaultModel = opts.model;
    this.region = opts.region;
    this.transport = opts.transport;
    this.inference = opts.inference;
  }

  async available(): Promise<boolean> {
    return true;
  }

  private async send(
    operation: 'generate' | 'generate_with_tools',
    attemptIndex: number,
    body: Record<string, unknown>,
    options: ProviderRunOptions,
  ): Promise<Response> {
    return fetchProviderHttpDispatch({
      provider: this.name,
      operation,
      attemptIndex,
      envelope: body,
      options,
      url: 'bedrock-converse',
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, signal: options.signal },
      transport: this.transport,
    });
  }

  // Reasoning effort is not supported here: the Converse request never carries
  // it (`supportsReasoningEffort('bedrock', …)` is false), and no Claude-only
  // field (`anthropic_version`, `output_config`, `thinking`) is ever sent.

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    const model = options.model ?? this.defaultModel;
    const { system, turns } = toConverse(messages);
    const res = await this.send('generate', 1, {
      model,
      messages: turns,
      ...(system.length ? { system } : {}),
      inferenceConfig: inferenceConfig(options, this.inference),
    }, options);
    if (!res.ok) throw await converseError(res, { model, region: this.region });
    return readReply(await res.json(), model).text;
  }

  async generateWithTools(
    messages: AgentMessage[],
    tools: AgentToolDefinition[],
    options: ProviderToolLoopOptions = {},
  ): Promise<NativeToolLoopResult> {
    if (tools.length === 0) return this.generate(messages, options);

    const model = options.model ?? this.defaultModel;
    const { system, turns } = toConverse(messages);
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    const dispatchLimit = providerDispatchLimit(options);
    const requestedToolBudget = Math.max(0, Math.min(dispatchLimit <= 2 ? 4 : 30, options.maxToolCalls ?? 8));
    // A live V2 tool policy reserves the last physical send for one
    // host-approved terminal action; without it the legacy budget applies.
    const dynamicToolPolicy = Boolean(options.getCurrentToolPolicy);
    const ordinaryToolBudget = dynamicToolPolicy
      ? Math.min(requestedToolBudget, Math.max(0, dispatchLimit - 1))
      : requestedToolBudget;
    let toolCallsUsed = 0;
    let lastText = '';
    let dispatches = 0;
    const requiresPostExecutionFinish = dynamicToolPolicy && tools.some((tool) => tool.name === 'finish_answer');
    let requiredActionSignature = '';
    let requiredActionProseRetries = 0;
    const advertised = tools.filter((tool) => !tool.hidden);

    const post = async (body: Record<string, unknown>): Promise<ConverseReply> => {
      dispatches += 1;
      const res = await this.send('generate_with_tools', dispatches, body, options);
      if (!res.ok) throw await converseError(res, { model, region: this.region });
      return readReply(await res.json(), model);
    };

    // Converse requires toolConfig whenever the history holds toolUse or
    // toolResult blocks, so the closing send still declares the tools; it is
    // only ever read for prose. A reply that asks for a tool again is ignored.
    const forcedFinal = async (): Promise<string> => {
      const reply = await post({
        model,
        messages: turns,
        ...(system.length ? { system } : {}),
        inferenceConfig: inferenceConfig(options, this.inference),
        toolConfig: toolConfig(advertised),
      });
      return reply.toolUses.length === 0 ? reply.text.trim() : '';
    };

    for (;;) {
      const currentPolicy = nativeToolPolicy(options, tools);
      const nextRequiredActionSignature = [...currentPolicy.terminalActionToolNames].sort().join('|');
      if (nextRequiredActionSignature !== requiredActionSignature) {
        requiredActionSignature = nextRequiredActionSignature;
        requiredActionProseRetries = 0;
      }
      const narrationControlRound = currentPolicy.terminalActionToolNames.has('finish_answer');
      const terminalExecutionAction = [...currentPolicy.terminalActionToolNames].some((name) => !isAskV2TerminalControlTool(name));
      const reservePostExecutionNarration = requiresPostExecutionFinish && terminalExecutionAction;
      const finalExecutionActionRound = !narrationControlRound
        && dispatches >= Math.max(0, dispatchLimit - (reservePostExecutionNarration ? 2 : 1));
      const terminalActionRound = dynamicToolPolicy
        && currentPolicy.terminalActionToolNames.size > 0
        && (toolCallsUsed >= ordinaryToolBudget
          || (narrationControlRound ? dispatches >= dispatchLimit - 1 : finalExecutionActionRound));
      if (dynamicToolPolicy && toolCallsUsed >= ordinaryToolBudget && !terminalActionRound) {
        return forcedFinal();
      }
      const roundTools = terminalActionRound
        ? currentPolicy.tools.filter((tool) => currentPolicy.terminalActionToolNames.has(tool.name))
        : currentPolicy.tools;
      const roundToolMap = new Map(
        (terminalActionRound
          ? currentPolicy.admittedTools.filter((tool) => currentPolicy.terminalActionToolNames.has(tool.name))
          : currentPolicy.admittedTools).map((tool) => [tool.name, tool]),
      );
      const forcedTool = dynamicToolPolicy && currentPolicy.visibleTerminalActionToolNames.size === 1
        ? [...currentPolicy.visibleTerminalActionToolNames][0]!
        : undefined;
      const roundSystem = currentPolicy.instruction ? [...system, { text: currentPolicy.instruction }] : system;

      let reply: ConverseReply;
      try {
        reply = await post({
          model,
          messages: turns,
          ...(roundSystem.length ? { system: roundSystem } : {}),
          inferenceConfig: inferenceConfig(options, this.inference),
          // History may hold tool blocks, so toolConfig is never empty.
          toolConfig: toolConfig(roundTools.length ? roundTools : advertised, forcedTool),
        });
      } catch (error) {
        const terminal = nativeToolLoopStopForError(error, toolCallsUsed);
        if (terminal) return terminal;
        throw error;
      }
      const { text, toolUses } = reply;
      if (toolUses.length > 0 && reply.stopReason === 'max_tokens') {
        // The tool input was cut off mid-way: running it would run a guess.
        throw new Error(`bedrock: ${model} ran out of output tokens while calling a tool; raise maxTokens.`);
      }

      if (toolUses.length === 0) {
        if (dynamicToolPolicy && text && await adoptProseAsFinishNarration(
          options,
          tools,
          { allowedToolNames: new Set(currentPolicy.tools.map((tool) => tool.name)), terminalActionToolNames: currentPolicy.terminalActionToolNames },
          text,
        )) {
          toolCallsUsed += 1;
          return text;
        }
        // Prose cannot escape a host-required action: discard it and re-send
        // while a physical send remains.
        if (dynamicToolPolicy && currentPolicy.terminalActionToolNames.size > 0) {
          if (dispatches >= dispatchLimit) return nativeToolLoopStop('provider_dispatch_budget_exhausted', '', toolCallsUsed);
          if (requiredActionProseRetries >= 1) return nativeToolLoopStop('invalid_tool_response', '', toolCallsUsed);
          requiredActionProseRetries += 1;
          pushTurn(turns, 'user', [{
            text: `Controller progression required. Call exactly one of: ${[...currentPolicy.visibleTerminalActionToolNames].join(', ')}. Do not answer in prose.`,
          }]);
          continue;
        }
        if (text) lastText = text;
        return text || lastText;
      }
      if (text) lastText = text;
      const roundToolBudget = terminalActionRound ? ordinaryToolBudget + 1 : ordinaryToolBudget;
      const invalidTerminalAction = terminalActionRound
        && (toolUses.length !== 1 || !currentPolicy.terminalActionToolNames.has(toolUses[0]!.name));
      if (invalidTerminalAction || toolCallsUsed + toolUses.length > roundToolBudget) {
        options.onToolCall?.({
          name: 'tool_budget_exhausted',
          input: { requestedToolCalls: toolUses.map((call) => call.name), maxToolCalls: roundToolBudget, toolCallsUsed },
          output: { error: `Tool-call budget exhausted after ${toolCallsUsed} call(s).` },
          isError: true,
        });
        if (dynamicToolPolicy) return nativeToolLoopStop('tool_budget_exhausted', '', toolCallsUsed);
        // Graceful close: the reply asked for tools we will not run, so it is
        // not put in the history; ask for the answer from what is there.
        pushTurn(turns, 'user', [{
          text: 'Tool budget reached — do not call any more tools. Answer now using only the information the tool calls above already returned, following the required output format.',
        }]);
        try {
          const finalText = await forcedFinal();
          if (finalText) return finalText;
        } catch {
          // Fall through to the legacy behaviour on any final-turn failure.
        }
        return lastText || JSON.stringify({ summary: `Tool-call budget exhausted after ${toolCallsUsed} call(s).` });
      }

      pushTurn(turns, 'assistant', reply.blocks.filter((block) => 'text' in block ? hasText(block.text as string) : 'toolUse' in block));
      const results: Block[] = [];
      for (const call of toolUses) {
        toolCallsUsed += 1;
        const tool = roundToolMap.get(call.name) ?? (dynamicToolPolicy ? undefined : toolMap.get(call.name));
        let output: unknown;
        let isError = false;
        let deadlineStop: NativeToolLoopResult | undefined;
        const toolStartedAt = Date.now();
        if (!tool) {
          output = { error: `Unknown tool: ${call.name}` };
          isError = true;
        } else {
          try {
            assertMayStartToolCall(options, call.name);
            output = await runGatedTool(tool, call.input);
          } catch (err) {
            const code = toolLoopErrorCode(err);
            output = { error: err instanceof Error ? err.message : String(err), ...(code ? { code } : {}) };
            isError = true;
            deadlineStop = nativeToolLoopStopForError(err, toolCallsUsed);
          }
        }
        options.onToolCall?.({ name: call.name, input: call.input, output, isError, durationMs: Date.now() - toolStartedAt });
        if (deadlineStop) return deadlineStop;
        results.push({
          toolResult: {
            toolUseId: call.id,
            content: [{ text: compactToolOutput(output) }],
            // `status` is documented for Anthropic models only; the error text
            // is in the content either way.
            ...(isError && /anthropic\./i.test(model) ? { status: 'error' } : {}),
          },
        });
        if (isAskV2TerminalControlTool(call.name) && !isError && isFinishedToolOutput(output)) {
          return text || lastText;
        }
      }
      pushTurn(turns, 'user', results);
      if (terminalActionRound) {
        const terminalCall = toolUses[0];
        if (terminalCall && isAskV2TerminalControlTool(terminalCall.name)) {
          return nativeToolLoopStop('tool_budget_exhausted', '', toolCallsUsed);
        }
        if (reservePostExecutionNarration) continue;
        return text || lastText;
      }
      if (dispatchLimit <= 2 && !dynamicToolPolicy) {
        try {
          const finalText = await forcedFinal();
          return finalText || lastText || JSON.stringify({ summary: 'The provider did not return a final answer within the bounded tool round.' });
        } catch (error) {
          if (toolLoopErrorCode(error) === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED') throw error;
          return lastText || JSON.stringify({ summary: 'The provider dispatch budget was exhausted before a final answer.' });
        }
      }
    }
  }
}

// ── Tool-loop helpers (the same rules as the OpenAI and Anthropic loops) ──

function assertMayStartToolCall(options: ProviderToolLoopOptions, toolName?: string): void {
  if (toolName === 'finish_answer') return;
  if (options.mayStartToolCall?.() === false) {
    throw Object.assign(new Error('The run soft target elapsed before this tool branch could start.'), { code: 'RUN_SOFT_TARGET_EXCEEDED' });
  }
}

function isFinishedToolOutput(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as { finished?: unknown }).finished === true);
}

function isAskV2TerminalControlTool(name: string): boolean {
  return name === 'finish_answer' || name === 'request_clarification';
}

function nativeToolLoopStop(kind: NativeToolLoopStop['kind'], text: string, toolCalls: number): NativeToolLoopResult {
  return { version: 1, kind, text, toolCalls };
}

function toolLoopErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function nativeToolLoopStopForError(error: unknown, toolCalls: number): NativeToolLoopResult | undefined {
  const code = toolLoopErrorCode(error);
  if (code === 'RUN_SOFT_TARGET_EXCEEDED') return nativeToolLoopStop('run_soft_target_exceeded', '', toolCalls);
  if (code === 'RUN_DEADLINE_INSUFFICIENT') return nativeToolLoopStop('run_deadline_insufficient', '', toolCalls);
  if (code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED') return nativeToolLoopStop('provider_dispatch_budget_exhausted', '', toolCalls);
  return undefined;
}

function nativeToolPolicy(
  options: ProviderToolLoopOptions,
  tools: readonly AgentToolDefinition[],
): { tools: AgentToolDefinition[]; admittedTools: AgentToolDefinition[]; terminalActionToolNames: Set<string>; visibleTerminalActionToolNames: Set<string>; instruction?: string } {
  const policy = options.getCurrentToolPolicy?.();
  const allowed = admittedToolNames(policy?.allowedToolNames ?? tools.map((tool) => tool.name), tools);
  const admitted = tools.filter((tool) => allowed.has(tool.name));
  const enabled = admitted.filter((tool) => !tool.hidden);
  const terminalActionToolNames = new Set(
    [...admittedToolNames(policy?.terminalActionToolNames ?? [], tools)].filter((name) => allowed.has(name)),
  );
  return {
    tools: enabled,
    admittedTools: admitted,
    terminalActionToolNames,
    visibleTerminalActionToolNames: new Set([...terminalActionToolNames].filter((name) => enabled.some((tool) => tool.name === name))),
    ...(policy?.instruction?.trim() ? { instruction: policy.instruction.trim() } : {}),
  };
}
