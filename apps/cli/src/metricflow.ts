import { existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/**
 * Run a MetricFlow command without stopping the world.
 *
 * `spawnSync` blocks the Node event loop for the entire life of the child. A
 * MetricFlow cold start on an enterprise semantic manifest is seconds — and on
 * the largest ones, far longer — during which this process serves no HTTP, no
 * progress events, and cannot honour its own deadline: the run's AbortSignal
 * is not even read until the child has already exited. That is the difference
 * between "the query is taking a while" and "the product froze". An async
 * spawn keeps the server responsive, lets the run deadline actually cancel a
 * compile, and bounds a hung binary with a real timeout.
 */
export interface MetricFlowSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut?: boolean;
}

/**
 * The environment MetricFlow runs with. A server many people use (a host) installs a narrower one: where programs
 * are, a home, a locale and dbt's own DBT_* settings (the warehouse settings its profile reads), and nothing else
 * from the server's environment.
 */
let childEnvironment: () => NodeJS.ProcessEnv | undefined = () => undefined;
export function setMetricFlowChildEnvironment(environment: () => NodeJS.ProcessEnv | undefined): void {
  childEnvironment = environment;
}
const metricFlowBaseEnv = (): NodeJS.ProcessEnv => childEnvironment() ?? process.env;

export function runMetricFlow(
  bin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal },
): Promise<MetricFlowSpawnResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: MetricFlowSpawnResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    let child;
    try {
      // `mf` is a Python entry point that spawns work of its own, so killing
      // it alone can leave a grandchild running — and holding this stdio pipe
      // open. Its own process group is what makes the kill below reach the
      // whole tree.
      child = spawn(bin, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      finish({ status: null, stdout: '', stderr: '', error: error as NodeJS.ErrnoException });
      return;
    }
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    /** Signal the whole process group, falling back to the child alone. */
    const signalTree = (signal: NodeJS.Signals): void => {
      try {
        if (typeof child.pid === 'number') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };
    /**
     * Stop waiting, having asked the tree to stop.
     *
     * The promise used to settle only on `close`, which fires when the process
     * exits AND its stdio closes. A surviving grandchild holds that pipe, so a
     * timeout signalled the compiler and then waited forever anyway — the exact
     * hang the timeout was added to prevent. The deadline is the answer; the
     * child's own exit is no longer required to reach it.
     */
    const abandon = (): void => {
      signalTree('SIGTERM');
      killTimer = setTimeout(() => signalTree('SIGKILL'), 2_000);
      if (killTimer.unref) killTimer.unref();
      finish({ status: null, stdout: stdout.join(''), stderr: stderr.join(''), timedOut });
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        abandon();
      }, options.timeoutMs)
      : undefined;
    // A cancelled Ask must actually stop the compiler it started.
    const onAbort = (): void => { abandon(); };
    options.signal?.addEventListener('abort', onAbort);
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    child.on('error', (error) => {
      cleanup();
      finish({ status: null, stdout: stdout.join(''), stderr: stderr.join(''), error: error as NodeJS.ErrnoException, timedOut });
    });
    child.on('close', (status) => {
      cleanup();
      finish({ status, stdout: stdout.join(''), stderr: stderr.join(''), timedOut });
    });
  });
}

/**
 * How long a single MetricFlow invocation may run before it is killed.
 * Generous, because a cold Python start on a large manifest is legitimately
 * slow — but finite, because an unbounded compile is what froze the server.
 */
const METRICFLOW_COMPILE_TIMEOUT_MS = 120_000;
const METRICFLOW_DIMENSION_TIMEOUT_MS = 30_000;

export type MetricFlowCliSource = 'env' | 'managed' | 'path';

export interface MetricFlowCliResolution {
  bin: string;
  source: MetricFlowCliSource;
  version: string;
}

export class MetricFlowUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricFlowUnavailableError';
  }
}

export interface MetricFlowQueryRequest {
  projectRoot: string;
  dbtProjectPath?: string;
  profilesDir?: string;
  metrics: string[];
  dimensions: string[];
  timeDimension?: { name: string; granularity: string };
  filters?: Array<{ dimension?: string; operator?: string; values?: string[]; expression?: string }>;
  orderBy?: Array<{ name: string; direction?: 'asc' | 'desc' }>;
  limit?: number;
  savedQuery?: string;
  /** The run's deadline/cancellation, so a compile cannot outlive its Ask. */
  signal?: AbortSignal;
  /**
   * Cap this compile below the module default. A run whose own deadline is
   * shorter than the compiler's has no use for the longer one, and a caller
   * that knows it is on a small manifest should not have to wait two minutes
   * to learn the runtime is wedged.
   */
  timeoutMs?: number;
}

