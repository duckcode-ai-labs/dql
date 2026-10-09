#!/usr/bin/env node

/**
 * Run DQL Agent tests in two deterministic lanes.
 *
 * `catalog.test.ts` and `project-state.test.ts` intentionally build large
 * local indexes. They remain unchanged and run in every package test. To avoid
 * CPU/file-system contention under Turbo, they run separately from the
 * deterministic serial ordinary suite.
 *
 * This runner executes the ordinary suite deterministically and serially, then
 * executes the two heavy files serially in a separate Vitest process. The
 * aggregate JSON receipts
 * prove the complete, non-skipped suite still ran exactly once.
 *
 * `--lane=ordinary` or `--lane=heavy` (or DQL_AGENT_TEST_LANE) runs one lane
 * and audits that lane against its own pinned counts. CI uses this: the
 * ordinary lane runs inside `pnpm test` with every other package, and the
 * heavy lane runs in its own step once nothing else is running, because its
 * wall-clock retrieval bound (catalog.test.ts, PERF-001/PERF-002) measured
 * about three times slower while the CLI suite shared the runner. With no
 * lane named, both lanes run, as before.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitestCli = require.resolve('vitest/vitest.mjs');

const HEAVY_TEST_FILES = [
  'src/metadata/catalog.test.ts',
  'src/project-state.test.ts',
];
// The Ask pipeline is the release-critical Ask surface. Keep an explicit
// discovery assertion so a future glob or lane refactor cannot omit its
// regression suites while still producing a superficially complete count.
const REQUIRED_TEST_FILES = [
  'src/ask-pipeline/ask-pipeline.test.ts',
  'src/ask-pipeline/prepare/prepare.test.ts',
  'src/ask-pipeline/vocabulary-from-pack.test.ts',
  'src/ask-pipeline/policies.test.ts',
  'src/relationship-validation.test.ts',
];
// Keep this audited set explicit: new Ask analytical-frame and observability
// regressions must participate in the same serial package gate rather than
// being silently omitted from the receipt audit.
// 170 since the App Dataset registry, period-comparison, and native semantic
// catalog suites joined the package on top of main (+3 files, +20 tests);
// 171 with the App driver-analysis suite (RFC 0008 step 7, +1 file, +7 tests);
// 172 with the story-drafting suite (RFC 0008 step 8, +1 file, +4 tests);
// 173 with the governed-HTML drafting suite (RFC 0008 step 9, +1 file, +4 tests);
// 174 with Claude on Bedrock and Vertex (RFC 0010 HH-5, +1 file, +8 tests);
// 175 with the tool gate (RFC 0010 HH-7, +1 file, +2 tests);
// 176 with knowledge sources (RFC 0010 HH-15, +1 file, +14 tests);
// 177 with stores that answer with Promises (RFC 0010 HH-6, +1 file, +3 tests);
// 178 with context-pack retention (bounded metadata cache, +1 file, +3 tests);
// 180 with the Bedrock Converse provider (+1 file, +29 tests);
// 181 with certified-block matching by meaning (+1 file, +14 tests).
// 182 with the block grain read from GROUP BY (+1 file, +4 tests).
const EXPECTED_TEST_FILES = 182;
// Keep the aggregate receipt exact. The Ask pipeline suites (intent contract,
// vocabulary, governed defaults and host proofs, prepare tiers), the engine,
// observability, retrieval, semantic-proof, research-ledger, conversation and
// provider-transport regressions total 1,891 non-skipped tests; a future
// accidental skip must not be hidden by a broad package pass.
// 2318 with the Bedrock Guardrail option (RFC 0010 HH-5 follow-up, +1 test);
// 2319 with model usage for a host (RFC 0010 HH-6 follow-up, +1 test);
// 2320 with an empty multi-select read as no filter in page stories (+1 test);
// 2321 with the conversation an answer was given in (links to one answer, +1 test);
// 2335 with knowledge sources: cited documents, never a figure source (RFC 0010 HH-15, +14 tests);
// 2337 on main;
// 2340 with stores that answer with Promises: async conversation helpers and host run records (RFC 0010 HH-6, +3 tests);
// 2343 with retired blocks answered from their replacement (replacedBy, +3 tests).
// 2344 with figures read however they are written (knowledge/figures.ts, +1 test);
// 2347 with context-pack retention (bounded metadata cache, +3 tests);
// 2353 with warehouse failures said plainly and cited answers keeping their reading (+3 Ask pipeline, +3 knowledge);
// 2354 with answer-tier counts of a person's own conversations (+1 test).
// 2360 with the local-model rule (Ollama contacts its one base URL, +3 tests) and drafts outside the privacy
// boundary naming grouped members by position (+2 story, +1 page).
// 2363 (179 files) with a follow-up's earlier values named by position outside the privacy boundary
// (prior-values.test.ts, +3 tests);
// 2393 (180 files) with the Bedrock Converse provider (bedrock-converse.test.ts, +30 tests).
const EXPECTED_TESTS = 2411;
// The heavy lane's share of EXPECTED_TESTS (catalog.test.ts 72 + project-state.test.ts 4), pinned so
// a lane run on its own (CI runs the two lanes as separate steps) is audited as exactly as both together.
// The ordinary lane's share is the difference: 2316.
const EXPECTED_HEAVY_TESTS = 76;

const LANES = ['all', 'ordinary', 'heavy'];
function requestedLane() {
  const flagIndex = process.argv.findIndex((arg) => arg === '--lane' || arg.startsWith('--lane='));
  const fromFlag = flagIndex < 0
    ? undefined
    : process.argv[flagIndex].includes('=')
      ? process.argv[flagIndex].slice('--lane='.length)
      : process.argv[flagIndex + 1];
  const lane = (fromFlag ?? process.env.DQL_AGENT_TEST_LANE ?? 'all').trim() || 'all';
  if (!LANES.includes(lane)) throw new Error(`Unknown test lane "${lane}"; expected one of ${LANES.join(', ')}.`);
  return lane;
}

function discoverTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return discoverTestFiles(target);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [target] : [];
  });
}

function runLane({ name, args, reportPath }) {
  const result = spawnSync(process.execPath, [
    vitestCli,
    'run',
    '--passWithNoTests',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
    ...args,
  ], {
    cwd: packageRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${name} test lane failed with exit code ${result.status ?? 'unknown'}.`);
  }
  return JSON.parse(readFileSync(reportPath, 'utf8'));
}

function laneSummary(report) {
  return {
    files: report.testResults.length,
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    todo: report.numTodoTests,
    paths: report.testResults.map((result) => realpathSync(result.name)),
  };
}

/**
 * Audit the lanes that ran. With both lanes, the receipts must cover every
 * discovered test file exactly once (EXPECTED_TESTS). With one lane, they must
 * cover exactly that lane's files and its pinned share of the tests, so the two
 * CI steps together still prove the whole suite ran once.
 */
