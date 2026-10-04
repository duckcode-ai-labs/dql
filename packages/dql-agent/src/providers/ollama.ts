import type {
  AgentProvider,
  AgentMessage,
  ProviderRunOptions,
} from './types.js';
import { fetchProviderHttpDispatch } from './dispatch.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './types.js';

/**
 * THE CONTEXT WINDOW A CALL NEEDS. Ollama serves a model with its own default
 * window (often 4k–8k tokens) unless the request names one, and a longer
 * prompt is cut without an error: an Ask reading (about 12k tokens of
 * governed vocabulary) lost its question. The window is sized from the prompt
 * (about 3 characters per token, generous for code and identifiers) plus the
 * reply budget, rounded up to 4k, at least 8k and at most
 * OLLAMA_NUM_CTX_MAX (default 65,536), since a larger window costs memory.
 */
export function ollamaContextWindow(messages: AgentMessage[], numPredict: number, env: NodeJS.ProcessEnv = process.env): number {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const needed = Math.ceil(chars / 3) + numPredict + 512;
  const ceiling = Number(env.OLLAMA_NUM_CTX_MAX) > 0 ? Number(env.OLLAMA_NUM_CTX_MAX) : 65_536;
  return Math.min(ceiling, Math.max(8192, Math.ceil(needed / 4096) * 4096));
}

/** Where Ollama listens when nothing else is configured: this machine. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/**
 * The one base URL an Ollama provider talks to: the configured one (the
 * provider's setting, else OLLAMA_BASE_URL), else this machine's default.
 */
export function ollamaBaseUrl(configured?: string): string {
  return (configured?.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
}

/**
 * Local Ollama provider — talks to ONE Ollama daemon: the configured base URL
 * (the provider setting, else OLLAMA_BASE_URL), else http://127.0.0.1:11434.
 * It never tries another address on its own: whether result values may reach
 * this model is decided from `baseUrl` (DQL's local-model rule: only a
 * loopback URL is "this machine"), so the provider must contact that URL and
 * no other. A container that runs Ollama elsewhere names it in
 * OLLAMA_BASE_URL (Docker Compose does), and is then a model off this machine.
 *
 * `available()` asks `/api/tags` and returns true on any 2xx/4xx — a 4xx
 * still means a daemon is listening. Use OLLAMA_MODEL or pass `model` to pin
 * the served model.
 */
export class OllamaProvider implements AgentProvider {
  readonly name = 'ollama' as const;
  /** The only base URL this provider contacts. */
  readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(opts: { baseUrl?: string; model?: string } = {}) {
    this.baseUrl = ollamaBaseUrl(opts.baseUrl ?? process.env.OLLAMA_BASE_URL);
    this.defaultModel = opts.model ?? process.env.OLLAMA_MODEL ?? 'qwen3.6:latest';
  }

  /** Every URL this provider can contact (one): for the local-model rule. */
  endpoints(): string[] {
    return [this.baseUrl];
  }

  async available(): Promise<boolean> {
    return canReachOllama(this.baseUrl);
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    const errors: string[] = [];
    let attemptIndex = 0;
    // The one configured URL, tried once more after a failed answer (a daemon that is loading a model); never another host.
    for (const baseUrl of [this.baseUrl, this.baseUrl]) {
      try {
        attemptIndex += 1;
        const res = await fetchProviderHttpDispatch({
          provider: this.name,
          operation: 'generate',
          attemptIndex,
          options,
          envelope: {
            model: options.model ?? this.defaultModel,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream: false,
            think: false,
            // A caller that asks for a structured reply gets JSON mode, so a
            // local model cannot answer in prose around the object.
            ...(options.responseJsonSchema ? { format: 'json' } : {}),
            options: {
              temperature: options.temperature ?? 0.2,
              num_predict: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
              num_ctx: ollamaContextWindow(messages, options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
            },
          },
          url: `${baseUrl}/api/chat`,
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: options.signal,
          },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => res.statusText);
          errors.push(`${res.status} ${body}`);
          continue;
        }
        const json = (await res.json()) as { message?: { content?: string } };
        return json.message?.content ?? '';
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (isDispatchBudgetError(err)) throw err;
        // Nothing listens there: say so plainly, and try nowhere else.
        throw new Error(ollamaNotRunning(this.baseUrl));
      }
    }
    throw new Error(`Ollama at ${this.baseUrl} could not answer: ${errors.join(' | ')}`);
  }

  async generateStream(
    messages: AgentMessage[],
    options: ProviderRunOptions,
    onDelta: (delta: string) => void,
  ): Promise<string> {
    const errors: string[] = [];
    let attemptIndex = 0;
    for (const baseUrl of [this.baseUrl, this.baseUrl]) {
      try {
        attemptIndex += 1;
        const res = await fetchProviderHttpDispatch({
          provider: this.name,
          operation: 'generate_stream',
          attemptIndex,
          options,
          envelope: {
            model: options.model ?? this.defaultModel,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
            think: false,
            options: { temperature: options.temperature ?? 0.2, num_predict: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, num_ctx: ollamaContextWindow(messages, options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) },
          },
          url: `${baseUrl}/api/chat`,
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: options.signal,
          },
        });
        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => res.statusText);
          errors.push(`${res.status} ${body}`);
          continue;
        }
        // Ollama streams newline-delimited JSON, one object per chunk.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let full = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: !done });
            let nl = buffer.indexOf('\n');
            while (nl >= 0) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (line) {
                try {
                  const obj = JSON.parse(line) as { message?: { content?: string } };
                  const delta = obj.message?.content;
                  if (delta) { full += delta; onDelta(delta); }
                } catch { /* ignore partial line */ }
              }
              nl = buffer.indexOf('\n');
            }
          }
          if (done) break;
        }
        return full;
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (isDispatchBudgetError(err)) throw err;
        throw new Error(ollamaNotRunning(this.baseUrl));
      }
    }
    throw new Error(`Ollama at ${this.baseUrl} could not answer: ${errors.join(' | ')}`);
  }
}

/** What a person reads when nothing answers at the configured Ollama. */
export function ollamaNotRunning(baseUrl: string): string {
  return `Ollama is not running at ${baseUrl}. Start it there, or set the Ollama base URL in Settings.`;
}

/** DQL's own stop for a run's provider calls (its dispatch budget): passed on as it is. */
function isDispatchBudgetError(error: unknown): boolean {
  return error instanceof Error && /dispatch budget exhausted/i.test(error.message);
}

async function canReachOllama(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { method: 'GET' });
    return res.status < 500;
  } catch {
    return false;
  }
}
