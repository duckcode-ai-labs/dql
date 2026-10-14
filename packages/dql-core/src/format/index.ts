// v0.11 canonical `.dql` serializer.
//
// Adds a stable format-version header and routes all writes through the
// formatter so that files produced by the CLI, notebook, and block studio
// byte-identical — the precondition for clean git diffs, `zlens diff`, and
// a safe file-format migration path.
//
// Format:
//   // dql-format: <N>
//   <formatted body>
//
// Readers that don't recognise a header treat it as an ordinary comment.
// Writers always emit the current version.

import { formatDQL, type FormatOptions } from '../formatter/index.js';

export * from './diff.js';
export * from './notebook.js';

export const FORMAT_VERSION = 1;
export const FORMAT_HEADER_PREFIX = '// dql-format:';

const HEADER_RE = /^\s*\/\/\s*dql-format:\s*(\d+)\s*$/;

export interface CanonicalizeOptions extends FormatOptions {
  /** Override the emitted format version. Defaults to FORMAT_VERSION. */
  version?: number;
}

/**
 * Return the declared format version of a `.dql` source, or `null` if the
 * header is absent. Only the first non-empty line is inspected.
 */
export function readFormatVersion(source: string): number | null {
  for (const line of source.split('\n')) {
    if (line.trim() === '') continue;
    const match = HEADER_RE.exec(line);
    return match ? Number(match[1]) : null;
  }
  return null;
}

export function hasCanonicalHeader(source: string): boolean {
  return readFormatVersion(source) !== null;
}

/**
 * Strip any leading `// dql-format:` header (plus a single trailing blank
 * line) so the remainder can be re-parsed by the existing formatter, which
 * does not yet preserve comments.
 */
function stripHeader(source: string): string {
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && HEADER_RE.test(lines[i])) {
    i++;
    if (i < lines.length && lines[i].trim() === '') i++;
    return lines.slice(i).join('\n');
  }
  return source;
}

/**
 * Produce the canonical on-disk representation of a `.dql` source:
 *   1. Drop any existing format header
 *   2. Reformat via `formatDQL` (deterministic key order, spacing)
 *   3. Prepend the current format header
 *
 * Idempotent: `canonicalize(canonicalize(x)) === canonicalize(x)`.
 */
export function canonicalize(source: string, options: CanonicalizeOptions = {}): string {
  const version = options.version ?? FORMAT_VERSION;
  const body = formatDQL(stripHeader(source), options);
  const header = `${FORMAT_HEADER_PREFIX} ${version}`;
  return `${header}\n\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

/**
 * True when `canonicalize(source) === source` — i.e. the file is already
 * byte-identical to its canonical form and needs no rewrite.
 */
export function isCanonical(source: string): boolean {
  return canonicalize(source) === source;
}
