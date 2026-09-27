import { describe, expect, it } from 'vitest';
import {
  classifyAnalyticalFailure,
  createAnalyticalFailure,
  deriveAnalyticalRepair,
  redactAnalyticalDiagnostic,
  type AnalyticalFailedRunV1,
} from './analytical-failure-repair.js';

const fingerprint = (character: string): string => character.repeat(64);

function failedRun(code: 'COLUMN_NOT_FOUND' | 'PERMISSION_DENIED' | 'TIMEOUT' = 'COLUMN_NOT_FOUND'): AnalyticalFailedRunV1 {
  const dqlSource = 'query revenue_by_customer { metric revenue }';
  const compiledSql = 'select sum(revenue) from analytics.orders';
  const failure = createAnalyticalFailure({
    code,
    phase: 'execution',
    snapshotId: 'snapshot-1',
    runId: 'run-original',
    planFingerprint: fingerprint('a'),
    dqlSource,
    compiledSql,
    failedBindings: [{ qualifiedId: 'commerce::dimension::revenue', role: 'measure' }],
  });
  return {
    version: 1,
    runId: 'run-original',
    snapshotId: 'snapshot-1',
    route: 'governed_sql',
    trustState: 'certified',
    planFingerprint: fingerprint('a'),
    dqlSource,
    dqlFingerprint: failure.dqlFingerprint,
    compiledSql,
    sqlFingerprint: failure.sqlFingerprint,
    failure,
  };
}

