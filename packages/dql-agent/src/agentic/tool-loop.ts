/**
 * Transport-agnostic agentic tool loop.
 *
 * Stage B of the answer pipeline is a SINGLE tool-driven generation call: one
 * capable model decides its own retrieval sequence (search blocks → semantic
 * layer → schema → compile/validate → run) instead of walking a fixed tier
 * cascade. This module runs that loop over ANY provider:
 *
 *   - Providers with native tool use (`generateWithTools`: Claude/OpenAI APIs)
 *     drive the loop through the provider's own tool protocol.
 *   - Providers with only `generate` (subscription CLI passthrough, Ollama, …)
 *     drive an equivalent loop over a TEXT protocol: the model emits one fenced
 *     JSON tool call per turn, the host executes it and appends the observation,
 *     then re-invokes. A malformed / absent tool call is treated as the final
 *     answer, so a weak-tool-calling model degrades to "answer from context now"
 *     rather than dead-ending.
 *
 * Governance is NOT enforced here — it lives in the tool backends (the semantic
 * compiler owns semantic SQL, certified execution keeps its grain gate, run_sql
 * is read-only). This module only orchestrates the conversation.
 */

import type {
  AgentMessage,
  AgentProvider,
  AgentToolDefinition,
  NativeToolLoopStop,
  ProviderCurrentToolPolicy,
  ProviderToolLoopOptions,
} from '../providers/types.js';
import { assertProviderPayloadAllowed, boundProviderResultRows } from '../provider-egress.js';
import { runGatedTool } from './tool-gate.js';
import { readEnv } from '@zlens/core';

export interface AgenticToolLoopOptions extends ProviderToolLoopOptions {
  /**
   * Extra system guidance appended before the tool contract (e.g. "prefer
   * semantic compile before deep warehouse search"). Applies to both transports.
   */
  toolPolicy?: string;
  /**
   * Replace the text-protocol response contract for a lane whose legal
   * responses differ from the default.
   *
   * The default contract offers the model two shapes: a tool call, or a final
   * answer carrying raw SQL. In a lane where the host owns execution, that
   * second shape is not merely unnecessary — it is unrepresentable: it has no
   * `tool` key, so it does not parse as a tool call, and the loop can only
   * read it as prose. A model that follows the instructions it was given then
   * fails the turn. A lane whose tools own the terminal must be able to say so.
   */
  textToolContract?: (tools: readonly AgentToolDefinition[], maxToolCalls: number) => string;
}

/**
 * Run the agentic tool loop and return the model's final assistant text. Tool
 * observations are surfaced through `options.onToolCall` (same contract the native
 * providers already use), so callers can record evidence regardless of transport.
 */
export async function runAgenticToolLoop(
  provider: AgentProvider,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  options: AgenticToolLoopOptions = {},
): Promise<string> {
  return (await runAgenticToolLoopDetailed(provider, messages, tools, options)).text;
}

/**
 * Run the agentic loop while retaining its terminal reason for internal
 * callers. The public `runAgenticToolLoop` compatibility API remains a string,
 * but an analytical caller must not mistake a budget-stopped tool request for
 * final SQL.
 */
export async function runAgenticToolLoopDetailed(
  provider: AgentProvider,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  options: AgenticToolLoopOptions = {},
): Promise<TextToolLoopResult> {
  const resultRowBudgetUsage = new Map<string, number>();
  const usable = tools
    .filter((tool) => tool.name && tool.description)
    .map((tool) => guardToolOutput(tool, options, resultRowBudgetUsage));
  const initialToolPolicy = renderCurrentToolPolicy(options, usable);
  const policyMessages: AgentMessage[] = [
    ...(options.toolPolicy ? [{ role: 'system' as const, content: options.toolPolicy }] : []),
    ...(initialToolPolicy ? [{ role: 'system' as const, content: initialToolPolicy }] : []),
  ];

  if (usable.length === 0) {
    try {
      return { text: await provider.generate([...messages, ...policyMessages], options), stop: 'final', toolCalls: 0 };
    } catch (error) {
      const terminal = providerDispatchTerminal(error);
      if (terminal) return terminal;
      throw error;
    }
  }

  // Native tool use owns its own loop; hand it the same policy + tools.
  if (provider.generateWithTools) {
    try {
      const native = await provider.generateWithTools([...messages, ...policyMessages], usable, options);
      if (isNativeToolLoopStop(native)) {
        return {
          text: native.text,
          stop: native.kind,
          toolCalls: native.toolCalls,
        };
      }
      return {
        text: native,
        stop: 'final',
        toolCalls: 0,
      };
    } catch (error) {
      const terminal = providerDispatchTerminal(error);
      if (terminal) return terminal;
      throw error;
    }
  }

  return runTextProtocolToolLoopDetailed(provider, [...messages, ...policyMessages], usable, options);
}

function isNativeToolLoopStop(value: unknown): value is NativeToolLoopStop {
  return Boolean(value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { version?: unknown }).version === 1
    && ((value as { kind?: unknown }).kind === 'tool_budget_exhausted'
      || (value as { kind?: unknown }).kind === 'provider_dispatch_budget_exhausted'
      || (value as { kind?: unknown }).kind === 'invalid_tool_response'
      || (value as { kind?: unknown }).kind === 'run_soft_target_exceeded'
      || (value as { kind?: unknown }).kind === 'run_deadline_insufficient')
    && typeof (value as { text?: unknown }).text === 'string'
    && typeof (value as { toolCalls?: unknown }).toolCalls === 'number');
}

