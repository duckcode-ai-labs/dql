/**
 * Block retirement — `replacedBy` / `deprecatedOn` on deprecated blocks.
 *
 * A deprecated block may name the block that supersedes it:
 *
 *   block "Claims Summary (legacy)" {
 *     status = "deprecated"
 *     replacedBy = "Claims Dataset"
 *     deprecatedOn = "2026-09-30"
 *     ...
 *   }
 *
 * The replacement is a block reference: a block name, or a `.dql` path
 * relative to the project root. These helpers resolve that reference, follow
 * replacement chains, and produce the `kind: 'retirement'` manifest
 * diagnostics `dql compile` / `dql validate` print.
 *
 * Rules:
 *   - `replacedBy` / `deprecatedOn` only mean something on a deprecated block
 *     (warning otherwise).
 *   - The replacement must exist (error) and should not itself be deprecated
 *     (warning — a chain; consumers follow it to the first active block).
 *   - A replacement cycle is refused (error) and resolves to no replacement.
 *   - Blocks and App pages that still use a deprecated block are warned.
 */

import type { ManifestBlock, ManifestDashboard, ManifestDiagnostic } from './types.js';

/** Minimal block shape the helpers need; satisfied by ManifestBlock. */
export interface RetirementBlockLike {
  name: string;
  filePath?: string;
  status?: string;
  replacedBy?: string;
  deprecatedOn?: string;
}

export const DEPRECATED_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

/**
 * Resolve a block reference (name, or project-relative `.dql` path) against a
 * set of blocks. Exact name wins, then case-insensitive name, then file path.
 * A path that holds several blocks resolves only when it holds exactly one.
 */
