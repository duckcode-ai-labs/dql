/**
 * Pluggable LLM provider interface for the agent.
 *
 * Providers are intentionally tiny — they take a system+user message pair
 * and return a string response. Streaming and tool-use orchestration are
 * intentionally out of scope at this layer; the answer-loop owns that
 * orchestration on top of the provider.
 *
 * Each provider is implementation-detail-free: it reads its config from
 * env vars and an optional user-supplied object, and uses `fetch` so we
 * stay zero-dep at the package level. Network-bound failures bubble out as
 * thrown Errors with provider-prefixed messages.
 */

export type ProviderName = 'claude' | 'openai' | 'gemini' | 'ollama' | 'bedrock';

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ProviderDispatchOperation = 'generate' | 'generate_with_tools' | 'generate_stream';

/** Exact provider-native envelope observed immediately before one HTTP send. */
export interface ProviderDispatchEvent {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  /** One-based attempt number within this provider method invocation. */
  attemptIndex: number;
  model?: string;
  options?: {
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: import('./reasoning-effort.js').ReasoningEffort;
  };
  envelope: Record<string, unknown>;
}

/**
 * The observer returns the normalized envelope that must be sent. This makes
 * guarding/accounting part of the transport boundary instead of an outer-call
 * approximation.
 */
export type ProviderDispatchObserver = (event: ProviderDispatchEvent) => Record<string, unknown>;

/** Content-free completion observation for one already-admitted physical send. */
export interface ProviderDispatchCompletionEvent {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  model?: string;
  outcome: 'ok' | 'error' | 'cancelled';
  /**
   * The physical boundary which just settled. A successful transport/process
   * observation is deliberately not a successful provider result: parsers and
   * stream consumers can still fail afterwards. Existing providers that do
   * not report this field retain the historical final-result interpretation.
   */
  settlement?: 'transport' | 'process' | 'result';
  httpStatus?: number;
  /** Runtime-only classification input. Observers must never persist this raw value. */
  error?: unknown;
}

export type ProviderDispatchCompletionObserver = (event: ProviderDispatchCompletionEvent) => void;

/** A send that was refused before an HTTP request was admitted. */
export interface ProviderDispatchRejectionEvent {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  model?: string;
  /** Runtime-only classification input; trace observers persist only its typed diagnostic. */
  error: unknown;
}

export type ProviderDispatchRejectionObserver = (event: ProviderDispatchRejectionEvent) => void;

