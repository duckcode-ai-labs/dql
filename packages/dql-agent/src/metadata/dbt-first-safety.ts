/** Compatibility wrapper around the unified manifest-v3 analytical policy service. */
import type { DQLManifest } from '@zlens/core';
import type { DomainContextEnvelope } from '../domain-context.js';
import {
  validateAnalyticalSql,
  type AnalyticalExploratoryPath,
  type AnalyticalPathDisposition,
  type AnalyticalPolicyCode,
} from './analytical-policy.js';

export type DbtFirstJoinSafetyCode = AnalyticalPolicyCode;

export interface DbtFirstJoinSafetyDecision {
  safe: boolean;
  code?: DbtFirstJoinSafetyCode;
  message?: string;
  entities: string[];
  relationshipIds: string[];
  /** Authoritative decision from the analytical policy service. */
  disposition: AnalyticalPathDisposition;
  reasonCode?: AnalyticalPolicyCode;
  userFacingReason?: string;
  technicalDetail?: string;
  /** Declared draft join path re-bound to the SQL's actual join set. */
  exploratoryPath?: AnalyticalExploratoryPath;
}

/**
 * Validate generated SQL against exact certified path and join-key proof.
 * Kept under the historical name so existing Ask AI integrations remain API
 * compatible while MCP, notebooks, and Apps adopt the same policy service.
 */
export function evaluateDbtFirstGeneratedSql(
  sql: string,
  manifest: DQLManifest,
  purpose?: string,
  domainContext?: DomainContextEnvelope,
  dialect = 'duckdb',
): DbtFirstJoinSafetyDecision {
  const decision = validateAnalyticalSql(sql, manifest, dialect, purpose, domainContext);
  return {
    safe: decision.safe,
    code: decision.code,
    message: decision.message,
    entities: decision.entities,
    relationshipIds: decision.relationshipIds,
    disposition: decision.disposition,
    reasonCode: decision.reasonCode,
    userFacingReason: decision.userFacingReason,
    technicalDetail: decision.technicalDetail,
    exploratoryPath: decision.exploratoryPath,
  };
}
