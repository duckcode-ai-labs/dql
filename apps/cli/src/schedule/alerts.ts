import type { AlertIR } from '@zlens/dql-compiler';
import type { QueryExecutor, ConnectionConfig } from '@zlens/connectors';
import type { AlertEvaluation } from './types.js';

export async function evaluateAlerts(
  alerts: AlertIR[],
  executor: QueryExecutor,
  connection: ConnectionConfig,
): Promise<AlertEvaluation[]> {
  const results: AlertEvaluation[] = [];

  for (const alert of alerts) {
    try {
      const result = await executor.executeQuery(alert.conditionSQL, [], {}, connection);
      const firstRow = result.rows[0] ?? {};
      const firstCol = Object.values(firstRow)[0];
      const observedValue = toNumber(firstCol);

      if (observedValue === null) {
        results.push({
          alert,
          breached: false,
          reason: 'condition SQL did not return a numeric first column',
        });
        continue;
      }

      const breached = compareThreshold(observedValue, alert.operator ?? '>', alert.threshold ?? 0);
      results.push({ alert, breached, observedValue });
    } catch (err) {
      results.push({
        alert,
        breached: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

function compareThreshold(value: number, op: AlertIR['operator'], threshold: number): boolean {
  switch (op) {
    case '>': return value > threshold;
    case '<': return value < threshold;
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    case '!=': return value !== threshold;
    default: return value > threshold;
  }
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}
