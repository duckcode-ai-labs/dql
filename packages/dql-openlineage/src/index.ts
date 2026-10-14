import { readEnv } from './env.js';
// OpenLineage emitter for DQL. Sends START/COMPLETE/FAIL run events to an
// OpenLineage-compatible receiver (Marquez, DataHub, Atlan, Monte Carlo).
//
// Design: pure fetch-based, zero deps. Gated at the *surface* — if
// OPENLINEAGE_URL isn't set and `enabled` isn't true in config, events are
// dropped silently. That matches the "never surface infra errors to the
// user" rule from run-snapshot autosave.
//
// Spec: https://openlineage.io/spec — currently emits spec 0.19.

export const OPENLINEAGE_SPEC_VERSION = '0.19.0';

export type EventType = 'START' | 'COMPLETE' | 'FAIL' | 'ABORT';

export interface LineageDataset {
  namespace: string;
  name: string;
  facets?: Record<string, unknown>;
}

export interface LineageJob {
  namespace: string;
  name: string;
  facets?: Record<string, unknown>;
}

export interface LineageRun {
  runId: string; // UUID recommended
  facets?: Record<string, unknown>;
}

export interface LineageEvent {
  eventType: EventType;
  eventTime: string; // ISO-8601
  producer: string;
  schemaURL: string;
  job: LineageJob;
  run: LineageRun;
  inputs?: LineageDataset[];
  outputs?: LineageDataset[];
}

export interface EmitterConfig {
  enabled?: boolean;
  url?: string;
  namespace?: string;
  // Supply a custom fetch (tests, polyfills). Defaults to global fetch.
  fetch?: typeof fetch;
  // Tiny structured logger. Errors never throw past here.
  onError?: (err: unknown) => void;
}

const PRODUCER = 'https://github.com/duckcode-ai-labs/dql';
const SCHEMA_URL =
  'https://openlineage.io/spec/2-0-0/OpenLineage.json#/definitions/RunEvent';

/**
 * Resolve config from args → env → disabled default. Env vars follow the
 * OpenLineage standard (OPENLINEAGE_URL, OPENLINEAGE_NAMESPACE) plus our
 * opt-out flag ZLENS_OPENLINEAGE_DISABLED.
 */
export function resolveConfig(partial: EmitterConfig = {}): Required<
  Pick<EmitterConfig, 'enabled' | 'url' | 'namespace'>
> & Pick<EmitterConfig, 'fetch' | 'onError'> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const disabled = readEnv('ZLENS_OPENLINEAGE_DISABLED', env) === '1';
  const enabled = !disabled && (partial.enabled ?? Boolean(partial.url ?? env.OPENLINEAGE_URL));
  return {
    enabled,
    url: partial.url ?? env.OPENLINEAGE_URL ?? '',
    namespace: partial.namespace ?? env.OPENLINEAGE_NAMESPACE ?? 'dql',
    fetch: partial.fetch,
    onError: partial.onError,
  };
}

export class OpenLineageEmitter {
  constructor(private readonly cfg: ReturnType<typeof resolveConfig>) {}

  async emit(event: Omit<LineageEvent, 'producer' | 'schemaURL'>): Promise<void> {
    if (!this.cfg.enabled || !this.cfg.url) return;
    const fullEvent: LineageEvent = {
      ...event,
      producer: PRODUCER,
      schemaURL: SCHEMA_URL,
    };
    const fetchImpl = this.cfg.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!fetchImpl) {
      this.cfg.onError?.(new Error('OpenLineage: no fetch implementation available'));
      return;
    }
    try {
      const res = await fetchImpl(this.cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fullEvent),
      });
      if (!res.ok) {
        this.cfg.onError?.(new Error(`OpenLineage POST returned ${res.status}`));
      }
    } catch (err) {
      // Best-effort — infra failures must not surface to end users.
      this.cfg.onError?.(err);
    }
  }

  /**
   * Convenience for the common block-run case: emits START then COMPLETE
   * around a synchronous or async handler. On throw, emits FAIL and
   * re-throws so the caller still sees the error.
   */
  async wrap<T>(
    job: LineageJob,
    runId: string,
    io: { inputs?: LineageDataset[]; outputs?: LineageDataset[] },
    handler: () => Promise<T> | T,
  ): Promise<T> {
    const now = () => new Date().toISOString();
    await this.emit({ eventType: 'START', eventTime: now(), job, run: { runId }, inputs: io.inputs, outputs: io.outputs });
    try {
      const result = await handler();
      await this.emit({ eventType: 'COMPLETE', eventTime: now(), job, run: { runId }, inputs: io.inputs, outputs: io.outputs });
      return result;
    } catch (err) {
      await this.emit({ eventType: 'FAIL', eventTime: now(), job, run: { runId }, inputs: io.inputs, outputs: io.outputs });
      throw err;
    }
  }
}

export function createEmitter(cfg: EmitterConfig = {}): OpenLineageEmitter {
  return new OpenLineageEmitter(resolveConfig(cfg));
}

export {
  buildEventsFromManifest,
  datasetNames,
  emitProjectSnapshot,
  jobNames,
  type BuildEventsOptions,
  type ManifestBlockProjection,
  type ManifestDataLexContractProjection,
  type ManifestDbtModelProjection,
  type ManifestProjection,
} from './manifest-events.js';
