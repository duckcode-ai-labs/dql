/**
 * Subscription-backed providers — use an installed agentic coding CLI (Claude Code,
 * Codex) as a plain text-completion backend, authenticated by the user's *login*
 * rather than an API key.
 *
 * The value: a user with a Claude Pro/Max or ChatGPT Plus/Pro subscription can power
 * DQL's AI without pasting an API key. There is no "subscription API key" — the only
 * sanctioned path is to shell out to the vendor's own client, which owns the OAuth
 * login. We constrain each CLI to behave as a one-shot text generator (no tools, no
 * file access, isolated cwd, neutral system prompt) so it slots into the existing
 * {@link AgentProvider} interface and every downstream flow (routing, synthesis,
 * conversation) works unchanged.
 *
 * Tradeoffs the caller should know: each call spawns a fresh CLI process (seconds of
 * cold-start latency), and — for Claude — programmatic usage draws from the plan's
 * Agent-SDK credit, then standard API rates, not the interactive chat pool.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeProviderHttpDispatch,
  prepareProviderHttpDispatch,
  type AgentMessage,
  type AgentProvider,
  type ProviderName,
  type ProviderRunOptions,
} from '@duckcodeailabs/dql-agent';

export interface SubscriptionCliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
  timedOut?: boolean;
}

export interface SubscriptionCliRunOptions {
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Spawn a process, optionally feed stdin, and collect stdout/stderr. Never throws. */
export type SubscriptionCliProcessRunner = (
  command: string,
  args: string[],
  options?: SubscriptionCliRunOptions,
) => Promise<SubscriptionCliRunResult>;

function runProcess(command: string, args: string[], options: SubscriptionCliRunOptions = {}): Promise<SubscriptionCliRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: SubscriptionCliRunResult) => { if (!settled) { settled = true; resolve(result); } };
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ code: null, stdout: '', stderr: '', spawnError: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    const stdout: string[] = [];
    const stderr: string[] = [];
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { /* noop */ }
          forceKillTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* noop */ }
          }, 2_000);
        }, options.timeoutMs)
      : undefined;
    const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* noop */ } };
    options.signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
      finish({ code: null, stdout: stdout.join(''), stderr: stderr.join(''), spawnError: error, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
      finish({ code, stdout: stdout.join(''), stderr: stderr.join(''), timedOut });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Surface a fired AbortSignal as its own reason (deadline TimeoutError, user AbortError). */
function throwIfAlreadyCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }
}

/**
 * A subscription CLI reads a hard question in well over a minute (a two-year
 * comparable cohort with a threshold in each year took longer than 60 s twice
 * in a row, and the turn ended with nothing). The pipeline's own deadline still
 * bounds the turn; this only stops cutting a dispatch off just before it lands.
 */
const DEFAULT_SUBSCRIPTION_CLI_TIMEOUT_MS = 90_000;

/**
 * The CLI did not answer inside its deadline. `code` lets the pipeline retry
 * the dispatch once; `message` is the sentence a reader gets; `detail` is
 * the configuration hint, kept for the receipt and Inspect.
 */
export class ProviderTimeoutError extends Error {
  readonly code = 'provider_timeout';
  readonly detail: string;
  constructor(timeoutMs: number) {
    super(`The AI model did not respond within ${Math.round(timeoutMs / 1_000)} seconds.`);
    this.name = 'ProviderTimeoutError';
    this.detail = 'Retry, choose a faster model, or increase DQL_SUBSCRIPTION_CLI_TIMEOUT_MS.';
  }
}

/** Safe structural fields Claude includes beside a one-shot result. */
export interface ParsedClaudeResult {
  text: string;
  isError: boolean;
  structured?: boolean;
  /** Provider-defined terminal category; retained for classification, never rendered verbatim. */
  terminalReason?: string;
  /** HTTP-style provider status when Claude emits one; 401 is authentication, not a retryable exit. */
  apiErrorStatus?: number;
}

interface ProviderExitContext {
  terminalReason?: string;
  apiErrorStatus?: number;
  /** stdout was not a usable structured error, so its raw content must not enter a receipt. */
  malformedOutput?: boolean;
}