export function resolveBlockReference<T extends RetirementBlockLike>(
  blocks: Iterable<T> | Record<string, T>,
  ref: string | undefined,
): T | undefined {
  const target = ref?.trim();
  if (!target) return undefined;
  const list: T[] = Symbol.iterator in Object(blocks)
    ? [...(blocks as Iterable<T>)]
    : Object.values(blocks as Record<string, T>);
  const exact = list.find((block) => block.name === target);
  if (exact) return exact;
  const lower = target.toLowerCase();
  const byName = list.filter((block) => block.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  const path = normalizePath(target);
  const withExt = path.endsWith('.dql') ? path : `${path}.dql`;
  const byPath = list.filter((block) => {
    if (!block.filePath) return false;
    const filePath = normalizePath(block.filePath);
    return filePath === path || filePath === withExt;
  });
  return byPath.length === 1 ? byPath[0] : undefined;
}

export function isDeprecatedStatus(status: string | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'deprecated';
}

export interface BlockReplacementResolution<T extends RetirementBlockLike = RetirementBlockLike> {
  /** The block that was asked about. */
  block: T;
  /** Deprecated blocks walked through, oldest first (includes `block` when deprecated). */
  chain: T[];
  /** First non-deprecated block at the end of the chain. Undefined when there is none. */
  replacement?: T;
  /** The chain loops back on itself. No replacement is returned. */
  cycle: boolean;
  /** A `replacedBy` along the chain does not resolve to a block. */
  unresolvedRef?: string;
}

/**
 * Follow `replacedBy` from a deprecated block to the first active block.
 * Returns `undefined` for a block that is not deprecated.
 */
export function resolveBlockReplacement<T extends RetirementBlockLike>(
  blocks: Iterable<T> | Record<string, T>,
  block: T,
): BlockReplacementResolution<T> | undefined {
  if (!isDeprecatedStatus(block.status)) return undefined;
  const list: T[] = Symbol.iterator in Object(blocks)
    ? [...(blocks as Iterable<T>)]
    : Object.values(blocks as Record<string, T>);
  const chain: T[] = [];
  const seen = new Set<T>();
  let current: T = block;
  while (true) {
    if (seen.has(current)) return { block, chain, cycle: true };
    seen.add(current);
    if (!isDeprecatedStatus(current.status)) return { block, chain, replacement: current, cycle: false };
    chain.push(current);
    const ref = current.replacedBy?.trim();
    if (!ref) return { block, chain, cycle: false };
    const next = resolveBlockReference(list, ref);
    if (!next) return { block, chain, cycle: false, unresolvedRef: ref };
    current = next;
  }
}

/** One-line author-facing notice for a deprecated block. */
export function retirementNotice(
  block: RetirementBlockLike,
  replacement?: RetirementBlockLike,
): string {
  const on = block.deprecatedOn ? ` on ${block.deprecatedOn}` : '';
  return replacement
    ? `${block.name} was retired${on}; use ${replacement.name} instead.`
    : `${block.name} was retired${on}.`;
}

export interface RetirementValidationInput {
  blocks: Record<string, ManifestBlock>;
  dashboards?: Record<string, ManifestDashboard>;
  /** Map a v3 Dataset tile `sourceId` back to its block, when the caller can. */
  resolveDatasetSource?: (sourceId: string) => ManifestBlock | undefined;
}

/**
 * Validate retirement metadata and report remaining uses of deprecated
 * blocks. Returns `kind: 'retirement'` diagnostics.
 */
export function validateBlockRetirements(input: RetirementValidationInput): ManifestDiagnostic[] {
  const diagnostics: ManifestDiagnostic[] = [];
  const blocks = Object.values(input.blocks);

  for (const block of blocks) {
    const deprecated = isDeprecatedStatus(block.status);
    if (!deprecated) {
      if (block.replacedBy || block.deprecatedOn) {
        const fields = [block.replacedBy ? 'replacedBy' : '', block.deprecatedOn ? 'deprecatedOn' : ''].filter(Boolean).join(' and ');
        diagnostics.push({
          kind: 'retirement',
          filePath: block.filePath,
          severity: 'warning',
          message: `Block "${block.name}" sets ${fields} but its status is "${block.status ?? 'draft'}"; these fields only apply when status = "deprecated".`,
        });
      }
      continue;
    }
    if (block.deprecatedOn && !DEPRECATED_ON_PATTERN.test(block.deprecatedOn)) {
      diagnostics.push({
        kind: 'retirement',
        filePath: block.filePath,
        severity: 'warning',
        message: `Block "${block.name}" has deprecatedOn = "${block.deprecatedOn}"; use a date in YYYY-MM-DD form.`,
      });
    }
    if (!block.replacedBy) continue;
    const target = resolveBlockReference(blocks, block.replacedBy);
    if (!target) {
      diagnostics.push({
        kind: 'retirement',
        filePath: block.filePath,
        severity: 'error',
        message: `Block "${block.name}" is replaced by "${block.replacedBy}", which is not a block in this project.`,
      });
      continue;
    }
    if (target === block) {
      diagnostics.push({
        kind: 'retirement',
        filePath: block.filePath,
        severity: 'error',
        message: `Block "${block.name}" names itself as its replacement.`,
      });
      continue;
    }
    if (!isDeprecatedStatus(target.status)) continue;
    const resolution = resolveBlockReplacement(blocks, block)!;
    if (resolution.cycle) {
      diagnostics.push({
        kind: 'retirement',
        filePath: block.filePath,
        severity: 'error',
        message: `Block "${block.name}" is part of a replacement cycle (${resolution.chain.map((b) => b.name).join(' → ')} → ${resolution.chain[0]?.name ?? block.name}). Point replacedBy at an active block.`,
      });
      continue;
    }
    const end = resolution.replacement
      ? `; DQL follows the chain to "${resolution.replacement.name}"`
      : '; the chain does not reach an active block';
    diagnostics.push({
      kind: 'retirement',
      filePath: block.filePath,
      severity: 'warning',
      message: `Block "${block.name}" is replaced by "${target.name}", which is itself deprecated${end}. Point replacedBy at the active block.`,
    });
  }

  const replacementHint = (old: ManifestBlock): string => {
    const resolution = resolveBlockReplacement(blocks, old);
    return resolution?.replacement ? ` Use "${resolution.replacement.name}" instead.` : '';
  };

  // Blocks that still ref() a deprecated block.
  for (const block of blocks) {
    if (isDeprecatedStatus(block.status)) continue;
    const seen = new Set<string>();
    for (const ref of block.refDependencies ?? []) {
      const used = resolveBlockReference(blocks, ref);
      if (!used || used === block || !isDeprecatedStatus(used.status) || seen.has(used.name)) continue;
      seen.add(used.name);
      diagnostics.push({
        kind: 'retirement',
        filePath: block.filePath,
        severity: 'warning',
        message: `Block "${block.name}" still references deprecated block "${used.name}".${replacementHint(used)}`,
      });
    }
  }

  // App pages that still bind a deprecated block.
  for (const dashboard of Object.values(input.dashboards ?? {})) {
    const used = new Map<string, ManifestBlock>();
    for (const name of [...(dashboard.blockIds ?? []), ...(dashboard.blockPathRefs ?? [])]) {
      const block = input.blocks[name] ?? resolveBlockReference(blocks, name);
      if (block && isDeprecatedStatus(block.status)) used.set(block.name, block);
    }
    for (const tile of dashboard.datasetTiles ?? []) {
      const block = input.resolveDatasetSource?.(tile.sourceId);
      if (block && isDeprecatedStatus(block.status)) used.set(block.name, block);
    }
    for (const block of used.values()) {
      diagnostics.push({
        kind: 'retirement',
        filePath: dashboard.filePath,
        severity: 'warning',
        message: `App page "${dashboard.qualifiedId}" still uses deprecated block "${block.name}".${replacementHint(block)}`,
      });
    }
  }

  return diagnostics;
}