export function managedMetricFlowRuntimeRoot(projectRoot: string): string {
  return join(projectRoot, '.dql', 'runtimes', 'metricflow');
}

export function managedMetricFlowBin(projectRoot: string): string {
  return process.platform === 'win32'
    ? join(managedMetricFlowRuntimeRoot(projectRoot), 'Scripts', 'mf.exe')
    : join(managedMetricFlowRuntimeRoot(projectRoot), 'bin', 'mf');
}

/** Resolve the semantic compiler without mutating PATH. A DQL-managed,
 * project-local runtime is considered before the user's ambient executable so
 * Settings installations work after completion without restarting the server. */
// MetricFlow is a Python CLI: a cold start through a venv routinely takes
// 2-6+ seconds on a loaded machine. Probing with a tight timeout on EVERY
// request made readiness flap — pass when idle, time out under load — and the
// adapter then silently fell back to native, which read as "MetricFlow
// disconnects after connecting". Cache POSITIVE resolutions per binary for the
// process lifetime (a working binary stays trusted; if it is later removed,
// the actual compile fails with a clear error). Negative results are never
// cached so a Settings-installed runtime is discovered without a restart.
const metricFlowCliCache = new Map<string, MetricFlowCliResolution>();

export function resolveMetricFlowCli(projectRoot?: string): MetricFlowCliResolution | null {
  const explicit = process.env.DQL_METRICFLOW_BIN || process.env.METRICFLOW_BIN;
  const candidates: Array<{ bin: string; source: MetricFlowCliSource }> = explicit
    ? [{ bin: explicit, source: 'env' }]
    : [
        ...(projectRoot ? [{ bin: managedMetricFlowBin(projectRoot), source: 'managed' as const }] : []),
        { bin: 'mf', source: 'path' },
      ];
  for (const candidate of candidates) {
    if (candidate.source === 'managed' && !existsSync(candidate.bin)) continue;
    const cached = metricFlowCliCache.get(candidate.bin);
    if (cached) return cached;
    const result = spawnSync(candidate.bin, ['--version'], {
      encoding: 'utf-8',
      env: metricFlowBaseEnv(),
      timeout: 10_000,
    });
    if (!result.error && result.status === 0) {
      const resolution: MetricFlowCliResolution = {
        ...candidate,
        version: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0] ?? '',
      };
      metricFlowCliCache.set(candidate.bin, resolution);
      return resolution;
    }
  }
  return null;
}

export interface MetricFlowCompileResult {
  sql: string;
  command: string[];
  stdout: string;
  stderr: string;
}

export interface MetricFlowDimension {
  /** Entity-qualified group-by name exactly as MetricFlow addresses it. */
  qualifiedName: string;
  /** Queryable grains, when MetricFlow reports them (time dimensions). */
  granularities?: string[];
}

interface MetricFlowDimensionListRequest {
  projectRoot: string;
  dbtProjectPath?: string;
  profilesDir?: string;
  metrics: string[];
  /** The run's deadline/cancellation, so a listing cannot outlive its Ask. */
  signal?: AbortSignal;
}

// Cache `mf list dimensions` by (binary + metrics-set + semantic_manifest mtime).
// The UI calls this on every metric toggle and mf cold-start is seconds.
const metricFlowDimensionCache = new Map<string, MetricFlowDimension[]>();
/** Recent failed listings, so one broken runtime is not re-probed per question. */
const metricFlowDimensionMissCache = new Map<string, number>();
const METRICFLOW_DIMENSION_MISS_TTL_MS = 60_000;

/**
 * Ask MetricFlow itself which dimensions a metric set can be grouped by, via
 * `mf list dimensions --metrics X,Y`. This is the EXACT truth for the executing
 * engine — entity-qualified names and real queryable grains — which the native
 * reachable-table heuristic can only approximate. Tolerant to output-format
 * drift across MetricFlow versions: unrecognized lines are ignored and a parse
 * that yields nothing returns [] so the caller falls back to native.
 */