/**
 * Internal terminal state for the text transport.
 *
 * The public compatibility API above intentionally remains `Promise<string>`:
 * callers outside the analyst lane use it as a normal completion helper.  The
 * text transport itself must not, however, confuse "the model asked for a
 * tool after its budget" with a normal final answer.  Keeping that distinction
 * here makes a caller able to turn it into a typed, non-executing outcome.
 */
export interface TextToolLoopResult {
  text: string;
  stop: 'final'
    | 'tool_budget_exhausted'
    | 'provider_dispatch_budget_exhausted'
    | 'invalid_tool_response'
    | 'run_soft_target_exceeded'
    | 'run_deadline_insufficient';
  toolCalls: number;
}

/**
 * Widen a policy's name set with the hidden tools that alias an admitted
 * advertised tool. The model is never shown a hidden name, but a transcript,
 * a cassette, or the host itself may still call one, and it is admitted
 * exactly when the tool it stands behind is.
 */
export function admittedToolNames(
  names: readonly string[],
  tools: readonly AgentToolDefinition[],
): Set<string> {
  const available = new Set(tools.map((tool) => tool.name));
  const admitted = new Set(names.filter((name) => available.has(name)));
  for (const tool of tools) {
    if (tool.hidden && tool.aliasOf && admitted.has(tool.aliasOf)) admitted.add(tool.name);
  }
  return admitted;
}

/** The tools a model may be shown: everything not marked hidden. */
export function advertisedTools(tools: readonly AgentToolDefinition[]): AgentToolDefinition[] {
  return tools.filter((tool) => !tool.hidden);
}

function currentToolPolicy(
  options: ProviderToolLoopOptions,
  tools: readonly AgentToolDefinition[],
): { policy?: ProviderCurrentToolPolicy; allowedToolNames: Set<string>; terminalActionToolNames: Set<string> } {
  const policy = options.getCurrentToolPolicy?.();
  const allowedToolNames = admittedToolNames(policy?.allowedToolNames ?? tools.map((tool) => tool.name), tools);
  const terminalActionToolNames = new Set(
    [...admittedToolNames(policy?.terminalActionToolNames ?? [], tools)]
      .filter((name) => allowedToolNames.has(name)),
  );
  return { policy, allowedToolNames, terminalActionToolNames };
}

function visibleNames(names: Iterable<string>, tools: readonly AgentToolDefinition[]): string[] {
  const hidden = new Set(tools.filter((tool) => tool.hidden).map((tool) => tool.name));
  return [...names].filter((name) => !hidden.has(name));
}

/**
 * Keep the text protocol honest about the same narrowing that native
 * transports receive in their next API `tools` declaration.  This is a safe
 * controller instruction, never hidden reasoning or mutable business context.
 */
