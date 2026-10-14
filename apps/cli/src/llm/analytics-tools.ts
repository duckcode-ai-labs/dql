import { DQLContext } from '@zlens/mcp';
import type { KGNode } from '@zlens/agent';
import type { AgentRunRequest, AgentTurn, BlockProposal } from './types.js';
import { buildAgentTools, type AgentTool } from './tools.js';
import { blockProposalDqlMetadata } from './proposal-metadata.js';

const QUERY_CERTIFIED_BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', description: 'Certified DQL block name to execute.' },
    limit: { type: 'number', description: 'Maximum rows to return in the tool result. Default 200.' },
    question: { type: 'string', description: 'Original user question used to resolve typed block parameters.' },
    parameters: {
      type: 'object',
      additionalProperties: true,
      description: 'Explicit typed values for the certified block parameters.',
    },
  },
} as const;

const INSPECT_RUNTIME_SCHEMA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  properties: {
    question: { type: 'string', description: 'The user question or analytical task to inspect schema for.' },
  },
} as const;

const EXECUTE_GENERATED_SQL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sql'],
  properties: {
    sql: {
      type: 'string',
      description: 'Read-only SQL to execute as a bounded, uncertified preview. ZLens will add safety limits.',
    },
  },
} as const;

export function buildAnalyticsAgentTools(ctx: DQLContext, req: AgentRunRequest): AgentTool[] {
  return [
    ...buildAgentTools(ctx),
    {
      name: 'query_certified_block',
      description:
        'Execute a certified DQL block by name through the local governed runtime. ' +
        'Use this when a certified block exactly answers the question.',
      inputSchema: QUERY_CERTIFIED_BLOCK_SCHEMA,
      run: async (args) => {
        if (!req.executeCertifiedBlock) {
          return { error: 'Certified block execution is not available in this host.' };
        }
        const input = objectArgs(args);
        const name = requiredString(input.name, 'name');
        const question = typeof input.question === 'string' && input.question.trim() ? input.question.trim() : undefined;
        const parameters = input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
          ? input.parameters as Record<string, unknown>
          : undefined;
        const result = await req.executeCertifiedBlock(blockNodeFor(name), { question, parameters });
        const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(10000, Math.floor(input.limit)))
          : 200;
        return {
          trust: 'certified',
          block: name,
          rowCount: result.rowCount,
          executionTime: result.executionTime,
          columns: result.columns,
          rows: Array.isArray(result.rows) ? result.rows.slice(0, limit) : [],
          sql: result.sql,
          chartConfig: result.chartConfig,
          blockPath: result.blockPath,
          parameters: result.parameters,
          auditId: result.auditId,
        };
      },
    },
    {
      name: 'inspect_runtime_schema',
      description:
        'Inspect runtime table and column context for an arbitrary analytics question. ' +
        'Use this before writing new SQL when no certified block directly answers the question.',
      inputSchema: INSPECT_RUNTIME_SCHEMA_SCHEMA,
      run: async (args) => {
        if (!req.getSchemaContext) {
          return { error: 'Runtime schema inspection is not available in this host.' };
        }
        const input = objectArgs(args);
        const question = requiredString(input.question, 'question');
        const tables = await req.getSchemaContext(question);
        return {
          question,
          tables: tables.slice(0, 24),
          tableCount: tables.length,
        };
      },
    },
    {
      name: 'execute_generated_sql',
      description:
        'Execute generated SQL as a bounded, uncertified preview. ' +
        'Use only after inspecting DQL/DBT/semantic context and only for read-only SELECT/WITH analysis.',
      inputSchema: EXECUTE_GENERATED_SQL_SCHEMA,
      run: async (args) => {
        if (!req.executeGeneratedSql) {
          return { error: 'Generated SQL preview execution is not available in this host.' };
        }
        const input = objectArgs(args);
        const sql = requiredString(input.sql, 'sql');
        const result = await req.executeGeneratedSql(sql);
        return {
          trust: 'uncertified',
          reviewStatus: 'draft_ready',
          warning: 'Generated SQL results are a preview and require analyst review before certification.',
          rowCount: result.rowCount,
          executionTime: result.executionTime,
          columns: result.columns,
          rows: Array.isArray(result.rows) ? result.rows.slice(0, 200) : [],
          sql: result.sql ?? sql,
          chartConfig: result.chartConfig,
        };
      },
    },
  ];
}

