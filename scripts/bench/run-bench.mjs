#!/usr/bin/env node
// Benchmark the manifest build + lineage rebuild against a generated dbt
// project. Fails non-zero if gates from docs/contribute/testing aren't met.
//
//   gates: cold build <30s, warm rebuild <2s
//
// Usage:
//   node scripts/bench/gen-dbt-project.mjs --models 4000 --out /tmp/stress
//   node scripts/bench/run-bench.mjs /tmp/stress
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

const project = resolve(process.argv[2] ?? '.');
const cli = (process.env.ZLENS_CLI ?? process.env.DQL_CLI) ?? 'node apps/cli/dist/index.js';

function time(label, fn) {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  console.log(`  ${label}: ${ms.toFixed(0)}ms`);
  return ms;
}

function run(args) {
  const [bin, ...rest] = cli.split(/\s+/);
  const r = spawnSync(bin, [...rest, ...args], { cwd: project, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`dql ${args.join(' ')} failed (${r.status})`);
}

console.log(`▸ benchmarking ${project}\n`);

const cold = time('cold manifest build ', () => run(['sync', 'dbt']));
const warm = time('warm manifest rebuild', () => run(['sync', 'dbt']));

console.log();

const gateCold = 30_000;
const gateWarm = 2_000;

let failed = 0;
if (cold > gateCold) { console.error(`✗ cold build exceeded ${gateCold}ms`); failed++; }
else console.log(`✓ cold build under ${gateCold}ms`);
if (warm > gateWarm) { console.error(`✗ warm rebuild exceeded ${gateWarm}ms`); failed++; }
else console.log(`✓ warm rebuild under ${gateWarm}ms`);

process.exit(failed ? 1 : 0);