function renderCurrentToolPolicy(
  options: ProviderToolLoopOptions,
  tools: readonly AgentToolDefinition[],
): string | undefined {
  const { policy, allowedToolNames, terminalActionToolNames } = currentToolPolicy(options, tools);
  if (!policy) return undefined;
  // Only advertised names reach the model; a hidden alias is admitted, not
  // announced.
  const visible = advertisedTools(tools);
  const visibleNames = new Set(visible.map((tool) => tool.name));
  const allowed = [...allowedToolNames].filter((name) => visibleNames.has(name));
  const terminal = [...terminalActionToolNames].filter((name) => visibleNames.has(name));
  const instruction = policy.instruction?.trim();
  // Re-state the SIGNATURES of the tools still on the table, not just their
  // names. The response contract is sent once, at the start, listing every
  // tool; a model reading it later has no way to tell that the host has since
  // narrowed the set, so it keeps proposing a tool that can only be refused —
  // and each refusal costs a dispatch until the turn dies with nothing run.
  // Naming the remaining options in full makes the next legal move the
  // easiest one to make.
  const allowedSignatures = allowed.length && allowed.length < visible.length
    ? visible
      .filter((tool) => allowedToolNames.has(tool.name))
      .map((tool) => {
        const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
        return `- ${tool.name}(${props ? Object.keys(props).join(', ') : ''}): ${tool.description}`;
      })
    : [];
  return [
    `Runtime tool availability update. You may call only: ${allowed.length ? allowed.join(', ') : 'no tools'}.`,
    terminal.length ? `If this is the final controller turn, use only: ${terminal.join(', ')}.` : undefined,
    instruction,
    allowedSignatures.length ? `\nStill available to you:\n${allowedSignatures.join('\n')}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(' ');
}

function providerDispatchTerminal(error: unknown): TextToolLoopResult | undefined {
  const code = toolLoopErrorCode(error);
  if (code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED') {
    return { text: '', stop: 'provider_dispatch_budget_exhausted', toolCalls: 0 };
  }
  if (code === 'RUN_SOFT_TARGET_EXCEEDED') {
    return { text: '', stop: 'run_soft_target_exceeded', toolCalls: 0 };
  }
  if (code === 'RUN_DEADLINE_INSUFFICIENT') {
    return { text: '', stop: 'run_deadline_insufficient', toolCalls: 0 };
  }
  return undefined;
}

function toolLoopErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' ? code : undefined;
}

function guardToolOutput(
  tool: AgentToolDefinition,
  options: AgenticToolLoopOptions,
  resultRowBudgetUsage: Map<string, number>,
): AgentToolDefinition {
  const policy = options.providerPayloadGuard;
  if (!policy) return tool;
  return {
    ...tool,
    run: async (args) => {
      const output = await runGatedTool(tool, args);
      const maxResultRows = policy.allowedResultRowTools?.[tool.name] ?? 0;
      const budgetGroup = policy.resultRowBudgetGroupByTool?.[tool.name] ?? tool.name;
      const cumulativeLimit = policy.cumulativeResultRowBudgets?.[budgetGroup] ?? maxResultRows;
      const alreadyUsed = resultRowBudgetUsage.get(budgetGroup) ?? 0;
      const bounded = boundProviderResultRows(
        output,
        Math.max(0, cumulativeLimit - alreadyUsed),
        policy.maxResultColumns,
        policy.maxResultCells,
      );
      const shape = assertProviderPayloadAllowed(bounded.value, {
        allowResultRows: maxResultRows > 0,
        maxResultRows: Math.max(0, cumulativeLimit - alreadyUsed),
        ...(typeof policy.maxResultColumns === 'number' ? { maxResultColumns: policy.maxResultColumns } : {}),
        ...(typeof policy.maxResultCells === 'number' ? { maxResultCells: policy.maxResultCells } : {}),
        purpose: policy.purpose,
      });
      const cumulativeResultRowCount = alreadyUsed + shape.resultRowCount;
      resultRowBudgetUsage.set(budgetGroup, cumulativeResultRowCount);
      policy.onPayload?.({
        toolName: tool.name,
        output: bounded.value,
        ...shape,
        cumulativeResultRowCount,
        budgetGroup,
        budgetExhausted: bounded.exhausted || cumulativeResultRowCount >= cumulativeLimit,
      });
      return bounded.value;
    },
  };
}

/**
 * Text-only providers do not have a server-side tool protocol, so DQL drives a
 * real bounded conversation: model -> one tool -> observation -> model.  One
 * physical dispatch is always reserved for a final answer.  This mirrors native
 * tool use and prevents the old one-tool implementation from collecting schema
 * evidence and then forcing a premature, SQL-less completion.
 */
export async function runTextProtocolToolLoopDetailed(
  provider: AgentProvider,
  baseMessages: AgentMessage[],
  tools: AgentToolDefinition[],
  options: AgenticToolLoopOptions,
): Promise<TextToolLoopResult> {
  const maxToolCalls = Math.max(0, Math.min(30, options.maxToolCalls ?? 8));
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  // Preserve the complete transport contract across both text-protocol turns.
  // Reconstructing a small options subset silently dropped the physical-send
  // observer, dispatch cap, redaction guard, and egress accounting for CLI and
  // Ollama providers.
  // A tool turn without a following answer is not useful.  When callers do
  // not set a dispatch cap, make room for every permitted tool plus the final
  // composition turn.  When they do set one, reserve its last slot for that
  // composition instead of silently spending it on another observation.
  const dispatchLimit = Math.max(1, Math.min(30, options.maxProviderDispatches ?? (maxToolCalls + 1)));
  const effectiveToolBudget = Math.min(maxToolCalls, Math.max(0, dispatchLimit - 1));
  // `onProviderDispatch` is an optional transport callback. Subscription and
  // test providers can legitimately be callback-silent, so it cannot be the
  // source of truth for whether this is the first model turn or a tool
  // follow-up. Keep a local invocation count for the text protocol itself;
  // the server-side wrapper remains the authority for physical admission and
  // the hard send cap.
  let providerTurns = 0;
  let physicalDispatches = 0;
  const outerObserver = options.onProviderDispatch;
  const runOptions: ProviderToolLoopOptions = {
    ...options,
    onProviderDispatch: (event) => {
      physicalDispatches += 1;
      if (physicalDispatches > dispatchLimit) {
        throw Object.assign(new Error(
          `Provider dispatch budget exhausted after ${dispatchLimit} physical attempt${dispatchLimit === 1 ? '' : 's'}.`,
        ), { code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' });
      }
      return outerObserver?.(event) ?? event.envelope;
    },
  };

  const messages: AgentMessage[] = [
    ...baseMessages,
    // Tell the model the *effective* ceiling, not a larger policy cap that
    // cannot physically leave room for its final response.
    { role: 'system', content: (options.textToolContract ?? buildTextToolContract)(advertisedTools(tools), effectiveToolBudget) },
  ];
  const initialPolicy = renderCurrentToolPolicy(options, tools);
  if (initialPolicy) messages.push({ role: 'system', content: initialPolicy });

  let lastText = '';
  let toolCalls = 0;
  let requiredActionSignature = '';
  let requiredActionProseRetries = 0;
  // Only canonical V2 lanes with a real host finish control need to reserve a
  // physical send after execution. Generic tool users retain their historical
  // final-action behavior at the cap.
  const requiresPostExecutionFinish = Boolean(options.getCurrentToolPolicy)
    && tools.some((tool) => tool.name === 'finish_answer');
  while (true) {
    // Keep the physical Ask V2 budget meaningful.  With the standard six
    // sends, the fifth send may be the controller-selected execution action
    // and the sixth is reserved for the host-required finish/narration
    // control.  This is a transport constraint only: the kernel still gives
    // the model the candidate-bound execution choices.
    const livePolicyBeforeDispatch = currentToolPolicy(options, tools);
    const nextRequiredActionSignature = [...livePolicyBeforeDispatch.terminalActionToolNames].sort().join('|');
    if (nextRequiredActionSignature !== requiredActionSignature) {
      requiredActionSignature = nextRequiredActionSignature;
      requiredActionProseRetries = 0;
    }
      // A required `finish_answer` is not always narration. The kernel also
    // requires it to CLOSE a turn that never executed — a declined tier, an
    // exhausted ladder — and the host's egress guard rejects a narration
    // dispatch that carries no validated result. Labelling that close
    // "narration" turned an orderly refusal into a hard provider failure, so
    // when the host installs a phase resolver, it decides.
    const hostDispatchPhase = options.resolvePhysicalDispatchPhase?.({ operation: 'generate', attemptIndex: 1 });
    const narrationControlRound = livePolicyBeforeDispatch.terminalActionToolNames.has('finish_answer')
      && (!options.resolvePhysicalDispatchPhase || hostDispatchPhase === 'narration');
    // Only an execution action needs a second, post-result finish/narration
    // send. A host-issued clarification is itself the terminal control, so
    // reserving a phantom narration slot would prematurely reject a malformed
    // clarification instead of returning its typed observation to the model.
    const terminalExecutionAction = [...livePolicyBeforeDispatch.terminalActionToolNames]
      .some((name) => !isAskV2TerminalControlTool(name));
    const reservePostExecutionNarration = requiresPostExecutionFinish && terminalExecutionAction;
    const finalExecutionActionRound = !narrationControlRound
      && livePolicyBeforeDispatch.terminalActionToolNames.size > 0
      && providerTurns >= Math.max(0, dispatchLimit - (reservePostExecutionNarration ? 2 : 1));
    const terminalActionRound = livePolicyBeforeDispatch.terminalActionToolNames.size > 0
      && (narrationControlRound
        ? providerTurns >= Math.max(0, dispatchLimit - 1)
        : finalExecutionActionRound);
    if (terminalActionRound) {
      messages.push({
        role: 'system',
        content: `Final controller action for this phase. Call exactly one of: ${visibleNames(livePolicyBeforeDispatch.terminalActionToolNames, tools).join(', ')}. Do not inspect more context or answer in prose.`,
      });
    }
    let text: string;
    try {
      // Authoritative Ask V2 labels its first model-controlled transport
      // separately from later tool-follow-up transports.  This is only a
      // server-owned accounting detail: it does not grant a different tool,
      // route, or egress policy.  Keeping it here makes text-only providers
      // truthful in the same way native multi-tool providers are.
      // Once an execution has completed, the only remaining controller action
      // is host-local finish_answer.  Account the request for that action from
      // the narration allowance instead of treating it as more discovery.
      const dispatchOptions = providerTurns > 0 && runOptions.dispatchPhase === 'agent_control'
        ? {
          ...runOptions,
          dispatchPhase: narrationControlRound
            ? 'narration' as const
            : 'tool_followup' as const,
        }
        : runOptions;
      providerTurns += 1;
      text = await provider.generate(messages, dispatchOptions);
    } catch (error: unknown) {
      const terminal = providerDispatchTerminal(error);
      if (terminal) return { ...terminal, text: lastText, toolCalls };
      throw error;
    }
    const requestedCall = parseTextToolCall(text);
    if (!requestedCall) {
      if (readEnv('ZLENS_DEBUG_TOOL_LOOP')) console.error('[tool-loop unparsed]', JSON.stringify(text.slice(0, 400)));
      const policy = livePolicyBeforeDispatch;
      const adopted = await adoptProseAsFinishNarration(options, tools, policy, text);
      if (adopted) {
        toolCalls += 1;
        return { text, stop: 'final', toolCalls };
      }
      // A live V2 policy can require one concrete next action. A prose reply
      // at this point is neither a valid answer nor a safe terminal: discard
      // it and spend the next admissible controller send on the host-approved
      // action only. This prevents a model from escaping the semantic/DQL/SQL
      // boundary just by answering in prose after an inspection.
      if (policy.terminalActionToolNames.size > 0) {
        // One constrained retry is enough to distinguish a transient
        // text-protocol miss from a provider that cannot honor a required
        // host action. Do not burn the remaining Ask budget on repeated
        // prose, and do not mislabel that transport fault as missing context.
        // If the admitted physical send was already the last one, there is
        // no constrained retry to attempt. Preserve the distinct transport
        // boundary: a post-result narration can then retain deterministic
        // facts, while a pre-freeze controller is told precisely that its
        // dispatch reserve is exhausted. `invalid_tool_response` means the
        // provider ignored the same narrowed action *twice*.
        if (providerTurns >= dispatchLimit) {
          return { text: '', stop: 'provider_dispatch_budget_exhausted', toolCalls };
        }
        if (requiredActionProseRetries >= 1) {
          return { text: '', stop: 'invalid_tool_response', toolCalls };
        }
        requiredActionProseRetries += 1;
        messages.push({
          role: 'user',
          content: `Controller progression required. Discard the prior prose and call exactly one of: ${visibleNames(policy.terminalActionToolNames, tools).join(', ')}. Do not answer in prose.`,
        });
        continue;
      }
      if (text.trim()) lastText = text;
      return { text: text || lastText, stop: 'final', toolCalls };
    }
    if (text.trim()) lastText = text;
    // A tool-shaped reply is not a final answer merely because the host has no
    // dispatch left for another observation. Keep this typed distinction so a
    // caller cannot mistake it for executable SQL or prose.
    // Ask V2 has two host-owned terminal controls.  They may use the reserved
    // final dispatch only when the tool backend confirms the terminal result.
    // A model can still propose either control too early; that rejected
    // proposal is a normal pre-freeze observation which must reach the next
    // controller turn rather than ending the loop as if an answer existed.
    const isTerminalControlCall = isAskV2TerminalControlTool(requestedCall.name);
    const responsePolicy = livePolicyBeforeDispatch;
    if (terminalActionRound && !responsePolicy.terminalActionToolNames.has(requestedCall.name)) {
      // The narrowed final-action send is not another discovery opportunity.
      // Do not execute an out-of-policy request or spend the narration reserve
      // trying to repair it. The lane projects this exact stop as
      // provider/dispatch_budget rather than a metadata gap.
      return { text: '', stop: 'provider_dispatch_budget_exhausted', toolCalls };
    }
    if (toolCalls >= effectiveToolBudget && !isTerminalControlCall) {
      return { text: text || lastText, stop: 'tool_budget_exhausted', toolCalls };
    }
    const call = requestedCall;

    const tool = toolMap.get(call.name);
    let output: unknown;
    let isError = false;
    let deadlineStop: TextToolLoopResult | undefined;
    const startedAt = Date.now();
    if (!tool) {
      output = { error: `Unknown tool: ${call.name}. Available: ${advertisedTools(tools).map((t) => t.name).join(', ')}` };
      isError = true;
    } else {
      try {
        assertMayStartToolCall(options, call.name);
        output = await runGatedTool(tool, call.input ?? {});
      } catch (err) {
        const code = toolLoopErrorCode(err);
        output = {
          error: err instanceof Error ? err.message : String(err),
          ...(code ? { code } : {}),
        };
        isError = true;
        deadlineStop = providerDispatchTerminal(err);
      }
    }
    toolCalls += 1;
    // Tool-call observers are diagnostics only. In particular, Ask V2 records
    // a terminal `finish_answer` through this callback; an observer bug must
    // never turn an already-authorized execution into a second provider turn
    // (or overwrite it as a planner/budget failure).
    notifyToolCall(options, { name: call.name, input: call.input, output, isError, durationMs: Date.now() - startedAt });
    if (deadlineStop) return { ...deadlineStop, text: lastText, toolCalls };
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: renderObservation(call.name, output) });
    const progressInstruction = renderCurrentToolPolicy(options, tools);
    // A per-turn availability update belongs WHERE IT HAPPENED. Claude-family
    // transports flatten every system message into one system prompt, so
    // pushing these as `system` collected all of them, out of order, ahead of
    // the conversation — the model could not tell which update was current and
    // kept proposing tools that had already been withdrawn. As a user-role
    // controller message it stays attached to the observation it follows, for
    // every transport.
    if (progressInstruction) messages.push({ role: 'user', content: progressInstruction });

    // A *completed* terminal host control carries its final answer or stable
    // clarification in the tool result.  Do not spend another provider send
    // to ask the model to repeat it.  Crucially, a denied/ineligible terminal
    // proposal does not have this marker: its safe-next-tool observation is
    // fed into the next controller dispatch below.
    if (isTerminalControlCall && !isError && isCompletedAskV2TerminalControlOutput(output)) {
      return { text, stop: 'final', toolCalls };
    }

    // An execution action at the final tool-followup slot must leave the next
    // physical send for `finish_answer`. A failed/ineligible final action has
    // no safe room for a second discovery attempt, so preserve the precise
    // dispatch-budget boundary rather than emitting a misleading coverage
    // terminal. A completed execution loops once more for host narration.
    if (terminalActionRound) {
      const nowRequiresNarration = currentToolPolicy(options, tools).terminalActionToolNames.has('finish_answer');
      if (isError || (isTerminalControlCall && !isCompletedAskV2TerminalControlOutput(output))) {
        return { text, stop: 'provider_dispatch_budget_exhausted', toolCalls };
      }
      if (nowRequiresNarration) {
        // The execution is validated and the next loop iteration emits the
        // sixth, narration-phase physical send with only finish_answer exposed.
        continue;
      }
      if (!reservePostExecutionNarration) return { text, stop: 'final', toolCalls };
      return { text, stop: 'provider_dispatch_budget_exhausted', toolCalls };
    }

    if (toolCalls >= effectiveToolBudget) {
      const policy = currentToolPolicy(options, tools);
      // A bounded Ask controller may reserve the last physical send for one
      // terminal *action* (for example, semantic compilation) rather than
      // prose. This remains model-controlled: the host only narrows the
      // tool set after prior observations make repeated discovery unsafe or
      // wasteful. Other tools cannot use this reserve.
      if (policy.terminalActionToolNames.size > 0) {
        messages.push({
          role: 'user',
          content: `Final controller action turn. Call exactly one of: ${visibleNames(policy.terminalActionToolNames, tools).join(', ')}. Do not inspect more context or write a prose answer.`,
        });
        const finalDispatchOptions = providerTurns > 0 && runOptions.dispatchPhase === 'agent_control'
          ? {
            ...runOptions,
            dispatchPhase: policy.terminalActionToolNames.has('finish_answer')
              && (!options.resolvePhysicalDispatchPhase
                || options.resolvePhysicalDispatchPhase({ operation: 'generate', attemptIndex: 1 }) === 'narration')
              ? 'narration' as const
              : 'tool_followup' as const,
          }
          : runOptions;
        providerTurns += 1;
        let finalText: string;
        try {
          finalText = await provider.generate(messages, finalDispatchOptions);
        } catch (error) {
          const terminal = providerDispatchTerminal(error);
          if (terminal) return { ...terminal, text: lastText, toolCalls };
          throw error;
        }
        if (!finalText.trim()) {
          return { text: lastText, stop: 'provider_dispatch_budget_exhausted', toolCalls };
        }
        const terminalCall = parseTextToolCall(finalText);
        if (!terminalCall || !policy.terminalActionToolNames.has(terminalCall.name)) {
          return {
            text: '',
            stop: terminalCall ? 'tool_budget_exhausted' : 'provider_dispatch_budget_exhausted',
            toolCalls,
          };
        }
        const terminalTool = toolMap.get(terminalCall.name);
        let terminalOutput: unknown;
        let terminalError = false;
        let terminalDeadlineStop: TextToolLoopResult | undefined;
        const terminalStartedAt = Date.now();
        if (!terminalTool) {
          terminalOutput = { error: `Unknown terminal tool: ${terminalCall.name}` };
          terminalError = true;
        } else {
          try {
            assertMayStartToolCall(options, terminalCall.name);
            terminalOutput = await runGatedTool(terminalTool, terminalCall.input ?? {});
          } catch (err) {
            const code = toolLoopErrorCode(err);
            terminalOutput = {
              error: err instanceof Error ? err.message : String(err),
              ...(code ? { code } : {}),
            };
            terminalError = true;
            terminalDeadlineStop = providerDispatchTerminal(err);
          }
        }
        toolCalls += 1;
        notifyToolCall(options, {
          name: terminalCall.name,
          input: terminalCall.input,
          output: terminalOutput,
          isError: terminalError,
          durationMs: Date.now() - terminalStartedAt,
        });
        if (terminalDeadlineStop) return { ...terminalDeadlineStop, text: lastText, toolCalls };
        return {
          text: finalText,
          stop: terminalError || (isAskV2TerminalControlTool(terminalCall.name)
            && !isCompletedAskV2TerminalControlOutput(terminalOutput))
            ? 'tool_budget_exhausted'
            : 'final',
          toolCalls,
        };
      }
      messages.push({
        role: 'user',
        content: 'Tool budget reached — do not call any more tools. Answer now using only the tool results above, as a single ```json fenced object with summary, sql, viz, outputs.',
      });
      // The next iteration is the reserved final dispatch.  If the model
      // nevertheless emits a tool shape, `call` is deliberately disabled and
      // the caller receives that text as a typed terminal, not an execution.
      const finalPolicy = currentToolPolicy(options, tools);
      const finalDispatchOptions = providerTurns > 0 && runOptions.dispatchPhase === 'agent_control'
        ? {
          ...runOptions,
          dispatchPhase: finalPolicy.terminalActionToolNames.has('finish_answer')
            ? 'narration' as const
            : 'tool_followup' as const,
        }
        : runOptions;
      providerTurns += 1;
      let finalText: string;
      try {
        finalText = await provider.generate(messages, finalDispatchOptions);
      } catch (error) {
        const terminal = providerDispatchTerminal(error);
        if (terminal) return { ...terminal, text: lastText, toolCalls };
        throw error;
      }
      if (!finalText.trim()) {
        return {
          text: lastText,
          stop: 'provider_dispatch_budget_exhausted',
          toolCalls,
        };
      }
      const terminalCall = parseTextToolCall(finalText);
      // The reserved composition dispatch may legally be an Ask V2 terminal
      // control. Execute it locally only when it reports a completed terminal
      // outcome. A premature/denied finish or clarification has consumed the
      // final physical send, so preserve the precise budget stop rather than
      // pretending that it produced a final answer.
      if (terminalCall && isAskV2TerminalControlTool(terminalCall.name)) {
        const terminalTool = toolMap.get(terminalCall.name);
        let terminalOutput: unknown;
        let terminalError = false;
        let terminalDeadlineStop: TextToolLoopResult | undefined;
        const terminalStartedAt = Date.now();
        if (!terminalTool) {
          terminalOutput = { error: 'Unknown tool: finish_answer' };
          terminalError = true;
        } else {
          try {
            assertMayStartToolCall(options, terminalCall.name);
            terminalOutput = await runGatedTool(terminalTool, terminalCall.input ?? {});
          } catch (err) {
            const code = toolLoopErrorCode(err);
            terminalOutput = {
              error: err instanceof Error ? err.message : String(err),
              ...(code ? { code } : {}),
            };
            terminalError = true;
            terminalDeadlineStop = providerDispatchTerminal(err);
          }
        }
        toolCalls += 1;
        notifyToolCall(options, {
          name: terminalCall.name,
          input: terminalCall.input,
          output: terminalOutput,
          isError: terminalError,
          durationMs: Date.now() - terminalStartedAt,
        });
        if (terminalDeadlineStop) return { ...terminalDeadlineStop, text: lastText, toolCalls };
        return {
          text: finalText,
          stop: terminalError || !isCompletedAskV2TerminalControlOutput(terminalOutput)
            ? 'tool_budget_exhausted'
            : 'final',
          toolCalls,
        };
      }
      return {
        text: finalText,
        stop: terminalCall ? 'tool_budget_exhausted' : 'final',
        toolCalls,
      };
    }
  }
}

