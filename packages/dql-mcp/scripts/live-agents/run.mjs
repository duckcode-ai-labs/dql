#!/usr/bin/env node
/**
 * Live agent check: run realistic ZLens tasks through Claude Code and Codex,
 * each connected to `zlens mcp` over stdio, and record which tools they called,
 * whether the answer is right, and whether the trust label is shown honestly.
 *
 * It uses the local `claude` and `codex` logins (no API keys) and never edits
 * their global config: Claude gets `--mcp-config <file> --strict-mcp-config
 * --setting-sources project`, Codex gets `-c mcp_servers.dql.*` overrides with
 * `--ignore-user-config --ephemeral`. Before the runs it calls
 * `zlens connect claude-code|codex <sample>` with the CLI under test, so the
 * agents read the CLAUDE.md / AGENTS.md guide and the server settings that
 * version writes (the server command is swapped for the local build).
 *
 * Each sample needs its workbench running (`zlens notebook <sample> --port N`).
 *
 *   node run.mjs --cli <repo>/apps/cli/dist/index.js \
 *     --sample duckdb=/path/jaffle-shop-duckdb@http://127.0.0.1:3640 \
 *     --sample warehouse=/path/jaffle-shop-warehouse@http://127.0.0.1:3641 \
 *     --out /path/results [--clients claude,codex] [--tasks id,id] [--concurrency 3]
 *     [--codex-approval approve] [--codex-bin <path>] [--claude-model <model>] [--timeout-min 10]
 *   node run.mjs --regrade --out /path/results   # re-grade saved runs with the current tasks.json
 *
 * Writes <out>/<client>/<task>.jsonl (raw transcript), <out>/<client>/<task>.json
 * (graded summary) and <out>/results.md + results.json. Exit code is 0 unless
 * the runner itself failed; grading is reported, not enforced.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { samples: {}, clients: ['claude', 'codex'], tasks: null, concurrency: 3, timeoutMin: 10, codexApproval: null, codexBin: 'codex', claudeBin: 'claude', claudeModel: null, codexModel: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--cli') args.cli = resolve(next());
    else if (a === '--out') args.out = resolve(next());
    else if (a === '--sample') {
      const [name, rest] = next().split('=');
      const at = rest.lastIndexOf('@');
      args.samples[name] = { path: resolve(rest.slice(0, at)), runtimeUrl: rest.slice(at + 1) };
    } else if (a === '--clients') args.clients = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--tasks') args.tasks = new Set(next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--concurrency') args.concurrency = Number(next());
    else if (a === '--timeout-min') args.timeoutMin = Number(next());
    else if (a === '--codex-approval') args.codexApproval = next();
    else if (a === '--codex-bin') args.codexBin = next();
    else if (a === '--claude-bin') args.claudeBin = next();
    else if (a === '--claude-model') args.claudeModel = next();
    else if (a === '--codex-model') args.codexModel = next();
    else if (a === '--tasks-file') args.tasksFile = resolve(next());
    else if (a === '--regrade') args.regrade = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  if (args.regrade && args.out) return args;
  if (!args.cli || !args.out || Object.keys(args.samples).length === 0) {
    throw new Error('Usage: run.mjs --cli <zlens dist/index.js> --sample name=/path@url [--sample …] --out <dir>');
  }
  return args;
}

/** Run `zlens connect` with the CLI under test and read what it wrote, so the runs use that guide and those settings. */
function connectSample(cli, sample) {
  for (const target of ['claude-code', 'codex']) {
    const result = spawnSync(process.execPath, [cli, 'connect', target, sample.path, '--format', 'json'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`zlens connect ${target} failed: ${result.stderr || result.stdout}`);
  }
  const mcpJson = JSON.parse(readFileSync(join(sample.path, '.mcp.json'), 'utf8'));
  const claudeEntry = mcpJson.mcpServers?.dql ?? {};
  const toml = readFileSync(join(sample.path, '.codex', 'config.toml'), 'utf8');
  const block = toml.match(/# BEGIN DQL MCP\n([\s\S]*?)# END DQL MCP/)?.[1] ?? '';
  const codexExtras = [];
  let section = '';
  for (const line of block.split('\n')) {
    const header = line.match(/^\[(.+)\]\s*$/);
    if (header) { section = header[1]; continue; }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = `${section}.${kv[1]}`;
    if (key === 'mcp_servers.dql.command' || key === 'mcp_servers.dql.args') continue;
    codexExtras.push(`${key}=${kv[2].trim()}`);
  }
  return { claudeEntry, codexExtras };
}

function serverCommand(cli, sample) {
  return { command: process.execPath, args: [cli, 'mcp', sample.path] };
}

function runProcess(command, args, { cwd, env, timeoutMs, stdoutPath, stdin }) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    const started = Date.now();
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(stdoutPath, stdout);
      writeFileSync(`${stdoutPath}.stderr`, stderr);
      resolveRun({ code, signal, timedOut: Date.now() - started >= timeoutMs, ms: Date.now() - started, stdout, stderr });
    });
  });
}

