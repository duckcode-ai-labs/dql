import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildVocabularyIndex, runAskPipeline, type AgentProvider } from '@zlens/agent';
import type { DQLManifest } from '@zlens/core';
import { buildVocabularySource, embeddedManifestRelations } from './vocabulary-source.js';
import { relevantRelationsForQuestion, runtimeSchemaForVocabulary } from './host.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/manifest-only-metricflow');
const generator = join(fixtureRoot, 'generate-enterprise-manifest.mjs');

describe('generated manifest-only enterprise acceptance fixture', () => {
  it('creates a sanitized >50k-column manifest with a late opportunity schema, decoy relation, and no DQL authoring', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-manifest-only-enterprise-'));
    try {
      const input = join(root, 'manifest.json');
      const output = join(root, 'manifest.enterprise.json');
      writeFileSync(input, JSON.stringify({
        nodes: {
          'model.manifest_only_metricflow.fct_opportunities': {
            unique_id: 'model.manifest_only_metricflow.fct_opportunities', resource_type: 'model', name: 'fct_opportunities', columns: {}, depends_on: { nodes: [] }, tags: [],
          },
        },
      }));
      execFileSync(process.execPath, [generator, input, output], { stdio: 'pipe' });
      const artifact = JSON.parse(readFileSync(output, 'utf8')) as { nodes: Record<string, { columns: Record<string, { name: string; data_type?: string; description?: string }> }> };
      const opportunities = artifact.nodes['model.manifest_only_metricflow.fct_opportunities']!;
      expect(Object.keys(opportunities.columns)).toHaveLength(50_057);
      expect(Object.keys(opportunities.columns).indexOf('competitor')).toBeGreaterThan(40);
      expect(artifact.nodes['model.manifest_only_metricflow.salesforce_daily_activity']).toBeDefined();

      // Enterprise manifests retain the full dbt artifact on disk instead of
      // materializing 50k individual vocabulary objects.  The relation-level
      // search lane must still see a late documented field, while the field
      // remains unavailable for binding until current catalog hydration.
      const manifest = {
        dbtProvenance: {
          manifestPath: output,
          nodes: {
            'model.manifest_only_metricflow.fct_opportunities': {
              uniqueId: 'model.manifest_only_metricflow.fct_opportunities', resourceType: 'model', name: 'fct_opportunities',
              relation: 'DB_A.TRANSFORMED.OPPORTUNITIES_WIDE', identityFingerprint: 'opportunities',
              available: { description: true, columns: true, tests: false, catalogTypes: false, dqlMeta: false },
            },
          },
          metricFlow: {},
        },
      } as unknown as DQLManifest;
      const embedded = embeddedManifestRelations(manifest);
      expect(embedded).toHaveLength(1);
      expect(embedded[0]?.columns).toEqual([]);
      expect(embedded[0]?.embeddedColumns).toHaveLength(50_057);
      const relationOnly = buildVocabularySource({ driver: 'snowflake', manifest, relations: embedded });
      expect(relevantRelationsForQuestion(relationOnly, 'lost opportunities amount by fiscal year FY26 where competitor is Splunk'))
        .toEqual(['DB_A.TRANSFORMED.OPPORTUNITIES_WIDE']);
      expect(buildVocabularyIndex(relationOnly).lookup('competitor', { kinds: ['column'] })).toEqual([]);

      const columns = Object.values(opportunities.columns).map((column) => ({ name: column.name, dataType: column.data_type, description: column.description }));
      const source = buildVocabularySource({
        driver: 'snowflake', snapshotId: 'snapshot:manifest-only', executionTargetFingerprint: 'target:role-a',
        relations: [
          { database: 'DB_A', schema: 'TRANSFORMED', name: 'OPPORTUNITIES_WIDE', columns, columnCompleteness: 'partial' },
          { database: 'DB_A', schema: 'SALES', name: 'SALESFORCE_DAILY_ACTIVITY', columns: Object.values(artifact.nodes['model.manifest_only_metricflow.salesforce_daily_activity']!.columns).map((column) => ({ name: column.name, dataType: column.data_type, description: column.description })), columnCompleteness: 'partial' },
        ],
      });
      expect(source.blocks).toEqual([]);
      expect(source.metrics).toEqual([]);
      expect(source.relations?.[0]?.columnCompleteness).toBe('partial');
      const discoveryCandidates = relevantRelationsForQuestion(source, 'lost opportunities amount by fiscal year FY26 where competitor is Splunk');
      // Discovery may retain a lexical decoy beside the true semantic/column
      // home, but it stays a bounded hydration list rather than a binding.
      expect(discoveryCandidates.length).toBeLessThanOrEqual(3);
      expect(discoveryCandidates[0]).toBe('DB_A.TRANSFORMED.OPPORTUNITIES_WIDE');

      const vocabulary = buildVocabularyIndex(source);
      const competitor = vocabulary.lookup('competitor', { kinds: ['column'], limit: 3 });
      expect(competitor.map((hit) => hit.entry.physical?.relation)).toContain('TRANSFORMED.OPPORTUNITIES_WIDE');
      const runtime = runtimeSchemaForVocabulary(vocabulary).find((entry) => entry.relation === 'DB_A.TRANSFORMED.OPPORTUNITIES_WIDE');
      expect(runtime).toMatchObject({ executionTargetFingerprint: 'target:role-a', columnCompleteness: 'partial' });
      expect(runtime?.columns.some((column) => column.name === 'competitor')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('runs the actual Ask semantic route against a manifest-only vocabulary and preserves a scalar result shape', async () => {
    // The deterministic provider makes this an Ask-pipeline test rather than a
    // structural fixture assertion. The local-MetricFlow runner below proves
    // the real external compiler/runtime separately; this test proves that Ask
    // hands its semantic request to that adapter and keeps the scalar contract.
    const provider: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: async () => JSON.stringify({
        version: 1,
        kind: 'analytics',
        reading: 'Total BCM.',
        measures: [{ ref: 'metric:bcm.total_bcm' }],
        groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'metric:bcm.total_bcm': 'q:BCM' }, expectedShape: 'scalar',
      }),
    };
    const vocabulary = buildVocabularyIndex({
      metrics: [{ name: 'total_bcm', model: 'bcm', sourceId: 'total_bcm', aggregation: 'sum', aggTimeDimension: 'report_as_of_dt' }],
      dimensions: [{ name: 'report_as_of_dt', model: 'bcm', sourceId: 'bcm.report_as_of_dt', dataType: 'date', isTime: true }],
      relations: [{ schema: 'main', name: 'fct_bcm', columnCompleteness: 'complete', columns: [
        { name: 'customer_id', dataType: 'INTEGER' }, { name: 'customer_name', dataType: 'VARCHAR' },
        { name: 'report_as_of_dt', dataType: 'DATE' }, { name: 'total_bcm', dataType: 'INTEGER' },
      ] }],
    });
    let semanticRequest: unknown;
    const outcome = await runAskPipeline({
      question: 'What is total BCM?',
      vocabulary,
      provider,
      clauseCoverage: false,
      prepareDeps: {
        engine: 'metricflow-cli',
        compileSemantic: async (request) => {
          semanticRequest = request;
          return { sql: 'SELECT 220 AS total_bcm', engine: 'metricflow-cli', columns: ['total_bcm'] };
        },
      },
      executeDeps: {
        run: async (sql) => {
          expect(sql).toBe('SELECT 220 AS total_bcm');
          return { columns: ['total_bcm'], rows: [{ total_bcm: 220 }], rowCount: 1, executionTimeMs: 1 };
        },
      },
    });
    expect(semanticRequest).toMatchObject({ metrics: ['total_bcm'], dimensions: [] });
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.candidate.tier).toBe('semantic');
    expect(outcome.candidate.engine).toBe('metricflow-cli');
    expect(outcome.result).toMatchObject({ columns: ['total_bcm'], rows: [{ total_bcm: 220 }], rowCount: 1 });
  });
});
