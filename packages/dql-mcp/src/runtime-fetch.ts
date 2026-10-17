import { readEnv } from '@zlens/core';

/**
 * Every call the MCP tools make to the ZLens runtime (the workbench) goes
 * through here so none can hang an agent: a runtime that accepts the
 * connection but never answers fails with a clear message instead of leaving
 * the MCP call open until the client gives up.
 *
 * `query` covers block/SQL/Dataset execution and checks; `generate` covers
 * answer_question and build_block_from_prompt, which wait on an AI model.
 * ZLENS_MCP_RUNTIME_TIMEOUT_MS overrides both.
 */
export type RuntimeCallKind = 'query' | 'generate';

const DEFAULT_TIMEOUT_MS: Record<RuntimeCallKind, number> = {
  query: 120_000,
  generate: 600_000,
};

export const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:3474';

export function runtimeBaseUrl(serverUrl?: string): string {
  return (serverUrl ?? readEnv('ZLENS_RUNTIME_URL') ?? DEFAULT_RUNTIME_URL).replace(/\/$/, '');
}

export function runtimeTimeoutMs(kind: RuntimeCallKind): number {
  const raw = Number(readEnv('ZLENS_MCP_RUNTIME_TIMEOUT_MS'));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS[kind];
}

export class RuntimeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(
      `no answer within ${Math.round(timeoutMs / 1000)} s — the workbench may be busy or stuck. ` +
      'Retry, check the workbench terminal, or set ZLENS_MCP_RUNTIME_TIMEOUT_MS to wait longer',
    );
    this.name = 'RuntimeTimeoutError';
  }
}

export async function fetchRuntime(url: string, init: RequestInit = {}, kind: RuntimeCallKind = 'query'): Promise<Response> {
  const timeoutMs = runtimeTimeoutMs(kind);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (isTimeout(error)) throw new RuntimeTimeoutError(timeoutMs);
    throw error;
  }
}

/** Read a JSON body under the same deadline (the signal also covers the body). */
export async function readRuntimeJson<T>(response: Response, timeoutMs = runtimeTimeoutMs('query')): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (isTimeout(error)) throw new RuntimeTimeoutError(timeoutMs);
    throw error;
  }
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * The message an agent sees when a runtime call fails before any answer:
 * not running (start it, with the exact command) or running but silent.
 */
export function runtimeUnreachableMessage(base: string, projectRoot: string, error: unknown, need = 'This tool needs it'): string {
  if (error instanceof RuntimeTimeoutError) {
    return `The ZLens runtime at ${base} did not answer: ${error.message}.`;
  }
  return (
    `Could not reach the ZLens runtime at ${base}. ${need} running — start the workbench with ` +
    `\`zlens notebook ${projectRoot}\` (\`npm run notebook\` in a create-zlens-app project) and keep it open, ` +
    `or set ZLENS_RUNTIME_URL / pass serverUrl if it runs on another address. ` +
    `(${error instanceof Error ? error.message : String(error)})`
  );
}
