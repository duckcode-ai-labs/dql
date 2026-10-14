import { createHash } from 'node:crypto';
import {
  NodeKind,
  Parser,
  blockParameterDefinitions,
  resolveBlockParameterValues,
  type BlockParameterDefinition,
} from '@zlens/core';

export type BlockInvocationSurface = 'block_studio' | 'ask_ai' | 'notebook' | 'app' | 'mcp' | 'cli';

export interface BlockInvocationRequest {
  /** Stable block reference for audit/evidence; source remains the execution input. */
  block?: string;
  source: string;
  parameters?: Record<string, unknown>;
  /** Provenance supplied by a consuming surface such as a dashboard binding. */
  parameterSources?: Record<string, 'policy' | 'explicit' | 'question' | 'prior_result' | 'surface' | 'default'>;
  question?: string;
  surface: BlockInvocationSurface;
  contextPackId?: string;
}

export interface PreparedBlockInvocation {
  parameters: BlockParameterDefinition[];
  values: Record<string, unknown>;
  resolvedParameters: Array<{
    name: string;
    value: unknown;
    source: 'policy' | 'explicit' | 'question' | 'prior_result' | 'surface' | 'default';
  }>;
  unresolvedParameters: string[];
  errors: string[];
  auditId: string;
}

/**
 * The only value-resolution path used by runtime surfaces. It intentionally
 * resolves values only; changing block structure remains outside this contract.
 */
export function prepareBlockInvocation(input: BlockInvocationRequest): PreparedBlockInvocation {
  const program = new Parser(input.source, '<block-invocation>').parse();
  const block = program.statements.find((statement) => statement.kind === NodeKind.BlockDecl);
  if (!block || block.kind !== NodeKind.BlockDecl) {
    return {
      parameters: [], values: {}, resolvedParameters: [], unresolvedParameters: [],
      errors: ['Block invocation requires a DQL block declaration.'],
      auditId: invocationAuditId(input, {}),
    };
  }
  const parameters = blockParameterDefinitions(block);
  const questionValues = inferQuestionValues(input.question ?? '', parameters);
  const explicit = { ...questionValues, ...(input.parameters ?? {}) };
  const resolution = resolveBlockParameterValues(parameters, explicit);
  const resolvedParameters = resolution.resolved.map((entry) => ({
    ...entry,
    source: input.parameterSources?.[entry.name]
      ?? (Object.prototype.hasOwnProperty.call(input.parameters ?? {}, entry.name)
      ? 'explicit' as const
      : Object.prototype.hasOwnProperty.call(questionValues, entry.name)
        ? 'question' as const
        : 'default' as const),
  }));
  return {
    parameters,
    values: resolution.values,
    resolvedParameters,
    unresolvedParameters: resolution.unresolved,
    errors: resolution.errors,
    auditId: invocationAuditId(input, resolution.values),
  };
}

function inferQuestionValues(question: string, definitions: BlockParameterDefinition[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lower = question.toLowerCase();
  const topN = /\b(?:top|bottom|first|last)\s+(\d+)\b/i.exec(question)?.[1];
  const years = Array.from(question.matchAll(/\b(19\d{2}|20\d{2})\b/g)).map((match) => Number(match[1]));
  const dates = Array.from(question.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)).map((match) => match[1]);

  // Inference legitimately overrides a block DEFAULT — "top 3" against a block
  // declaring `top_n = 10` must return 3. It is scoped to values the question
  // states outright (limit, dates, years); labels such as regions and ids stay
  // unresolved rather than being guessed (see the note at the end of the loop).
  for (const definition of definitions) {
    if ((definition.name === 'top_n' || definition.binding?.kind === 'limit') && topN) {
      out[definition.name] = Number(topN);
      continue;
    }
    if ((definition.name.includes('start') || definition.name.includes('from')) && dates[0]) {
      out[definition.name] = dates[0];
      continue;
    }
    if ((definition.name.includes('end') || definition.name.includes('to')) && dates.length > 1) {
      out[definition.name] = dates.at(-1);
      continue;
    }
    if ((definition.name.includes('start') || definition.name.includes('from')) && years[0]) {
      out[definition.name] = years[0];
      continue;
    }
    if ((definition.name.includes('end') || definition.name.includes('to')) && years.length > 1) {
      out[definition.name] = years.at(-1);
      continue;
    }
    if ((definition.name === 'season' || definition.name.endsWith('_year')) && years.length === 1) {
      out[definition.name] = years[0];
      continue;
    }
    // Value labels such as regions and customer ids deliberately remain unresolved.
    // They require an explicit UI value or a schema-backed agent tool, never guessing.
    void lower;
  }
  return out;
}

function invocationAuditId(input: BlockInvocationRequest, values: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${input.surface}\0${input.question ?? ''}\0${JSON.stringify(values)}\0${input.source}`)
    .digest('hex')
    .slice(0, 20);
}