function assertLanes({ ordinary, heavy }) {
  const ordinarySummary = ordinary ? laneSummary(ordinary) : undefined;
  const heavySummary = heavy ? laneSummary(heavy) : undefined;
  const summaries = [ordinarySummary, heavySummary].filter(Boolean);
  const paths = summaries.flatMap((summary) => summary.paths);
  const uniquePaths = new Set(paths);
  const heavyPaths = new Set(HEAVY_TEST_FILES.map((file) => realpathSync(join(packageRoot, file))));
  const discoveredPaths = new Set(discoverTestFiles(join(packageRoot, 'src')).map((file) => realpathSync(file)));
  const requiredPaths = REQUIRED_TEST_FILES.map((file) => realpathSync(join(packageRoot, file)));
  const expectedPaths = new Set([...discoveredPaths].filter((path) => heavyPaths.has(path)
    ? Boolean(heavySummary)
    : Boolean(ordinarySummary)));
  const expectedTests = (ordinarySummary ? EXPECTED_TESTS - EXPECTED_HEAVY_TESTS : 0)
    + (heavySummary ? EXPECTED_HEAVY_TESTS : 0);

  const failures = [];
  if (discoveredPaths.size !== EXPECTED_TEST_FILES) {
    failures.push(`discovered ${discoveredPaths.size} test files; expected ${EXPECTED_TEST_FILES}`);
  }
  if (paths.length !== expectedPaths.size || uniquePaths.size !== expectedPaths.size) {
    failures.push(`ran ${paths.length} file receipts / ${uniquePaths.size} unique files; expected ${expectedPaths.size} exactly once`);
  }
  if (paths.some((path) => !expectedPaths.has(path)) || [...expectedPaths].some((path) => !uniquePaths.has(path))) {
    failures.push('Vitest file receipts do not exactly match the discovered test-file set for the lanes that ran');
  }
  if (ordinarySummary && requiredPaths.some((path) => !discoveredPaths.has(path) || !uniquePaths.has(path))) {
    failures.push('required Ask V2 test files were not included exactly once in the package lanes');
  }
  if (ordinarySummary?.paths.some((path) => heavyPaths.has(path))) {
    failures.push('heavy files ran in the ordinary lane');
  }
  if (heavySummary && (heavyPaths.size !== heavySummary.paths.length
    || heavySummary.paths.some((path) => !heavyPaths.has(path)))) {
    failures.push('heavy files were not run exactly once in the isolated lane');
  }

  const totalTests = summaries.reduce((sum, summary) => sum + summary.tests, 0);
  const totalPassed = summaries.reduce((sum, summary) => sum + summary.passed, 0);
  const totalFailed = summaries.reduce((sum, summary) => sum + summary.failed, 0);
  const totalPending = summaries.reduce((sum, summary) => sum + summary.pending, 0);
  const totalTodo = summaries.reduce((sum, summary) => sum + summary.todo, 0);
  if (totalTests !== expectedTests || totalPassed !== expectedTests) {
    failures.push(`ran ${totalPassed}/${totalTests} tests; expected ${expectedTests}/${expectedTests}`);
  }
  if (totalFailed !== 0 || totalPending !== 0 || totalTodo !== 0) {
    failures.push(`found failed=${totalFailed}, skipped=${totalPending}, todo=${totalTodo}; expected all tests to run and pass`);
  }
  if (failures.length > 0) throw new Error(`DQL Agent test-lane audit failed: ${failures.join('; ')}`);

  const lanes = [
    ordinarySummary ? `${ordinarySummary.files} ordinary bounded` : undefined,
    heavySummary ? `${heavySummary.files} isolated serial` : undefined,
  ].filter(Boolean).join(' + ');
  console.log(
    `\nDQL Agent test-lane audit: ${uniquePaths.size}/${expectedPaths.size} files, `
    + `${totalPassed}/${expectedTests} tests, no skips (${lanes}).`,
  );
}

