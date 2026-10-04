#!/usr/bin/env node
// The CLI suite, with every Node process it starts recording each name lookup and connection towards an address
// that is not this machine (scripts/network-log.cjs). Fails when there is any: the suite must reach nothing off
// the machine, and a lookup is caught even when it fails before a socket exists.
// usage: node scripts/test-offline.mjs [vitest arguments…]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'dql-offline-'));
const log = join(scratch, 'network.jsonl');
const preload = join(here, 'network-log.cjs');
const run = spawnSync('npx', ['vitest', 'run', ...process.argv.slice(2)], {
  cwd: join(here, '..'),
  stdio: 'inherit',
  env: { ...process.env, DQL_NETWORK_LOG: log, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${preload}`.trim() },
});
let lines = [];
try { lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { /* nothing recorded */ }
rmSync(scratch, { recursive: true, force: true });
const processes = lines.filter((line) => line.kind === 'start').length;
const offMachine = lines.filter((line) => line.kind !== 'start');
console.log(`\nNetwork record: ${processes} Node processes, ${offMachine.length} lookups or connections off this machine.`);
for (const line of offMachine.slice(0, 40)) console.log(`  ${line.kind} ${line.host}${line.port ? `:${line.port}` : ''}  ${line.stack ?? ''}`);
if (processes === 0) {
  console.error('The network record is empty: the recorder did not load.');
  process.exit(1);
}
process.exit(offMachine.length > 0 ? 1 : run.status ?? 1);
