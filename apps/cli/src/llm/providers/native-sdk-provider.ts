import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  defaultKgPath,
  normalizeAnthropicBaseUrl,
  reindexProject,
  supportsReasoningEffort,
} from '@zlens/agent';
import { DQLContext } from '@zlens/mcp';
import { existsSync } from 'node:fs';
import type { AgentRunRequest, AgentRunner, AgentTurn } from '../types.js';
import type { AgentTool } from '../tools.js';
import {
  analyticsSystemPrompt,
  buildAnalyticsAgentTools,
  emitProposalFromSuggestBlock,
} from '../analytics-tools.js';
import {
  anthropicMcpConfig,
  loadRemoteMcpServers,
  openAiMcpTools,
} from '../mcp-config.js';
import { getEffectiveProviderConfig } from '../../settings/provider-settings.js';
import { runGatedTool } from '@zlens/agent';

const MAX_TOOL_ITERATIONS = 16;

interface OpenAIResponseLike {
  id?: string;
  output?: Array<Record<string, unknown>>;
  output_text?: string;
}

interface AnthropicResponseLike {
  id?: string;
  content?: Array<Record<string, unknown>>;
  stop_reason?: string | null;
}

export const openAiSdkRunner: AgentRunner = {
  async run(req, emit, signal) {
    const config = getEffectiveProviderConfig(req.projectRoot, 'openai');
    if (!config.enabled) {
      emit({ kind: 'error', message: 'OpenAI is disabled in Settings.' });
      return;
    }
    if (!config.apiKey) {
      emit({ kind: 'error', message: 'OpenAI API key is missing. Configure OpenAI in Settings or set OPENAI_API_KEY.' });
      return;
    }
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    await runOpenAIResponsesAgent({
      client,
      model: config.model ?? 'gpt-5.5',
      req,
      emit,
      signal,
    });
  },
};

export const anthropicSdkRunner: AgentRunner = {
  async run(req, emit, signal) {
    const config = getEffectiveProviderConfig(req.projectRoot, 'anthropic');
    if (!config.enabled) {
      emit({ kind: 'error', message: 'Anthropic Claude is disabled in Settings.' });
      return;
    }
    if (!config.apiKey) {
      emit({ kind: 'error', message: 'Anthropic API key is missing. Configure Anthropic in Settings or set ANTHROPIC_API_KEY.' });
      return;
    }
    const client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: normalizeAnthropicBaseUrl(config.baseUrl) } : {}),
    });
    await runAnthropicMessagesAgent({
      client,
      model: config.model ?? 'claude-opus-4-8',
      req,
      emit,
      signal,
    });
  },
};

async function prepareNativeAgent(req: AgentRunRequest, emit: (turn: AgentTurn) => void): Promise<{
  ctx: DQLContext;
  tools: AgentTool[];
  system: string;
}> {
  const kgPath = defaultKgPath(req.projectRoot);
  if (!existsSync(kgPath)) {
    emit({ kind: 'thinking', text: 'Building the local agent knowledge graph from DQL, dbt, semantic, app, and notebook metadata.' });
  }
  await reindexProject(req.projectRoot, { kgPath });
  const ctx = new DQLContext({ projectRoot: req.projectRoot });
  return {
    ctx,
    tools: buildAnalyticsAgentTools(ctx, req),
    system: analyticsSystemPrompt(ctx, req),
  };
}

async function runOpenAIResponsesAgent(input: {
  client: OpenAI;
  model: string;
  req: AgentRunRequest;
  emit: (turn: AgentTurn) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { client, model, req, emit, signal } = input;
  const { tools, system } = await prepareNativeAgent(req, emit);
  const remoteMcp = loadRemoteMcpServers(req.projectRoot, 'openai');
  for (const warning of remoteMcp.warnings) emit({ kind: 'thinking', text: warning });
  if (remoteMcp.servers.length > 0) {
    emit({ kind: 'thinking', text: `OpenAI Responses SDK attached ${remoteMcp.servers.length} trusted MCP connector/server(s).` });
  }

  const sdkTools = [
    ...tools.filter((tool) => !tool.hidden).map(openAIFunctionTool),
    ...openAiMcpTools(remoteMcp.servers),
  ];
  let previousResponseId: string | undefined;
  let nextInput: unknown = openAIInputFromMessages(req.messages);

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    if (signal.aborted) {
      emit({ kind: 'error', message: 'Aborted by user.' });
      return;
    }

    const response = await client.responses.create({
      model,
      instructions: system,
      input: nextInput,
      tools: sdkTools,
      previous_response_id: previousResponseId,
      parallel_tool_calls: false,
      ...(req.reasoningEffort && supportsReasoningEffort('openai', model)
        ? { reasoning: { effort: req.reasoningEffort } }
        : {}),
    } as never, { signal } as never) as unknown as OpenAIResponseLike;

    emitOpenAIResponseItems(response, emit);
    const calls = openAIFunctionCalls(response);
    if (calls.length === 0) {
      const fallbackText = typeof response.output_text === 'string' ? response.output_text.trim() : '';
      if (fallbackText && !hasOpenAITextItem(response)) emit({ kind: 'text', text: fallbackText });
      emit({ kind: 'done', stopReason: 'stop' });
      return;
    }

    const outputs: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      const tool = tools.find((candidate) => candidate.name === call.name);
      const args = parseJsonObject(call.arguments);
      emit({ kind: 'tool_call', id: call.callId, name: call.name, input: args });
      let output: unknown;
      let isError = false;
      if (!tool) {
        output = { error: `Unknown ZLens tool: ${call.name}` };
        isError = true;
      } else {
        try {
          output = await runGatedTool(tool, args);
        } catch (error) {
          output = { error: error instanceof Error ? error.message : String(error) };
          isError = true;
        }
      }
      emit({ kind: 'tool_result', id: call.callId, output, isError });
      if (call.name === 'suggest_block') emitProposalFromSuggestBlock(args, output, emit);
      outputs.push({
        type: 'function_call_output',
        call_id: call.callId,
        output: JSON.stringify(output),
      });
    }

    previousResponseId = response.id;
    nextInput = outputs;
  }

  emit({ kind: 'error', message: `OpenAI SDK tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations.` });
}

