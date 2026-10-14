/**
 * The join-fanout proof for a NATIVE semantic query.
 *
 * MetricFlow and dbt Cloud own their join semantics; the native composer does
 * not. When it joins several models it can multiply fact rows, and an
 * aggregate over multiplied rows is the worst kind of wrong: a confident,
 * governed-looking number. The composer therefore hands back an unfiltered
 * probe (`base_rows` vs `joined_rows`) and the host runs it BEFORE the
 * governed query. `joined_rows > base_rows` is proof the join key is not
 * unique on the joined side; nothing is shown in that case.
 *
 * These codes deliberately carry no adapter/warehouse error text: that text
 * can contain credentials, SQL literals, or other operator-only detail.
 */
import type { AgentResultPayload } from '../answer-loop.js';

export type SemanticFanoutProbeFailureCodeV1 =
  | 'SEMANTIC_FANOUT_DUPLICATE_KEY'
  | 'SEMANTIC_FANOUT_PROBE_ERROR'
  | 'SEMANTIC_FANOUT_PROBE_UNPARSEABLE';

export type SemanticFanoutProbeResultV1 =
  | { status: 'safe' }
  | {
    status: 'blocked';
    code: SemanticFanoutProbeFailureCodeV1;
    message: string;
  };

/**
 * Execute the semantic layer's fanout probe before a governed native semantic
 * join runs. A native join that cannot be checked is not a governed-safe
 * join: the caller decides whether that is a block or a review-required
 * label, but it is never silently "safe".
 */
export async function probeSemanticJoinFanout(
  probeSql: string,
  joinedTables: string[],
  executeSql: (sql: string, artifact?: never) => Promise<AgentResultPayload>,
): Promise<SemanticFanoutProbeResultV1> {
  try {
    const payload = await (executeSql as (sql: string) => Promise<AgentResultPayload>)(probeSql);
    const counts = parseFanoutProbeCounts(payload);
    if (!counts || counts.base <= 0) {
      return {
        status: 'blocked',
        code: 'SEMANTIC_FANOUT_PROBE_UNPARSEABLE',
        message: 'ZLens did not execute this governed semantic answer because its join-safety probe did not return verifiable row counts. Check the declared relationship or run the metric through MetricFlow / dbt Cloud, then retry.',
      };
    }
    if (counts.joined <= counts.base) return { status: 'safe' };
    const factor = counts.joined / counts.base;
    const tables = joinedTables.filter(Boolean).join(', ');
    return {
      status: 'blocked',
      code: 'SEMANTIC_FANOUT_DUPLICATE_KEY',
      message: [
        `Blocked a governed semantic answer whose join inflates results: joining ${tables || 'the declared tables'}`,
        `turned ${counts.base.toLocaleString('en-US')} base rows into ${counts.joined.toLocaleString('en-US')} (×${factor >= 10 ? Math.round(factor) : factor.toFixed(1)}).`,
        'The declared join key is not unique on the joined side, so every aggregated value would be multiplied.',
        'Deduplicate the joined model (for example, filter a slowly-changing dimension to current records)',
        'or execute this metric through MetricFlow / dbt Cloud, then retry. No numbers were shown because they would be wrong.',
      ].join(' '),
    };
  } catch {
    return {
      status: 'blocked',
      code: 'SEMANTIC_FANOUT_PROBE_ERROR',
      message: 'ZLens did not execute this governed semantic answer because it could not verify join fanout before aggregation. Check the declared relationship or run the metric through MetricFlow / dbt Cloud, then retry.',
    };
  }
}

function parseFanoutProbeCounts(payload: AgentResultPayload): { base: number; joined: number } | null {
  const row = payload.rows?.[0];
  if (row === undefined || row === null) return null;
  const toCount = (value: unknown): number | null => {
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'bigint'
        ? Number(value)
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  if (Array.isArray(row)) {
    const base = toCount(row[0]);
    const joined = toCount(row[1]);
    return base !== null && joined !== null ? { base, joined } : null;
  }
  if (typeof row === 'object') {
    const record = row as Record<string, unknown>;
    const lookup = (name: string): number | null => {
      for (const [key, value] of Object.entries(record)) {
        if (key.toLowerCase() === name) return toCount(value);
      }
      return null;
    };
    const base = lookup('base_rows');
    const joined = lookup('joined_rows');
    return base !== null && joined !== null ? { base, joined } : null;
  }
  return null;
}