/**
 * The CLI ended without an answer. A usage/session limit is a quota the
 * user must wait out or route around (`provider_quota`, never retried). An
 * expired or missing subscription login is `provider_auth`, which must be
 * repaired by the operator instead of spending the turn on the same CLI
 * again. Any other non-zero exit or empty reply is `provider_exit`, which the
 * pipeline may retry once before anything executes. `detail` is the CLI's own
 * words, sanitized (no paths, bounded) for the receipt.
 */
export class ProviderExitError extends Error {
  readonly code: 'provider_exit' | 'provider_quota' | 'provider_auth';
  readonly detail: string;
  constructor(cli: string, stderr: string, stdout = '', context: ProviderExitContext = {}) {
    const text = `${stderr}\n${stdout}`;
    // A structured 401 outranks any incidental word in the response. It is a
    // stable provider fact, unlike prose which can mention both quota and auth.
    const authByStatus = context.apiErrorStatus === 401;
    const quota = !authByStatus && /session limit|usage limit|rate limit|hit your .*limit|quota/i.test(text);
    const auth = authByStatus || (!quota && /not (?:logged|signed) in|reauthenticate|authenticate|\/login|oauth(?:\s+access)?\s+token.*(?:expired|invalid)|access token.*(?:expired|invalid)|api error:\s*401|\b401\b.*(?:oauth|auth|token)|unauthori[sz]ed/i.test(text));
    const login = cli === 'Claude Code' ? 'claude /login' : cli === 'Codex' ? 'codex login' : 'the provider login command';
    super(quota
      ? `The AI model's usage limit is reached.`
      : auth
        ? `${cli} needs authentication. Re-authenticate with \`${login}\`, then retry.`
        : `${cli} exited before producing an answer.`);
    this.name = 'ProviderExitError';
    this.code = quota ? 'provider_quota' : auth ? 'provider_auth' : 'provider_exit';
    this.detail = sanitizeProviderDetail(text) || (quota
      ? 'usage limit'
      : auth
        ? 'authentication is required'
        : context.malformedOutput
          ? 'The CLI exited with an unreadable error response.'
          : 'empty reply');
  }
}