async function runAnthropicMessagesAgent(input: {
  client: Anthropic;
  model: string;
  req: AgentRunRequest;
  emit: (turn: AgentTurn) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { client, model, req, emit, signal } = input;
  const { tools, system } = await prepareNativeAgent(req, emit);
  const remoteMcp = loadRemoteMcpServers(req.projectRoot, 'anthropic');
  for (const warning of remoteMcp.warnings) emit({ kind: 'thinking', text: warning });
  if (remoteMcp.servers.length > 0) {
    emit({ kind: 'thinking', text: `Anthropic SDK attached ${remoteMcp.servers.length} trusted MCP server(s).` });
  }
  const mcp = anthropicMcpConfig(remoteMcp.servers);
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = req.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const toolDefs = [
    ...tools.filter((tool) => !tool.hidden).map(anthropicClientTool),
    ...mcp.toolsets,
  ];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    if (signal.aborted) {
      emit({ kind: 'error', message: 'Aborted by user.' });
      return;
    }

    const params = {
      model,
      max_tokens: 8192,
      system,
      tools: toolDefs,
      messages,
      ...(req.reasoningEffort && supportsReasoningEffort('claude', model)
        ? { output_config: { effort: req.reasoningEffort } }
        : {}),
      ...(mcp.mcpServers.length > 0 ? { mcp_servers: mcp.mcpServers, betas: ['mcp-client-2025-11-20'] } : {}),
    };
    const api = mcp.mcpServers.length > 0
      ? (client.beta.messages as unknown as { create(params: unknown, options?: unknown): Promise<unknown> })
      : (client.messages as unknown as { create(params: unknown, options?: unknown): Promise<unknown> });
    const response = await api.create(params, { signal }) as AnthropicResponseLike;
    const blocks = Array.isArray(response.content) ? response.content : [];
    const toolUses = blocks.filter(isAnthropicToolUse);
    emitAnthropicBlocks(blocks, emit);
    messages.push({ role: 'assistant', content: blocks });

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      emit({ kind: 'done', stopReason: response.stop_reason ?? undefined });
      return;
    }

    const results: Array<Record<string, unknown>> = [];
    for (const call of toolUses) {
      const tool = tools.find((candidate) => candidate.name === call.name);
      const args = call.input && typeof call.input === 'object' ? call.input : {};
      let output: unknown;
      let isError = false;
      if (!tool) {
        output = { error: `Unknown ZLens tool: ${call.name}` };
        isError = true;
      } else {
        try {
          output = await runGatedTool(tool, args);
        } catch (error) {
          output = { error: error instanceof Error ? error.message : String(error) };
          isError = true;
        }
      }
      emit({ kind: 'tool_result', id: call.id, output, isError });
      if (call.name === 'suggest_block') emitProposalFromSuggestBlock(args, output, emit);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(output),
        is_error: isError,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  emit({ kind: 'error', message: `Anthropic SDK tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations.` });
}

function openAIFunctionTool(tool: AgentTool): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function anthropicClientTool(tool: AgentTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function openAIInputFromMessages(messages: AgentRunRequest['messages']): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function openAIFunctionCalls(response: OpenAIResponseLike): Array<{
  callId: string;
  name: string;
  arguments: string;
}> {
  const output = Array.isArray(response.output) ? response.output : [];
  return output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      callId: typeof item.call_id === 'string' ? item.call_id : String(item.id ?? item.name ?? 'function_call'),
      name: typeof item.name === 'string' ? item.name : '',
      arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
    }))
    .filter((call) => call.name);
}

function emitOpenAIResponseItems(response: OpenAIResponseLike, emit: (turn: AgentTurn) => void): void {
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    const type = typeof item.type === 'string' ? item.type : '';
    if (type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary.map((part) => textFromUnknown(part)).filter(Boolean).join('\n') : '';
      if (summary) emit({ kind: 'thinking', text: summary });
    } else if (type === 'message') {
      const text = openAIMessageText(item);
      if (text) emit({ kind: 'text', text });
    } else if (type.startsWith('mcp_')) {
      emit({ kind: 'tool_result', id: String(item.id ?? type), output: item });
    }
  }
}

function hasOpenAITextItem(response: OpenAIResponseLike): boolean {
  return (response.output ?? []).some((item) => item.type === 'message' && Boolean(openAIMessageText(item)));
}

function openAIMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.output_text === 'string') return record.output_text;
    return '';
  }).filter(Boolean).join('\n');
}

function isAnthropicToolUse(block: Record<string, unknown>): block is {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
} {
  return block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string';
}

function emitAnthropicBlocks(blocks: Array<Record<string, unknown>>, emit: (turn: AgentTurn) => void): void {
  for (const block of blocks) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      emit({ kind: 'thinking', text: block.thinking });
    } else if (block.type === 'text' && typeof block.text === 'string') {
      emit({ kind: 'text', text: block.text });
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      emit({ kind: 'tool_call', id: block.id, name: block.name, input: block.input ?? {} });
    } else if (typeof block.type === 'string' && block.type.includes('tool')) {
      emit({ kind: 'tool_result', id: String(block.id ?? block.type), output: block });
    }
  }
}

function parseJsonObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return typeof record.text === 'string' ? record.text : '';
  }
  return '';
}
