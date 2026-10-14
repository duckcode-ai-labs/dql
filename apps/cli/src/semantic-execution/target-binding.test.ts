import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWarehouseTargetIdentity } from '@zlens/core';
import { saveTestedSemanticRuntimeSettings } from '../semantic-runtime-settings.js';
import {
  SemanticExecutionTargetMismatchError,
  SemanticSourceBindingMissingError,
  assertSemanticExecutionTarget,
  buildSemanticTargetBinding,
} from './target-binding.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dql-target-binding-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function target(database: string, schema = 'semantic') {
  return createWarehouseTargetIdentity({
    connectionRef: `connection:${database}`,
    driver: 'snowflake',
    redactedContext: {
      account: 'acme',
      database,
      schema,
      role: 'analyst',
      warehouse: 'reporting',
    },
  });
}

describe('semantic target binding', () => {
  it('blocks dbt Cloud SQL before compilation when the active database differs', () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'semantic-layer.cloud.getdbt.com',
        environmentId: '99',
        serviceToken: 'secret',
      },
    }, { ok: true, message: 'ok', dialect: 'snowflake' }, target('PROD'));

    expect(() => assertSemanticExecutionTarget({
      projectRoot: root,
      adapterId: 'dbt-cloud',
      executionTarget: target('DEV'),
    })).toThrow(SemanticExecutionTargetMismatchError);
  });

  it('accepts a legacy dbt Cloud locator binding for the same canonical Snowflake account', () => {
    const legacyLocator = createWarehouseTargetIdentity({
      connectionRef: 'legacy-bound-target',
      driver: 'snowflake',
      redactedContext: {
        account: 'XY12345',
        database: 'PROD',
        schema: 'SEMANTIC',
        role: 'ANALYST',
        warehouse: 'REPORTING',
      },
    });
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'semantic-layer.cloud.getdbt.com',
        environmentId: '99',
        serviceToken: 'secret',
      },
    }, { ok: true, message: 'ok', dialect: 'snowflake' }, legacyLocator);
    const observed = createWarehouseTargetIdentity({
      connectionRef: 'active-target',
      driver: 'snowflake',
      redactedContext: {
        account: 'ACME-PROD',
        accountLocator: 'XY12345',
        accountName: 'PROD',
        organization: 'ACME',
        database: 'PROD',
        schema: 'SEMANTIC',
        role: 'ANALYST',
        warehouse: 'REPORTING',
      },
    });

    expect(assertSemanticExecutionTarget({
      projectRoot: root,
      adapterId: 'dbt-cloud',
      executionTarget: observed,
    }).redactedContext.account).toBe('XY12345');
  });

  it('accepts a MetricFlow client account identifier for the same observed account locator', () => {
    const profileTarget = createWarehouseTargetIdentity({
      connectionRef: 'dbt-profile',
      driver: 'snowflake',
      redactedContext: {
        account: 'ACME-PROD',
        database: 'PROD',
        schema: 'SEMANTIC',
        role: 'ANALYST',
        warehouse: 'REPORTING',
      },
    });
    const observed = createWarehouseTargetIdentity({
      connectionRef: 'active-target',
      driver: 'snowflake',
      redactedContext: {
        account: 'ACME-PROD',
        accountLocator: 'XY12345',
        accountName: 'PROD',
        organization: 'ACME',
        database: 'PROD',
        schema: 'SEMANTIC',
        role: 'ANALYST',
        warehouse: 'REPORTING',
      },
    });

    expect(assertSemanticExecutionTarget({
      projectRoot: root,
      adapterId: 'metricflow-cli',
      executionTarget: observed,
      metricFlow: { expectedTarget: profileTarget },
    })).toBe(profileTarget);
  });

  it('records redacted target and adapter evidence without credentials', () => {
    const executionTarget = target('PROD');
    const binding = buildSemanticTargetBinding({
      projectRoot: root,
      adapterId: 'native',
      executionTarget,
    });

    expect(binding.executionTarget.redactedContext.database).toBe('PROD');
    expect(binding.proof.checks.map((check) => check.kind)).toContain('warehouse_context');
    expect(JSON.stringify(binding)).not.toContain('password');
  });

  it('does not claim a verified dbt Cloud binding without a complete compiler inventory', () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'semantic-layer.cloud.getdbt.com',
        environmentId: '99',
        serviceToken: 'secret',
      },
    }, { ok: true, message: 'connection only', dialect: 'snowflake' }, target('PROD'));

    expect(() => buildSemanticTargetBinding({
      projectRoot: root,
      adapterId: 'dbt-cloud',
      executionTarget: target('PROD'),
    })).toThrow(SemanticSourceBindingMissingError);
  });

  it('binds the dbt Cloud compiler target to the runtime catalog fingerprint, not the local artifact fingerprint', () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'semantic-layer.cloud.getdbt.com',
        environmentId: '99',
        serviceToken: 'secret',
      },
    }, {
      ok: true,
      message: 'catalog verified',
      dialect: 'snowflake',
      metricCount: 1,
      metricNames: ['revenue'],
      semanticCatalogFingerprint: 'cloud-catalog-fingerprint',
      metricInventoryComplete: true,
    }, target('PROD'));

    const binding = buildSemanticTargetBinding({
      projectRoot: root,
      adapterId: 'dbt-cloud',
      executionTarget: target('PROD'),
    });
    expect(binding.compileTarget).toMatchObject({
      kind: 'dbt_cloud_environment',
      semanticCatalogFingerprint: 'cloud-catalog-fingerprint',
    });
    expect(binding.proof.checks).toContainEqual({
      kind: 'semantic_catalog',
      fingerprint: 'cloud-catalog-fingerprint',
    });
  });
});
