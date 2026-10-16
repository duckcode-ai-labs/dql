#!/usr/bin/env node
/**
 * jaffle-golden's questions through the answer ROUTER, with dbt and without.
 *
 * The router (`zlens eval`, `planAgentAnswer`) decides from the project's
 * context alone whether a question is answerable and how: a certified block,
 * generated SQL, research, or a safe refusal / clarification. No model is
 * called and no SQL runs, so this is deterministic and CI-safe. It is the
 * router-level half of the warehouse-only golden eval; the Ask pipeline half
 * (right rows, right trust) is `apps/cli/src/ask-golden-jaffle-warehouse.test.ts`.
 *
 * Both fixtures get the same cases, built from
 * `apps/cli/test/ask-golden/questions.json`:
 *   - outcome rows / answered_with_caveat  → must route to an answer
 *     (certified, generated or research);
 *   - outcome gap                          → must refuse (missing context);
 *   - clarify_or_rows, gap_or_caveat, conversation → either is right, so
 *     they are listed with their route but not scored.
 *
 * Usage:
 *   node scripts/eval-golden-router-compare.mjs                 # print the comparison
 *   node scripts/eval-golden-router-compare.mjs --check <baseline.json>
 *       fail (exit 1) when jaffle-warehouse-golden scores below floor.router
 *   node scripts/eval-golden-router-compare.mjs --write <baseline.json>
 *       record both fixtures' per-question routes and set floor.router
 *   --cli <path>   the built CLI (default apps/cli/dist/index.js)
 *   --json <path>  also write the comparison as JSON
 * With GITHUB_STEP_SUMMARY set, the totals are appended to the job summary.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = ['jaffle-golden', 'jaffle-warehouse-golden'];
const ANSWER_ROUTES = new Set(['certified', 'generated', 'research']);

function parseArgs(argv) {
  const args = { cli: join(repoRoot, 'apps/cli/dist/index.js'), check: null, write: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cli') args.cli = resolve(argv[++i]);
    else if (arg === '--check') args.check = resolve(argv[++i]);
    else if (arg === '--write') args.write = resolve(argv[++i]);
    else if (arg === '--json') args.json = resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

/** What the router must do for a golden case, from its expected outcome. */
export function routerExpectation(outcome = 'rows') {
  if (outcome === 'rows' || outcome === 'answered_with_caveat') return 'answer';
  if (outcome === 'gap') return 'refuse';
  return 'either';
}

/** Did the router do what the case needs? `null` when the case is not scored. */
export function routerPass(expect, route) {
  if (expect === 'answer') return ANSWER_ROUTES.has(route);
  if (expect === 'refuse') return route === 'missing_context';
  return null;
}

function goldenCases() {
  const file = join(repoRoot, 'apps/cli/test/ask-golden/questions.json');
  return JSON.parse(readFileSync(file, 'utf8')).questions.map((q) => ({
    id: q.id,
    question: q.question,
    outcome: q.outcome ?? 'rows',
    expect: routerExpectation(q.outcome ?? 'rows'),
  }));
}