/**
 * Only explicit Ask V2 controls can terminate a transport early. Execution
 * and retrieval tools may return useful `{ finished: true }`-shaped payloads
 * for their own protocols, but they do not own final answer authority.
 */
export function isAskV2TerminalControlTool(name: string): boolean {
  return name === 'finish_answer' || name === 'request_clarification';
}

/**
 * A prose reply in the narration phase IS the narration.
 *
 * After the host has validated an execution result, the only remaining
 * controller action is `finish_answer`, whose single argument is the answer
 * text. Every transport used to discard a model that simply wrote that text
 * instead of wrapping it in a tool call, then spent one more physical send
 * asking for the same words in the right envelope — a dispatch that bought
 * nothing, because the host composes the route, the trust label, and the
 * facts itself and only ever takes the sentences from the model. So when the
 * host says this send is the narration phase (a validated result is held and
 * `finish_answer` is the one admissible action), the prose is handed to the
 * host's own finish control. Nothing about authority moves: the finish tool
 * still runs through the kernel, still records ASK_V2_RESULT_NARRATED, and a
 * turn that never executed is not in the narration phase and is not adopted.
 *
 * Returns the finish tool's completed output, or undefined when the prose
 * cannot be adopted and the caller's ordinary rejection applies.
 */
export async function adoptProseAsFinishNarration(
  options: ProviderToolLoopOptions,
  tools: readonly AgentToolDefinition[],
  policy: { allowedToolNames: Set<string>; terminalActionToolNames: Set<string> },
  text: string,
): Promise<unknown | undefined> {
  const narration = text.trim();
  if (!narration) return undefined;
  if (policy.terminalActionToolNames.size !== 1 || !policy.terminalActionToolNames.has('finish_answer')) return undefined;
  if (policy.allowedToolNames.size !== 1 || !policy.allowedToolNames.has('finish_answer')) return undefined;
  // The host decides whether a validated result exists. Without a resolver
  // the transport cannot tell a post-result finish from a ladder close, and
  // a ladder close must not adopt prose as if it were an answer.
  if (!options.resolvePhysicalDispatchPhase) return undefined;
  if (options.resolvePhysicalDispatchPhase({ operation: 'generate', attemptIndex: 1 }) !== 'narration') return undefined;
  const finish = tools.find((tool) => tool.name === 'finish_answer');
  if (!finish) return undefined;
  const input = { answer: narration.slice(0, 8000) };
  const startedAt = Date.now();
  let output: unknown;
  let isError = false;
  try {
    output = await runGatedTool(finish, input);
  } catch (error) {
    output = { error: error instanceof Error ? error.message : String(error) };
    isError = true;
  }
  notifyToolCall(options, { name: 'finish_answer', input, output, isError, durationMs: Date.now() - startedAt });
  return !isError && isCompletedAskV2TerminalControlOutput(output) ? output : undefined;
}