/** The CLI's words for a receipt: one line, no file paths, no credentials-looking tokens, bounded. */
export function sanitizeProviderDetail(text: string): string {
  return text
    // Authentication headers are opaque credentials. Redact the entire
    // header value whatever authentication scheme it uses (Basic, Bearer,
    // custom), bounded by its newline or JSON-quoted value.
    .replace(/(^|[\s,{;])((?:["']?(?:proxy[-_ ]?authorization|authorization)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/gim, '$1$2<redacted>')
    // Other header-style credentials and JSON/key-value fields can carry JWTs
    // that do not match the older sk-/key- token heuristic.
    .replace(/((?:["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|credential|token)["']?)\s*[:=]\s*)(?:(?:Bearer|JWT)\s+)?(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi, '$1<redacted>')
    .replace(/\b(?:Bearer|JWT)\s+[A-Za-z0-9._~+/=-]+/gi, '<redacted>')
    .replace(/\/(?:Users|home|private|tmp|var)\/\S+/g, '<path>')
    .replace(/\b(sk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function resolveSubscriptionCliTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.DQL_SUBSCRIPTION_CLI_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_SUBSCRIPTION_CLI_TIMEOUT_MS;
  return Math.max(5_000, Math.min(300_000, Math.floor(configured)));
}

/** Split messages into a single system string and a flattened conversation prompt. */
function flattenMessages(messages: AgentMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = messages.filter((m) => m.role !== 'system');
  const prompt = convo.length <= 1
    ? (convo[0]?.content ?? '')
    : convo.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
  return { system, prompt };
}

/** Detection status surfaced to the UI so users know whether a CLI is usable. */
export interface CliAuthStatus {
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
  detail?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code (Claude Pro / Max / Team / Enterprise subscription)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Force OAuth-subscription auth: Claude Code's credential precedence puts an API key
 * / gateway token / cloud-provider flags ABOVE the logged-in subscription. Scrubbing
 * them from the child env makes "use my Claude subscription" deterministic.
 */
function claudeSubscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  return env;
}

export class ClaudeCodeCliProvider implements AgentProvider {
  readonly name: ProviderName = 'claude';
  private readonly command: string;
  private readonly defaultModel?: string;
  private readonly processRunner: SubscriptionCliProcessRunner;

  /** Open CLI sessions, keyed by the server-owned conversation handle. */
  private readonly sessions = new Map<string, { sessionId: string; sentMessageCount: number }>();

  constructor(opts: { command?: string; model?: string; runProcess?: SubscriptionCliProcessRunner } = {}) {
    this.command = opts.command ?? 'claude';
    this.defaultModel = opts.model;
    this.processRunner = opts.runProcess ?? runProcess;
  }

  /**
   * Decide whether this send continues an open CLI session, and how much of the
   * transcript it still has to carry.
   *
   * Resuming is only safe while the transcript GROWS by appending: a caller
   * that rewrote earlier turns would have the session remember a conversation
   * that no longer exists, so any shrink or unexpected count restarts the
   * session with the full text rather than silently diverging.
   */
  private resolveSession(
    options: ProviderRunOptions,
    messages: AgentMessage[],
  ): { sessionId: string; resumed: boolean; sentMessageCount: number; commit: (count: number) => void } | undefined {
    const conversationId = options.conversationId;
    // OFF BY DEFAULT, ON THE EVIDENCE.
    //
    // Resuming was expected to cut latency by not re-sending the transcript.
    // Measured on a 3,373-model project it does not: six runs of one question
    // came in at 38-53s resuming and 44-47s re-sending, inside the noise. The
    // cost of this transport is the model's own time per dispatch, not the
    // bytes. Since resuming also leaves session state on disk where
    // `--no-session-persistence` left none, it stays opt-in until a
    // measurement justifies it. It still saves tokens, which is why the code
    // remains rather than being deleted.
    if (!conversationId || process.env.DQL_SUBSCRIPTION_CLI_SESSION !== 'on') return undefined;
    const existing = this.sessions.get(conversationId);
    const usable = existing && existing.sentMessageCount > 0 && messages.length > existing.sentMessageCount;
    const sessionId = existing?.sessionId ?? randomUUID();
    const entry = existing ?? { sessionId, sentMessageCount: 0 };
    this.sessions.set(conversationId, entry);
    // Bound the map: one entry per live turn, and turns end.
    if (this.sessions.size > 32) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined && oldest !== conversationId) this.sessions.delete(oldest);
    }
    return {
      sessionId,
      resumed: Boolean(usable),
      sentMessageCount: usable ? entry.sentMessageCount : 0,
      commit: (count: number) => {
        entry.sentMessageCount = count;
      },
    };
  }

  /** Installed AND logged in (checked via `claude auth status --json`). */
  async available(): Promise<boolean> {
    const status = await ClaudeCodeCliProvider.detect(this.command);
    return status.installed && status.loggedIn;
  }

  /** Rich detection for the settings UI. */
  static async detect(command = 'claude'): Promise<CliAuthStatus> {
    const res = await runProcess(command, ['auth', 'status', '--json'], { timeoutMs: 8000 });
    if (res.spawnError) return { installed: false, loggedIn: false, detail: 'Claude Code CLI not found on PATH.' };
    // A binary that answers nothing in 8 s is installed but not ready (hung,
    // updating, or waiting on a prompt); that is a different fix from "not installed".
    if (res.timedOut) return { installed: true, loggedIn: false, detail: `\`${command} auth status\` did not answer within 8 seconds; the CLI may be hung or mid-update. Run it in a terminal, or point DQL at a responsive install.` };
    try {
      const parsed = JSON.parse(res.stdout.trim()) as {
        loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string;
      };
      return {
        installed: true,
        loggedIn: parsed.loggedIn === true,
        authMethod: parsed.authMethod,
        subscriptionType: parsed.subscriptionType,
        email: parsed.email,
      };
    } catch {
      // Binary present but `auth status --json` shape unknown — treat as installed,
      // login unverified (generate() will surface a clear error if not logged in).
      return { installed: res.code === 0, loggedIn: res.code === 0, detail: res.stderr.trim() || undefined };
    }
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    // A run whose deadline already fired must not spawn a doomed child process.
    throwIfAlreadyCancelled(options.signal);
    // RESUME THE TURN INSTEAD OF RE-TELLING IT.
    //
    // Every dispatch used to re-send the entire flattened transcript — system
    // prompt, 24 opening cards, every prior observation — so a turn's fifth
    // tool follow-up paid for the first four all over again. The CLI can hold
    // a session, so a continued turn sends only what is new. `--session-id`
    // opens one, `--resume` continues it, and `DQL_SUBSCRIPTION_CLI_SESSION=off`
    // returns to re-sending everything if a CLI build ever misbehaves.
    const session = this.resolveSession(options, messages);
    const flattened = session?.resumed
      ? flattenMessages(messages.slice(session.sentMessageCount))
      : flattenMessages(messages);
    const dispatch = {
      provider: this.name,
      operation: 'generate',
      attemptIndex: 1,
      options,
      envelope: {
        model: options.model ?? this.defaultModel,
        system: flattened.system,
        prompt: flattened.prompt,
        options: { tools: false, maxTurns: options.responseJsonSchema ? 6 : 1, permissionMode: 'dontAsk', sessionPersistence: false },
      },
    } as const;
    const prepared = prepareProviderHttpDispatch(dispatch);
    const system = typeof prepared.system === 'string' ? prepared.system : '';
    const prompt = typeof prepared.prompt === 'string' ? prepared.prompt : '';
    const model = typeof prepared.model === 'string' ? prepared.model : undefined;
    // Constrain the reply's SHAPE where the CLI can do it. The governed lane
    // parses every response as JSON; an unparseable reply is not a recoverable
    // error there, it is a turn that ends having run nothing. With a schema the
    // CLI cannot return a shape the caller will reject.
    const responseSchema = options.responseJsonSchema
      ? JSON.stringify(options.responseJsonSchema)
      : undefined;
    // Effort was accepted by every other Claude transport and silently dropped
    // by this one, so a run configured for deep reasoning quietly got the
    // default on the slowest provider in the product.
    const effort = options.reasoningEffort;
    // `--max-turns 1` exists to stop the CLI running an agentic loop of its
    // own, not to bound DQL's conversation — that is the tool loop's job.
    // Structured output is implemented as an internal tool call, so a schema
    // request legitimately needs turns of its own; at one turn the CLI exits
    // `error_max_turns` with an empty stderr, which surfaced as an
    // unexplained "provider could not complete this step". `--tools ''` still
    // denies it every real tool, so the extra allowance buys no capability.
    const maxTurns = responseSchema ? '6' : '1';
    const args = [
      '-p',
      '--output-format', 'json',
      '--tools', '',                    // pure text generation, no tool/file access
      '--max-turns', maxTurns,
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',            // ignore any ambient MCP config
      ...(session
        ? session.resumed
          ? ['--resume', session.sessionId]
          : ['--session-id', session.sessionId]
        : ['--no-session-persistence']),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...(responseSchema ? ['--json-schema', responseSchema] : []),
      ...(system ? ['--system-prompt', system] : []),
    ];
    // Isolated cwd so no project CLAUDE.md / .claude settings leak into the completion.
    const cwd = mkdtempSync(join(tmpdir(), 'dql-claude-'));
    let processSettled = false;
    let processSucceeded = false;
    try {
      const res = await this.processRunner(this.command, args, {
        input: prompt,
        cwd,
        env: claudeSubscriptionEnv(),
        // The UI always supplies an AbortSignal. The previous conditional disabled
        // the timeout in exactly that path, so a stalled CLI left Ask spinning
        // forever. User cancellation and the independent hard deadline now both
        // apply.
        timeoutMs: resolveSubscriptionCliTimeoutMs(),
        signal: options.signal,
      });
      const cancelled = options.signal?.aborted;
      processSucceeded = !cancelled && !res.timedOut && !res.spawnError && res.code === 0;
      processSettled = true;
      completeProviderHttpDispatch(dispatch, {
        settlement: 'process',
        outcome: cancelled ? 'cancelled' : processSucceeded ? 'ok' : 'error',
        ...(res.spawnError ? { error: res.spawnError } : {}),
      });
      // A mid-flight cancellation SIGTERMed the child; surface the exact abort
      // reason (e.g. the run deadline's TimeoutError), never a parse error.
      throwIfAlreadyCancelled(options.signal);
      if (process.env.DQL_DEBUG_PROVIDER_CLI) {
        console.error('[DQL_DEBUG cli]', JSON.stringify({
          code: res.code,
          timedOut: res.timedOut,
          stderr: sanitizeProviderDetail(res.stderr).slice(0, 800),
          stdout: sanitizeProviderDetail(res.stdout).slice(0, 1600),
        }));
      }
      if (res.timedOut) {
        throw new ProviderTimeoutError(resolveSubscriptionCliTimeoutMs());
      }
      if (res.spawnError) {
        throw new Error(`Claude Code CLI not found. Install it (https://claude.com/claude-code) and run \`claude /login\`, or switch to an API-key provider. (${res.spawnError.message})`);
      }
      if (res.code !== 0) {
        // Claude returns a structured error result even when its process exit
        // code is non-zero. Parse it before classifying the exit so an expired
        // OAuth token reaches the reader as an actionable authentication
        // failure, rather than an empty generic retry. Malformed stdout is
        // intentionally not passed through: a CLI can put credentials there,
        // and the receipt gets a fixed bounded diagnostic instead.
        const parsed = parseClaudeResult(res.stdout);
        const structuredError = parsed?.isError === true;
        const exit = new ProviderExitError(
          'Claude Code',
          res.stderr,
          structuredError ? parsed.text : '',
          {
            ...(parsed?.terminalReason ? { terminalReason: parsed.terminalReason } : {}),
            ...(parsed?.apiErrorStatus !== undefined ? { apiErrorStatus: parsed.apiErrorStatus } : {}),
            malformedOutput: Boolean(res.stdout.trim()) && !structuredError,
          },
        );
        // A resume can fail for reasons that have nothing to do with this
        // request: the session expired, the CLI was upgraded, the store was
        // cleared. Losing the turn over an optimisation would be the worst
        // possible trade, so drop the session and say the whole thing again.
        // Authentication and quota failures are not resume failures: retrying
        // them wastes budget and hides the action the operator must take.
        if (session?.resumed && exit.code === 'provider_exit') {
          this.sessions.delete(options.conversationId!);
          return this.generate(messages, options);
        }
        throw exit;
      }
      const parsed = parseClaudeResult(res.stdout);
      if (parsed === undefined) {
        if (!res.stdout.trim()) throw new ProviderExitError('Claude Code', res.stderr, res.stdout);
        throw new Error(`claude did not return a parseable result${res.stderr ? `: ${res.stderr.trim()}` : '.'}`);
      }
      if (parsed.isError) {
        const message = sanitizeProviderDetail(parsed.text || res.stderr.trim()) || 'unknown error';
        if (/not logged in|\/login|unauthor/i.test(message)) {
          throw new Error('Claude Code is not logged in. Run `claude /login` with your Claude subscription, then retry.');
        }
        throw new Error(`claude returned an error: ${message}`);
      }
      completeProviderHttpDispatch(dispatch, { settlement: 'result', outcome: 'ok' });
      if (session) session.commit(messages.length);
      return parsed.text;
    } catch (error) {
      const cancelled = options.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      if (!processSettled) {
        completeProviderHttpDispatch(dispatch, { settlement: 'process', outcome: cancelled ? 'cancelled' : 'error', error });
      } else if (processSucceeded) {
        completeProviderHttpDispatch(dispatch, { settlement: 'result', outcome: cancelled ? 'cancelled' : 'error', error });
      }
      throw error;
    } finally {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}

/**
 * Parse `claude -p --output-format json` stdout (a single result object).
 *
 * With `--json-schema`, newer Claude Code releases put the validated object
 * in `structured_output` and leave `result` empty or as a prose summary
 * ("ok: true, n: 7"); older releases repeat the JSON in `result`. The
 * structured object is the answer whenever it is present; `result` is the
 * answer otherwise. An error wrapper is an error whatever else it carries.
 */
export function parseClaudeResult(stdout: string): ParsedClaudeResult | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const tryParse = (raw: string): ParsedClaudeResult | undefined => {
    try {
      const obj = JSON.parse(raw) as { result?: unknown; is_error?: unknown; structured_output?: unknown; terminal_reason?: unknown; api_error_status?: unknown };
      const isError = obj.is_error === true;
      const structured = obj.structured_output;
      const terminalReason = typeof obj.terminal_reason === 'string' ? obj.terminal_reason : undefined;
      const statusCandidate = typeof obj.api_error_status === 'number'
        ? obj.api_error_status
        : typeof obj.api_error_status === 'string' && /^\d{3}$/.test(obj.api_error_status)
          ? Number(obj.api_error_status)
          : undefined;
      const status = Number.isInteger(statusCandidate) ? statusCandidate : undefined;
      const metadata = {
        ...(terminalReason ? { terminalReason } : {}),
        ...(status !== undefined ? { apiErrorStatus: status } : {}),
      };
      if (!isError && structured !== undefined && structured !== null && typeof structured === 'object') {
        return { text: JSON.stringify(structured), isError, structured: true, ...metadata };
      }
      return { text: typeof obj.result === 'string' ? obj.result : '', isError, ...metadata };
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(trimmed);
  if (whole) return whole;
  // Fallback: last non-empty line that parses as the result object.
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(lines[i]);
    if (parsed) return parsed;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex (ChatGPT Plus / Pro / Team subscription)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reasoning effort a Codex call runs at. Without one, Codex reads its
 * default from the user's own `~/.codex/config.toml`, so a run configured for
 * deep reasoning quietly got whatever the user's Codex app was last set to.
 * DQL passes its per-call effort (low, medium, high). An operator may pin
 * every Codex call to one of Codex's own levels, including those DQL has no
 * name for (xhigh, max): DQL_CODEX_REASONING_EFFORT=max.
 */
export function codexReasoningEffort(requested: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pinned = env.DQL_CODEX_REASONING_EFFORT?.trim().toLowerCase();
  if (pinned && /^[a-z]+$/.test(pinned)) return pinned;
  return requested && /^[a-z]+$/.test(requested) ? requested : undefined;
}

export class CodexCliProvider implements AgentProvider {
  readonly name: ProviderName = 'openai';
  private readonly command: string;
  private readonly defaultModel?: string;
  private readonly processRunner: SubscriptionCliProcessRunner;

  constructor(opts: { command?: string; model?: string; runProcess?: SubscriptionCliProcessRunner } = {}) {
    this.command = opts.command ?? 'codex';
    this.defaultModel = opts.model;
    this.processRunner = opts.runProcess ?? runProcess;
  }

  async available(): Promise<boolean> {
    const status = await CodexCliProvider.detect(this.command);
    return status.installed && status.loggedIn;
  }

  /**
   * Detection: binary present + a stored auth file. Codex has no documented
   * non-interactive `login status` command, so we check `~/.codex/auth.json`
   * (written by `codex login` for both ChatGPT-account and API-key auth).
   */
  static async detect(command = 'codex'): Promise<CliAuthStatus> {
    const version = await runProcess(command, ['--version'], { timeoutMs: 8000 });
    if (version.spawnError) return { installed: false, loggedIn: false, detail: 'Codex CLI not found on PATH.' };
    const authPath = join(homedir(), '.codex', 'auth.json');
    const loggedIn = existsSync(authPath);
    return {
      installed: true,
      loggedIn,
      authMethod: loggedIn ? 'chatgpt' : undefined,
      detail: loggedIn ? undefined : 'Run `codex login` to sign in with your ChatGPT plan.',
    };
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    // A run whose deadline already fired must not spawn a doomed child process.
    throwIfAlreadyCancelled(options.signal);
    const flattened = flattenMessages(messages);
    const dispatch = {
      provider: this.name,
      operation: 'generate',
      attemptIndex: 1,
      options,
      envelope: {
        model: options.model ?? this.defaultModel,
        system: flattened.system,
        prompt: flattened.prompt,
        options: { sandbox: 'read-only', ephemeral: true, sessionPersistence: false },
      },
    } as const;
    const prepared = prepareProviderHttpDispatch(dispatch);
    const system = typeof prepared.system === 'string' ? prepared.system : '';
    const prompt = typeof prepared.prompt === 'string' ? prepared.prompt : '';
    const model = typeof prepared.model === 'string' ? prepared.model : undefined;
    // Codex exec has no --system-prompt; prepend the system text as a labeled preamble.
    const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
    const cwd = mkdtempSync(join(tmpdir(), 'dql-codex-'));
    const outFile = join(cwd, 'last-message.txt');
    const effort = codexReasoningEffort(options.reasoningEffort);
    const args = [
      'exec',
      '-',                              // read the prompt from stdin
      '--sandbox', 'read-only',         // no writes / no side effects
      '--skip-git-repo-check',
      '--cd', cwd,
      '--ephemeral',                    // do not persist a session
      '--output-last-message', outFile, // write just the final assistant text
      ...(model ? ['--model', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    ];
    let processSettled = false;
    let processSucceeded = false;
    try {
      const res = await this.processRunner(this.command, args, {
        input: fullPrompt,
        cwd,
        timeoutMs: resolveSubscriptionCliTimeoutMs(),
        signal: options.signal,
      });
      const cancelled = options.signal?.aborted;
      processSucceeded = !cancelled && !res.timedOut && !res.spawnError && res.code === 0;
      processSettled = true;
      completeProviderHttpDispatch(dispatch, {
        settlement: 'process',
        outcome: cancelled ? 'cancelled' : processSucceeded ? 'ok' : 'error',
        ...(res.spawnError ? { error: res.spawnError } : {}),
      });
      // A mid-flight cancellation SIGTERMed the child; surface the exact abort
      // reason (e.g. the run deadline's TimeoutError), never a parse error.
      throwIfAlreadyCancelled(options.signal);
      if (res.timedOut) {
        throw new ProviderTimeoutError(resolveSubscriptionCliTimeoutMs());
      }
      if (res.spawnError) {
        throw new Error(`Codex CLI not found. Install it and run \`codex login\` with your ChatGPT plan, or switch to an API-key provider. (${res.spawnError.message})`);
      }
      if (res.code !== 0) {
        throw new ProviderExitError('Codex', res.stderr, res.stdout);
      }
      if (existsSync(outFile)) {
        const text = readFileSync(outFile, 'utf-8').trim();
        if (text) {
          completeProviderHttpDispatch(dispatch, { settlement: 'result', outcome: 'ok' });
          return text;
        }
      }
      // Fallback: parse the JSONL event stream for the final agent_message.
      const fromStream = parseCodexFinalMessage(res.stdout);
      if (fromStream) {
        completeProviderHttpDispatch(dispatch, { settlement: 'result', outcome: 'ok' });
        return fromStream;
      }
      const message = res.stderr.trim() || 'no output';
      if (/not (logged|signed) in|login|unauthor|401/i.test(message)) {
        throw new Error('Codex is not logged in. Run `codex login` with your ChatGPT plan, then retry.');
      }
      throw Object.assign(new Error(`codex exec produced no message: ${message}`), {
        code: 'PROVIDER_RESULT_MALFORMED',
      });
    } catch (error) {
      const cancelled = options.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      if (!processSettled) {
        completeProviderHttpDispatch(dispatch, { settlement: 'process', outcome: cancelled ? 'cancelled' : 'error', error });
      } else if (processSucceeded) {
        completeProviderHttpDispatch(dispatch, { settlement: 'result', outcome: cancelled ? 'cancelled' : 'error', error });
      }
      throw error;
    } finally {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}

/** Parse `codex exec --json` JSONL for the final `agent_message` text. */
export function parseCodexFinalMessage(stdout: string): string | undefined {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  let last: string | undefined;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; text?: string };
      const item = event.item;
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
        last = item.text;
      } else if (item?.type === 'agent_message' && typeof item.text === 'string') {
        last = item.text;
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  return last?.trim() || undefined;
}