describe('stable analytical diagnostics (API-007 / SEC-004)', () => {
  it.each([
    [{ code: '42703', message: 'column secret_name does not exist' }, 'COLUMN_NOT_FOUND'],
    [{ sqlState: '42P01', message: 'relation hidden_table does not exist' }, 'RELATION_NOT_FOUND'],
    [new Error('Binder Error: Catalog "jaffle_shop" does not exist'), 'RELATION_NOT_FOUND'],
    [{ code: '42501', message: 'permission denied' }, 'PERMISSION_DENIED'],
    [new Error('column reference customer_id is ambiguous'), 'AMBIGUOUS_COLUMN'],
    [new Error('syntax error near warehouse token'), 'DIALECT_ERROR'],
    [new Error('schema drift against snapshot'), 'SNAPSHOT_DRIFT'],
    [new Error('query timeout'), 'TIMEOUT'],
    [new Error('missing output revenue_delta'), 'RESULT_CONTRACT_MISMATCH'],
    // A host's row policy refused the statement (RFC 0010): nothing a repair can change.
    [Object.assign(new Error('This question would list health data for individual people.'), { code: 'ROW_POLICY_REFUSED' }), 'POLICY_DENIED'],
  ])('classifies supported connector/compiler failures without changing their stable code', (error, code) => {
    expect(classifyAnalyticalFailure(error)).toBe(code);
  });

  it('returns deterministic redacted failures with immutable fingerprints and qualified bindings', () => {
    const input = {
      error: new Error("column 'zoom@example.com' does not exist; password=hunter2"),
      phase: 'execution' as const,
      snapshotId: 'snapshot-1',
      planFingerprint: fingerprint('a'),
      dqlSource: 'query x { metric revenue }',
      compiledSql: "select revenue from orders where email = 'zoom@example.com'",
      failedBindings: [{ qualifiedId: 'commerce::metric::revenue', role: 'measure', reasonCode: 'WAREHOUSE_COLUMN_MISSING' }],
    };
    const first = createAnalyticalFailure(input);
    const second = createAnalyticalFailure(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      code: 'COLUMN_NOT_FOUND',
      phase: 'execution',
      failedBindings: [{ qualifiedId: 'commerce::metric::revenue' }],
    });
    expect(first.message).not.toMatch(/zoom|hunter2|orders/i);
    expect(first.dqlFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sqlFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('treats a missing warehouse catalog as a target-selection failure, not a generic compilation miss', () => {
    const failure = createAnalyticalFailure({
      error: new Error('Binder Error: Catalog "jaffle_shop" does not exist'),
      phase: 'execution',
      snapshotId: 'snapshot-1',
      planFingerprint: fingerprint('a'),
    });

    expect(failure).toMatchObject({
      code: 'RELATION_NOT_FOUND',
      phase: 'execution',
      safeActions: expect.arrayContaining(['change_authorized_connection']),
    });
  });

  it('redacts connection strings, secrets, tokens, and literal values from diagnostics', () => {
    const raw = "postgres://admin:secret@warehouse/db password=hunter2 token=abcdefghijklmnopqrstuvwx.yyyyyyyyyyyy.zzzzzzzzzzzz email='zoom@example.com'";
    const redacted = redactAnalyticalDiagnostic(raw);
    expect(redacted).not.toContain('admin:secret');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('zoom@example.com');
  });
});

describe('immutable analytical repair derivation (API-007 / SEC-004)', () => {
  it('derives DQL repair without mutating the source and removes certification', () => {
    const source = failedRun();
    const sourceCopy = structuredClone(source);
    const result = deriveAnalyticalRepair(source, {
      version: 1,
      action: 'edit_dql',
      dqlSource: 'query revenue_by_customer { metric net_revenue }',
      governedValidationPassed: true,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.derivation).toMatchObject({
      sourceRunId: source.runId,
      action: 'edit_dql',
      routeLocked: true,
      permissionsExpanded: false,
      requiresRecompile: true,
      requiresExecution: true,
      trustTransition: {
        previous: 'certified',
        next: 'governed',
        preservesCertifiedAssetIdentity: false,
      },
    });
    expect(result.derivation.derivedRunId).not.toBe(source.runId);
    expect(source).toEqual(sourceCopy);
  });

  it('creates a review-required SQL notebook derivation linked to the original fingerprints', () => {
    const source = failedRun();
    const result = deriveAnalyticalRepair(source, {
      version: 1,
      action: 'open_sql_notebook',
      sqlText: source.compiledSql,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.derivation.trustTransition.next).toBe('review_required');
    expect(result.derivation.sourceSqlFingerprint).toBe(source.sqlFingerprint);
    expect(result.derivation.requiresExecution).toBe(false);
  });

  it('keeps certified identity for an explicit parameter-only rerun and requires a new receipt (E2E-014)', () => {
    const source = { ...failedRun('TIMEOUT'), route: 'certified' as const };
    const sourceCopy = structuredClone(source);
    const result = deriveAnalyticalRepair(source, {
      version: 1,
      action: 'parameter_rerun',
      parameterValues: { customer: 'Zoom' },
    });
    expect(result).toMatchObject({
      status: 'ready',
      derivation: {
        action: 'parameter_rerun',
        change: 'parameter_only',
        trustTransition: {
          previous: 'certified',
          next: 'certified',
          requiresNewReceipt: true,
          preservesCertifiedAssetIdentity: true,
        },
        routeLocked: true,
        permissionsExpanded: false,
        requiresExecution: true,
      },
    });
    if (result.status === 'ready') expect(result.derivation.parameterFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(source).toEqual(sourceCopy);
  });

  it('keeps permission denial terminal and allows only explicit access/connection actions', () => {
    const source = failedRun('PERMISSION_DENIED');
    expect(deriveAnalyticalRepair(source, {
      version: 1,
      action: 'edit_dql',
      dqlSource: 'query alternate_source { metric revenue }',
    })).toMatchObject({ status: 'blocked', code: 'ACTION_NOT_ALLOWED' });
    expect(deriveAnalyticalRepair(source, {
      version: 1,
      action: 'change_authorized_connection',
      authorizedConnectionFingerprint: fingerprint('b'),
    })).toMatchObject({
      status: 'ready',
      derivation: { routeLocked: true, permissionsExpanded: false },
    });
  });

  it('rejects a retained source whose text no longer matches its fingerprint', () => {
    const source = failedRun();
    source.dqlSource = 'mutated in place';
    expect(deriveAnalyticalRepair(source, {
      version: 1,
      action: 'edit_dql',
      dqlSource: 'query repaired { metric revenue }',
    })).toMatchObject({ status: 'blocked', code: 'SOURCE_FINGERPRINT_MISMATCH' });
  });
});

/**
 * `message` is a fixed SAFE_FAILURES headline per failure code — the default,
 * "The selected route could not compile its immutable analytical plan", covers
 * everything unclassified, so a MetricFlow compile error and a dialect mismatch
 * read identically and neither tells the user what to change. `diagnostic`
 * carries the producer's own words, already stripped of credentials, connection
 * strings, and quoted literals.
 */
describe('analytical failures keep a usable diagnostic', () => {
  it('records the producer text alongside the safe headline', () => {
    const failure = createAnalyticalFailure({
      code: 'COMPILATION_FAILED',
      phase: 'compilation',
      snapshotId: 'snapshot-1',
      error: new Error("MetricFlow compile failed: group-by-items do not include 'metric_time'"),
    });

    expect(failure.message).toBeTruthy();
    // The producer's SENTENCE survives, which is what turns a dead end into a
    // fixable error. Note the quoted token itself is redacted — the redactor
    // cannot tell a schema identifier from a row value, so it strips both. The
    // headline alone would have said only "could not compile its immutable
    // analytical plan", which is the default for anything unclassified.
    expect(failure.diagnostic).toContain('MetricFlow compile failed');
    expect(failure.diagnostic).toContain('group-by-items do not include');
    expect(failure.diagnostic).not.toBe(failure.message);
  });

  it('redacts credentials and quoted literals out of the diagnostic', () => {
    const failure = createAnalyticalFailure({
      code: 'COMPILATION_FAILED',
      phase: 'compilation',
      snapshotId: 'snapshot-1',
      error: new Error("failed for password=hunter2 on region 'EMEA'"),
    });

    expect(failure.diagnostic).not.toContain('hunter2');
    expect(failure.diagnostic).not.toContain('EMEA');
  });

  it('omits the diagnostic when there was nothing to report', () => {
    const failure = createAnalyticalFailure({
      code: 'COMPILATION_FAILED',
      phase: 'compilation',
      snapshotId: 'snapshot-1',
    });
    expect(failure.diagnostic).toBeUndefined();
  });
});