export async function listMetricFlowDimensions(
  request: MetricFlowDimensionListRequest,
): Promise<MetricFlowDimension[]> {
  const dbtRoot = resolveDbtProjectRoot(request.projectRoot, request.dbtProjectPath);
  const manifestPath = join(dbtRoot, 'target', 'semantic_manifest.json');
  if (!existsSync(manifestPath) || request.metrics.length === 0) return [];

  const resolvedCli = resolveMetricFlowCli(request.projectRoot);
  const bin = resolvedCli?.bin ?? process.env.DQL_METRICFLOW_BIN ?? process.env.METRICFLOW_BIN ?? 'mf';
  let mtime = '';
  try { mtime = String(statSync(manifestPath).mtimeMs); } catch { /* ignore */ }
  const cacheKey = `${bin}::${mtime}::${[...request.metrics].sort().join(',')}`;
  const cached = metricFlowDimensionCache.get(cacheKey);
  if (cached) return cached;
  const missedAt = metricFlowDimensionMissCache.get(cacheKey);
  if (missedAt !== undefined) {
    if (Date.now() - missedAt < METRICFLOW_DIMENSION_MISS_TTL_MS) return [];
    metricFlowDimensionMissCache.delete(cacheKey);
  }

  const args = ['list', 'dimensions', '--metrics', request.metrics.join(',')];
  const result = await runMetricFlow(bin, args, {
    cwd: dbtRoot,
    timeoutMs: METRICFLOW_DIMENSION_TIMEOUT_MS,
    ...(request.signal ? { signal: request.signal } : {}),
    env: {
      ...metricFlowBaseEnv(),
      ...(request.profilesDir ? { DBT_PROFILES_DIR: resolve(request.projectRoot, request.profilesDir) } : {}),
    },
  });
  if (result.error || result.status !== 0) {
    // A failed listing used to be re-attempted on EVERY filtered question,
    // re-paying a full cold start (or a 30s timeout) each time for the same
    // answer. Remember the miss briefly so one broken run does not become a
    // per-question tax, while a fixed runtime is still picked up quickly.
    metricFlowDimensionMissCache.set(cacheKey, Date.now());
    return [];
  }

  const parsed = parseMetricFlowDimensionList(result.stdout ?? '');
  if (parsed.length > 0) metricFlowDimensionCache.set(cacheKey, parsed);
  return parsed;
}

/** Parse `mf list dimensions` stdout into qualified names + grains. Kept
 *  separate + exported so its format tolerance is unit-testable without mf. */
