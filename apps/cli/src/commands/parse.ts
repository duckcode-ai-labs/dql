import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DataLexContractRegistry, Parser, SemanticAnalyzer, printAST, resolveDataLexManifestPath } from '@zlens/core';
import { deserializeNotebook } from '@zlens/notebook';
import type { CLIFlags } from '../args.js';

export async function runParse(filePath: string, flags: CLIFlags): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.dqlnb')) {
    try {
      const notebook = deserializeNotebook(source);
      if (flags.format === 'json') {
        console.log(JSON.stringify({
          file: filePath,
          format: 'dqlnb',
          version: notebook.dqlnbVersion,
          title: notebook.metadata.title,
          cells: notebook.cells.length,
          cellTypes: notebook.cells.map((cell) => cell.type),
          diagnostics: [],
        }, null, 2));
      } else {
        console.log(`\n  ✓ Parsed notebook: ${filePath}`);
        console.log(`    Cells: ${notebook.cells.length}`);
        console.log('    Diagnostics: ✓ No errors, no warnings\n');
      }
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (flags.format === 'json') console.log(JSON.stringify({ file: filePath, error: message }, null, 2));
      else console.error(`\n  ✗ Notebook parse error: ${message}\n`);
      process.exit(1);
      return;
    }
  }
  const projectRoot = dirname(resolve(filePath));
  const datalexManifestPath = resolveDataLexManifestPath(projectRoot, flags.datalexManifestPath || undefined) ?? undefined;
  if (flags.datalexManifestPath && (!datalexManifestPath || !existsSync(datalexManifestPath))) {
    console.error(`\n  ✗ DataLex manifest not found: ${flags.datalexManifestPath}\n`);
    process.exit(1);
    return;
  }

  let ast;
  try {
    const parser = new Parser(source, filePath);
    ast = parser.parse();
  } catch (err: any) {
    if (flags.format === 'json') {
      console.log(JSON.stringify({ file: filePath, error: err.message }, null, 2));
    } else {
      console.error(`\n  ✗ Parse error: ${err.message}\n`);
    }
    process.exit(1);
    return;
  }

  const analyzer = new SemanticAnalyzer({
    datalexRegistry: datalexManifestPath ? new DataLexContractRegistry({ manifestPath: datalexManifestPath }) : undefined,
  });
  const diagnostics = analyzer.analyze(ast);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      file: filePath,
      statements: ast.statements.length,
      diagnostics,
      ast: flags.verbose ? ast : undefined,
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Parsed: ${filePath}`);
  console.log(`    Statements: ${ast.statements.length}`);

  if (false) {
    const parseErrors: any[] = [];
    console.log(`\n  ✗ Parse errors (${parseErrors.length}):`);
    for (const e of parseErrors) {
      console.log(`    → ${e.message}`);
    }
  }

  if (diagnostics.length > 0) {
    const errors = diagnostics.filter((d: any) => d.severity === 'error');
    const warnings = diagnostics.filter((d: any) => d.severity === 'warning');
    if (errors.length > 0) {
      console.log(`\n  ✗ Errors (${errors.length}):`);
      for (const e of errors) console.log(`    → ${e.message}`);
    }
    if (warnings.length > 0) {
      console.log(`\n  ⚠ Warnings (${warnings.length}):`);
      for (const w of warnings) console.log(`    → ${w.message}`);
    }
  } else {
    console.log('    Diagnostics: ✓ No errors, no warnings');
  }

  if (flags.verbose) {
    console.log('\n  AST:');
    console.log(printAST(ast).split('\n').map((l) => `    ${l}`).join('\n'));
  }

  console.log('');
}