export interface ProviderRunOptions {
  /** Optional model override; otherwise the provider picks a sane default. */
  model?: string;
  /** Hard token cap. */
  maxTokens?: number;
  /** Sampling temperature (0..1). */
  temperature?: number;
  /**
   * Reasoning effort (low/medium/high). Providers with a reasoning surface
   * translate it into their native param; the rest ignore it. See
   * `./reasoning-effort.ts`.
   */
  reasoningEffort?: import('./reasoning-effort.js').ReasoningEffort;
  /** Caller-supplied AbortSignal — providers honor it. */
  signal?: AbortSignal;
  /** Hard cap covering compatibility retries and native tool follow-ups. */
  maxProviderDispatches?: number;
  /** Server-owned hook invoked immediately before every provider HTTP body send. */
  onProviderDispatch?: ProviderDispatchObserver;
  /** Server-owned hook invoked when that same physical HTTP send settles. */
  onProviderDispatchComplete?: ProviderDispatchCompletionObserver;
  /** Server-owned hook invoked when admission rejects a would-be physical send. */
  onProviderDispatchRejected?: ProviderDispatchRejectionObserver;
  /**
   * Server-owned lifecycle label for the physical send.  Providers must carry
   * this through untouched; the local runtime is the only authority that maps
   * it to an egress receipt and a trace span.  It exists so an immutable
   * exploratory-plan correction cannot be miscounted as a second generation.
   */
  dispatchPhase?: import('@duckcodeailabs/dql-core').ProviderDispatchPhaseV1;
  /**
   * Server-owned identity for the sequence of sends that make up ONE turn.
   *
   * A transport that can hold a conversation open uses it to send only the new
   * observation instead of re-transmitting the whole transcript on every tool
   * follow-up. It is an efficiency handle and nothing else: it grants no tool,
   * route, or egress permission, and a provider that cannot resume sessions
   * ignores it entirely.
   */
  conversationId?: string;
  /**
   * Server-owned sub-phase for the bounded analytical planner. It exists only
   * to distinguish one initial proposal from one verifier-directed targeted
   * revision at the local egress ledger; providers cannot use it to select a
   * route or request another planner loop.
   */
  analyticalPlanningKind?: 'initial' | 'targeted_revision';
  /**
   * Server-owned egress purpose paired with {@link dispatchPhase}.  Ordinary
   * Ask generation remains content-free; the only normal Ask repair purpose is
   * `repair_sql` and it has no result-row permission.
   */
  egressPurpose?: import('@duckcodeailabs/dql-core').ProviderEgressPurpose;
  /**
   * Server-owned lineage marker for one same-provider transient transport
   * retry. Providers carry it through to the local ledger; callers cannot use
   * it to reopen planning or route selection.
   */
  retryOfAttemptIndex?: number;
  /**
   * The exact JSON shape the caller will accept back, for transports that can
   * CONSTRAIN generation rather than merely request a format.
   *
   * A text-protocol lane parses the model's reply as JSON and treats anything
   * unparseable as prose — which, in a lane where every legal response is a
   * tool call, ends the turn with nothing run. Where the transport supports
   * schema-constrained output, a malformed reply stops being possible instead
   * of being handled. Providers without that capability ignore this.
   */
  responseJsonSchema?: Record<string, unknown>;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: unknown): Promise<unknown>;
  /**
   * Callable when named, never advertised.
   *
   * A hidden tool is left out of every surface the model is shown — the
   * native tool declaration, the text contract, the availability updates —
   * but stays in the loop's dispatch table. The Ask lane uses this for the
   * host's own tier handlers, which the model reaches through one
   * `propose_plan` and which older transcripts and cassettes still name.
   */
  hidden?: boolean;
  /**
   * The advertised tool whose policy admission this hidden tool shares: when
   * the host allows `aliasOf`, a call to this tool is admitted too (and it
   * may take the terminal slot `aliasOf` holds). Meaningful only with
   * `hidden`.
   */
  aliasOf?: string;
}

/**
 * A server-owned update to an in-flight tool conversation.
 *
 * Native tool transports obtain this immediately before every provider send;
 * text transports append the same instruction after every observation.  It
 * lets a bounded controller narrow discovery to the next safe action without
 * making a second, hidden planner call or trusting a provider to remember a
 * stale tool list.
 */
export interface ProviderCurrentToolPolicy {
  /** Canonical tools the provider may request on its next turn. */
  allowedToolNames: readonly string[];
  /** Safe, provider-visible explanation of why the set changed. */
  instruction?: string;
  /**
   * At a physical-send reserve, one of these tools may be the final action.
   * This is intentionally separate from `allowedToolNames`: ordinary tools
   * must never use the last controller turn as a discovery escape hatch.
   */
  terminalActionToolNames?: readonly string[];
}

/**
 * Host-owned phase decision for one concrete provider send.
 *
 * A native tool provider can issue several HTTP requests from one logical
 * `generateWithTools` call.  The outer Ask runtime is the only component that
 * knows whether its state has advanced from discovery/execution to the one
 * required, post-result `finish_answer` control.  This callback lets that
 * runtime classify each physical send at the transport boundary without
 * serializing mutable state to a provider or granting a provider a lifecycle
 * capability.
 */
export type ProviderPhysicalDispatchPhaseResolver = (input: {
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  requestedPhase?: import('@duckcodeailabs/dql-core').ProviderDispatchPhaseV1;
}) => import('@duckcodeailabs/dql-core').ProviderDispatchPhaseV1 | undefined;

