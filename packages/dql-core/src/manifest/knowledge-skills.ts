import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import type { DomainPackageRegistryResult } from './domain-package-registry.js';
import type { ManifestDiagnostic } from './types.js';

type UnknownRecord = Record<string, unknown>;

export interface ManifestKnowledgeSkillDescriptor {
  id: string;
  localId: string;
  qualifiedId: string;
  domain?: string;
  domains: string[];
  modelAreaRefs: string[];
  kind: string;
  status: 'draft' | 'active' | 'deprecated';
  owner?: string;
  description?: string;
  triggers: string[];
  exclusions: string[];
  preferredMetrics: string[];
  preferredBlocks: string[];
  preferredDimensions: string[];
  requiredFilters: string[];
  clarifyWhen: string[];
  examples: string[];
  sourceRefs: string[];
  vocabulary: Record<string, string>;
  sourcePath: string;
  contentHash: string;
  bodyHash: string;
  /** Compatibility hook only; ZLens does not execute bundled Agent Skill scripts. */
  format: 'dql-knowledge-v1';
}

export interface ManifestKnowledgeSkillLoadResult {
  skills: ManifestKnowledgeSkillDescriptor[];
  diagnostics: ManifestDiagnostic[];
  files: string[];
}

/**
 * Parse the Git-owned skill catalog at compile time. Only compact descriptors
 * and content hashes enter the manifest; full Markdown is hydrated into the
 * immutable search snapshot by dql-agent.
 */
