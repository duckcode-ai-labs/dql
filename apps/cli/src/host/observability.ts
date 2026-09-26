import { answerIdentities } from './answer-facts.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAskTracePortableBundleV1, toOtlpOpenInferenceJsonV1 } from '@duckcodeailabs/dql-agent';
import type { DqlPrincipal } from './request-context.js';
import type { DqlRouteAction } from './route-actions.js';

/**
 * WHO DID WHAT, AND HOW EACH ANSWER WAS MADE (RFC 0010, slice HH-6).
 *
 * Audit: with `hostHooks.audit`, the server reports one event for every API
 * request that changes something or was refused (who, what action on what,
 * the outcome) and one for every finished answer (its trust label, the SQL
 * it ran as fingerprints, the sources, the provider). Events carry no result
 * values. With no hook nothing is recorded — central audit is the host's.
 *
 * Traces: each finished Ask trace becomes the same strict, redacted bundle
 * the trace export route serves, and goes to `hostHooks.traces` and/or, as
 * OpenTelemetry (OpenInference spans), to the standard
 * OTEL_EXPORTER_OTLP_ENDPOINT. Export never slows or fails an answer.
 */
export type DqlAuditEvent =
  | {
    kind: 'request';
    at: string;
    requestId?: string;
    actor: string | null;
    principalId: string | null;
    action: string;
    resource: DqlRouteAction['resource'];
    method: string;
    path: string;
    status: number;
    outcome: 'ok' | 'refused' | 'failed';
  }
  | {
    kind: 'answer';
    at: string;
    runId: string;
    actor: string | null;
    principalId: string | null;
    status: string;
    trustState: string;
    /** sha256 of each SQL statement the answer's artifacts carry; never the SQL or its values. */
    sqlSha256: string[];
    sources: string[];
  };

export type DqlAuditSink = (event: DqlAuditEvent) => void | Promise<void>;

/** Who is acting, for audit records. */
export function auditActor(principal: DqlPrincipal | null | undefined): string | null {
  if (!principal) return null;
  return principal.email?.trim() || principal.displayName?.trim() || principal.id;
}
export type DqlTraceSink = (trace: { traceId: string; runId: string; bundle: unknown; otlp: Record<string, unknown> }) => void | Promise<void>;

const failed = { audit: 0, traces: 0 };
/** Events a sink failed to take, for health checks. Export never fails the request. */
export function observabilityFailures(): { audit: number; traces: number } {
  return { ...failed };
}

function emit(sink: DqlAuditSink, event: DqlAuditEvent): void {
  try {
    void Promise.resolve(sink(event)).catch(() => { failed.audit += 1; });
  } catch {
    failed.audit += 1;
  }
}

/**
 * Report this request when it finishes, if it changed something or was
 * refused. `who` is read at finish time, after sign-in resolved the person.
 */
export function auditRequest(
  sink: DqlAuditSink,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  route: DqlRouteAction,
  who: () => { principal: DqlPrincipal | null; actor: string | null; requestId?: string },
): void {
  const method = (req.method ?? 'GET').toUpperCase();
  res.once('finish', () => {
    const status = res.statusCode;
    const refused = status === 401 || status === 403;
    if ((method === 'GET' || method === 'HEAD') && !refused) return;
    const { principal, actor, requestId } = who();
    emit(sink, {
      kind: 'request',
      at: new Date().toISOString(),
      ...(requestId ? { requestId } : {}),
      actor,
      principalId: principal?.id ?? null,
      action: route.action,
      resource: route.resource,
      method,
      path,
      status,
      outcome: refused ? 'refused' : status >= 400 ? 'failed' : 'ok',
    });
  });
}

const TERMINAL = new Set(['completed', 'needs_review', 'needs_clarification', 'cancelled', 'blocked']);

type AuditableRun = {
  id?: unknown;
  status?: unknown;
  trustState?: unknown;
  artifacts?: Array<{ payload?: Record<string, unknown>; sourceId?: unknown; kind?: unknown }>;
};

/** The answer event for a finished run: no question text, no SQL, no values. */
export function answerAuditEvent(run: AuditableRun, who: { principal: DqlPrincipal | null; actor: string | null }): DqlAuditEvent | null {
  if (typeof run.id !== 'string' || typeof run.status !== 'string' || !TERMINAL.has(run.status)) return null;
  // The same identifiers a host gets with the answer's facts (answer-facts.ts).
  const { sqlSha256, sources } = answerIdentities(run as { artifacts?: unknown[] });
  return {
    kind: 'answer',
    at: new Date().toISOString(),
    runId: run.id,
    actor: who.actor,
    principalId: who.principal?.id ?? null,
    status: run.status,
    trustState: typeof run.trustState === 'string' ? run.trustState : 'unknown',
    sqlSha256,
    sources,
  };
}

/** A run store that also reports each run once, when it first finishes. */
export function withAnswerAudit<T extends { save(run: never): unknown }>(store: T, sink: DqlAuditSink, who: () => { principal: DqlPrincipal | null; actor: string | null }): T {
  const reported = new Set<string>();
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'save' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
      return (run: AuditableRun) => {
        const result = (value as (run: unknown) => unknown).call(target, run);
        const event = answerAuditEvent(run, who());
        if (event?.kind === 'answer' && !reported.has(event.runId)) {
          reported.add(event.runId);
          emit(sink, event);
        }
        return result;
      };
    },
  });
}

/** POST one OTLP/JSON traces payload to a collector (OpenTelemetry's HTTP/JSON protocol). */
export async function postOtlpTraces(endpoint: string, payload: Record<string, unknown>, headers: Record<string, string> = {}): Promise<void> {
  const base = endpoint.replace(/\/$/, '');
  const url = /\/v1\/traces$/.test(base) ? base : `${base}/v1/traces`;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`OTLP collector answered ${response.status}`);
}

/** `OTEL_EXPORTER_OTLP_HEADERS` (k=v,k2=v2), as OpenTelemetry defines it. */
export function otlpHeadersFromEnv(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (value ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    out[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  return out;
}

type TraceStoreLike = {
  finalize(envelope: { traceId: string; runId: string }): unknown;
  get(traceId: string): Parameters<typeof createAskTracePortableBundleV1>[0] | undefined;
};

/**
 * A trace store that also exports each finished trace — strictly redacted —
 * to the host's sink and/or an OTLP collector, after the local write.
 */
export function withTraceExport<T extends TraceStoreLike>(store: T, targets: { sink?: DqlTraceSink; otlpEndpoint?: string; otlpHeaders?: Record<string, string> }): T {
  if (!targets.sink && !targets.otlpEndpoint) return store;
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'finalize' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
      return (envelope: { traceId: string; runId: string }) => {
        const result = (value as (envelope: unknown) => unknown).call(target, envelope);
        queueMicrotask(() => {
          void (async () => {
            try {
              const trace = target.get(envelope.traceId);
              if (!trace) return;
              const bundle = createAskTracePortableBundleV1(trace, { profile: 'strict', provenance: 'recorded' } as Parameters<typeof createAskTracePortableBundleV1>[1]);
              const otlp = toOtlpOpenInferenceJsonV1(bundle.trace);
              if (targets.sink) await targets.sink({ traceId: envelope.traceId, runId: envelope.runId, bundle, otlp });
              if (targets.otlpEndpoint) await postOtlpTraces(targets.otlpEndpoint, otlp, targets.otlpHeaders);
            } catch {
              failed.traces += 1;
            }
          })();
        });
        return result;
      };
    },
  });
}