export function parseMetricFlowDimensionList(stdout: string): MetricFlowDimension[] {
  const dimensions: MetricFlowDimension[] = [];
  let current: MetricFlowDimension | undefined;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // A dimension entry: a bullet or bare token that is a valid identifier,
    // optionally entity-qualified with `__`. Skip headers/counts/emoji lines.
    const nameMatch = /^(?:[•*-]\s*)?([A-Za-z_][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*)$/.exec(line);
    if (nameMatch) {
      current = { qualifiedName: nameMatch[1] };
      dimensions.push(current);
      continue;
    }
    // A grain hint attaches to the dimension it follows.
    const grainMatch = /queryable\s+granularities?\s*[:=]?\s*\[?([^\]]+)\]?/i.exec(line);
    if (grainMatch && current) {
      const grains = grainMatch[1]
        .split(/[,\s]+/)
        .map((g) => g.replace(/['"]/g, '').trim().toLowerCase())
        .filter(Boolean);
      if (grains.length > 0) current.granularities = grains;
    }
  }
  return dimensions;
}

export type MetricFlowCompileMode = 'legacy-compile' | 'explain';

/** dbt-metricflow 0.13 removed `mf query --compile`. Its quiet explain mode
 * emits only the compiled SQL and does not print the result table. Keep the
 * legacy flag for existing user-managed MetricFlow installations. */
export function metricFlowCompileMode(version: string): MetricFlowCompileMode {
  const match = /(?:version\s*)?(\d+)\.(\d+)\.(\d+)/i.exec(version);
  if (!match) return 'legacy-compile';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 13 ? 'explain' : 'legacy-compile';
}

export function resolveDbtProjectRoot(projectRoot: string, configuredPath?: string): string {
  return configuredPath ? resolve(projectRoot, configuredPath) : projectRoot;
}

export function hasDbtSemanticManifest(projectRoot: string, configuredPath?: string): boolean {
  return existsSync(join(resolveDbtProjectRoot(projectRoot, configuredPath), 'target', 'semantic_manifest.json'));
}

/**
 * Where `dbt parse` writes the semantic manifest for THIS project: beside the
 * dbt manifest, under the dbt project directory — which is the DQL project
 * root only when the two coincide. A lookup under the DQL root alone said
 * "no MetricFlow manifest" for every project that wraps a dbt repository,
 * and silently compiled derived metrics on the native composer instead.
 */
export function resolveSemanticManifestPath(projectRoot: string, options: { dbtProjectDir?: string; dbtManifestPath?: string; provenanceManifestPath?: string } = {}): string {
  if (options.provenanceManifestPath) return join(dirname(options.provenanceManifestPath), 'semantic_manifest.json');
  const dbtRoot = resolveDbtProjectRoot(projectRoot, options.dbtProjectDir);
  if (options.dbtManifestPath) return join(dirname(resolve(dbtRoot, options.dbtManifestPath)), 'semantic_manifest.json');
  return join(dbtRoot, 'target', 'semantic_manifest.json');
}

/** Check whether the configured MetricFlow executable is callable. */
export function hasMetricFlowCli(projectRoot?: string): boolean {
  return resolveMetricFlowCli(projectRoot) !== null;
}

/**
 * Compiled SQL for a request that has already been compiled against this exact
 * semantic manifest.
 *
 * MetricFlow compilation is deterministic: the same metrics, dimensions,
 * filters, grain and limit against the same manifest produce the same SQL. It
 * was nonetheless re-derived through a fresh Python cold start every time,
 * which is the single largest fixed cost in a semantic answer — paid again on
 * every repeat of a question and on every follow-up that keeps the same shape.
 * The manifest's mtime is part of the key, so a `dbt parse` invalidates it.
 */
const metricFlowCompileCache = new Map<string, MetricFlowCompileResult>();
const METRICFLOW_COMPILE_CACHE_LIMIT = 64;

function metricFlowCompileCacheKey(bin: string, manifestMtime: string, request: MetricFlowQueryRequest): string {
  return JSON.stringify([
    bin,
    manifestMtime,
    [...request.metrics].sort(),
    [...request.dimensions].sort(),
    request.timeDimension ?? null,
    request.filters ?? null,
    request.orderBy ?? null,
    request.limit ?? null,
    request.savedQuery ?? null,
  ]);
}

export async function compileMetricFlowQuery(request: MetricFlowQueryRequest): Promise<MetricFlowCompileResult> {
  const dbtRoot = resolveDbtProjectRoot(request.projectRoot, request.dbtProjectPath);
  if (!existsSync(join(dbtRoot, 'target', 'semantic_manifest.json'))) {
    throw new MetricFlowUnavailableError(
      'dbt semantic execution requires target/semantic_manifest.json. Run `dbt parse` or `dbt build` in the dbt project, then retry.',
    );
  }

  const resolvedCli = resolveMetricFlowCli(request.projectRoot);
  const bin = resolvedCli?.bin ?? process.env.DQL_METRICFLOW_BIN ?? process.env.METRICFLOW_BIN ?? 'mf';
  const mode = metricFlowCompileMode(resolvedCli?.version ?? '');
  let manifestMtime = '';
  try { manifestMtime = String(statSync(join(dbtRoot, 'target', 'semantic_manifest.json')).mtimeMs); } catch { /* ignore */ }
  const compileCacheKey = metricFlowCompileCacheKey(bin, manifestMtime, request);
  const compileCached = metricFlowCompileCache.get(compileCacheKey);
  if (compileCached) return compileCached;
  // MetricFlow's WHERE templates hard-require entity-qualified names
  // ("product__product_type"); a bare "product_type" is a parse ERROR (and,
  // in older paths, a silently dropped filter). DQL's semantic layer speaks
  // bare dimension names, so pre-qualify every filter and group-by from
  // MetricFlow's OWN dimension list for these metrics — cached per manifest.
  // The same rule as the group-by repair applies: leaf-name equality, then
  // fewest entity hops; a tie is genuinely ambiguous and stays unchanged so
  // MetricFlow's own resolver error names the choices.
  // Qualification requires an extra synchronous `mf list dimensions` spawn.
  // On a large manifest that cold start can consume the entire Ask deadline,
  // so pay it ONLY when something actually needs qualifying: a WHERE filter
  // on a bare dimension name (a hard parse error without qualification).
  // Bare group-bys and order-bys survive via MetricFlow's own suggestion
  // repair below at no extra cost on the happy path.
  const needsQualification = (request.filters ?? []).some((filter) =>
    filter.dimension && !filter.dimension.includes('__') && filter.dimension !== 'metric_time');
  const qualifiedRequest = request.savedQuery || !needsQualification ? request : await (async () => {
    const qualified = await listMetricFlowDimensions({
      projectRoot: request.projectRoot,
      ...(request.dbtProjectPath ? { dbtProjectPath: request.dbtProjectPath } : {}),
      ...(request.profilesDir ? { profilesDir: request.profilesDir } : {}),
      metrics: request.metrics,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (qualified.length === 0) return request;
    const qualify = (name: string | undefined): string | undefined => {
      if (!name || name.includes('__') || name === 'metric_time') return name;
      const matches = qualified.filter((dimension) => dimension.qualifiedName.split('__').pop() === name);
      if (matches.length === 0) return name;
      const byHops = [...matches].sort((a, b) => a.qualifiedName.split('__').length - b.qualifiedName.split('__').length);
      const fewest = byHops[0].qualifiedName.split('__').length;
      return byHops.filter((dimension) => dimension.qualifiedName.split('__').length === fewest).length === 1
        ? byHops[0].qualifiedName
        : name;
    };
    return {
      ...request,
      dimensions: request.dimensions.map((dimension) => qualify(dimension) ?? dimension),
      ...(request.timeDimension
        ? { timeDimension: { ...request.timeDimension, name: qualify(request.timeDimension.name) ?? request.timeDimension.name } }
        : {}),
      ...(request.filters
        ? {
          filters: request.filters.map((filter) => filter.dimension
            ? { ...filter, dimension: qualify(filter.dimension) ?? filter.dimension }
            : filter),
        }
        : {}),
      ...(request.orderBy
        ? { orderBy: request.orderBy.map((order) => ({ ...order, name: qualify(order.name) ?? order.name })) }
        : {}),
    };
  })();
  const runCompile = async (spawnRequest: MetricFlowQueryRequest) => {
    const args = buildMetricFlowArgs(spawnRequest, mode);
    return {
      args,
      result: await runMetricFlow(bin, args, {
        cwd: dbtRoot,
        timeoutMs: Math.min(
          METRICFLOW_COMPILE_TIMEOUT_MS,
          request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : METRICFLOW_COMPILE_TIMEOUT_MS,
        ),
        ...(request.signal ? { signal: request.signal } : {}),
        env: {
          ...metricFlowBaseEnv(),
          ...(spawnRequest.profilesDir
            ? { DBT_PROFILES_DIR: resolve(spawnRequest.projectRoot, spawnRequest.profilesDir) }
            : {}),
        },
      }),
    };
  };
  let { args, result } = await runCompile(qualifiedRequest);

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MetricFlowUnavailableError(
        'MetricFlow CLI was not found. Install dbt Semantic Layer dependencies so `mf` is on PATH, or set DQL_METRICFLOW_BIN to the MetricFlow executable.',
      );
    }
    throw result.error;
  }

  let stdout = result.stdout ?? '';
  let stderr = result.stderr ?? '';
  if (result.status !== 0) {
    // MetricFlow group-by items are ENTITY-QUALIFIED ("bcm_hdr__customer_name"),
    // while DQL's semantic layer speaks bare dimension names ("customer_name").
    // On a group-by resolution failure MetricFlow lists the valid qualified
    // names — adopt its own suggestion and retry ONCE rather than surfacing a
    // wall of resolver errors for a question that has an exact governed answer.
    const repaired = repairMetricFlowGroupBy(qualifiedRequest, `${stderr}\n${stdout}`);
    if (repaired) {
      const retry = await runCompile(repaired);
      if (!retry.result.error && retry.result.status === 0) {
        args = retry.args;
        result = retry.result;
        stdout = retry.result.stdout ?? '';
        stderr = retry.result.stderr ?? '';
      }
    }
  }
  if (result.timedOut) {
    throw new MetricFlowUnavailableError(
      `MetricFlow did not finish compiling within ${Math.round(METRICFLOW_COMPILE_TIMEOUT_MS / 1000)} seconds.`
      + ' The semantic manifest may be very large or the runtime may be stuck; retry, or run the query through dbt Cloud.',
    );
  }
  if (result.status !== 0) {
    throw new Error(`MetricFlow compile failed (${result.status}): ${composeMetricFlowFailure(stdout, stderr)}`);
  }

  const sql = extractCompiledSql(stdout);
  if (!sql) {
    throw new Error('MetricFlow compile completed but no SQL statement was found in stdout.');
  }

  const compiled: MetricFlowCompileResult = {
    sql,
    command: [bin, ...args],
    stdout,
    stderr,
  };
  if (metricFlowCompileCache.size >= METRICFLOW_COMPILE_CACHE_LIMIT) {
    const oldest = metricFlowCompileCache.keys().next().value;
    if (oldest !== undefined) metricFlowCompileCache.delete(oldest);
  }
  metricFlowCompileCache.set(compileCacheKey, compiled);
  return compiled;
}

/**
 * Parse a MetricFlow "does not match any of the available group-by-items"
 * failure and rewrite the failing bare names to the qualified names MetricFlow
 * itself suggested. Returns the corrected request, or null when the failure is
 * not a group-by resolution problem or no suggestion unambiguously matches.
 *
 * Selection rule per failing input: among the suggested qualified names whose
 * final segment equals the input (`…__<input>`), take the one with the fewest
 * entity hops; ties on hop count → null (genuinely ambiguous, do not guess).
 */
export function repairMetricFlowGroupBy(
  request: MetricFlowQueryRequest,
  output: string,
): MetricFlowQueryRequest | null {
  if (!/does not match any of the available group-by-items/i.test(output)) return null;

  // A group-by names its input on the "Query Input:" line; a --where filter
  // names it as `Object Builder Input: Dimension('x__y')`, and its suggestions
  // come wrapped the same way. Both are read, so a filter on a dimension
  // spelled by its semantic model (premium__has_premium) is repaired to the
  // entity spelling MetricFlow itself suggests (policy_amount__has_premium).
  const unwrap = (item: string) => item.replace(/['"\s]/g, '').replace(/,+$/, '').replace(/^(?:Time)?Dimension\(([^,)]*)(?:,[^)]*)?\)$/, '$1');
  const inputs = [
    ...[...output.matchAll(/Query Input:\s*\n?\s*['"]?([A-Za-z0-9_.]+)['"]?/g)].map((match) => match[1]),
    ...[...output.matchAll(/Object Builder Input:\s*\n?\s*(?:Time)?Dimension\(\s*['"]([A-Za-z0-9_.]+)['"]/g)].map((match) => match[1]),
  ].filter((input): input is string => Boolean(input) && input !== 'WhereFilter');
  const suggestions = [...output.matchAll(/Suggestions:\s*\[([^\]]*)\]/g)]
    .flatMap((match) => match[1].split(/,\s*(?=["'A-Za-z])/).map(unwrap).filter(Boolean));
  if (inputs.length === 0 || suggestions.length === 0) return null;

  const uniqueSuggestions = [...new Set(suggestions)];
  const resolveQualified = (input: string): string | null => {
    // Strip an existing granularity suffix for matching (metric_time__day).
    const bare = input.includes('__') ? input.split('__').pop()! : input;
    const candidates = uniqueSuggestions.filter((name) => {
      const tail = name.split('__').pop();
      return tail === bare || name === input;
    });
    if (candidates.length === 0) return null;
    const byHops = [...candidates].sort((a, b) => a.split('__').length - b.split('__').length);
    const fewest = byHops[0].split('__').length;
    if (byHops.filter((name) => name.split('__').length === fewest).length > 1) return null;
    return byHops[0];
  };

  const renames = new Map<string, string>();
  for (const input of new Set(inputs)) {
    const qualified = resolveQualified(input);
    if (!qualified || qualified === input) continue;
    renames.set(input, qualified);
  }
  if (renames.size === 0) return null;

  const renameOf = (name: string): string => renames.get(name) ?? name;
  return {
    ...request,
    dimensions: request.dimensions.map(renameOf),
    ...(request.timeDimension
      ? { timeDimension: { ...request.timeDimension, name: renameOf(request.timeDimension.name) } }
      : {}),
    ...(request.filters
      ? {
          filters: request.filters.map((filter) => filter.dimension
            ? { ...filter, dimension: renameOf(filter.dimension) }
            : filter),
        }
      : {}),
    ...(request.orderBy
      ? { orderBy: request.orderBy.map((order) => ({ ...order, name: renameOf(order.name) })) }
      : {}),
  };
}

export function buildMetricFlowArgs(request: MetricFlowQueryRequest, mode: MetricFlowCompileMode): string[] {
  const args = mode === 'explain'
    ? ['query', '--explain', '--quiet']
    : ['query', '--compile'];
  if (request.savedQuery) {
    args.push('--saved-query', request.savedQuery);
  } else {
    if (request.metrics.length === 0) {
      throw new Error('MetricFlow semantic query requires at least one metric.');
    }
    args.push('--metrics', request.metrics.join(','));
    const groupBy = [...request.dimensions];
    if (request.timeDimension) {
      groupBy.push(`${request.timeDimension.name}__${request.timeDimension.granularity}`);
    }
    if (groupBy.length > 0) args.push('--group-by', groupBy.join(','));
  }

  for (const where of buildWhereClauses(request.filters ?? [])) {
    args.push('--where', where);
  }
  for (const order of request.orderBy ?? []) {
    if (!order.name) continue;
    // An order-by must name a query item exactly: the time group-by carries
    // its grain (`metric_time__month`), so ordering by it does too.
    const name = request.timeDimension && order.name === request.timeDimension.name ? `${order.name}__${request.timeDimension.granularity}` : order.name;
    args.push('--order', mode === 'explain' && order.direction === 'desc'
      ? `-${name}`
      : mode === 'explain'
        ? name
        : `${name} ${order.direction ?? 'asc'}`);
  }
  if (request.limit && Number.isFinite(request.limit)) {
    args.push('--limit', String(request.limit));
  }
  return args;
}

function buildWhereClauses(filters: NonNullable<MetricFlowQueryRequest['filters']>): string[] {
  // MetricFlow's Dimension() template takes exactly TWO segments
  // (entity__dimension); additional hops ride in entity_path. The group-by
  // CLI flag accepts the full multi-hop spelling, the where template does not.
  const dimensionRef = (name: string): string => {
    const segments = name.split('__');
    if (segments.length <= 2) return `Dimension('${name}')`;
    const path = segments.slice(0, -2).map((hop) => `'${hop}'`).join(', ');
    return `Dimension('${segments.slice(-2).join('__')}', entity_path=[${path}])`;
  };
  return filters.flatMap((filter) => {
    if (filter.expression?.trim()) return [filter.expression.trim()];
    if (!filter.dimension || !filter.operator) return [];
    const values = filter.values ?? [];
    const quote = (value: string) => /^-?\d+(\.\d+)?$/.test(value.trim())
      ? value
      : `'${value.replace(/'/g, "''")}'`;
    const first = values[0] ?? '';
    // Producers spell comparison operators both ways ('=' from the governed
    // Ask compile tool, 'equals' from blocks). An unknown operator must never
    // silently drop the clause — the Ask boundary now refuses to execute a
    // query whose filter vanished — so accept both spellings here.
    switch (filter.operator) {
      case 'equals':
      case '=':
      case '==':
        return values.length <= 1
          ? [`{{ ${dimensionRef(filter.dimension)} }} = ${quote(first)}`]
          : [`{{ ${dimensionRef(filter.dimension)} }} IN (${values.map(quote).join(', ')})`];
      case 'not_equals':
      case '!=':
      case '<>':
        return [`{{ ${dimensionRef(filter.dimension)} }} != ${quote(first)}`];
      case 'in':
        return values.length > 0 ? [`{{ ${dimensionRef(filter.dimension)} }} IN (${values.map(quote).join(', ')})`] : [];
      case 'not_in':
        return values.length > 0 ? [`{{ ${dimensionRef(filter.dimension)} }} NOT IN (${values.map(quote).join(', ')})`] : [];
      case 'gt':
      case '>':
        return [`{{ ${dimensionRef(filter.dimension)} }} > ${quote(first)}`];
      case 'gte':
      case '>=':
        return [`{{ ${dimensionRef(filter.dimension)} }} >= ${quote(first)}`];
      case 'lt':
      case '<':
        return [`{{ ${dimensionRef(filter.dimension)} }} < ${quote(first)}`];
      case 'lte':
      case '<=':
        return [`{{ ${dimensionRef(filter.dimension)} }} <= ${quote(first)}`];
      default:
        return [];
    }
  });
}

const METRICFLOW_FAILURE_MAX_CHARS = 2_000;

/** Lines MetricFlow prints around a failure that are never the reason for it. */
const METRICFLOW_NOISE_LINES = [
  /A new version of the MetricFlow CLI is available/i,
  /Please update to version\b/i,
  /pip install --upgrade dbt-metricflow/i,
  /^If you think you found a bug/i,
  /github\.com\/dbt-labs\/metricflow\/issues/i,
  /^(?:Log File::|Artifact Path:|Artifact Modified Time:)/,
  /^ERROR:root:Logging exception handled by the CLI exception handler/,
  /^Traceback \(most recent call last\):/,
  /^(?:During handling of the above exception|The above exception was the direct cause)/,
  /^\s*[~^]+\s*$/,
];

const METRICFLOW_FAILURE_LINE = /^ERROR\b|\b(?:not found|unable to|could not|cannot|does not (?:exactly )?match|no such|invalid)\b|(?:Error|Exception):\s/i;

function cleanMetricFlowOutput(output: string): string[] {
  const lines: string[] = [];
  let inFrame = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    // A traceback frame is `  File "…"` followed by its more-indented source line.
    if (/^\s+File "/.test(line)) { inFrame = true; continue; }
    if (inFrame && /^\s{4,}\S/.test(line)) continue;
    inFrame = false;
    if (METRICFLOW_NOISE_LINES.some((pattern) => pattern.test(line))) continue;
    if (!line && (lines.length === 0 || !lines[lines.length - 1])) continue;
    lines.push(line);
  }
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
  return lines;
}

/** The first run of non-blank lines after `<label>:`, on one line. */
function metricFlowParagraph(text: string, label: string): string | undefined {
  const match = new RegExp(`${label}:[ \\t]*\\n?\\s*(\\S[^\\n]*(?:\\n[ \\t]*\\S[^\\n]*)*)`).exec(text);
  return match?.[1]?.replace(/\s+/g, ' ').trim() || undefined;
}

/**
 * The part of a failed `mf` run's output that says why it failed.
 *
 * MetricFlow writes its version-update banner ahead of the error, on the same
 * stream, and readers downstream keep only the first line — so a verbatim dump
 * reported "A new version of the MetricFlow CLI is available" as the reason a
 * reading did not compile. The banner and boilerplate are dropped, the output
 * starts at the first line that describes the failure (stdout, where `mf`
 * prints handled errors, before stderr tracebacks), and a resolver error leads
 * with its own message and query input.
 */
export function composeMetricFlowFailure(stdout: string, stderr: string): string {
  const out = cleanMetricFlowOutput(stdout);
  const err = cleanMetricFlowOutput(stderr);
  const failureAt = (lines: string[]) => lines.findIndex((line) => METRICFLOW_FAILURE_LINE.test(line.trim()));
  const section = failureAt(out) >= 0
    ? out.slice(failureAt(out))
    : failureAt(err) >= 0
      ? err.slice(failureAt(err))
      : out.length > 0 ? out : err;
  if (section.length === 0) return 'no output';
  const body = section.join('\n');
  const message = metricFlowParagraph(body, 'Message');
  const input = message ? metricFlowParagraph(body, 'Query Input') : undefined;
  const text = message ? `${message}${input ? ` Query input: ${input}.` : ''}\n${body}` : body;
  return text.length > METRICFLOW_FAILURE_MAX_CHARS ? `${text.slice(0, METRICFLOW_FAILURE_MAX_CHARS - 1)}…` : text;
}

function extractCompiledSql(output: string): string {
  const normalized = output.trim();
  const index = normalized.search(/\b(with|select)\b/i);
  if (index < 0) return '';
  return normalized.slice(index).trim().replace(/;?\s*$/, '');
}