function isCompletedAskV2TerminalControlOutput(value: unknown): boolean {
  return Boolean(value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { finished?: unknown }).finished === true);
}

function assertMayStartToolCall(options: ProviderToolLoopOptions, toolName?: string): void {
  // finish_answer is a host-local terminal control following an already
  // admitted provider response. It cannot start discovery or a warehouse
  // operation, so the final control itself may consume the narration reserve.
  if (toolName === 'finish_answer') return;
  if (options.mayStartToolCall?.() === false) {
    throw Object.assign(new Error('The run soft target elapsed before this tool branch could start.'), {
      code: 'RUN_SOFT_TARGET_EXCEEDED',
    });
  }
}

/**
 * Observability must be fail-open with respect to the bounded tool runtime.
 * Provider/tool callbacks are outside the execution authority and cannot be
 * allowed to reopen a finished response or alter its terminal result.
 */
function notifyToolCall(
  options: ProviderToolLoopOptions,
  event: { name: string; input: unknown; output: unknown; isError: boolean; durationMs: number },
): void {
  try {
    options.onToolCall?.(event);
  } catch {
    // Receipt recording has its own error handling at the host boundary. The
    // transport still has a valid, typed tool outcome to return to the caller.
  }
}

interface TextToolCall {
  name: string;
  input?: Record<string, unknown>;
}

