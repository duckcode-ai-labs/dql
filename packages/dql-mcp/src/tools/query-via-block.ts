import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InvariantResult } from '@zlens/governance';
import {
  buildAnalysisQuestionPlan,
  grainMatches,
  requestedGrainFromPlan,
  type MetadataObject,
} from '@zlens/agent';
import {
  composeEffectiveTrust,
  TRUST_QUALIFIER_INVARIANT_VIOLATED,
  type DataStateLike,
} from '@zlens/core';
import type { DQLContext } from '../context.js';
import { zodInputShapeForTool } from '../tool-schema.js';
import { readEnv } from '@zlens/core';
import { fetchRuntime, runtimeUnreachableMessage } from '../runtime-fetch.js';

const DEFAULT_QUERY_VIA_BLOCK_ROW_LIMIT = 200;

export const queryViaBlockInput = zodInputShapeForTool('query_via_block');

/**
 * Execute a certified block by name. Delegates SQL prep + warehouse execution
 * to the local-runtime HTTP server, so results honor the same semantic resolver
 * and connection config as the notebook UI — the agent never sees raw SQL.
 */
export async function queryViaBlock(
  ctx: DQLContext,
  args: { name: string; limit?: number; question?: string; parameters?: Record<string, unknown>; serverUrl?: string },
) {
  const block = ctx.manifest.blocks[args.name];
  if (!block) return { error: `No block named "${args.name}".` };
  if (block.status !== 'certified') {
    return {
      error: `Block "${args.name}" is "${block.status ?? 'draft'}" — only certified blocks can be executed via MCP.`,
    };
  }

  // Grain-gate defense in depth. When a question is provided, re-run the same
  // grain check the router uses before serving this certified block. A genuine
  // grain/entity mismatch is refused here even if the tool was called directly,
  // so a near-miss certified block can never be served as a confidently-wrong
  // governed answer. Behavior is unchanged when no question is supplied or when
  // the block / question carries no clearly-extractable grain.
  if (args.question) {
    const plan = buildAnalysisQuestionPlan(args.question);
    const requestedGrain = requestedGrainFromPlan(plan);
    const gate = grainMatches(blockToGrainObject(block), requestedGrain);
    if (!gate.allow) {
      return {
        error: `Block "${args.name}" failed the grain gate: ${gate.reason}. Refusing to serve a near-miss certified answer; generate SQL for the requested grain instead.`,
        routeReason: gate.reason,
        grainGate: {
          allow: gate.allow,
          kind: gate.kind,
          requestedGrain: gate.requestedGrainLabel,
          blockGrain: gate.blockGrainLabel,
        },
      };
    }
  }

  // v1.6 — DataLex contract enforcement (the wedge).
  // When a certified block declares datalex_contract, refuse the call if
  // the reference doesn't resolve in the project's loaded DataLex
  // manifest. We do NOT fail when no manifest is loaded — projects that
  // haven't adopted DataLex still work; the analyzer separately surfaces a
  // warning at compile time so the user is aware.
  const datalexContract = (block as { datalexContract?: string }).datalexContract;
  if (datalexContract && ctx.datalexRegistry.isLoaded()) {
    const resolution = ctx.datalexRegistry.resolve(datalexContract);
    if (!resolution.ok) {
      return {
        error: `Block "${args.name}" references DataLex contract "${datalexContract}" which ${resolution.reason === 'not_found' ? 'is not in the loaded DataLex manifest' : resolution.reason === 'version_mismatch' ? `pins a version that does not exist (available: ${(resolution.availableVersions ?? []).join(', ')})` : `is malformed (${resolution.message})`}. Refusing to serve until the contract resolves.`,
      };
    }
  }

  const base = args.serverUrl ?? readEnv('ZLENS_RUNTIME_URL') ?? 'http://127.0.0.1:3474';
  const url = `${base.replace(/\/$/, '')}/api/notebook/execute`;
  let source: string;
  try {
    source = readFileSync(join(ctx.projectRoot, block.filePath), 'utf-8');
  } catch (err) {
    return {
      error: `Could not read block source for "${args.name}" at ${block.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let response: Response;
  try {
    response = await fetchRuntime(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cell: {
          id: `mcp-${args.name}`,
          type: 'dql',
          source,
          title: args.name,
        },
        question: args.question,
        parameters: args.parameters,
      }),
    });
  } catch (err) {
    return {
      error: runtimeUnreachableMessage(base, ctx.projectRoot, err, 'Running a certified block needs it'),
    };
  }

  if (!response.ok) {
    return { error: `Runtime returned ${response.status}: ${await response.text()}` };
  }

  const payload = (await response.json()) as {
    result?: {
      columns?: Array<{ name: string; type?: string }>;
      rows?: unknown[];
      executionTime?: number;
    };
    invariantResults?: InvariantResult[];
    invariantViolation?: boolean;
    error?: string;
    invocation?: {
      resolvedParameters?: Array<{
        name: string;
        value: unknown;
        source: 'policy' | 'explicit' | 'question' | 'prior_result' | 'surface' | 'default';
      }>;
      auditId?: string;
    };
  };
  if (payload.error) return { error: payload.error };
  const rows = payload.result?.rows ?? [];
  const rowLimit = args.limit ?? DEFAULT_QUERY_VIA_BLOCK_ROW_LIMIT;
  const returnedRows = rows.slice(0, rowLimit);

  // Invariant enforcement: the runtime evaluates the block's declared
  // invariants against this run's result. A real violation downgrades the
  // trust label even though the block is certified — "certified" means the
  // logic was reviewed, not that today's data honors every stated guarantee.
  const invariantResults = payload.invariantResults ?? [];
  const invariantViolation = Boolean(payload.invariantViolation);
  const declaredInvariants = block.invariants ?? [];

  // Freshness-aware trust: "certified" is the logic axis; the data axis is the
  // health of the block's upstream dbt models (last-run status + freshness),
  // computed at build time into `block.dataState`. A certified block whose
  // upstream failed/is stale is downgraded to "Certified · upstream failed" /
  // "Certified · stale data". An invariant violation is a stronger signal, so
  // it keeps the qualifier slot when both apply (composeEffectiveTrust honors
  // the existing qualifier first). Missing run_results → undefined dataState →
  // plain "Certified" (backward compatible).
  const dataState = (block as { dataState?: DataStateLike }).dataState;
  const effectiveTrust = composeEffectiveTrust({
    id: 'certified',
    dataState,
    existingQualifier: invariantViolation ? TRUST_QUALIFIER_INVARIANT_VIOLATED : undefined,
  });

  return {
    block: args.name,
    blockPath: block.filePath,
    trustLabel: effectiveTrust.display,
    invariantViolation,
    dataState: dataState ?? 'unknown',
    ...((block as { dataStateDetail?: string }).dataStateDetail
      ? { dataStateDetail: (block as { dataStateDetail?: string }).dataStateDetail }
      : {}),
    ...(declaredInvariants.length > 0 || invariantResults.length > 0
      ? { invariantResults }
      : {}),
    rowCount: rows.length,
    returnedRowCount: returnedRows.length,
    maxRowsReturned: rowLimit,
    rowsTruncated: rows.length > returnedRows.length,
    durationMs: payload.result?.executionTime ?? null,
    columns: payload.result?.columns ?? [],
    rows: returnedRows,
    parameters: payload.invocation?.resolvedParameters ?? [],
    auditId: payload.invocation?.auditId,
  };
}

/**
 * Adapt a manifest block into the minimal `MetadataObject` shape the grain gate
 * reads (it only inspects `payload.grain`, `payload.declaredOutputs`, and
 * `payload.entities`).
 */
function blockToGrainObject(block: {
  name: string;
  grain?: string;
  declaredOutputs?: string[];
  entities?: string[];
}): MetadataObject {
  return {
    objectKey: `dql:block:${block.name}`,
    objectType: 'dql_block',
    name: block.name,
    payload: {
      grain: block.grain,
      declaredOutputs: block.declaredOutputs ?? [],
      entities: block.entities ?? [],
    },
  };
}