async function runClaude(args, task, sample, connected, outDir) {
  const { command, args: serverArgs } = serverCommand(args.cli, sample);
  const entry = { ...connected.claudeEntry, command, args: serverArgs, env: { ...(connected.claudeEntry.env ?? {}), ZLENS_RUNTIME_URL: sample.runtimeUrl } };
  delete entry.cwd;
  const configPath = join(outDir, `${task.id}.mcp.json`);
  writeFileSync(configPath, JSON.stringify({ mcpServers: { dql: entry } }, null, 2));
  const claudeArgs = [
    '-p', task.prompt,
    '--mcp-config', configPath, '--strict-mcp-config',
    '--setting-sources', 'project',
    '--output-format', 'stream-json', '--verbose',
    '--allowedTools', 'mcp__dql',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent',
  ];
  if (args.claudeModel) claudeArgs.push('--model', args.claudeModel);
  const run = await runProcess(args.claudeBin, claudeArgs, { cwd: sample.path, env: process.env, timeoutMs: args.timeoutMin * 60_000, stdoutPath: join(outDir, `${task.id}.jsonl`) });
  return { run, ...parseClaude(run.stdout) };
}

function parseClaude(stdout) {
  const calls = [];
  const results = new Map();
  let answer = '';
  let model;
  let turns;
  let cost;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'system' && event.subtype === 'init') model = event.model;
    if (event.type === 'assistant') {
      for (const item of event.message?.content ?? []) {
        if (item.type === 'tool_use') calls.push({ id: item.id, tool: item.name, args: item.input });
      }
    }
    if (event.type === 'user') {
      for (const item of event.message?.content ?? []) {
        if (item.type === 'tool_result') {
          const text = Array.isArray(item.content) ? item.content.map((c) => c.text ?? '').join('') : String(item.content ?? '');
          results.set(item.tool_use_id, { isError: Boolean(item.is_error), text });
        }
      }
    }
    if (event.type === 'result') { answer = event.result ?? ''; turns = event.num_turns; cost = event.total_cost_usd; }
  }
  const tools = calls
    .filter((call) => call.tool.startsWith('mcp__dql__'))
    .map((call) => {
      const result = results.get(call.id);
      return { tool: call.tool.replace('mcp__dql__', ''), args: call.args, isError: result?.isError ?? false, resultChars: result?.text.length ?? 0, resultHead: (result?.text ?? '').slice(0, 300) };
    });
  return { tools, answer, model, turns, cost };
}

async function runCodex(args, task, sample, connected, outDir) {
  const { command, args: serverArgs } = serverCommand(args.cli, sample);
  const overrides = [
    `mcp_servers.dql.command=${JSON.stringify(command)}`,
    `mcp_servers.dql.args=${JSON.stringify(serverArgs)}`,
    `mcp_servers.dql.env={ZLENS_RUNTIME_URL=${JSON.stringify(sample.runtimeUrl)}}`,
    ...connected.codexExtras.filter((kv) => !kv.startsWith('mcp_servers.dql.env')),
  ];
  if (args.codexApproval) overrides.push(`mcp_servers.dql.default_tools_approval_mode=${JSON.stringify(args.codexApproval)}`);
  const codexArgs = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-s', 'read-only', '-C', sample.path];
  for (const kv of overrides) codexArgs.push('-c', kv);
  if (args.codexModel) codexArgs.push('-m', args.codexModel);
  codexArgs.push(task.prompt);
  const run = await runProcess(args.codexBin, codexArgs, { cwd: sample.path, env: process.env, timeoutMs: args.timeoutMin * 60_000, stdoutPath: join(outDir, `${task.id}.jsonl`) });
  return { run, overrides, ...parseCodex(run.stdout) };
}