// Defensively bound carried-forward conversation text so a long multi-turn chat
// can't grow the system prompt unbounded.
function clampPromptText(value: string, max = 240): string {
  return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

export function analyticsSystemPrompt(ctx: DQLContext, req: AgentRunRequest): string {
  const domains = Array.from(new Set(Object.values(ctx.manifest.blocks).map((block) => block.domain).filter(Boolean))).sort();
  const upstream = req.upstream?.sql?.trim();
  const context = req.conversationContext;
  const lines = [
    'You are the DQL agentic analytics runtime.',
    'Answer business questions by using tools, not by guessing from memory.',
    '',
    'Tool order and trust policy:',
    '1. Call ask_dql first for analytics questions. Use its route, trust label, contextPackId, and nextTool.',
    '2. If the semantic layer has the needed metric/dimensions/time grain, call query_semantic_model before deep dbt/warehouse search and carry its DQL artifact and draft path forward.',
    '3. If ask_dql returns a certified exact fit, run query_via_block or query_certified_block and label the result certified.',
    '4. If ask_dql returns generated_sql, call inspect_metadata_context, then query_via_metadata with one read-only SELECT/WITH query and declared outputs; use strictness="exploratory" for deep/broad research and carry the returned dqlArtifact.source forward as the default artifact.',
    '5. For follow-ups that refer to prior/previous results, pass followUp.priorResultRef and followUp.priorDqlArtifact into query_via_metadata instead of answering from vague follow-up prose.',
    '6. If query_via_metadata reports a known relation outside the inspected context, call expand_context with the prior contextPackId and retry query_via_metadata once with the new contextPackId and regroundAttemptsUsed: 1.',
    '7. Use inspect_runtime_schema and execute_generated_sql only as host-side fallback tools when the metadata tools cannot execute in this host.',
    '8. Use external MCP servers only as optional extra context; never let them bypass DQL validation, execution safety, or certification.',
    '9. When producing a reusable asset, call suggest_block or describe the DQL draft path and review status.',
    '',
    'Final answers must include: answer, table/result summary when available, DQL artifact/source when generated, compiled SQL as supporting evidence, trust status, and next review/certification action.',
    `Project context: ${Object.keys(ctx.manifest.blocks).length} blocks. Domains: ${domains.join(', ') || '(none yet)'}.`,
    upstream ? `Current UI/app context:\n${upstream}` : '',
    context?.sourceCertifiedBlock ? `Selected/source certified block: ${context.sourceCertifiedBlock}` : '',
    context?.sourceQuestion ? `Prior question: ${clampPromptText(context.sourceQuestion, 200)}` : '',
    context?.sourceAnswerSummary ? `Prior answer summary: ${clampPromptText(context.sourceAnswerSummary)}` : '',
    context?.requestedFilters?.length ? `Remembered filters: ${context.requestedFilters.slice(0, 8).join(', ')}` : '',
    context?.requestedDimensions?.length ? `Remembered dimensions: ${context.requestedDimensions.slice(0, 8).join(', ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function emitProposalFromSuggestBlock(input: unknown, output: unknown, emit: (turn: AgentTurn) => void): void {
  if (!input || typeof input !== 'object') return;
  const proposalInput = input as Partial<BlockProposal>;
  if (!proposalInput.name || !proposalInput.sql) return;
  const outputRecord = output && typeof output === 'object'
    ? output as { name?: unknown; path?: unknown; certified?: boolean; errors?: unknown[]; warnings?: unknown[] }
    : {};
  emit({
    kind: 'proposal',
    proposal: {
      name: typeof outputRecord.name === 'string' && outputRecord.name.trim() ? outputRecord.name : String(proposalInput.name),
      path: typeof outputRecord.path === 'string' && outputRecord.path.trim() ? outputRecord.path : undefined,
      domain: String(proposalInput.domain ?? ''),
      owner: String(proposalInput.owner ?? ''),
      description: String(proposalInput.description ?? ''),
      sql: String(proposalInput.sql),
      ...blockProposalDqlMetadata(proposalInput),
      tags: Array.isArray(proposalInput.tags) ? proposalInput.tags.map(String) : undefined,
      chartType: typeof proposalInput.chartType === 'string' ? proposalInput.chartType : undefined,
    },
    governance: {
      certified: Boolean(outputRecord.certified),
      errors: Array.isArray(outputRecord.errors) ? outputRecord.errors.map(String) : [],
      warnings: Array.isArray(outputRecord.warnings) ? outputRecord.warnings.map(String) : [],
    },
  });
}

function blockNodeFor(name: string): KGNode {
  return {
    nodeId: `block:${name}`,
    kind: 'block',
    name,
    sourceTier: 'certified_artifact',
    certification: 'certified',
  };
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}
