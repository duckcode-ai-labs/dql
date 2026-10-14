import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DQLContext } from '@zlens/mcp';
import { dqlToolNamesForSurface, recordRuntimeSchemaSnapshot } from '@zlens/agent';
import { buildAgentTools, lookupRuntimeTableSchema } from './tools.js';
import { analyticsSystemPrompt } from './analytics-tools.js';
import type { AgentRunRequest } from './types.js';

describe('native agent tools', () => {
  it('uses the governed DQL route and metadata execution tools', () => {
    const tools = buildAgentTools({} as DQLContext);
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(dqlToolNamesForSurface('native'));
    expect(tools.find((tool) => tool.name === 'query_semantic_model')?.inputSchema).toMatchObject({
      properties: {
        metrics: {
          type: 'array',
          items: { type: 'string' },
        },
        saveDraft: {
          type: 'boolean',
        },
        dryRun: {
          type: 'boolean',
        },
        rowLimit: {
          type: 'number',
        },
      },
    });
    expect(tools.find((tool) => tool.name === 'inspect_metadata_context')?.inputSchema).toMatchObject({
      properties: {
        strictness: {
          type: 'string',
          enum: ['balanced', 'exploratory'],
        },
      },
    });
    expect(tools.find((tool) => tool.name === 'query_via_metadata')?.inputSchema).toMatchObject({
      required: ['question'],
      properties: {
        outputs: {
          type: 'array',
          items: { type: 'string' },
        },
        regroundAttemptsUsed: { type: 'number' },
        followUp: {
          properties: {
            kind: { enum: ['generic', 'drilldown', 'contextual'] },
            priorResultRef: {
              required: ['id', 'columns'],
            },
            priorDqlArtifact: {
              required: ['kind', 'source'],
            },
          },
        },
      },
    });
    expect(tools.find((tool) => tool.name === 'expand_context')?.inputSchema).toMatchObject({
      required: ['contextPackId', 'relations'],
    });
  });

  it('instructs native agents to carry prior result refs into metadata follow-ups', () => {
    const prompt = analyticsSystemPrompt({
      manifest: { blocks: {} },
    } as DQLContext, {
      provider: 'anthropic',
      projectRoot: '/tmp/project',
      messages: [{ role: 'user', content: 'include product details with previous results' }],
    } as AgentRunRequest);

    expect(prompt).toContain('followUp.priorResultRef');
    expect(prompt).toContain('followUp.priorDqlArtifact');
    expect(prompt).toContain('previous results');
  });

  it('exposes the P3 schema-discovery tools to the native/answer_loop surface', () => {
    const names = buildAgentTools({} as DQLContext).map((tool) => tool.name);
    // buildAgentTools throws if any registered native tool lacks a handler, so this
    // also proves the search_metadata/get_table_schema/validate_sql handlers wired.
    expect(names).toContain('search_metadata');
    expect(names).toContain('get_table_schema');
    expect(names).toContain('validate_sql');
  });
});

describe('get_table_schema live-schema fallback (P3)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

  function seededProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'p3-runtime-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.dql', 'cache'), { recursive: true });
    // A raw warehouse table dbt never wrapped, captured by a prior live scan.
    recordRuntimeSchemaSnapshot(dir, {
      source: 'test',
      tables: [{
        relation: 'raw.events_stream',
        name: 'events_stream',
        schema: 'raw',
        columns: [
          { name: 'event_id', type: 'VARCHAR' },
          { name: 'occurred_at', type: 'TIMESTAMP' },
        ],
      }],
    });
    return dir;
  }

  it('resolves a live-only table (absent from the dbt manifest) from the runtime snapshot', () => {
    const result = lookupRuntimeTableSchema(seededProject(), 'events_stream') as {
      found?: boolean; source?: string; columns?: Array<{ name: string }>;
    } | undefined;
    expect(result?.found).toBe(true);
    expect(result?.source).toBe('runtime_schema');
    expect(result?.columns?.map((column) => column.name)).toEqual(['event_id', 'occurred_at']);
  });

  it('matches a fully-qualified relation too', () => {
    const result = lookupRuntimeTableSchema(seededProject(), 'raw.events_stream') as { found?: boolean } | undefined;
    expect(result?.found).toBe(true);
  });

  it('returns undefined when the table is not in the snapshot', () => {
    expect(lookupRuntimeTableSchema(seededProject(), 'nonexistent_table')).toBeUndefined();
  });
});
