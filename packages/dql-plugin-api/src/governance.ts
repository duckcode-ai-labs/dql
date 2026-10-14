/**
 * Governance rule pack contract.
 *
 * FROZEN at v1.0. A rule pack is a named bundle of lint rules that run
 * against block ASTs — in the editor (real-time) and at `zlens certify`
 * (gating).
 */

export type Severity = 'error' | 'warning' | 'info';

/** A minimal view of a parsed block passed to rules. Keep this shape stable. */
export interface BlockView {
  name: string;
  domain?: string;
  owner?: string;
  description?: string;
  tags: string[];
  query: string;
  visualization?: string;
  path: string;                 // source file path
  metricRefs: string[];         // @metric("…") references
  dimensionRefs: string[];      // @dim("…") references
  blockRefs: string[];          // @block("…") references
  tableRefs: string[];          // @table("…") references
}

export interface Diagnostic {
  ruleId: string;
  severity: Severity;
  message: string;
  /** Optional AST span (0-based byte offsets) for editor underlining. */
  span?: { start: number; end: number };
  /** Optional fix suggestion. */
  fix?: { title: string; newText: string; span: { start: number; end: number } };
}

export interface Rule {
  id: string;                   // unique within the pack, e.g. "no-select-star"
  description: string;
  defaultSeverity: Severity;
  check(block: BlockView): Diagnostic[];
}

export interface RulePack {
  id: string;                   // unique across the ecosystem, e.g. "hipaa"
  displayName: string;
  version: string;              // semver of the pack itself
  rules: Rule[];
}
