// Opt-in, privacy-first telemetry.
//
// Principles (per v1.0 roadmap):
//   - OFF by default. Must be explicitly enabled.
//   - No PII. Ever. Only enum-valued counters and durations.
//   - One-line opt-out (env, config, or `zlens telemetry off`).
//   - The event shape is documented publicly — no hidden fields.
//   - Best-effort transport. Failures are silent and bounded.
//
// Events are posted to a first-party HTTPS endpoint. No third-party
// analytics SDK is bundled.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEnv } from './env.js';

export type TelemetryEventName =
  | 'cli.command'       // a CLI subcommand completed
  | 'notebook.open'     // notebook booted
  | 'block.certified'   // a block was promoted to certified
  | 'dbt.synced'        // zlens sync dbt finished
  | 'dashboard.built';  // zlens build produced a dashboard

export interface TelemetryEvent {
  name: TelemetryEventName;
  // Small, enum-valued properties only. No free-form strings.
  props?: Record<string, string | number | boolean>;
  // Optional timing in ms.
  durationMs?: number;
}

export interface TelemetryConfig {
  enabled?: boolean;
  endpoint?: string;     // defaults to https://telemetry.duckcode.ai/v1/events
  anonymousId?: string;  // auto-generated stable UUID per machine
  version?: string;      // ZLens version string; included as a property
  fetch?: typeof fetch;
  onError?: (err: unknown) => void;
}

const DEFAULT_ENDPOINT = 'https://telemetry.duckcode.ai/v1/events';
const CONFIG_DIR = join(homedir(), '.config', 'dql');
const CONFIG_FILE = join(CONFIG_DIR, 'telemetry.json');

interface PersistedConfig {
  enabled: boolean;
  anonymousId: string;
  askedAt?: string;
}

function loadPersisted(): PersistedConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as PersistedConfig; }
  catch { return null; }
}

function savePersisted(cfg: PersistedConfig): void {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  } catch { /* best-effort */ }
}

/**
 * Idempotent enable/disable. Persists to `~/.config/dql/telemetry.json` so
 * the user only answers once.
 */
export function setEnabled(enabled: boolean): void {
  const prev = loadPersisted();
  savePersisted({
    enabled,
    anonymousId: prev?.anonymousId ?? randomUUID(),
    askedAt: new Date().toISOString(),
  });
}

export function getStatus(): { enabled: boolean; anonymousId: string | null } {
  const persisted = loadPersisted();
  return {
    enabled: persisted?.enabled ?? false,
    anonymousId: persisted?.anonymousId ?? null,
  };
}

/**
 * Resolve config from explicit args → env → persisted file → OFF default.
 */
function resolveConfig(partial: TelemetryConfig): Required<Pick<TelemetryConfig, 'enabled' | 'endpoint' | 'anonymousId'>> & Pick<TelemetryConfig, 'fetch' | 'onError' | 'version'> {
  const env = process.env;
  if (readEnv('ZLENS_TELEMETRY_DISABLED', env) === '1' || env.DO_NOT_TRACK === '1') {
    return { enabled: false, endpoint: '', anonymousId: '', version: partial.version };
  }
  const persisted = loadPersisted();
  const enabled = partial.enabled ?? persisted?.enabled ?? false;
  return {
    enabled,
    endpoint: partial.endpoint ?? readEnv('ZLENS_TELEMETRY_ENDPOINT', env) ?? DEFAULT_ENDPOINT,
    anonymousId: partial.anonymousId ?? persisted?.anonymousId ?? '',
    fetch: partial.fetch,
    onError: partial.onError,
    version: partial.version,
  };
}

/**
 * One-shot send. No batching — volume is low enough to not matter, and a
 * batch buffer would mean we might drop events on abrupt CLI exit.
 */
export async function track(event: TelemetryEvent, cfg: TelemetryConfig = {}): Promise<void> {
  const resolved = resolveConfig(cfg);
  if (!resolved.enabled || !resolved.endpoint) return;
  const fetchImpl = resolved.fetch ?? (globalThis.fetch as typeof fetch | undefined);
  if (!fetchImpl) return;

  const payload = {
    event: event.name,
    anonymousId: resolved.anonymousId || hashedMachineId(),
    version: resolved.version ?? 'unknown',
    ts: new Date().toISOString(),
    props: event.props ?? {},
    durationMs: event.durationMs,
  };

  // 2s timeout — telemetry must never block a CLI command visibly.
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 2000);
  try {
    await fetchImpl(resolved.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    resolved.onError?.(err);
  } finally {
    clearTimeout(to);
  }
}

/**
 * Hash of hostname + platform so we don't need to persist anything to get
 * a stable-ish machine id. Used only when no persisted anonymousId exists
 * (e.g. first call before first-run opt-in prompt).
 */
function hashedMachineId(): string {
  const bits = [process.platform, process.arch, process.env.USER ?? '', process.env.USERNAME ?? ''].join('|');
  return createHash('sha256').update(bits).digest('hex').slice(0, 16);
}
