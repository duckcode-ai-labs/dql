import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { compile, writeBundle } from '@zlens/dql-compiler';
import { DataLexContractRegistry, resolveDataLexManifestPath } from '@zlens/core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, loadProjectConfig } from '../local-runtime.js';
import { isDigestOutput, runDigestBuild } from '../digest.js';

export async function runBuild(filePath: string, flags: CLIFlags): Promise<void> {
  const absoluteFile = resolve(filePath);
  const projectRoot = findProjectRoot(dirname(absoluteFile));
  const config = loadProjectConfig(projectRoot);
  const source = readFileSync(absoluteFile, 'utf-8');
  const datalexManifestPath = resolveDataLexManifestPath(projectRoot, flags.datalexManifestPath || undefined) ?? undefined;
  if (flags.datalexManifestPath && (!datalexManifestPath || !existsSync(datalexManifestPath))) {
    throw new Error(`DataLex manifest not found: ${flags.datalexManifestPath}`);
  }
  const result = compile(source, {
    file: absoluteFile,
    theme: config.preview?.theme ?? 'light',
    datalexRegistry: datalexManifestPath ? new DataLexContractRegistry({ manifestPath: datalexManifestPath }) : undefined,
  });

  if (result.errors.length > 0) {
    throw new Error(`Build failed:\n${result.errors.map((e) => `- ${e}`).join('\n')}`);
  }

  for (const w of result.warnings) {
    console.error(`  ⚠ ${w}`);
  }

  if (result.dashboards.length === 0) {
    throw new Error('Build requires a charted block, dashboard, or workbook that compiles to HTML output.');
  }

  const name = basename(absoluteFile, extname(absoluteFile));
  const outDir = resolve(flags.outDir || join(projectRoot, 'dist', name));
  mkdirSync(outDir, { recursive: true });

  const primary = result.dashboards[0];

  // Digest post-processing: load block SHAs, generate narrative, citation-gate,
  // and splice the narrative into the dashboard HTML + emit a markdown sibling.
  let digestDiagnostics: Array<{ level: string; message: string }> = [];
  if (isDigestOutput(primary)) {
    const digest = await runDigestBuild(primary, projectRoot);
    primary.html = digest.html;
    primary.markdown = digest.markdown;
    digestDiagnostics = digest.diagnostics;
  }

  writeBundle(primary, outDir);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      source: absoluteFile,
      outDir,
      built: true,
      digest: isDigestOutput(primary),
      diagnostics: digestDiagnostics,
      files: isDigestOutput(primary)
        ? ['index.html', 'index.md', 'dql-metadata.json', 'specs/']
        : ['index.html', 'dql-metadata.json', 'specs/'],
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Built DQL bundle`);
  console.log(`    Source: ${absoluteFile}`);
  console.log(`    Output: ${outDir}`);
  if (isDigestOutput(primary)) {
    console.log(`    Digest: narrative + markdown sibling (index.md) written`);
    const warn = digestDiagnostics.filter((d) => d.level === 'warning').length;
    if (warn > 0) {
      console.log(`    Citation gate: ${warn} warning(s)`);
      for (const d of digestDiagnostics.filter((d) => d.level === 'warning')) {
        console.log(`      ⚠ ${d.message}`);
      }
    }
  }
  console.log('');
  console.log('  Next step:');
  console.log(`    zlens serve ${outDir}`);
  console.log('');
}