const lane = requestedLane();
const reportsDirectory = mkdtempSync(join(tmpdir(), 'dql-agent-test-lanes-'));
try {
  const ordinary = lane === 'heavy' ? undefined : runLane({
    name: 'ordinary bounded',
    reportPath: join(reportsDirectory, 'ordinary.json'),
    // Under Turbo's workspace graph, even a percentage-based worker pool can
    // contend with simultaneous package builds/tests enough to breach an
    // unchanged local-index assertion elsewhere in this lane. Run this lane
    // deterministically and serially; the separate heavy lane below remains
    // the only place that changes file grouping or test isolation.
    args: [
      '--maxWorkers=1',
      '--minWorkers=1',
      '--no-file-parallelism',
      ...HEAVY_TEST_FILES.flatMap((file) => [`--exclude=${file}`]),
    ],
  });
  const heavy = lane === 'ordinary' ? undefined : runLane({
    name: 'isolated heavy',
    reportPath: join(reportsDirectory, 'heavy.json'),
    args: [
      '--maxWorkers=1',
      '--minWorkers=1',
      '--no-file-parallelism',
      ...HEAVY_TEST_FILES,
    ],
  });
  assertLanes({ ordinary, heavy });
} finally {
  rmSync(reportsDirectory, { recursive: true, force: true });
}