export interface ProviderToolLoopOptions extends ProviderRunOptions {
  /** Hard cap for provider-visible tool calls in this turn. Default 8. */
  maxToolCalls?: number;
  /** Optional trace hook for tests/UI instrumentation. `durationMs` is the tool's wall-clock time. */
  onToolCall?: (event: { name: string; input: unknown; output?: unknown; isError?: boolean; durationMs?: number }) => void;
  /** Run-budget guard checked immediately before each physical tool branch. */
  mayStartToolCall?: () => boolean;
  /** Server-owned result-row egress policy applied recursively to every tool output. */
  providerPayloadGuard?: {
    purpose: import('@duckcodeailabs/dql-core').ProviderEgressPurpose;
    allowedResultRowTools?: Record<string, number>;
    resultRowBudgetGroupByTool?: Record<string, string>;
    cumulativeResultRowBudgets?: Record<string, number>;
    /** Additional shape caps for bounded local Ask V2 row egress. */
    maxResultColumns?: number;
    maxResultCells?: number;
    onPayload?: (event: {
      toolName: string;
      output: unknown;
      resultRowCount: number;
      columnCount: number;
      cumulativeResultRowCount: number;
      budgetGroup: string;
      budgetExhausted: boolean;
    }) => void;
  };
  /**
   * Optional live tool policy owned by the host runtime.  The callback is
   * process-local and is never serialized to a provider.  It is evaluated at
   * each transport turn so native and text protocols receive the same current
   * allowed-tool set and safe progress instruction.
   */
  getCurrentToolPolicy?: () => ProviderCurrentToolPolicy | undefined;
  /**
   * Process-local physical-send phase resolver.  Only the local Ask runtime
   * installs this. Providers carry it to the wrapper unchanged and may never
   * use it to choose a route, tool, or egress purpose.
   */
  resolvePhysicalDispatchPhase?: ProviderPhysicalDispatchPhaseResolver;
}

/**
 * Typed native-tool-loop stop. Native transports normally return final prose,
 * but a live Ask V2 policy must distinguish a physical controller/tool budget
 * stop from an answer. The result deliberately contains no provider payload
 * beyond the already-sanitized final text.
 */
export interface NativeToolLoopStop {
  version: 1;
  /**
   * A typed controller stop. Deadline stops deliberately remain distinct from
   * a tool budget: callers can preserve an already validated result and show
   * the actual run-boundary recovery action.
   */
  kind: 'tool_budget_exhausted'
    | 'provider_dispatch_budget_exhausted'
    | 'invalid_tool_response'
    | 'run_soft_target_exceeded'
    | 'run_deadline_insufficient';
  text: string;
  toolCalls: number;
}

export type NativeToolLoopResult = string | NativeToolLoopStop;

export interface AgentProvider {
  readonly name: ProviderName;
  /**
   * Send the conversation, return a single response string.
   * Throws on transport / API errors.
   */
  generate(messages: AgentMessage[], options?: ProviderRunOptions): Promise<string>;
  /**
   * Optional bounded tool loop. Providers that implement native tool use should
   * call supplied tools, append their observations, and resolve with the final
   * assistant text. Callers must keep a one-shot generate() fallback.
   */
  generateWithTools?(
    messages: AgentMessage[],
    tools: AgentToolDefinition[],
    options?: ProviderToolLoopOptions,
  ): Promise<NativeToolLoopResult>;
  /**
   * Optional token streaming. Calls `onDelta` with each text chunk as it arrives
   * and resolves with the full concatenated text. Providers that omit this fall
   * back to `generate()` via {@link streamOrGenerate}.
   */
  generateStream?(
    messages: AgentMessage[],
    options: ProviderRunOptions,
    onDelta: (delta: string) => void,
  ): Promise<string>;
  /** True if this provider has all the credentials/binaries it needs. */
  available(): Promise<boolean>;
}

/**
 * Stream if the provider supports it, else generate once and emit the whole text
 * as a single delta. Degradation is structural — callers always get the full text
 * and at least one delta.
 */
export async function streamOrGenerate(
  provider: AgentProvider,
  messages: AgentMessage[],
  options: ProviderRunOptions,
  onDelta: (delta: string) => void,
): Promise<string> {
  if (provider.generateStream) {
    return provider.generateStream(messages, options, onDelta);
  }
  const text = await provider.generate(messages, options);
  if (text) onDelta(text);
  return text;
}

/**
 * The output ceiling of an API call whose caller named none. Reasoning models
 * spend their thinking from the same budget as the reply: at the old 1,024 an
 * Ask reading (a JSON intent) or a drafted statement with CTEs was cut off
 * mid-way and failed to parse. A ceiling is not a cost: only tokens produced
 * are billed.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