export function loadManifestKnowledgeSkills(
  projectRoot: string,
  registry?: DomainPackageRegistryResult,
): ManifestKnowledgeSkillLoadResult {
  const diagnostics: ManifestDiagnostic[] = [];
  const roots: Array<{ path: string; inferredDomain?: string }> = [
    ...(registry?.values().map((pkg) => ({ path: join(pkg.root, 'skills'), inferredDomain: pkg.id })) ?? []),
    { path: resolveConfiguredSkillsRoot(projectRoot) },
    { path: join(projectRoot, '.dql', 'skills') },
  ];
  const files = [...new Set(roots.flatMap((root) => walkSkillFiles(root.path)))].sort();
  const rootByFile = (file: string) => roots
    .filter((root) => file === root.path || file.startsWith(`${root.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const domainAliases = new Map<string, string>();
  for (const pkg of registry?.values() ?? []) {
    domainAliases.set(pkg.id.toLowerCase(), pkg.id);
    domainAliases.set(pkg.name.toLowerCase(), pkg.id);
  }
  const seenFiles = new Set<string>();
  const seenIds = new Map<string, string>();
  const skills: ManifestKnowledgeSkillDescriptor[] = [];

  for (const file of files) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const sourcePath = relative(projectRoot, file).replace(/\\/g, '/');
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = parseDescriptor(raw, sourcePath, rootByFile(file)?.inferredDomain, domainAliases);
      if (!parsed) {
        diagnostics.push({ kind: 'parse', filePath: sourcePath, severity: 'warning', message: 'Skill file has no YAML frontmatter and was not compiled.' });
        continue;
      }
      const existing = seenIds.get(parsed.qualifiedId);
      if (existing) {
        diagnostics.push({ kind: 'resolve', filePath: sourcePath, severity: 'error', message: `Duplicate skill "${parsed.qualifiedId}" also declared in ${existing}.` });
        continue;
      }
      seenIds.set(parsed.qualifiedId, sourcePath);
      skills.push(parsed);
    } catch (error) {
      diagnostics.push({ kind: 'parse', filePath: sourcePath, severity: 'error', message: `Failed to parse skill: ${message(error)}` });
    }
  }

  return { skills: skills.sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId)), diagnostics, files };
}

export function manifestKnowledgeSkillInputFiles(projectRoot: string, registry?: DomainPackageRegistryResult): string[] {
  const roots = [
    ...(registry?.values().map((pkg) => join(pkg.root, 'skills')) ?? []),
    resolveConfiguredSkillsRoot(projectRoot),
    join(projectRoot, '.dql', 'skills'),
  ];
  return [...new Set(roots.flatMap(walkSkillFiles))].sort();
}

function parseDescriptor(
  raw: string,
  sourcePath: string,
  inferredDomain: string | undefined,
  domainAliases: Map<string, string>,
): ManifestKnowledgeSkillDescriptor | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return null;
  const meta = record(yaml.load(match[1]));
  const body = match[2].trim();
  const localId = stringValue(meta.id) ?? sourcePath.split('/').at(-1)?.replace(/\.skill\.md$|\.md$/, '') ?? 'skill';
  const declaredDomains = stringArray(meta.domains ?? meta.domain).map((domain) => canonicalDomain(domain, domainAliases));
  const domains = unique(declaredDomains.length > 0 ? declaredDomains : inferredDomain ? [inferredDomain] : []);
  const declaredOwner = stringValue(meta.domain);
  const canonicalOwner = declaredOwner ? canonicalDomain(declaredOwner, domainAliases) : undefined;
  const domain = canonicalOwner ?? (domains.length === 1 ? domains[0] : inferredDomain);
  if (inferredDomain && canonicalOwner && canonicalOwner !== inferredDomain) {
    throw new Error(`Skill domain "${canonicalOwner}" conflicts with owning Domain Package "${inferredDomain}".`);
  }
  if (inferredDomain && domains.length > 0 && !domains.includes(inferredDomain)) {
    throw new Error(`Cross-domain skill must include its owning Domain Package "${inferredDomain}".`);
  }
  const ownerScope = domains.length === 1
    ? domains[0]
    : domains.length > 1
      ? `cross_domain_${[...domains].sort().join('_')}`
      : 'global';
  const statusValue = stringValue(meta.status);
  const status = statusValue === 'draft' || statusValue === 'deprecated' ? statusValue : 'active';
  return {
    id: localId,
    localId,
    qualifiedId: `${ownerScope}::skill::${localId}`,
    domain,
    domains,
    modelAreaRefs: stringArray(meta.model_areas ?? meta.modelAreaRefs),
    kind: stringValue(meta.kind) ?? 'custom',
    status,
    owner: stringValue(meta.owner),
    description: stringValue(meta.description),
    triggers: stringArray(meta.triggers),
    exclusions: stringArray(meta.exclusions),
    preferredMetrics: stringArray(meta.preferred_metrics),
    preferredBlocks: stringArray(meta.preferred_blocks),
    preferredDimensions: stringArray(meta.preferred_dimensions),
    requiredFilters: stringArray(meta.required_filters),
    clarifyWhen: stringArray(meta.clarify_when),
    examples: stringArray(meta.examples),
    sourceRefs: stringArray(meta.source_refs),
    vocabulary: stringMap(meta.vocabulary),
    sourcePath,
    contentHash: sha256(raw),
    bodyHash: sha256(body),
    format: 'dql-knowledge-v1',
  };
}

function resolveConfiguredSkillsRoot(projectRoot: string): string {
  const configPath = join(projectRoot, 'dql.config.json');
  if (!existsSync(configPath)) return join(projectRoot, 'skills');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { layout?: { skillsPath?: unknown } };
    const configured = typeof config.layout?.skillsPath === 'string' && config.layout.skillsPath.trim()
      ? config.layout.skillsPath.trim()
      : 'skills';
    return isAbsolute(configured) ? resolve(configured) : resolve(projectRoot, configured);
  } catch {
    return join(projectRoot, 'skills');
  }
}

function walkSkillFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) output.push(...walkSkillFiles(path));
    } else if (entry.isFile() && (entry.name.endsWith('.skill.md') || entry.name === 'SKILL.md')) {
      if (statSync(path).size <= 256 * 1024) output.push(resolve(path));
    }
  }
  return output;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? unique(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)) : [];
}

function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([key, item]) => typeof item === 'string' ? [[key, item]] : []));
}

function canonicalDomain(value: string, aliases: Map<string, string>): string {
  return aliases.get(value.trim().toLowerCase()) ?? value.trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
