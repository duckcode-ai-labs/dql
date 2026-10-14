import { parse, analyze, NodeKind, type DataLexContractRegistry, type SemanticLayer } from '@zlens/core';
import type { ProgramNode, DashboardBodyItem } from '@zlens/core';
import { lowerProgram, lowerWorkbookProgram } from './ir/lowering.js';
import { emitChartSpecs } from './codegen/vega-lite-emitter.js';
import { emitDashboardHTML, emitWorkbookHTML } from './codegen/html-emitter.js';
import { emitRuntimeJS } from './codegen/runtime-emitter.js';
import { getTheme } from './themes/index.js';
import { ModuleResolver } from './modules/resolver.js';
import { expandUseDeclarations } from './modules/use-expander.js';
import type { CompilationOutput } from './codegen/bundle.js';
import type { DashboardIR, DigestIR } from './ir/ir-nodes.js';
import { dirname } from 'node:path';

// Ensure chart emitters are registered
import './charts/index.js';

export interface CompileOptions {
  theme?: string;
  file?: string;
  semanticLayer?: SemanticLayer;
  datalexRegistry?: DataLexContractRegistry;
  vegaAssets?: 'cdn' | 'local';
  vegaBasePath?: string;
}

export interface CompileResult {
  dashboards: CompilationOutput[];
  errors: string[];
  /**
   * Non-fatal warnings from the compile pass. Includes feature-deprecation
   * notices (e.g. `workbook` slated for removal in v1.3). Callers should
   * print these to stderr but must not fail the build on them.
   */
  warnings: string[];
  isWorkbook: boolean;
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Parse
  const ast = parse(source, options.file);

  // 2. Resolve imports (if file path is available for relative resolution)
  if (options.file) {
    try {
      const resolver = new ModuleResolver(dirname(options.file));
      const registry = resolver.resolveImports(ast);

      // Expand 'use' declarations in the AST by inlining imported symbols
      expandUseDeclarations(ast, registry.symbols);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Module resolution failed';
      errors.push(`import: ${msg}`);
    }
  }

  // 3. Semantic analysis
  const diagnostics = analyze(ast, { datalexRegistry: options.datalexRegistry });
  for (const d of diagnostics) {
    if (d.severity === 'error') {
      errors.push(`${d.span.start.line}:${d.span.start.column}: ${d.message}`);
    }
  }

  // 4. Check if this is a workbook
  const hasWorkbook = ast.statements.some((s) => s.kind === NodeKind.Workbook);
  const themeName = options.theme ?? 'light';
  const theme = getTheme(themeName);

  if (hasWorkbook) {
    // v1.2 deprecation: workbook compiles to a tabbed dashboard. Removal
    // planned for v1.3 — see docs/migrations/workbook-to-dashboard.md.
    warnings.push(
      'workbook { } is deprecated and will be removed in v1.3. Replace with dashboard { tabs: [...] }. See docs/migrations/workbook-to-dashboard.md.',
    );
  }

  if (hasWorkbook) {
    // Workbook mode: emit tabbed page HTML
    const loweringDiagnostics: string[] = [];
    const workbookIR = lowerWorkbookProgram(ast, {
      semanticLayer: options.semanticLayer,
      diagnostics: loweringDiagnostics,
    });
    for (const msg of loweringDiagnostics) {
      errors.push(`lowering: ${msg}`);
    }
    if (workbookIR) {
      const allChartSpecs = workbookIR.pages.flatMap((page) => emitChartSpecs(page.charts, theme));
      const runtimeJS = emitRuntimeJS();
      const html = emitWorkbookHTML(workbookIR, theme, runtimeJS, {
        vegaAssets: options.vegaAssets ?? 'cdn',
        vegaBasePath: options.vegaBasePath,
      });

      const output: CompilationOutput = {
        html,
        chartSpecs: allChartSpecs,
        runtimeJS,
        metadata: {
          title: workbookIR.title,
          schedule: workbookIR.schedule,
          notifications: workbookIR.notifications,
          alerts: workbookIR.alerts,
          queries: workbookIR.pages.flatMap((p) =>
            p.charts.map((c) => ({ id: c.id, sql: c.sql, sqlParams: c.sqlParams })),
          ),
          layoutDiagnostics: workbookIR.pages.flatMap((p) => p.layoutDiagnostics ?? []),
        },
      };

      return { dashboards: [output], errors, warnings, isWorkbook: true };
    }
  }

  // 4. Standard dashboard mode: Lower to IR
  const loweringDiagnostics: string[] = [];
  const dashboardIRs = lowerProgram(ast, {
    semanticLayer: options.semanticLayer,
    diagnostics: loweringDiagnostics,
  });
  for (const msg of loweringDiagnostics) {
    errors.push(`lowering: ${msg}`);
  }

  // 5. Generate output for each dashboard
  const dashboards: CompilationOutput[] = dashboardIRs.map((ir) => {
    const chartSpecs = emitChartSpecs(ir.charts, theme);
    const runtimeJS = emitRuntimeJS();
    const html = emitDashboardHTML(ir, chartSpecs, theme, runtimeJS, {
      vegaAssets: options.vegaAssets ?? 'cdn',
      vegaBasePath: options.vegaBasePath,
    });

    const narrative = (ir as DigestIR).narrative;

    return {
      html,
      chartSpecs,
      runtimeJS,
      metadata: {
        title: ir.title,
        schedule: ir.schedule,
        notifications: ir.notifications,
        alerts: ir.alerts,
        queries: ir.charts.map((c) => ({ id: c.id, sql: c.sql, sqlParams: c.sqlParams })),
        layoutDiagnostics: ir.layoutDiagnostics,
        narrative,
        dependencies: ir.dependencies,
      },
    };
  });

  return { dashboards, errors, warnings, isWorkbook: false };
}
