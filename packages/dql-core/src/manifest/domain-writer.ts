/**
 * Domain declaration writer (spec 17, part B).
 *
 * `scanDomains` reads first-class `domain "<Name>" { ... }` declarations and
 * `zlens doctor` warns when a used domain has no such declaration — but until now
 * there was no way to AUTHOR one. This module emits a `domain` declaration in
 * the EXACT format the parser (`parseDomainDecl`) + `scanDomains` accept, and
 * resolves the canonical on-disk location for it.
 *
 * Convention (matches `scanDomains` + the "domain-first folders" test):
 *   domains/<slug>/domain.dql      ← when a domain folder exists or is chosen
 *   domains/<slug>/domain.dql      ← created if absent (the writer makes the dir)
 *
 * A domain authored here is `name`, `owner`, `boundedContext`, `sourceSystems`,
 * `description`. `reviewCadence` is included with a sensible default so the
 * doctor's "missing reviewCadence" warning is also satisfied.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** A domain authored through the writer (spec 17, part B). */
export interface DomainInput {
  name: string;
  /** Stable dot-qualified package id. Defaults to the normalized name for compatibility. */
  id?: string;
  parent?: string;
  owner?: string;
  businessOwner?: string;
  boundedContext?: string;
  sourceSystems?: string[];
  primaryTerms?: string[];
  tags?: string[];
  businessOutcome?: string;
  description?: string;
  inScope?: string[];
  outOfScope?: string[];
  dbtGroups?: string[];
  dbtPaths?: string[];
  dbtTags?: string[];
  semanticDomains?: string[];
  semanticTags?: string[];
  /** Compatibility entity export ids; prefer structured v3 interfaces for new policy. */
  exports?: string[];
  /** Optional review cadence; defaults to "quarterly" so doctor stays quiet. */
  reviewCadence?: string;
  /** Existing project-relative source path. Used for legacy flat declarations. */
  sourcePath?: string;
}

export interface WrittenDomain {
  /** Project-relative path of the written `domain.dql`. */
  path: string;
  /** Absolute path on disk. */
  absPath: string;
  /** The folder slug under `domains/`. */
  slug: string;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Normalize a domain name/id into a folder slug under `domains/`. */
export function domainFolderSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'domain'
  );
}

function stringArrayField(name: string, values: string[] | undefined): string {
  if (!values || values.length === 0) return '';
  return `\n  ${name} = [${values.map((v) => `"${escapeString(v)}"`).join(', ')}]`;
}

/**
 * Render a first-class `domain` declaration that `scanDomains` reads back. The
 * field order + syntax mirror the parser's accepted set so a round-trip is
 * lossless for the authored fields.
 */
export function renderDomainDeclaration(domain: DomainInput): string {
  const reviewCadence = domain.reviewCadence?.trim() || 'quarterly';
  const lines = [`domain "${escapeString(domain.name)}" {`];
  if (domain.id) lines.push(`  id = "${escapeString(domain.id)}"`);
  if (domain.parent) lines.push(`  parent = "${escapeString(domain.parent)}"`);
  if (domain.owner) lines.push(`  owner = "${escapeString(domain.owner)}"`);
  if (domain.businessOwner) lines.push(`  businessOwner = "${escapeString(domain.businessOwner)}"`);
  if (domain.boundedContext) lines.push(`  boundedContext = "${escapeString(domain.boundedContext)}"`);
  lines.push(`  reviewCadence = "${escapeString(reviewCadence)}"`);
  let body = lines.join('\n');
  body += stringArrayField('sourceSystems', domain.sourceSystems);
  body += stringArrayField('primaryTerms', domain.primaryTerms);
  body += stringArrayField('tags', domain.tags);
  body += stringArrayField('inScope', domain.inScope);
  body += stringArrayField('outOfScope', domain.outOfScope);
  body += stringArrayField('dbtGroups', domain.dbtGroups);
  body += stringArrayField('dbtPaths', domain.dbtPaths);
  body += stringArrayField('dbtTags', domain.dbtTags);
  body += stringArrayField('semanticDomains', domain.semanticDomains);
  body += stringArrayField('semanticTags', domain.semanticTags);
  body += stringArrayField('exports', domain.exports);
  if (domain.businessOutcome) body += `\n  businessOutcome = "${escapeString(domain.businessOutcome)}"`;
  if (domain.description) body += `\n  description = "${escapeString(domain.description)}"`;
  body += '\n}\n';
  return body;
}

