import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import {
  DataLexContractRegistry,
  Parser,
  analyze,
  buildManifest,
  loadSemanticLayerFromDir,
  resolveDataLexManifestPath,
  type SemanticLayer,
  type Diagnostic as CoreDiagnostic,
} from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';

interface Diagnostic {
  file: string;
  severity: 'error' | 'warning';
  message: string;
  line?: number;
}

interface ValidationFile {
  filePath: string;
  relativePath: string;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function findProjectRoot(startPath: string): string {
  let current = existsSync(startPath) && statSync(startPath).isFile() ? dirname(startPath) : startPath;

  while (true) {
    if (existsSync(join(current, 'dql.config.json')) || existsSync(join(current, 'blocks')) || existsSync(join(current, 'semantic-layer'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return startPath;
    current = parent;
  }
}

function collectDqlFilesFromDir(dirPath: string, projectRoot: string): ValidationFile[] {
  if (!existsSync(dirPath)) return [];

  const files: ValidationFile[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDqlFilesFromDir(entryPath, projectRoot));
    } else if (entry.isFile() && extname(entry.name) === '.dql') {
      files.push({
        filePath: entryPath,
        relativePath: normalizePath(relative(projectRoot, entryPath)),
      });
    }
  }
  return files;
}

function collectValidationFiles(targetPath: string | null): { projectRoot: string; files: ValidationFile[] } {
  const target = resolve(targetPath ?? '.');
  const projectRoot = findProjectRoot(target);

  if (existsSync(target)) {
    const targetStat = statSync(target);
    if (targetStat.isFile()) {
      return {
        projectRoot,
        files: extname(target) === '.dql'
          ? [{ filePath: target, relativePath: normalizePath(relative(projectRoot, target)) }]
          : [],
      };
    }

    if (targetStat.isDirectory() && target !== projectRoot) {
      return {
        projectRoot,
        files: collectDqlFilesFromDir(target, projectRoot),
      };
    }
  }

  // Domain-owned blocks and terms live under domains/<id>/ (e.g. domains/claims/blocks).
  const dirs = ['blocks', 'terms', 'business-views', 'dashboards', 'workbooks', 'domains'];
  return {
    projectRoot,
    files: dirs.flatMap((dir) => collectDqlFilesFromDir(join(projectRoot, dir), projectRoot)),
  };
}

export async function runValidate(path: string | null, flags: CLIFlags): Promise<void> {
  const { projectRoot, files } = collectValidationFiles(path);
  const diagnostics: Diagnostic[] = [];
  const targetPath = resolve(path ?? '.');

  // Load semantic layer if present
  let semanticLayer: SemanticLayer | undefined;
  const semanticDir = join(projectRoot, 'semantic-layer');
  if (existsSync(semanticDir)) {
    try {
      semanticLayer = loadSemanticLayerFromDir(semanticDir);
    } catch (err) {
      diagnostics.push({
        file: 'semantic-layer/',
        severity: 'error',
        message: `Failed to load semantic layer: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  let datalexRegistry: DataLexContractRegistry | undefined;
  const datalexManifestPath = resolveDataLexManifestPath(projectRoot, flags.datalexManifestPath || undefined) ?? undefined;
  if (flags.datalexManifestPath && (!datalexManifestPath || !existsSync(datalexManifestPath))) {
    diagnostics.push({
      file: flags.datalexManifestPath,
      severity: 'error',
      message: `DataLex manifest not found: ${flags.datalexManifestPath}`,
    });
  } else if (datalexManifestPath) {
    datalexRegistry = new DataLexContractRegistry({ manifestPath: datalexManifestPath });
    for (const message of datalexRegistry.loadDiagnostics()) {
      diagnostics.push({
        file: relative(projectRoot, datalexManifestPath),
        severity: 'warning',
        message,
      });
    }
  }

  for (const { filePath, relativePath } of files) {
    try {
      const source = readFileSync(filePath, 'utf-8');
      const parser = new Parser(source, relativePath);
      const ast = parser.parse();

      // Run semantic analysis
      try {
        const diags: CoreDiagnostic[] = analyze(ast, { datalexRegistry });
        for (const diag of diags) {
          diagnostics.push({
            file: relativePath,
            severity: diag.severity === 'error' ? 'error' : 'warning',
            message: diag.message,
            line: diag.span?.start?.line,
          });
        }
      } catch {
        // analyze may throw on some inputs
      }

      // Check semantic block metric references
      for (const stmt of ast.statements) {
        if ((stmt as any).kind !== 'BlockDecl') continue;
        const block = stmt as any;
        const semanticMetrics = block.metricsRef?.length ? block.metricsRef : (block.metricRef ? [block.metricRef] : []);
        if (block.blockType === 'semantic' && semanticMetrics.length > 0) {
          if (semanticLayer) {
            const composed = semanticLayer.composeQuery({
              metrics: semanticMetrics,
              dimensions: block.dimensionsRef ?? [],
            });
            if (!composed) {
              diagnostics.push({
                file: relativePath,
                severity: 'error',
                message: `Semantic references in block "${block.name}" could not be composed. Check metrics [${semanticMetrics.join(', ')}] and dimensions [${(block.dimensionsRef ?? []).join(', ')}].`,
              });
            }
          } else {
            diagnostics.push({
              file: relativePath,
              severity: 'warning',
              message: `Semantic block "${block.name}" references metrics [${semanticMetrics.join(', ')}] but no semantic-layer/ directory exists`,
            });
          }
        }
      }
    } catch (err) {
      diagnostics.push({
        file: relativePath,
        severity: 'error',
        message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const shouldRunProjectManifestValidation = existsSync(join(projectRoot, 'dql.config.json'))
    && (!existsSync(targetPath) || statSync(targetPath).isDirectory());
  if (shouldRunProjectManifestValidation) {
    try {
      const manifest = buildManifest({
        projectRoot,
        datalexManifestPath,
      });
      for (const diag of manifest.diagnostics ?? []) {
        if (diag.kind !== 'resolve' || (!diag.message.includes('business_view') && !diag.message.includes('term refs'))) continue;
        diagnostics.push({
          file: diag.filePath ?? 'dql-manifest.json',
          severity: diag.severity,
          message: diag.message,
        });
      }
    } catch (err) {
      diagnostics.push({
        file: 'dql-manifest.json',
        severity: 'error',
        message: `Manifest validation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const fileCount = files.length;

  // Output
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  if (flags.format === 'json') {
    console.log(JSON.stringify({ files: fileCount, diagnostics }, null, 2));
  } else {
    console.log(`\n  Validated ${fileCount} DQL file(s)\n`);
    if (diagnostics.length === 0) {
      console.log('  All files are valid.\n');
    } else {
      for (const d of diagnostics) {
        const loc = d.line ? `:${d.line}` : '';
        const icon = d.severity === 'error' ? 'ERROR' : 'WARN';
        console.log(`  ${icon} ${d.file}${loc}: ${d.message}`);
      }
      console.log(`\n  ${errors.length} error(s), ${warnings.length} warning(s)\n`);
    }
  }

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
