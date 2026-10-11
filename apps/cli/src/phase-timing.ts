/**
 * Per-phase timing for one request. Records phase names and durations only:
 * never SQL, values, paths or identifiers, so the output is safe to log and to
 * send back in a response header.
 */
export interface PhaseTimer {
  /** Time one phase. The duration is kept even when the phase throws. */
  time<T>(name: string, work: () => Promise<T> | T): Promise<T>;
  /** Phases in the order they finished, durations in whole milliseconds. */
  phases(): Array<{ name: string; ms: number }>;
  /** Milliseconds since the timer was created. */
  elapsedMs(): number;
  /** `Server-Timing` header value, e.g. `mapping;dur=12, query;dur=40`. */
  header(): string;
  /** One log line when the request took at least `thresholdMs`; returns it, or null when fast. */
  slowLine(label: string, thresholdMs?: number): string | null;
}

export const SLOW_REQUEST_THRESHOLD_MS = 5_000;

/** Write the slow-request line to the server log when the request was slow. */
export function logSlowRequest(timer: PhaseTimer, label: string, thresholdMs?: number): void {
  const line = timer.slowLine(label, thresholdMs);
  if (line) console.log(line);
}

const PHASE_NAME =/[^A-Za-z0-9_-]/g;

export function createPhaseTimer(now: () => number = Date.now): PhaseTimer {
  const startedAt = now();
  const recorded: Array<{ name: string; ms: number }> = [];
  return {
    async time(name, work) {
      const phaseStart = now();
      try {
        return await work();
      } finally {
        recorded.push({ name: name.replace(PHASE_NAME, '_'), ms: Math.max(0, now() - phaseStart) });
      }
    },
    phases: () => recorded.map((phase) => ({ ...phase })),
    elapsedMs: () => Math.max(0, now() - startedAt),
    header: () => recorded.map((phase) => `${phase.name};dur=${phase.ms}`).join(', '),
    slowLine(label, thresholdMs = SLOW_REQUEST_THRESHOLD_MS) {
      const total = Math.max(0, now() - startedAt);
      if (total < thresholdMs) return null;
      const detail = recorded.map((phase) => `${phase.name}=${phase.ms}ms`).join(' ');
      return `[dql] slow request ${label} took ${total}ms${detail ? ` (${detail})` : ''}`;
    },
  };
}