/**
 * Resolve the canonical `domains/<slug>/domain.dql` path for a domain. Honors an
 * EXISTING `domain.dql` anywhere under `domains/<slug>/` (so a PUT/DELETE finds
 * the file `scanDomains` actually read), else falls back to the canonical path.
 */
export function resolveDomainDeclPath(
  projectRoot: string,
  nameOrSlug: string,
): { absPath: string; relativePath: string; slug: string } {
  const slug = domainFolderSlug(nameOrSlug);
  const domainDir = join(projectRoot, 'domains', slug);
  // Prefer an existing declaration file (any `*.dql` that declares this domain).
  const existing = findExistingDomainFile(domainDir);
  const flat = findFlatDomainFile(join(projectRoot, 'domains'), nameOrSlug);
  const absPath = existing ?? flat ?? join(domainDir, 'domain.dql');
  return { absPath, relativePath: relative(projectRoot, absPath), slug };
}

/** Find a legacy flat `domains/<name>.dql` declaration by declared name. */
function findFlatDomainFile(domainsRoot: string, nameOrSlug: string): string | undefined {
  if (!existsSync(domainsRoot)) return undefined;
  const wanted = domainFolderSlug(nameOrSlug);
  try {
    for (const entry of readdirSync(domainsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.dql')) continue;
      const file = join(domainsRoot, entry.name);
      if (statSync(file).size > 1024 * 256) continue;
      const source = readFileSync(file, 'utf-8');
      const match = source.match(/(^|\n)\s*domain\s+"([^"]+)"/);
      if (match && domainFolderSlug(match[2] ?? '') === wanted) return file;
    }
  } catch {
    // Best effort: use the canonical nested path when the legacy file cannot be read.
  }
  return undefined;
}

/** Find an existing `.dql` file under a domain folder that declares a domain. */
function findExistingDomainFile(domainDir: string): string | undefined {
  if (!existsSync(domainDir)) return undefined;
  try {
    for (const entry of readdirSync(domainDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.dql')) continue;
      const file = join(domainDir, entry.name);
      const source = readFileSync(file, 'utf-8');
      if (/(^|\n)\s*domain\s+"/.test(source)) return file;
    }
  } catch {
    // Best-effort.
  }
  return undefined;
}

/**
 * Write (create or overwrite) a first-class domain declaration. Returns the path
 * written. The folder is created so subsequent block authoring can place blocks
 * under `domains/<slug>/blocks/`.
 */
export function writeDomainDeclaration(projectRoot: string, domain: DomainInput): WrittenDomain {
  if (!domain.name || !domain.name.trim()) {
    throw new Error('writeDomainDeclaration requires a non-empty domain name.');
  }
  const requestedPath = domain.sourcePath?.replace(/\\/g, '/').replace(/^\/+/, '');
  const safeRequested = requestedPath && requestedPath.startsWith('domains/') && !requestedPath.includes('../')
    ? join(projectRoot, requestedPath)
    : undefined;
  const resolved = resolveDomainDeclPath(projectRoot, domain.name);
  const absPath = safeRequested && existsSync(safeRequested) ? safeRequested : resolved.absPath;
  const relativePath = relative(projectRoot, absPath);
  const slug = resolved.slug;
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, renderDomainDeclaration(domain), 'utf-8');
  return { path: relativePath, absPath, slug };
}

/**
 * Delete a domain declaration file. Returns true when a file was removed. Only
 * the declaration `.dql` is removed — authored blocks/terms under the folder are
 * left untouched.
 */
export function deleteDomainDeclaration(projectRoot: string, nameOrSlug: string): boolean {
  const { absPath } = resolveDomainDeclPath(projectRoot, nameOrSlug);
  if (!existsSync(absPath)) return false;
  rmSync(absPath, { force: true });
  return true;
}
