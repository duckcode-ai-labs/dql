import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  ManagedMetricFlowInstaller,
  isMetricFlowWarehouseAdapter,
  managedMetricFlowDbt,
  managedMetricFlowPython,
  metricFlowAdapterForDriver,
  metricFlowPackageSpec,
  metricFlowPythonCandidates,
} from './metricflow-installer.js';
import { managedMetricFlowBin, managedMetricFlowRuntimeRoot } from './metricflow.js';

describe('managed MetricFlow installer', () => {
  it('maps supported ZLens connection drivers to dbt adapter extras', () => {
    expect(metricFlowAdapterForDriver('file')).toBe('duckdb');
    expect(metricFlowAdapterForDriver('postgresql')).toBe('postgres');
    expect(metricFlowAdapterForDriver('snowflake')).toBe('snowflake');
    expect(metricFlowAdapterForDriver('databricks')).toBe('databricks');
    expect(metricFlowAdapterForDriver('trino')).toBe('trino');
    expect(isMetricFlowWarehouseAdapter('bigquery')).toBe(true);
    expect(isMetricFlowWarehouseAdapter('mssql')).toBe(false);
  });

  it('uses a bounded DQL-tested package range and a project-local environment', () => {
    expect(metricFlowPackageSpec('snowflake')).toBe('dbt-metricflow[dbt-snowflake]>=0.13,<0.14');
    const root = join('/workspace', 'analytics');
    expect(managedMetricFlowRuntimeRoot(root)).toBe(join(root, '.dql', 'runtimes', 'metricflow'));
    expect(managedMetricFlowBin(root)).toContain(join('.dql', 'runtimes', 'metricflow'));
    expect(managedMetricFlowPython(root)).toContain(join('.dql', 'runtimes', 'metricflow'));
    expect(managedMetricFlowDbt(root)).toContain(join('.dql', 'runtimes', 'metricflow'));
  });

  it('checks compatible versioned Python binaries before an unsupported default', () => {
    expect(metricFlowPythonCandidates()).toEqual([
      'python3.13',
      'python3.12',
      'python3.11',
      'python3.10',
      'python3',
      'python',
    ]);
    expect(metricFlowPythonCandidates('/approved/python')[0]).toBe('/approved/python');
  });

  it('refuses installation before a dbt project is connected', () => {
    const installer = new ManagedMetricFlowInstaller('/missing-project');
    expect(() => installer.start({
      adapter: 'duckdb',
      dbtProjectDir: '/missing-project',
    })).toThrow('Connect a valid dbt project');
    expect(installer.latest()).toBeNull();
  });
});
