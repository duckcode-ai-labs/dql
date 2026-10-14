/**
 * Manifest build benchmark — validates the v0.9 "Scale & Sync" thesis.
 *
 * Generates a synthetic dbt project with N models (default 4000) and a handful
 * of DQL blocks anchored at the tail of the dbt DAG, then measures:
 *
 *   cold   — first compile, no cache
 *   warm   — second compile, cache hit path
 *   edit   — third compile after touching one block, cache miss + rebuild
 *
 * Pass criteria (from the v0.9 verification plan):
 *   cold < 30000 ms
 *   warm <  2000 ms
 *   edit <  5000 ms
 *
 * Run:  pnpm --filter @zlens/cli bench:manifest [-- --models 4000]
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, collectInputFiles } from '@zlens/core';
import { ManifestCache } from '@zlens/project';

interface BenchOptions {
  models: number;
  blocks: number;
  anchorFanIn: number;
}

const DEFAULTS: BenchOptions = { models: 4000, blocks: 12, anchorFanIn: 6 };

function parseArgs(argv: string[]): BenchOptions {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--models' && argv[i + 1]) opts.models = parseInt(argv[++i], 10);
    else if (argv[i] === '--blocks' && argv[i + 1]) opts.blocks = parseInt(argv[++i], 10);
  }
  return opts;
}

interface DbtNode {
  resource_type: 'model';
  name: string;
  alias: string;
  schema: string;
  database: string;
  depends_on: { nodes: string[] };
  tags: string[];
  original_file_path: string;
  config: { materialized: string };
  raw_code?: string;
  compiled_code?: string;
}

function generateDbtManifest(modelCount: number): { nodes: Record<string, DbtNode>; sources: Record<string, unknown>; metadata: { project_name: string } } {
  const nodes: Record<string, DbtNode> = {};

  // Layers: raw (25%) -> staging (35%) -> intermediate (25%) -> marts (15%)
  const rawCount = Math.floor(modelCount * 0.25);
  const stagingCount = Math.floor(modelCount * 0.35);
  const intermediateCount = Math.floor(modelCount * 0.25);
  const martsCount = modelCount - rawCount - stagingCount - intermediateCount;

  const layerOf = (i: number): { layer: string; prefix: string } => {
    if (i < rawCount) return { layer: 'raw', prefix: 'raw' };
    if (i < rawCount + stagingCount) return { layer: 'staging', prefix: 'stg' };
    if (i < rawCount + stagingCount + intermediateCount) return { layer: 'intermediate', prefix: 'int' };
    return { layer: 'marts', prefix: 'mart' };
  };

  for (let i = 0; i < modelCount; i++) {
    const { layer, prefix } = layerOf(i);
    const name = `${prefix}_model_${i}`;
    const id = `model.demo.${name}`;

    // Each model depends on 1-2 earlier models in a prior layer.
    const deps: string[] = [];
    if (layer !== 'raw') {
      const maxDep = i;
      const dep1 = Math.max(0, Math.floor(i - 10 - Math.random() * 20));
      if (dep1 < maxDep) {
        const d = layerOf(dep1);
        deps.push(`model.demo.${d.prefix}_model_${dep1}`);
      }
      if (layer !== 'staging' && Math.random() > 0.5) {
        const dep2 = Math.max(0, Math.floor(i - 5 - Math.random() * 15));
        if (dep2 < maxDep && dep2 !== dep1) {
          const d = layerOf(dep2);
          deps.push(`model.demo.${d.prefix}_model_${dep2}`);
        }
      }
    }

    nodes[id] = {
      resource_type: 'model',
      name,
      alias: name,
      schema: layer,
      database: 'db',
      depends_on: { nodes: deps },
      tags: [layer],
      original_file_path: `models/${layer}/${name}.sql`,
      config: { materialized: layer === 'marts' ? 'table' : 'view' },
      raw_code: `select 1 as col from ${deps[0] ?? 'source_table'}`,
      compiled_code: `select 1 as col from ${deps[0] ?? 'source_table'}`,
    };
  }

  return { nodes, sources: {}, metadata: { project_name: 'demo' } };
}

function seedProject(opts: BenchOptions): { root: string; anchors: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'dql-bench-'));

  // Find mart models to anchor against
  const dbtManifest = generateDbtManifest(opts.models);
  const martNames = Object.values(dbtManifest.nodes)
    .filter((n) => n.schema === 'marts')
    .map((n) => n.name);
  const anchors = martNames.slice(0, opts.anchorFanIn);

  writeFileSync(
    join(root, 'dql.config.json'),
    JSON.stringify({
      project: 'bench',
      dbtImport: { anchors },
    }),
  );

  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'target', 'manifest.json'), JSON.stringify(dbtManifest));

  mkdirSync(join(root, 'blocks'), { recursive: true });
  for (let i = 0; i < opts.blocks; i++) {
    const anchor = anchors[i % anchors.length];
    writeFileSync(
      join(root, 'blocks', `block_${i}.dql`),
      `block "Block${i}" {
  domain = "bench"
  type = "custom"
  query = """SELECT COUNT(*) AS total FROM ${anchor}"""
}`,
    );
  }

  return { root, anchors };
}

interface RunResult {
  label: string;
  ms: number;
  blocks: number;
  dbtModels: number;
  cacheHit: boolean;
}

function runCompile(
  root: string,
  opts: { useCache: boolean; force?: boolean },
): RunResult {
  const dbtManifestPath = join(root, 'target', 'manifest.json');
  const cachePath = join(root, '.dql', 'cache', 'manifest.sqlite');
  const buildOptions = { projectRoot: root, dbtManifestPath };

  const start = process.hrtime.bigint();

  let manifest;
  let cacheHit = false;

  if (!opts.useCache) {
    manifest = buildManifest(buildOptions);
  } else {
    const cache = new ManifestCache({ path: cachePath });
    try {
      const files = collectInputFiles(buildOptions).map((path) => ({ path }));
      const fingerprint = cache.fingerprint(files);
      const lookup = cache.lookup(fingerprint, files);
      if (lookup.hit && !opts.force) {
        manifest = lookup.value as ReturnType<typeof buildManifest>;
        cacheHit = true;
      } else {
        manifest = buildManifest(buildOptions);
        cache.put(fingerprint, manifest, files);
      }
    } finally {
      cache.close();
    }
  }

  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    label: '',
    ms,
    blocks: Object.keys(manifest.blocks).length,
    dbtModels: manifest.dbtImport?.dbtDag?.models.length ?? 0,
    cacheHit,
  };
}

function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - s.length));
}

function format(r: RunResult, target: number): string {
  const ok = r.ms <= target;
  const mark = ok ? 'PASS' : 'FAIL';
  return `  ${pad(r.label, 8)} ${pad(r.ms.toFixed(1) + ' ms', 12)} target ${pad(target + ' ms', 10)} [${mark}]  ${r.cacheHit ? 'cache HIT' : 'built'}  blocks=${r.blocks}  dbtModels=${r.dbtModels}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`\n  DQL manifest benchmark`);
  console.log('  ' + '='.repeat(60));
  console.log(`  Synthetic project: ${opts.models} dbt models, ${opts.blocks} DQL blocks, ${opts.anchorFanIn} anchors`);

  const t0 = Date.now();
  const { root } = seedProject(opts);
  console.log(`  Seeded ${root} in ${Date.now() - t0} ms\n`);

  try {
    // Cold — no cache
    const cold = { ...runCompile(root, { useCache: false }), label: 'cold' };
    console.log(format(cold, 30000));

    // Warm #1 — first cache write
    const warm1 = { ...runCompile(root, { useCache: true }), label: 'warm-1' };
    console.log(format(warm1, 30000));

    // Warm #2 — cache hit
    const warm2 = { ...runCompile(root, { useCache: true }), label: 'warm-2' };
    console.log(format(warm2, 2000));

    // Edit one block — cache miss + rebuild
    writeFileSync(
      join(root, 'blocks', 'block_0.dql'),
      `block "Block0" {
  domain = "bench"
  type = "custom"
  query = """SELECT COUNT(DISTINCT id) AS total FROM mart_model_${opts.models - 1}"""
}`,
    );
    const edit = { ...runCompile(root, { useCache: true }), label: 'edit' };
    console.log(format(edit, 5000));

    // Warm again after edit — should hit cache
    const warm3 = { ...runCompile(root, { useCache: true }), label: 'warm-3' };
    console.log(format(warm3, 2000));

    console.log('');
    const targets: Array<[RunResult, number]> = [
      [cold, 30000],
      [warm2, 2000],
      [edit, 5000],
    ];
    const failed = targets.filter(([r, t]) => r.ms > t);
    if (failed.length > 0) {
      console.error(`  ${failed.length} benchmark(s) missed target`);
      process.exitCode = 1;
    } else {
      console.log('  All benchmarks within target.');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
