/**
 * WHETHER ASK REVIEWS AN AI-DRAFTED RESULT before answering it.
 *
 * The review is one more AI call per AI-drafted answer that returned rows
 * (median 3.6 s on claude-code): it sees the question, the SQL and the
 * result's shape, never a value, and may send the SQL back for one revision.
 * It has no measured gain yet, so it is opt-in:
 * `agent.resultReview.mode: "on"` in dql.config.json, read at every question.
 * `ZLENS_ASK_RESULT_REVIEW=1` turns it on and `=0` off, whatever the project says.
 */
import { readEnv } from '@zlens/core';

export type ResultReviewMode = 'on' | 'off';

export function resolveResultReviewMode(config: { agent?: { resultReview?: { mode?: string } } } | undefined): ResultReviewMode {
  return config?.agent?.resultReview?.mode === 'on' ? 'on' : 'off';
}

/** The project's setting, unless the environment overrides it either way. */
export function resultReviewEnabled(configuredOn: boolean, env: string | undefined = readEnv('ZLENS_ASK_RESULT_REVIEW')): boolean {
  if (env === '1') return true;
  if (env === '0') return false;
  return configuredOn;
}