function parseCodex(stdout) {
  const tools = [];
  const messages = [];
  let usage;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'item.completed') {
      const item = event.item ?? {};
      if (item.type === 'mcp_tool_call' && item.server === 'dql') {
        const text = item.result?.content?.map((c) => c.text ?? '').join('') ?? '';
        tools.push({ tool: item.tool, args: item.arguments, isError: Boolean(item.error) || Boolean(item.result?.isError), error: item.error?.message, resultChars: text.length, resultHead: text.slice(0, 300) });
      }
      if (item.type === 'agent_message') messages.push(item.text ?? '');
    }
    if (event.type === 'turn.completed') usage = event.usage;
  }
  return { tools, answer: messages.at(-1) ?? '', usage };
}

const GENERATED_LABEL = /(AI[- ]?Generated|AI[- ]?drafted|uncertified|not certified|isn.t certified|needs? review|review[- ]required|requires review|for review|Reviewed|draft)/i;
// A generated answer must never wear the Certified label. Mentions such as
// "no certified block" or "not certified" are fine; a trust line, badge or
// heading that says Certified is not.
const CERTIFIED_CLAIM = /(trust(?:\s+(?:label|status|level))?|label|badge)\s*[:\-–—]?\s*\**\s*["“`]?certified\b|^\s*[*_`>#-]*\s*certified\s*\**\s*(?:[·•|—–]|$)/im;

function grade(task, outcome) {
  const notes = [];
  const toolNames = outcome.tools.map((t) => t.tool);
  const okTools = outcome.tools.filter((t) => !t.isError).map((t) => t.tool);
  const exp = task.expect ?? {};
  let toolsOk = true;
  if (exp.tools?.allOf) for (const name of exp.tools.allOf) if (!okTools.includes(name)) { toolsOk = false; notes.push(`missing ${name}`); }
  if (exp.tools?.anyOf && !exp.tools.anyOf.some((name) => okTools.includes(name))) { toolsOk = false; notes.push(`none of ${exp.tools.anyOf.join('/')}`); }
  if (exp.tools?.none) for (const name of exp.tools.none) if (okTools.includes(name)) { toolsOk = false; notes.push(`called ${name}`); }
  const answer = outcome.answer ?? '';
  let answerOk = Boolean(answer.trim());
  for (const pattern of exp.answer?.all ?? []) if (!new RegExp(pattern, 'i').test(answer)) { answerOk = false; notes.push(`answer lacks /${pattern}/`); }
  if (exp.answer?.any && !exp.answer.any.some((pattern) => new RegExp(pattern, 'i').test(answer))) { answerOk = false; notes.push('answer matches none of the expected forms'); }
  for (const pattern of exp.answer?.none ?? []) if (new RegExp(pattern, 'i').test(answer)) { answerOk = false; notes.push(`answer has /${pattern}/`); }
  let labelOk = null;
  let certifiedClaim = false;
  if (exp.label === 'certified') labelOk = /\bcertified\b/i.test(answer);
  if (exp.label === 'generated' || exp.label === 'draft') {
    labelOk = GENERATED_LABEL.test(answer);
    certifiedClaim = CERTIFIED_CLAIM.test(answer);
    if (certifiedClaim) { labelOk = false; notes.push('generated output presented as Certified'); }
  }
  if (exp.label === 'refusal') labelOk = !CERTIFIED_CLAIM.test(answer);
  if (labelOk === false && !certifiedClaim) notes.push(`trust label (${exp.label}) not shown`);
  const errors = outcome.tools.filter((t) => t.isError).map((t) => `${t.tool}: ${(t.error ?? t.resultHead).slice(0, 120)}`);
  const pass = toolsOk && answerOk && labelOk !== false && !outcome.run.timedOut;
  return { pass, toolsOk, answerOk, labelOk, certifiedClaim, toolNames, errors, notes, timedOut: outcome.run.timedOut };
}

async function pool(items, size, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, size) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const taskFile = JSON.parse(readFileSync(args.tasksFile ?? join(here, 'tasks.json'), 'utf8'));
  if (args.regrade) {
    const summaries = [];
    for (const client of ['claude', 'codex']) {
      const dir = join(args.out, client);
      if (!existsSync(dir)) continue;
      for (const task of taskFile.tasks) {
        const file = join(dir, `${task.id}.json`);
        if (!existsSync(file)) continue;
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        const graded = grade(task, { tools: saved.tools, answer: saved.answer, run: { timedOut: saved.timedOut } });
        const summary = { ...saved, feature: task.feature, ...graded };
        writeFileSync(file, JSON.stringify(summary, null, 2));
        summaries.push(summary);
      }
    }
    writeResults(args, taskFile.tasks, summaries);
    return;
  }
  const tasks = taskFile.tasks.filter((task) => args.samples[task.sample] && (!args.tasks || args.tasks.has(task.id)));
  mkdirSync(args.out, { recursive: true });
  const connected = {};
  for (const [name, sample] of Object.entries(args.samples)) {
    if (!existsSync(join(sample.path, 'dql.config.json'))) throw new Error(`${sample.path} is not a ZLens project`);
    connected[name] = connectSample(args.cli, sample);
  }
  const jobs = [];
  for (const client of args.clients) for (const task of tasks) jobs.push({ client, task });
  const summaries = [];
  await pool(jobs, args.concurrency, async ({ client, task }) => {
    const sample = args.samples[task.sample];
    const outDir = join(args.out, client);
    mkdirSync(outDir, { recursive: true });
    process.stderr.write(`▶ ${client} ${task.id}\n`);
    const outcome = client === 'claude'
      ? await runClaude(args, task, sample, connected[task.sample], outDir)
      : await runCodex(args, task, sample, connected[task.sample], outDir);
    const graded = grade(task, outcome);
    const summary = {
      client, task: task.id, sample: task.sample, feature: task.feature, prompt: task.prompt,
      ...graded,
      tools: outcome.tools,
      answer: outcome.answer,
      model: outcome.model, turns: outcome.turns, cost: outcome.cost, usage: outcome.usage,
      ms: outcome.run.ms, exitCode: outcome.run.code,
    };
    writeFileSync(join(outDir, `${task.id}.json`), JSON.stringify(summary, null, 2));
    summaries.push(summary);
    process.stderr.write(`${graded.pass ? '✓' : '✗'} ${client} ${task.id} [${graded.toolNames.join(' → ')}] ${graded.notes.join('; ')}\n`);
  });
  writeResults(args, tasks, summaries);
}

