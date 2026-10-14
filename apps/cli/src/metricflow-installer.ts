import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { managedMetricFlowBin, managedMetricFlowRuntimeRoot } from './metricflow.js';
import { readEnv } from '@zlens/core';

export type MetricFlowWarehouseAdapter = 'duckdb' | 'snowflake' | 'bigquery' | 'databricks' | 'redshift' | 'postgres' | 'trino';
export type MetricFlowInstallState = 'idle' | 'queued' | 'running' | 'completed' | 'failed';
export type MetricFlowInstallStage = 'detecting_python' | 'creating_environment' | 'installing' | 'parsing' | 'testing' | 'ready';

export interface MetricFlowInstallJob {
  id: string;
  state: MetricFlowInstallState;
  stage: MetricFlowInstallStage;
  progress: number;
  adapter: MetricFlowWarehouseAdapter;
  packageSpec: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  runtimePath: string;
  runtimeVersion?: string;
  logs: string[];
  error?: string;
}

export interface MetricFlowInstallInput {
  adapter: MetricFlowWarehouseAdapter;
  dbtProjectDir: string;
  profilesDir?: string;
}

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; onOutput: (line: string) => void },
) => Promise<CommandResult>;

const SUPPORTED_ADAPTERS = new Set<MetricFlowWarehouseAdapter>([
  'duckdb',
  'snowflake',
  'bigquery',
  'databricks',
  'redshift',
  'postgres',
  'trino',
]);

/** API-004 / UI-009: keep the Python semantic engine isolated and versioned
 * independently from the user's system dbt installation. */
export function metricFlowPackageSpec(adapter: MetricFlowWarehouseAdapter): string {
  if (!SUPPORTED_ADAPTERS.has(adapter)) throw new Error(`Unsupported MetricFlow warehouse adapter: ${adapter}`);
  return `dbt-metricflow[dbt-${adapter}]>=0.13,<0.14`;
}

export function metricFlowAdapterForDriver(driver: string | undefined): MetricFlowWarehouseAdapter | null {
  switch (driver?.trim().toLowerCase()) {
    case 'file':
    case 'duckdb': return 'duckdb';
    case 'postgresql':
    case 'postgres': return 'postgres';
    case 'snowflake': return 'snowflake';
    case 'bigquery': return 'bigquery';
    case 'databricks': return 'databricks';
    case 'redshift': return 'redshift';
    case 'trino': return 'trino';
    default: return null;
  }
}

export function isMetricFlowWarehouseAdapter(value: unknown): value is MetricFlowWarehouseAdapter {
  return typeof value === 'string' && SUPPORTED_ADAPTERS.has(value as MetricFlowWarehouseAdapter);
}

export function managedMetricFlowPython(projectRoot: string): string {
  return process.platform === 'win32'
    ? join(managedMetricFlowRuntimeRoot(projectRoot), 'Scripts', 'python.exe')
    : join(managedMetricFlowRuntimeRoot(projectRoot), 'bin', 'python');
}

export function managedMetricFlowDbt(projectRoot: string): string {
  return process.platform === 'win32'
    ? join(managedMetricFlowRuntimeRoot(projectRoot), 'Scripts', 'dbt.exe')
    : join(managedMetricFlowRuntimeRoot(projectRoot), 'bin', 'dbt');
}