function runRouter(cli, fixture, cases) {
  const root = mkdtempSync(join(tmpdir(), `zlens-router-${fixture}-`));
  try {
    cpSync(join(repoRoot, 'apps/cli/test/fixtures', fixture), root, { recursive: true });
    rmSync(join(root, 'test-cassettes'), { recursive: true, force: true });
    mkdirSync(join(root, 'eval'), { recursive: true });
    // JSON is YAML: the eval reads eval/*.yaml.
    const yamlCases = cases.map((c) => ({ name: c.id, question: c.question, ...(c.expect === 'refuse' ? { expectRefuse: true } : {}) }));
    writeFileSync(join(root, 'eval', 'golden.yaml'), JSON.stringify({ cases: yamlCases }, null, 2));
    const result = spawnSync(process.execPath, [cli, 'eval', root, '--format', 'json', '--no-examples'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ZLENS_DISABLE_VERSION_CHECK: '1', ZLENS_EMBEDDINGS_AUTODETECT: 'off' },
    });
    if (result.status !== 0 && !result.stdout.trim().startsWith('{')) {
      throw new Error(`zlens eval failed for ${fixture} (exit ${result.status}):\n${result.stderr || result.stdout}`);
    }
    const report = JSON.parse(result.stdout);
    const byName = new Map(report.results.map((r) => [r.name, r]));
    return cases.map((c) => {
      const route = byName.get(c.id)?.actualRoute ?? 'missing';
      return { id: c.id, expect: c.expect, route, pass: routerPass(c.expect, route) };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function totals(rows) {
  const scored = rows.filter((r) => r.pass !== null);
  return {
    scored: scored.length,
    passed: scored.filter((r) => r.pass).length,
    answerable: rows.filter((r) => r.expect === 'answer').length,
    answered: rows.filter((r) => r.expect === 'answer' && r.pass).length,
    mustRefuse: rows.filter((r) => r.expect === 'refuse').length,
    refused: rows.filter((r) => r.expect === 'refuse' && r.pass).length,
    routes: rows.reduce((acc, r) => ({ ...acc, [r.route]: (acc[r.route] ?? 0) + 1 }), {}),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.cli)) throw new Error(`Built CLI not found at ${args.cli}; run pnpm build first.`);
  const cases = goldenCases();
  const results = Object.fromEntries(FIXTURES.map((fixture) => [fixture, runRouter(args.cli, fixture, cases)]));
  const summary = Object.fromEntries(FIXTURES.map((fixture) => [fixture, totals(results[fixture])]));

  const [dbt, wh] = FIXTURES;
  console.log('jaffle-golden questions through the router: dbt (jaffle-golden) vs no dbt (jaffle-warehouse-golden)\n');
  console.log(`${'case'.padEnd(36)} ${'expect'.padEnd(7)} ${'dbt'.padEnd(16)} no dbt`);
  results[dbt].forEach((row, index) => {
    const other = results[wh][index];
    const mark = (r) => `${r.route}${r.pass === null ? '' : r.pass ? ' ✓' : ' ✗'}`;
    console.log(`${row.id.padEnd(36)} ${row.expect.padEnd(7)} ${mark(row).padEnd(16)} ${mark(other)}`);
  });
  for (const fixture of FIXTURES) {
    const t = summary[fixture];
    console.log(`\n${fixture}: ${t.passed}/${t.scored} scored cases routed right (answered ${t.answered}/${t.answerable}, refused ${t.refused}/${t.mustRefuse}); routes ${JSON.stringify(t.routes)}`);
  }

  if (args.json) writeFileSync(args.json, `${JSON.stringify({ summary, results }, null, 2)}\n`);

  let exitCode = 0;
  if (args.check) {
    const baseline = JSON.parse(readFileSync(args.check, 'utf8'));
    const floor = baseline.floor?.router ?? 0;
    const passedBefore = new Set((baseline.router?.[wh]?.cases ?? []).filter((c) => c.pass).map((c) => c.id));
    const lost = results[wh].filter((r) => r.pass === false && passedBefore.has(r.id)).map((r) => r.id);
    const line = `${wh} router: ${summary[wh].passed}/${summary[wh].scored} (floor ${floor}); ${dbt}: ${summary[dbt].passed}/${summary[dbt].scored}`
      + (lost.length ? `; no longer routed right: ${lost.join(', ')}` : '');
    console.log(`\n${line}`);
    if (summary[wh].passed < floor) {
      console.error(`Below the committed floor in ${args.check}: a router regression for database-only projects.`);
      exitCode = 1;
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      const table = [
        '### jaffle-golden questions, router: dbt vs no dbt',
        '',
        '| fixture | routed right | answered | refused | certified routes |',
        '|---|---|---|---|---|',
        ...FIXTURES.map((f) => `| ${f} | ${summary[f].passed}/${summary[f].scored} | ${summary[f].answered}/${summary[f].answerable} | ${summary[f].refused}/${summary[f].mustRefuse} | ${summary[f].routes.certified ?? 0} |`),
        '',
        `Floor for ${wh}: ${floor}.${lost.length ? ` No longer routed right: ${lost.join(', ')}.` : ''}`,
        '',
      ].join('\n');
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, table, { flag: 'a' });
    }
  }

  if (args.write) {
    const baseline = existsSync(args.write) ? JSON.parse(readFileSync(args.write, 'utf8')) : {};
    baseline.floor = { ...(baseline.floor ?? {}), router: summary[wh].passed };
    baseline.router = Object.fromEntries(FIXTURES.map((f) => [f, { ...summary[f], cases: results[f] }]));
    writeFileSync(args.write, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\nWrote router results and floor.router = ${summary[wh].passed} to ${args.write}`);
  }
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
