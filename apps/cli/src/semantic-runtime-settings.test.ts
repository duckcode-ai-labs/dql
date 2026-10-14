import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWarehouseTargetIdentity } from '@zlens/core';
import {
  getEffectiveDbtCloudSemanticSettings,
  getSemanticRuntimeSettings,
  saveTestedSemanticRuntimeSettings,
  semanticLayerGraphqlEndpoint,
  semanticRuntimeSettingsPath,
} from './semantic-runtime-settings.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dql-semantic-runtime-settings-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DBT_CLOUD_SEMANTIC_LAYER_HOST;
  delete process.env.DBT_CLOUD_ENVIRONMENT_ID;
  delete process.env.DBT_CLOUD_SERVICE_TOKEN;
});

describe('semantic runtime settings', () => {
  const target = createWarehouseTargetIdentity({
    connectionRef: 'connection:test',
    driver: 'snowflake',
    redactedContext: {
      account: 'acme',
      database: 'analytics',
      schema: 'semantic',
      role: 'analyst',
      warehouse: 'reporting',
    },
  });

  it('normalizes regional hosts to the GraphQL endpoint', () => {
    expect(semanticLayerGraphqlEndpoint('semantic-layer.emea.dbt.com/')).toBe(
      'https://semantic-layer.emea.dbt.com/api/graphql',
    );
    expect(semanticLayerGraphqlEndpoint('https://example.test/api/graphql')).toBe(
      'https://example.test/api/graphql',
    );
  });

  it('preserves a tested token when a later successful edit leaves it blank and never returns it raw', () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'https://semantic-layer.cloud.getdbt.com',
        environmentId: '12345',
        serviceToken: 'dbtc_secret_value',
      },
    }, { ok: true, message: 'Test passed', dialect: 'snowflake', metricCount: 7_500 }, target);

    saveTestedSemanticRuntimeSettings(root, {
      dbtCloud: { host: 'semantic-layer.emea.dbt.com', environmentId: '67890', serviceToken: '' },
    }, { ok: true, message: 'Test passed again', dialect: 'databricks' }, target);

    expect(getEffectiveDbtCloudSemanticSettings(root)).toMatchObject({
      serviceToken: 'dbtc_secret_value',
      environmentId: '67890',
      testState: 'passed',
    });
    const redacted = getSemanticRuntimeSettings(root);
    expect(redacted.dbtCloud.hasServiceToken).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('dbtc_secret_value');
    expect(readFileSync(semanticRuntimeSettingsPath(root), 'utf8')).toContain('dbtc_secret_value');
    expect(redacted.dbtCloud).toMatchObject({
      targetBindingState: 'bound',
      executionTargetFingerprint: target.identityFingerprint,
    });
  });

  it('detects a complete environment configuration without persisting credentials', () => {
    process.env.DBT_CLOUD_SEMANTIC_LAYER_HOST = 'semantic-layer.au.dbt.com';
    process.env.DBT_CLOUD_ENVIRONMENT_ID = '42';
    process.env.DBT_CLOUD_SERVICE_TOKEN = 'env-secret';

    expect(getSemanticRuntimeSettings(root).dbtCloud).toMatchObject({
      configured: true,
      source: 'env',
      hasServiceToken: true,
      testState: 'configured',
    });
  });

  it('does not overwrite working settings with a failed test result', () => {
    saveTestedSemanticRuntimeSettings(root, {
      dbtCloud: { host: 'semantic-layer.cloud.getdbt.com', environmentId: '1', serviceToken: 'working' },
    }, { ok: true, message: 'Test passed' }, target);

    expect(() => saveTestedSemanticRuntimeSettings(root, {
      dbtCloud: { host: 'broken.example', environmentId: '2', serviceToken: 'broken' },
    }, { ok: false, message: 'Connection failed' })).toThrow('Connection failed');
    expect(getEffectiveDbtCloudSemanticSettings(root)).toMatchObject({
      host: 'https://semantic-layer.cloud.getdbt.com',
      environmentId: '1',
      serviceToken: 'working',
    });
  });

  it('requires old tested settings to be reapplied before semantic execution', () => {
    saveTestedSemanticRuntimeSettings(root, {
      dbtCloud: {
        host: 'semantic-layer.cloud.getdbt.com',
        environmentId: '1',
        serviceToken: 'working',
      },
    }, { ok: true, message: 'Catalog test passed' });

    expect(getSemanticRuntimeSettings(root).dbtCloud).toMatchObject({
      testState: 'passed',
      targetBindingState: 'missing',
      metricInventoryState: 'missing',
    });
  });

  it('persists the compiler metric inventory server-side and exposes only its redacted proof', () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'semantic-layer.cloud.getdbt.com',
        environmentId: '99',
        serviceToken: 'working',
      },
    }, {
      ok: true,
      message: 'Catalog test passed',
      dialect: 'snowflake',
      metricCount: 2,
      metricNames: ['revenue', 'revenue_yoy'],
      semanticCatalogFingerprint: 'catalog-fingerprint',
      metricInventoryComplete: true,
    }, target);

    expect(getEffectiveDbtCloudSemanticSettings(root)).toMatchObject({
      metricNames: ['revenue', 'revenue_yoy'],
      semanticCatalogFingerprint: 'catalog-fingerprint',
      metricInventoryComplete: true,
    });
    const redacted = getSemanticRuntimeSettings(root);
    expect(redacted.dbtCloud).toMatchObject({
      metricCount: 2,
      semanticCatalogFingerprint: 'catalog-fingerprint',
      metricInventoryState: 'complete',
    });
    expect(JSON.stringify(redacted)).not.toContain('revenue_yoy');
  });
});
