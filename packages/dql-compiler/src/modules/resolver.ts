import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse, type ProgramNode, type DashboardBodyItem, NodeKind } from '@zlens/core';

export interface ModuleSymbol {
  name: string;
  items: DashboardBodyItem[];
}

export interface ModuleRegistry {
  symbols: Map<string, ModuleSymbol>;
}

export class ModuleResolver {
  private registry: ModuleRegistry = { symbols: new Map() };
  private resolvedFiles: Set<string> = new Set();

  constructor(private baseDir: string) {}

  resolveImports(program: ProgramNode): ModuleRegistry {
    for (const stmt of program.statements) {
      if (stmt.kind === NodeKind.ImportDecl) {
        const filePath = this.resolveFilePath(stmt.path);
        if (!filePath) {
          console.warn(`[DQL] Import file not found: ${stmt.path}`);
          continue;
        }

        if (this.resolvedFiles.has(filePath)) {
          continue; // Already resolved, avoid circular imports
        }
        this.resolvedFiles.add(filePath);

        const importedProgram = this.parseFile(filePath);
        if (!importedProgram) continue;

        // Recursively resolve imports in the imported file
        const nestedResolver = new ModuleResolver(dirname(filePath));
        nestedResolver.resolvedFiles = this.resolvedFiles;
        nestedResolver.resolveImports(importedProgram);

        // Merge nested symbols
        for (const [name, symbol] of nestedResolver.registry.symbols) {
          this.registry.symbols.set(name, symbol);
        }

        // Extract named exports from the imported file
        this.extractSymbols(importedProgram, stmt.names);
      }
    }

    return this.registry;
  }

  getSymbol(name: string): ModuleSymbol | undefined {
    return this.registry.symbols.get(name);
  }

  private extractSymbols(program: ProgramNode, requestedNames: string[]): void {
    for (const stmt of program.statements) {
      if (stmt.kind === NodeKind.Dashboard) {
        // Dashboard name can be used as a symbol
        const dashName = this.toIdentifier(stmt.title);
        if (requestedNames.length === 0 || requestedNames.includes(dashName)) {
          this.registry.symbols.set(dashName, {
            name: dashName,
            items: stmt.body,
          });
        }

        // Also extract individual named items from the dashboard body
        for (const item of stmt.body) {
          if (item.kind === NodeKind.VariableDecl) {
            if (requestedNames.includes(item.name)) {
              this.registry.symbols.set(item.name, {
                name: item.name,
                items: [item],
              });
            }
          } else if (item.kind === NodeKind.FilterCall) {
            // Use the param name as the symbol name
            const paramArg = item.args.find((a) => a.name === 'param');
            if (paramArg && paramArg.value.kind === NodeKind.StringLiteral) {
              const filterName = paramArg.value.value;
              if (requestedNames.includes(filterName)) {
                this.registry.symbols.set(filterName, {
                  name: filterName,
                  items: [item],
                });
              }
            }
          }
        }
      }
    }
  }

  private resolveFilePath(importPath: string): string | null {
    // Try with and without .dql extension
    const candidates = [
      resolve(this.baseDir, importPath),
      resolve(this.baseDir, importPath + '.dql'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private parseFile(filePath: string): ProgramNode | null {
    try {
      const source = readFileSync(filePath, 'utf-8');
      return parse(source, filePath);
    } catch (error) {
      console.warn(`[DQL] Failed to parse imported file ${filePath}:`, error);
      return null;
    }
  }

  private toIdentifier(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }
}