export class ManagedMetricFlowInstaller {
  private readonly jobs = new Map<string, MetricFlowInstallJob>();
  private latestId: string | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly runner: CommandRunner = runCommand,
  ) {}

  latest(): MetricFlowInstallJob | null {
    return this.latestId ? cloneJob(this.jobs.get(this.latestId) ?? null) : null;
  }

  get(id: string): MetricFlowInstallJob | null {
    return cloneJob(this.jobs.get(id) ?? null);
  }

  start(input: MetricFlowInstallInput): MetricFlowInstallJob {
    const current = this.latest();
    if (current && (current.state === 'queued' || current.state === 'running')) return current;
    if (!SUPPORTED_ADAPTERS.has(input.adapter)) throw new Error(`Unsupported MetricFlow warehouse adapter: ${input.adapter}`);
    if (!existsSync(join(input.dbtProjectDir, 'dbt_project.yml'))) {
      throw new Error('Connect a valid dbt project before installing its semantic runtime.');
    }
    const now = new Date().toISOString();
    const id = `metricflow-install-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job: MetricFlowInstallJob = {
      id,
      state: 'queued',
      stage: 'detecting_python',
      progress: 3,
      adapter: input.adapter,
      packageSpec: metricFlowPackageSpec(input.adapter),
      message: 'Preparing the isolated MetricFlow runtime.',
      createdAt: now,
      updatedAt: now,
      runtimePath: managedMetricFlowRuntimeRoot(this.projectRoot),
      logs: [],
    };
    this.jobs.set(id, job);
    this.latestId = id;
    queueMicrotask(() => void this.run(id, input));
    return cloneJob(job)!;
  }

  private update(id: string, patch: Partial<MetricFlowInstallJob>): MetricFlowInstallJob | null {
    const current = this.jobs.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(id, next);
    return next;
  }

  private log(id: string, raw: string): void {
    const current = this.jobs.get(id);
    if (!current) return;
    const additions = redactInstallOutput(raw)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(0, 500));
    if (additions.length === 0) return;
    this.update(id, { logs: [...current.logs, ...additions].slice(-120) });
  }

  private async run(id: string, input: MetricFlowInstallInput): Promise<void> {
    const onOutput = (line: string) => this.log(id, line);
    try {
      this.update(id, { state: 'running', message: 'Detecting a compatible Python runtime.' });
      const python = detectPythonExecutable();
      this.log(id, `Using ${python.bin} (${python.version}).`);

      const runtimeRoot = managedMetricFlowRuntimeRoot(this.projectRoot);
      mkdirSync(join(this.projectRoot, '.dql', 'runtimes'), { recursive: true });
      this.update(id, { stage: 'creating_environment', progress: 12, message: 'Creating an isolated project-local Python environment.' });
      await this.runner(python.bin, ['-m', 'venv', runtimeRoot], {
        cwd: this.projectRoot,
        timeoutMs: 90_000,
        onOutput,
      });

      const runtimePython = managedMetricFlowPython(this.projectRoot);
      this.update(id, { stage: 'installing', progress: 28, message: `Installing MetricFlow for ${input.adapter}. This can take a few minutes.` });
      await this.runner(runtimePython, [
        '-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', metricFlowPackageSpec(input.adapter),
      ], {
        cwd: this.projectRoot,
        timeoutMs: 10 * 60_000,
        onOutput,
      });

      const environment = {
        ...process.env,
        ...(input.profilesDir ? { DBT_PROFILES_DIR: input.profilesDir } : {}),
      };
      const semanticManifestPath = join(input.dbtProjectDir, 'target', 'semantic_manifest.json');
      if (!existsSync(semanticManifestPath)) {
        this.update(id, { stage: 'parsing', progress: 78, message: 'Generating the dbt semantic manifest.' });
        await this.runner(managedMetricFlowDbt(this.projectRoot), [
          'parse', '--project-dir', input.dbtProjectDir,
          ...(input.profilesDir ? ['--profiles-dir', input.profilesDir] : []),
        ], {
          cwd: input.dbtProjectDir,
          env: environment,
          timeoutMs: 3 * 60_000,
          onOutput,
        });
      }

      this.update(id, { stage: 'testing', progress: 88, message: 'Testing MetricFlow against the connected dbt project.' });
      const version = await this.runner(managedMetricFlowBin(this.projectRoot), ['--version'], {
        cwd: input.dbtProjectDir,
        env: environment,
        timeoutMs: 30_000,
        onOutput,
      });
      await this.runner(managedMetricFlowBin(this.projectRoot), ['list', 'metrics'], {
        cwd: input.dbtProjectDir,
        env: environment,
        timeoutMs: 2 * 60_000,
        onOutput,
      });
      const runtimeVersion = `${version.stdout}\n${version.stderr}`.trim().split(/\r?\n/)[0] || 'MetricFlow installed';
      this.update(id, {
        state: 'completed',
        stage: 'ready',
        progress: 100,
        runtimeVersion,
        message: 'MetricFlow is installed, tested, and active for this project.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(id, message);
      this.update(id, {
        state: 'failed',
        progress: Math.max(5, this.jobs.get(id)?.progress ?? 5),
        message: 'MetricFlow setup needs attention. Your existing dbt and DQL configuration was not replaced.',
        error: message,
      });
    }
  }
}

export function metricFlowPythonCandidates(explicit?: string): string[] {
  // Prefer a compatible, version-pinned interpreter before the unversioned
  // binaries. Homebrew may make `python3` point at a newer release before
  // dbt-metricflow supports it while keeping python3.13/3.12 installed.
  return [
    ...(explicit?.trim() ? [explicit.trim()] : []),
    'python3.13',
    'python3.12',
    'python3.11',
    'python3.10',
    'python3',
    'python',
  ];
}

function detectPythonExecutable(): { bin: string; version: string } {
  const candidates = metricFlowPythonCandidates(readEnv('ZLENS_PYTHON_BIN'));
  for (const bin of candidates) {
    const result = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 3000, env: process.env });
    if (result.error || result.status !== 0) continue;
    const version = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    const parsed = /Python\s+(\d+)\.(\d+)/i.exec(version);
    if (!parsed) continue;
    const major = Number(parsed[1]);
    const minor = Number(parsed[2]);
    if (major === 3 && minor >= 10 && minor < 14) return { bin, version };
  }
  throw new Error('Compatible Python 3.10–3.13 was not found. Install an approved version, or set ZLENS_PYTHON_BIN to that executable.');
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; onOutput: (line: string) => void },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const append = (kind: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = String(chunk);
      if (kind === 'stdout') stdout = `${stdout}${text}`.slice(-256_000);
      else stderr = `${stderr}${text}`.slice(-256_000);
      options.onOutput(text);
    };
    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail(new Error(`${command} timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`));
    }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}: ${redactInstallOutput(stderr || stdout).trim().slice(-2000)}`));
    });
  });
}

function redactInstallOutput(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***@')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/([?&](?:access_token|auth|key|password|secret|token)=)[^&\s]+/gi, '$1***')
    .replace(/(authorization:\s*)(?:bearer\s+)?[^\s]+/gi, '$1***')
    .replace(/\b(token|password|secret|api[_-]?key)=([^\s]+)/gi, '$1=***');
}

function cloneJob(job: MetricFlowInstallJob | null): MetricFlowInstallJob | null {
  return job ? { ...job, logs: [...job.logs] } : null;
}
