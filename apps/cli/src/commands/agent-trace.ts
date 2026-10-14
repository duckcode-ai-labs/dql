/**
 * Offline, local-only Ask trace inspection. These commands intentionally open
 * the observability database read-only and never initialize providers, tools,
 * connectors, or a runtime server.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AskTraceSqliteStoreV1,
  compareAskTracesV1,
  defaultAskTraceSqlitePath,
  exportAskTraceBundleV1,
  replayAskTraceReceiptV1,
  validateAskTraceBundleV1,
  type AskTraceDataV1,
} from '@zlens/agent';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

export async function runAgentTrace(rest: string[], flags: CLIFlags): Promise<void> {
  const [command, ...args] = rest;
  switch (command) {
    case 'list':
      return listTraces(flags);
    case 'show':
      return showTrace(args[0], flags);
    case 'export':
      return exportTrace(args[0], flags);
    case 'validate':
      return validateTrace(args[0], flags);
    case 'replay':
      return replayTrace(args[0], flags);
    case 'compare':
      return compareTraces(args[0], args[1], flags);
    default:
      throw new Error(
        'Usage: zlens agent trace <list|show|export|validate|replay|compare>\n' +
        '  zlens agent trace list [--format json]\n' +
        '  zlens agent trace show <trace-id|run-id> [--format json]\n' +
        '  zlens agent trace export <trace-id|run-id> --out <empty-dir> [--profile strict|support --confirm-reviewed-identifiers]\n' +
        '  zlens agent trace validate <bundle-dir>\n' +
        '  zlens agent trace replay <bundle-dir> --mode receipt\n' +
        '  zlens agent trace compare <left-bundle-dir> <right-bundle-dir> --mode compare',
      );
  }
}

function openReadOnlyTraceStore(flags: CLIFlags): AskTraceSqliteStoreV1 {
  const projectRoot = findProjectRoot(process.cwd());
  const path = flags.input ? resolve(flags.input) : defaultAskTraceSqlitePath(projectRoot);
  if (!existsSync(path)) throw new Error('No local Ask trace store exists for this project.');
  const store = new AskTraceSqliteStoreV1({ path, readOnly: true });
  const status = store.status();
  if (!status.available) {
    store.close();
    throw new Error(status.reason === 'unsupported_schema'
      ? 'The local Ask trace store uses a newer schema. Open it with a compatible ZLens release.'
      : 'The local Ask trace store is unavailable.');
  }
  return store;
}

function resolveTrace(store: AskTraceSqliteStoreV1, id: string | undefined): AskTraceDataV1 {
  if (!id) throw new Error('A trace ID or run ID is required.');
  const trace = store.get(id) ?? store.getByRun(id);
  if (!trace) throw new Error('TRACE_NOT_FOUND: no local Ask trace matches that identifier.');
  if (trace.envelope.recordingStatus === 'detail_expired') {
    throw new Error('TRACE_DETAIL_EXPIRED: detailed evidence has expired; list the trace summary instead.');
  }
  return trace;
}

function listTraces(flags: CLIFlags): void {
  const store = openReadOnlyTraceStore(flags);
  try {
    const result = store.list({ limit: 100 });
    if (flags.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.traces.length === 0) {
      console.log('No local Ask traces found.');
      return;
    }
    console.log('TRACE ID                          STATUS       MODE      TIER                 STARTED');
    for (const trace of result.traces) {
      console.log(`${trace.traceId}  ${trace.status.padEnd(11)} ${trace.mode.padEnd(9)} ${(trace.selectedTier ?? '—').padEnd(20)} ${trace.startedAt}`);
    }
    if (result.nextCursor) console.log('\nMore traces are available through the local runtime API cursor.');
  } finally {
    store.close();
  }
}

function showTrace(id: string | undefined, flags: CLIFlags): void {
  const store = openReadOnlyTraceStore(flags);
  try {
    const trace = resolveTrace(store, id);
    if (flags.format === 'json') {
      console.log(JSON.stringify(trace, null, 2));
      return;
    }
    const envelope = trace.envelope;
    console.log(`Trace ${envelope.traceId}\nRun ${envelope.runId}\n${envelope.status} · ${envelope.mode} · ${envelope.selectedTier ?? 'no selected tier'}\n`);
    console.log(`Spans: ${trace.spans.length}  Candidates: ${trace.candidateDecisions.length}  Links: ${trace.links.length}`);
    for (const span of trace.spans) {
      console.log(`  ${String(span.ordinal + 1).padStart(3)}  ${span.name.padEnd(30)} ${span.outcome.padEnd(12)} ${span.reasonCode}`);
    }
  } finally {
    store.close();
  }
}

function exportTrace(id: string | undefined, flags: CLIFlags): void {
  if (!flags.outDir) throw new Error('`zlens agent trace export` requires --out <empty-directory>.');
  const store = openReadOnlyTraceStore(flags);
  try {
    const trace = resolveTrace(store, id);
    const profile = flags.traceProfile ?? 'strict';
    const receipt = exportAskTraceBundleV1(trace, {
      profile,
      outputDirectory: resolve(flags.outDir),
      confirmReviewedIdentifiers: flags.confirmReviewedIdentifiers,
      // Support prose is only allowed when an operator intentionally supplies
      // it via --question together with confirmation. It is never recovered
      // from the local trace or AgentRun.
      ...(profile === 'support' && flags.question ? { reviewedQuestion: flags.question } : {}),
      provenance: 'recorded',
    });
    store.recordExportReceipt(trace.envelope.traceId, receipt);
    print(flags, receipt);
  } finally {
    store.close();
  }
}

function validateTrace(directory: string | undefined, flags: CLIFlags): void {
  if (!directory) throw new Error('A trace bundle directory is required.');
  const result = validateAskTraceBundleV1(resolve(directory));
  print(flags, result);
  if (!result.valid) throw new Error(`Trace bundle validation failed: ${result.errors.join(' ')}`);
}

function replayTrace(directory: string | undefined, flags: CLIFlags): void {
  if (!directory) throw new Error('A trace bundle directory is required.');
  if (flags.traceMode !== 'receipt') throw new Error('Replay is receipt-only. Pass --mode receipt.');
  const result = replayAskTraceReceiptV1(resolve(directory));
  print(flags, {
    valid: result.valid,
    errors: result.errors,
    ...(result.trace ? { traceId: result.trace.envelope.traceId, spanCount: result.trace.spans.length } : {}),
    guarantees: ['zero_provider_calls', 'zero_tool_calls', 'zero_sql_calls', 'zero_network_calls'],
  });
  if (!result.valid) throw new Error(`Trace receipt replay failed: ${result.errors.join(' ')}`);
}

function compareTraces(leftDirectory: string | undefined, rightDirectory: string | undefined, flags: CLIFlags): void {
  if (!leftDirectory || !rightDirectory) throw new Error('Compare requires two trace bundle directories.');
  if (flags.traceMode !== 'compare') throw new Error('Compare is structural. Pass --mode compare.');
  const left = replayAskTraceReceiptV1(resolve(leftDirectory));
  const right = replayAskTraceReceiptV1(resolve(rightDirectory));
  if (!left.valid || !left.trace || !right.valid || !right.trace) {
    throw new Error(`Trace compare requires valid receipts. ${[...left.errors, ...right.errors].join(' ')}`);
  }
  print(flags, compareAskTracesV1(left.trace, right.trace));
}

function print(flags: CLIFlags, value: unknown): void {
  if (flags.format === 'json') {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}
