import { DQLContext, runStdio, runLoopbackHTTP } from '@zlens/mcp';
import {
  defaultKgPath,
  ensureMetadataCatalogFresh,
  reindexProject,
} from '@zlens/agent';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';
import { readEnv } from '@zlens/core';

interface McpFlags extends CLIFlags {
  http?: boolean;
}

export async function runMcp(arg: string | null, rest: string[], flags: McpFlags): Promise<void> {
  if (arg === 'test') {
    return runMcpTest(rest[0] ?? null, flags);
  }

  const projectRoot = findProjectRoot(arg ?? process.cwd());

  if (flags.http) {
    const handle = await runLoopbackHTTP({ projectRoot, port: flags.port ?? 0 });
    process.stderr.write(`dql-mcp listening on ${handle.url}\n`);
    process.stderr.write(`  Authorization: Bearer ${handle.token}\n`);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => void handle.close().then(() => process.exit(0)));
    }
    return;
  }

  await runStdio({ projectRoot });
}

async function runMcpTest(targetPath: string | null, flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(resolve(targetPath ?? process.cwd()));
  // `optional` checks are informational and do not fail overall readiness — the
  // runtime is only needed for governed generation (answer_question /
  // build_block_from_prompt) and bounded execution, not for routing/BYOSQL planning.
  const checks: Array<{ name: string; ok: boolean; detail: string; optional?: boolean }> = [];

  checks.push({
    name: 'ZLens project',
    ok: existsSync(join(projectRoot, 'dql.config.json')),
    detail: existsSync(join(projectRoot, 'dql.config.json')) ? projectRoot : 'dql.config.json not found',
  });

  try {
    const ctx = new DQLContext({ projectRoot });
    const manifest = ctx.manifest;
    checks.push({
      name: 'Manifest context',
      ok: true,
      detail: `${Object.keys(manifest.blocks ?? {}).length} block(s), ${Object.keys(manifest.apps ?? {}).length} app(s)`,
    });
  } catch (error) {
    checks.push({
      name: 'Manifest context',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const result = await ensureMetadataCatalogFresh(projectRoot);
    checks.push({
      name: 'Metadata catalog',
      ok: true,
      detail: `${result.objectCount} object(s), ${result.edgeCount} edge(s) at ${result.path}`,
    });
  } catch (error) {
    checks.push({
      name: 'Metadata catalog',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const result = await reindexProject(projectRoot, { kgPath: defaultKgPath(projectRoot) });
    checks.push({
      name: 'Agent index',
      ok: true,
      detail: `${result.nodes} node(s), ${result.edges} edge(s), ${result.skills} skill(s); KG ${result.kgRebuilt ? 'rebuilt' : 'fresh'}, metadata ${result.metadataRefreshed ? 'refreshed' : 'fresh'}`,
    });
  } catch (error) {
    checks.push({
      name: 'Agent index',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  checks.push({
    name: 'MCP tool surface',
    ok: true,
    detail: 'ask_dql, answer_question, typed App Dataset tools, query_via_metadata, build_block_from_prompt, build_dql_app, inspect_dql_project, certify, lineage, and metadata tools are available',
  });

  // Advisory: is the ZLens runtime up? Governed answer/build + bounded execution
  // proxy to it. stdio routing/BYOSQL planning works without it.
  const runtimeBase = (readEnv('ZLENS_RUNTIME_URL') ?? 'http://127.0.0.1:3474').replace(/\/$/, '');
  let runtimeOk = false;
  let runtimeDetail = `not reachable at ${runtimeBase} — start it with \`zlens serve\` for answer_question / build_block_from_prompt / query execution`;
  try {
    const resp = await fetch(`${runtimeBase}/api/schema`, { signal: AbortSignal.timeout(1500) });
    // Any HTTP response (even 404) means the runtime is up.
    runtimeOk = resp.status < 500;
    if (runtimeOk) runtimeDetail = `reachable at ${runtimeBase}`;
  } catch {
    // not reachable — leave runtimeOk false with the actionable detail
  }
  checks.push({
    name: 'ZLens runtime (governed generation + execution)',
    ok: runtimeOk,
    detail: runtimeDetail,
    optional: true,
  });

  // Dataset MCP calls must reach the dedicated typed Dataset endpoint, not
  // merely any process speaking HTTP on the configured runtime port. The
  // endpoint itself owns current catalog, source, proof and target validation.
  let datasetRuntimeOk = false;
  let datasetRuntimeDetail = `not reachable at ${runtimeBase}/api/app-datasets — start \`zlens serve\` for typed Dataset MCP execution`;
  try {
    const response = await fetch(`${runtimeBase}/api/app-datasets`, { signal: AbortSignal.timeout(1500) });
    datasetRuntimeOk = response.status >= 200 && response.status < 300;
    if (datasetRuntimeOk) datasetRuntimeDetail = `typed Dataset runtime available at ${runtimeBase}/api/app-datasets`;
    else datasetRuntimeDetail = `typed Dataset runtime returned ${response.status} at ${runtimeBase}/api/app-datasets`;
  } catch {
    // Retain the actionable unavailable detail above.
  }
  checks.push({
    name: 'Dataset MCP runtime capability',
    ok: datasetRuntimeOk,
    detail: datasetRuntimeDetail,
    optional: true,
  });

  const ok = checks.filter((check) => !check.optional).every((check) => check.ok);
  if (flags.format === 'json') {
    console.log(JSON.stringify({ ok, projectRoot, checks }, null, 2));
    return;
  }

  console.log('\n  ZLens MCP Test');
  console.log(`    Project: ${projectRoot}`);
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}`);
    console.log(`    ${check.detail}`);
  }
  console.log('');
  console.log(ok
    ? '  Ready: point Claude Code, Codex, Cursor, or Claude Desktop at this project with `zlens connect`.'
    : '  Not ready: fix the failed checks above, then rerun `zlens mcp test`.');
  console.log('');
}