/**
 * Parse a text-protocol tool call. A tool call is a JSON object with a `tool`
 * (string) field, optionally in a ```json fence. Anything else — prose, or a JSON
 * object WITHOUT `tool` (i.e. a final `{summary, sql, ...}` answer) — returns
 * undefined so the caller treats the response as the final answer.
 */
export function parseTextToolCall(raw: string): TextToolCall | undefined {
  for (const candidate of jsonCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const name = typeof record.tool === 'string' ? record.tool
      : typeof record.tool_name === 'string' ? record.tool_name
      : typeof record.name === 'string' && ('input' in record || 'arguments' in record || 'args' in record) ? record.name
      : undefined;
    if (!name) continue;
    const rawInput = record.input ?? record.arguments ?? record.args ?? record.parameters;
    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined;
    return { name, input };
  }
  return undefined;
}

/** Candidate JSON strings from a model response: fenced blocks first, then a bare object. */
function jsonCandidates(raw: string): string[] {
  const out: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of raw.matchAll(fenceRe)) {
    const body = match[1]?.trim();
    if (body) out.push(body);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) out.push(trimmed);
  // A bare object embedded in prose (first { … last }).
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) out.push(raw.slice(first, last + 1));
  return out;
}

/**
 * How much of a tool observation reaches the model.
 *
 * A hard slice through JSON is the worst possible bound: it cuts mid-token,
 * breaks the structure, and silently drops whatever sorted last — which, for a
 * card inspection, is the tail of the very identifier list the model is
 * required to quote verbatim. Discovery results therefore get a larger budget
 * and, when they still exceed it, are shrunk FIELD BY FIELD (prose first,
 * identifiers last) so the result stays valid JSON and keeps the part that
 * matters.
 */
