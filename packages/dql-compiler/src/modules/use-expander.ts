import { NodeKind, type ProgramNode, type DashboardBodyItem } from '@zlens/core';
import type { ModuleSymbol } from './resolver.js';

/**
 * Expand 'use' declarations in the AST by replacing them with the
 * imported symbol's body items.
 *
 * This is used by the compiler (and the worker) so that lowering/emission sees
 * a fully inlined program after imports have been resolved.
 */
export function expandUseDeclarations(
  ast: ProgramNode,
  symbols: Map<string, ModuleSymbol>,
): void {
  if (symbols.size === 0) return;

  for (const stmt of ast.statements) {
    if (stmt.kind === NodeKind.Dashboard) {
      stmt.body = expandBodyUses(stmt.body, symbols);
    } else if (stmt.kind === NodeKind.Workbook) {
      for (const page of stmt.pages) {
        page.body = expandBodyUses(page.body, symbols);
      }
    }
  }
}

function expandBodyUses(
  body: DashboardBodyItem[],
  symbols: Map<string, ModuleSymbol>,
): DashboardBodyItem[] {
  const expanded: DashboardBodyItem[] = [];
  for (const item of body) {
    if (item.kind === NodeKind.UseDecl) {
      const symbol = symbols.get(item.name);
      if (symbol) {
        expanded.push(...symbol.items);
      } else {
        // Keep the use declaration; IR lowering will skip it gracefully
        expanded.push(item);
      }
    } else {
      expanded.push(item);
    }
  }
  return expanded;
}

