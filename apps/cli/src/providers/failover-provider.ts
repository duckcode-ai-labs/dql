import type {
  AgentMessage,
  AgentProvider,
  AgentToolDefinition,
  NativeToolLoopResult,
  ProviderName,
  ProviderRunOptions,
  ProviderToolLoopOptions,
} from '@zlens/agent';

/**
 * One unhealthy provider should not end a question when a healthy one is
 * configured.
 *
 * A project can enable Claude Code, Codex and Ollama at once, and DQL used
 * exactly one of them: whichever was active. When that one failed — expired
 * login, a model that is not pulled, a process that died — the turn ended with
 * "The AI provider could not complete this Ask step" while two working
 * providers sat idle. Every governed decision still belongs to the host; this
 * only changes WHICH transport carries the same conversation.
 *
 * The care is in what is NOT retried. A host admission denial, a user
 * cancellation and a run deadline are all decisions, not faults, and asking a
 * second provider would either bypass a gate or ignore the user. Only a
 * genuine transport fault moves down the list.
 */

/** Codes the HOST attaches to a decision. Never a reason to try elsewhere. */
const HOST_DECISION_CODES = new Set([
  'PROVIDER_DISPATCH_NARRATION_NOT_ALLOWED',
  'PROVIDER_DISPATCH_PLANNING_NOT_ALLOWED',
  'PROVIDER_DISPATCH_BUDGET_EXHAUSTED',
  'PROVIDER_INTERPRETATION_PHASE_CONFLICT',
  'PROVIDER_REPAIR_NOT_AUTHORIZED',
  'PROVIDER_RETRY_NOT_AUTHORIZED',
  'RUN_SOFT_TARGET_EXCEEDED',
  'RUN_DEADLINE_INSUFFICIENT',
  'AGENT_RUN_USER_CANCELLED',
]);

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Is this a transport fault another provider might not have?
 *
 * Deliberately conservative: anything the host labelled, anything the user or
 * the deadline stopped, stays where it is.
 */
export function isFailoverEligibleProviderError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  const code = errorCode(error);
  if (code && HOST_DECISION_CODES.has(code)) return false;
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return false;
  return true;
}

export interface FailoverProviderCandidate {
  /** Settings id, for the operator-facing log line only. */
  id: string;
  /** Built lazily: constructing a provider can probe the filesystem or network. */
  create: () => Promise<AgentProvider | null>;
}

export interface FailoverProviderOptions {
  /** Called when a provider fails and another is tried, for the server log. */
  onFailover?: (event: { from: string; to: string; reason: string }) => void;
}

/**
 * Present a list of providers as one provider, moving down the list on a
 * transport fault.
 *
 * The first candidate's `name` is reported as this provider's name so receipts,
 * routing and reasoning-effort resolution behave exactly as before when nothing
 * fails — failover is invisible until it is needed.
 */
export function createFailoverProvider(
  primary: AgentProvider,
  alternates: readonly FailoverProviderCandidate[],
  options: FailoverProviderOptions = {},
): AgentProvider {
  if (alternates.length === 0) return primary;
  const boundedAlternates = alternates.slice(0, 3);

  /**
   * Run one call against the primary, then each alternate in turn.
   *
   * The FIRST error is what the caller sees if every provider fails: it names
   * the transport the project actually chose, which is the one whose readiness
   * the operator needs to fix. Later failures would only describe fallbacks
   * nobody configured deliberately.
   */
  const withFailover = async <T>(
    label: string,
    signal: AbortSignal | undefined,
    call: (provider: AgentProvider) => Promise<T>,
  ): Promise<T> => {
    try {
      return await call(primary);
    } catch (error) {
      if (!isFailoverEligibleProviderError(error, signal)) throw error;
      const firstError = error;
      for (const candidate of boundedAlternates) {
        if (signal?.aborted) throw firstError;
        let provider: AgentProvider | null = null;
        try {
          provider = await candidate.create();
        } catch {
          continue;
        }
        if (!provider) continue;
        try {
          const result = await call(provider);
          options.onFailover?.({
            from: primary.name,
            to: candidate.id,
            reason: `${label}: ${firstError instanceof Error ? firstError.message.slice(0, 160) : 'provider failed'}`,
          });
          return result;
        } catch (alternateError) {
          if (!isFailoverEligibleProviderError(alternateError, signal)) throw alternateError;
        }
      }
      throw firstError;
    }
  };

  const failover: AgentProvider = {
    name: primary.name as ProviderName,
    available: () => primary.available(),
    generate: (messages: AgentMessage[], runOptions?: ProviderRunOptions) =>
      withFailover('generate', runOptions?.signal, (provider) => provider.generate(messages, runOptions)),
  };

  // Only advertise the optional capabilities the PRIMARY has. A caller choosing
  // the native tool loop because the fallback happens to support it would take a
  // different path through the kernel than the project's own provider does.
  if (primary.generateWithTools) {
    failover.generateWithTools = (
      messages: AgentMessage[],
      tools: AgentToolDefinition[],
      loopOptions?: ProviderToolLoopOptions,
    ): Promise<NativeToolLoopResult> => withFailover(
      'generateWithTools',
      loopOptions?.signal,
      (provider) => (provider.generateWithTools
        ? provider.generateWithTools(messages, tools, loopOptions)
        // A fallback without a native loop still answers: the text protocol is
        // the same conversation, and the kernel validates either identically.
        : provider.generate(messages, loopOptions)),
    );
  }
  if (primary.generateStream) {
    failover.generateStream = (
      messages: AgentMessage[],
      runOptions: ProviderRunOptions,
      onDelta: (delta: string) => void,
    ): Promise<string> => withFailover(
      'generateStream',
      runOptions.signal,
      (provider) => (provider.generateStream
        ? provider.generateStream(messages, runOptions, onDelta)
        : provider.generate(messages, runOptions)),
    );
  }
  const readiness = (primary as AgentProvider & { getReadinessFailure?: () => unknown }).getReadinessFailure;
  if (readiness) {
    (failover as AgentProvider & { getReadinessFailure?: () => unknown }).getReadinessFailure =
      () => readiness.call(primary);
  }
  return failover;
}