const OBSERVATION_BUDGET_BYTES = 8_000;
const DISCOVERY_OBSERVATION_BUDGET_BYTES = 24_000;
const DISCOVERY_TOOLS = new Set([
  'inspect_ask_context',
  'inspect_certified_candidates',
  'inspect_semantic_candidates',
  'inspect_relational_context',
  'inspect_business_context',
  'describe_relation',
  'describe_metric',
]);

/**
 * Drop the most expendable prose from a card-bearing payload, in order, until
 * it fits. Identifiers, usage guidance and column names are never removed —
 * losing those is what makes an observation useless.
 */
function shrinkObservationPayload(output: unknown, budget: number): unknown {
  const serialized = (value: unknown): number => {
    try { return JSON.stringify(value)?.length ?? 0; } catch { return Number.MAX_SAFE_INTEGER; }
  };
  if (serialized(output) <= budget) return output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const record = { ...(output as Record<string, unknown>) };
  const cards = Array.isArray(record.cards) ? [...record.cards] as unknown[] : undefined;
  const trimCards = (mutate: (card: Record<string, unknown>) => void): void => {
    if (!cards) return;
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      if (card && typeof card === 'object' && !Array.isArray(card)) {
        const next = { ...(card as Record<string, unknown>) };
        mutate(next);
        cards[index] = next;
      }
    }
    record.cards = cards;
  };
  // 1. Definitions are the largest field and the least load-bearing.
  trimCards((card) => { delete card.definition; });
  if (serialized(record) <= budget) return record;
  // 2. Compatibility prose and relationship narration.
  trimCards((card) => { delete card.compatibilityFacts; delete card.relationshipEvidence; });
  if (serialized(record) <= budget) return record;
  // 3. Column descriptions, then column type annotations.
  trimCards((card) => {
    if (!Array.isArray(card.columns)) return;
    card.columns = (card.columns as unknown[]).map((column) => (
      column && typeof column === 'object' && !Array.isArray(column)
        ? { name: (column as Record<string, unknown>).name }
        : column
    ));
  });
  if (serialized(record) <= budget) return record;
  // 4. Finally drop whole cards from the tail, recording how many, so the
  //    model knows it is looking at a prefix rather than the whole snapshot.
  if (cards && cards.length > 1) {
    let kept = cards.length;
    while (kept > 1 && serialized({ ...record, cards: cards.slice(0, kept) }) > budget) kept -= 1;
    if (kept < cards.length) {
      record.cards = cards.slice(0, kept);
      record.cardsOmitted = cards.length - kept;
      record.cardsOmittedNote = 'Call inspect_ask_context with expand for the remaining admitted cards.';
    }
  }
  return record;
}