function writeResults(args, tasks, summaries) {
  summaries.sort((a, b) => tasks.findIndex((t) => t.id === a.task) - tasks.findIndex((t) => t.id === b.task) || a.client.localeCompare(b.client));
  writeFileSync(join(args.out, 'results.json'), JSON.stringify(summaries, null, 2));
  const yesNo = (value) => (value === null || value === undefined ? '–' : value ? 'yes' : 'no');
  const lines = [
    `# Live agent results`,
    '',
    `CLI: ${args.cli ?? '(regraded)'}`,
    '',
    '| Task | Feature | Client | Tools called | Right tool | Right answer | Label shown | Pass | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of summaries) {
    const toolList = s.toolNames.length ? s.toolNames.map((name, i) => (s.tools[i]?.isError ? `${name}(err)` : name)).join(' → ') : '(none)';
    lines.push(`| ${s.task} | ${s.feature} | ${s.client} | ${toolList} | ${yesNo(s.toolsOk)} | ${yesNo(s.answerOk)} | ${yesNo(s.labelOk)} | ${s.pass ? 'PASS' : 'FAIL'} | ${[...s.notes, ...s.errors].join('; ').replace(/\|/g, '\\|').slice(0, 300)} |`);
  }
  const passed = summaries.filter((s) => s.pass).length;
  lines.push('', `${passed}/${summaries.length} passed.`);
  writeFileSync(join(args.out, 'results.md'), `${lines.join('\n')}\n`);
  process.stderr.write(`\n${passed}/${summaries.length} passed. ${join(args.out, 'results.md')}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