function renderObservation(name: string, output: unknown): string {
  const budget = DISCOVERY_TOOLS.has(name) ? DISCOVERY_OBSERVATION_BUDGET_BYTES : OBSERVATION_BUDGET_BYTES;
  let body: string;
  try {
    body = JSON.stringify(shrinkObservationPayload(output, budget)) ?? '';
  } catch {
    body = String(output);
  }
  // A last-resort bound for a payload no structural shrink could reach.
  if (body.length > budget) body = `${body.slice(0, budget)}… (truncated)`;
  return `Observation from ${name}:\n\`\`\`json\n${body}\n\`\`\``;
}

function buildTextToolContract(tools: AgentToolDefinition[], maxToolCalls: number): string {
  const toolLines = tools.map((tool) => {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const params = props ? Object.keys(props).join(', ') : '';
    return `- ${tool.name}(${params}): ${tool.description}`;
  });
  return [
    'You can call tools to gather grounded context before answering. On EACH turn respond with EXACTLY ONE of:',
    '',
    '1. A tool call — a single ```json fenced object: {"tool": "<name>", "input": { ... }}',
    '2. Your FINAL answer — a single ```json fenced object: {"summary": "...", "sql": "...", "viz": "...", "outputs": ["..."]}',
    '',
    'Rules:',
    `- You may make at most ${maxToolCalls} tool call(s). Stop searching as soon as you can answer.`,
    '- Prefer compiling a governed semantic query (compile_semantic_query) over hand-writing SQL when the semantic layer covers the metric/dimensions.',
    '- Only reference relations and columns you have confirmed via a tool. Do not invent tables.',
    '- Never wrap a tool call and a final answer in the same message.',
    '',
    'Available tools:',
    ...toolLines,
  ].join('\n');
}
