/**
 * Skills loader — discover and parse `.dql/skills/*.skill.md` files.
 *
 * Each skill is a markdown file with YAML frontmatter:
 *
 *     ---
 *     id: cxo-monthly-review
 *     user: alice@acme.com
 *     description: Alice's monthly board review
 *     preferred_metrics: [arr, nrr]
 *     vocabulary: { "ARR": "metric:arr" }
 *     ---
 *     Free-form prompt body...
 *
 * No external YAML dep — we ship a tiny parser that handles only flat
 * key/value, list-of-strings, and one-level objects (good enough for skills).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, relative, isAbsolute, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { loadDomainPackageRegistry } from '@zlens/core';

export interface Skill {
  id: string;
  /** Author-facing id, retained when `id` is used by legacy callers. */
  localId?: string;
  /** Collision-free identity used by manifests, retrieval, and the KG. */
  qualifiedId?: string;
  /**
   * Skill scope. PROJECT skills (`user` empty) are shared with everyone;
   * PERSONAL skills (`user` set) are bound to a single user. Derived from
   * `user` on parse; persisted faithfully on write.
   */
  scope: 'project' | 'personal';
  /** Optional user this skill is bound to. Empty = project-level skill. */
  user?: string;
  /** Optional domain this skill belongs to (spec 17, part B). */
  domain?: string;
  /** Domain paths for cross-domain skills. `domain` remains backward compatible. */
  domains?: string[];
  /** Optional focused Model Areas. This is a ranking hint inside an authorized domain, never an access grant. */
  modelAreaRefs?: string[];
  kind?: 'domain_reference' | 'metric_policy' | 'glossary' | 'analysis_pattern' | 'sql_policy' | 'custom';
  status?: 'draft' | 'active' | 'deprecated';
  owner?: string;
  triggers?: string[];
  exclusions?: string[];
  description?: string;
  preferredMetrics: string[];
  preferredBlocks: string[];
  preferredDimensions?: string[];
  requiredFilters?: string[];
  clarifyWhen?: string[];
  examples?: string[];
  sourceRefs?: string[];
  vocabulary: Record<string, string>;
  /**
   * Structured analytical defaults. These fields may fill an omitted time or
   * comparison policy only after normal Skill domain/area eligibility gates;
   * they never authorize a metric, member, relationship, or execution route.
   */
  analyticalPolicy?: SkillAnalyticalPolicy;
  /** Markdown body (everything after the closing `---`). */
  body: string;
  sourcePath: string;
  /** True for the editable starter skills seeded by `seedDefaultSkills`. */
  isStarter?: boolean;
}

export interface SkillAnalyticalPolicy {
  metricIds?: string[];
  timeRole?: string;
  calendarId?: string;
  timezone?: string;
  completenessPolicy?: "partial_current" | "latest_complete" | "closed_period";
  comparisonAlignment?: "elapsed_period" | "calendar_period" | "fiscal_period";
  defaultRankingPeriod?: "current" | "comparison";
  narrativeGuidance?: string[];
}

export interface SkillLoadResult {
  skills: Skill[];
  errors: Array<{ path: string; message: string }>;
}

/**
 * Walk the visible, Git-owned `skills/**` tree. The historical
 * `.dql/skills/**` tree remains read-compatible during migration, but a skill
 * with the same id in `skills/` wins so projects can move incrementally.
 * Misformed files are reported in `errors`; valid Skills still come back.
 */
export function loadSkills(projectRoot: string): SkillLoadResult {
  const domainRoots = loadDomainPackageRegistry(projectRoot).values().map((pkg) => ({ root: join(pkg.root, 'skills'), inferredDomain: pkg.id }));
  const roots: Array<{ root: string; inferredDomain?: string }> = [
    ...domainRoots,
    { root: skillsDir(projectRoot), inferredDomain: undefined },
    { root: legacySkillsDir(projectRoot), inferredDomain: undefined },
  ];
  const skills: Skill[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const seen = new Set<string>();

  for (const { root, inferredDomain } of roots) {
    for (const f of walkMd(root)) {
      try {
        const raw = readFileSync(f, 'utf-8');
        const parsed = parseSkill(raw, f);
        const skill = parsed ? qualifySkill(parsed, inferredDomain) : null;
        const identity = skill?.qualifiedId ?? skill?.id;
        if (skill && identity && !seen.has(identity)) {
          seen.add(identity);
          skills.push(skill);
        }
      } catch (err) {
        errors.push({ path: f, message: (err as Error).message });
      }
    }
  }
  return { skills, errors };
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      out.push(...walkMd(p));
    } else if (entry.isFile() && (entry.name.endsWith('.skill.md') || entry.name.endsWith('.md'))) {
      if (statSync(p).size <= 1024 * 256) out.push(p);
    }
  }
  return out;
}

/** Public for tests. */
export function parseSkill(raw: string, path: string): Skill | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const front = m[1];
  const body = m[2].trim();
  const meta = parseSkillFrontmatter(front);

  const id = pickString(meta.id) ?? basename(path).replace(/\.skill\.md$|\.md$/, '');
  const user = pickString(meta.user);
  const starter = meta.starter;
  return {
    id,
    localId: id,
    scope: user ? 'personal' : 'project',
    user,
    domain: pickString(meta.domain),
    domains: pickStringArray(meta.domains ?? meta.domain),
    modelAreaRefs: pickStringArray(meta.model_areas ?? meta.modelAreaRefs),
    kind: parseSkillKind(pickString(meta.kind)),
    status: parseSkillStatus(pickString(meta.status)),
    owner: pickString(meta.owner),
    triggers: pickStringArray(meta.triggers),
    exclusions: pickStringArray(meta.exclusions),
    description: pickString(meta.description),
    preferredMetrics: pickStringArray(meta.preferred_metrics),
    preferredBlocks: pickStringArray(meta.preferred_blocks),
    preferredDimensions: pickStringArray(meta.preferred_dimensions),
    requiredFilters: pickStringArray(meta.required_filters),
    clarifyWhen: pickStringArray(meta.clarify_when),
    examples: pickStringArray(meta.examples),
    sourceRefs: pickStringArray(meta.source_refs),
    vocabulary: pickStringMap(meta.vocabulary),
    analyticalPolicy: parseSkillAnalyticalPolicy(
      meta.analytical_policy ?? meta.analyticalPolicy,
    ),
    body,
    sourcePath: path,
    isStarter: starter === true || starter === 'true' || starter === 'yes' ? true : undefined,
  };
}

function qualifySkill(skill: Skill, inferredDomain?: string): Skill {
  const declaredDomains = [...new Set((skill.domains ?? (skill.domain ? [skill.domain] : []))
    .map((value) => value.trim())
    .filter(Boolean))];
  const domains = declaredDomains.length > 0 ? declaredDomains : (inferredDomain ? [inferredDomain] : []);
  const domain = skill.domain?.trim() || (domains.length === 1 ? domains[0] : undefined);
  const ownerScope = domains.length === 1
    ? domains[0]
    : domains.length > 1
      ? `cross_domain_${domains.slice().sort().join('_')}`
      : skill.user
        ? `user_${skill.user.trim().toLowerCase()}`
        : 'global';
  return {
    ...skill,
    localId: skill.localId ?? skill.id,
    qualifiedId: `${ownerScope}::skill::${skill.localId ?? skill.id}`,
    domain,
    domains,
  };
}

// ─── Serialization + CRUD (spec 16) ──────────────────────────────────────────

/** Visible Git-owned skills directory for new and upgraded OSS projects. */
export function skillsDir(projectRoot: string): string {
  const configured = configuredSkillsPath(projectRoot);
  return isAbsolute(configured) ? resolve(configured) : resolve(projectRoot, configured);
}

/**
 * Repository-relative Skills folder configured by `layout.skillsPath`.
 *
 * The setting has existed in generated ZLens projects since the OSS dbt layout
 * was introduced. Keep `skills` as the fallback so older projects continue to
 * work, while allowing a ZLens workspace nested inside a dbt repo to point at an
 * existing sibling folder such as `../skills` without copying files.
 */
export function configuredSkillsPath(projectRoot: string): string {
  const configPath = join(projectRoot, 'dql.config.json');
  if (!existsSync(configPath)) return 'skills';
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      layout?: { skillsPath?: unknown };
    };
    const value = typeof config.layout?.skillsPath === 'string'
      ? config.layout.skillsPath.trim()
      : '';
    return value || 'skills';
  } catch {
    return 'skills';
  }
}

/** Historical local-state location, retained only as a read/migration source. */
export function legacySkillsDir(projectRoot: string): string {
  return join(projectRoot, '.dql', 'skills');
}

/** Resolve the `.skill.md` path a skill should be written to. */
export function skillPath(projectRoot: string, id: string, domains: string[] = []): string {
  const firstDomain = domains[0]?.trim();
  if (firstDomain && domains.length === 1) {
    const packageRoot = loadDomainPackageRegistry(projectRoot).get(firstDomain)?.root;
    if (packageRoot) return join(packageRoot, 'skills', `${sanitizeSkillId(id)}.skill.md`);
  }
  const folder = firstDomain
    ? firstDomain.split(/[/.]/).map(sanitizeSkillId).filter(Boolean)
    : [];
  const target = domains.length > 1 ? ['_cross-domain'] : folder;
  return join(skillsDir(projectRoot), ...target, `${sanitizeSkillId(id)}.skill.md`);
}

function sanitizeSkillId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'skill';
}

/** Does a frontmatter value need quoting (any whitespace, colons, specials)? */
function needsQuote(value: string): boolean {
  return /[\s:#"'\[\]{}]|^[&*!|>%@`-]/.test(value) || value === '';
}

function quoteIfNeeded(value: string): string {
  if (!needsQuote(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Render a Skill back to the EXACT `.skill.md` format `parseSkill` consumes, so
 * `parseSkill(renderSkill(s))` round-trips. Only emits keys that have content.
 */
export function renderSkill(skill: Skill): string {
  const lines: string[] = ['---', `id: ${quoteIfNeeded(skill.id)}`];
  if (skill.domain) lines.push(`domain: ${quoteIfNeeded(skill.domain)}`);
  if ((skill.domains?.length ?? 0) > 0) lines.push(`domains: [${(skill.domains ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.modelAreaRefs?.length ?? 0) > 0) lines.push(`model_areas: [${(skill.modelAreaRefs ?? []).map(quoteIfNeeded).join(', ')}]`);
  if (skill.kind && skill.kind !== 'custom') lines.push(`kind: ${skill.kind}`);
  if (skill.status && skill.status !== 'active') lines.push(`status: ${skill.status}`);
  if (skill.owner) lines.push(`owner: ${quoteIfNeeded(skill.owner)}`);
  if (skill.description) lines.push(`description: ${quoteIfNeeded(skill.description)}`);
  if (skill.preferredMetrics.length > 0) {
    lines.push(`preferred_metrics: [${skill.preferredMetrics.map(quoteIfNeeded).join(', ')}]`);
  }
  if (skill.preferredBlocks.length > 0) {
    lines.push(`preferred_blocks: [${skill.preferredBlocks.map(quoteIfNeeded).join(', ')}]`);
  }
  if ((skill.preferredDimensions?.length ?? 0) > 0) lines.push(`preferred_dimensions: [${(skill.preferredDimensions ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.triggers?.length ?? 0) > 0) lines.push(`triggers: [${(skill.triggers ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.exclusions?.length ?? 0) > 0) lines.push(`exclusions: [${(skill.exclusions ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.requiredFilters?.length ?? 0) > 0) lines.push(`required_filters: [${(skill.requiredFilters ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.clarifyWhen?.length ?? 0) > 0) lines.push(`clarify_when: [${(skill.clarifyWhen ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.examples?.length ?? 0) > 0) lines.push(`examples: [${(skill.examples ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.sourceRefs?.length ?? 0) > 0) lines.push(`source_refs: [${(skill.sourceRefs ?? []).map(quoteIfNeeded).join(', ')}]`);
  const vocabEntries = Object.entries(skill.vocabulary);
  if (vocabEntries.length > 0) {
    lines.push('vocabulary:');
    for (const [key, value] of vocabEntries) {
      lines.push(`  ${quoteIfNeeded(key)}: ${quoteIfNeeded(value)}`);
    }
  }
  if (skill.analyticalPolicy) {
    const policy = skill.analyticalPolicy;
    lines.push("analytical_policy:");
    if ((policy.metricIds?.length ?? 0) > 0)
      lines.push(
        `  metric_ids: [${policy.metricIds!.map(quoteIfNeeded).join(", ")}]`,
      );
    if (policy.timeRole)
      lines.push(`  time_role: ${quoteIfNeeded(policy.timeRole)}`);
    if (policy.calendarId)
      lines.push(`  calendar_id: ${quoteIfNeeded(policy.calendarId)}`);
    if (policy.timezone)
      lines.push(`  timezone: ${quoteIfNeeded(policy.timezone)}`);
    if (policy.completenessPolicy)
      lines.push(`  completeness_policy: ${policy.completenessPolicy}`);
    if (policy.comparisonAlignment)
      lines.push(`  comparison_alignment: ${policy.comparisonAlignment}`);
    if (policy.defaultRankingPeriod)
      lines.push(`  default_ranking_period: ${policy.defaultRankingPeriod}`);
    if ((policy.narrativeGuidance?.length ?? 0) > 0)
      lines.push(
        `  narrative_guidance: [${policy.narrativeGuidance!.map(quoteIfNeeded).join(", ")}]`,
      );
  }
  if (skill.isStarter) lines.push("starter: true");
  lines.push("---");
  const body = skill.body.trim();
  return `${lines.join('\n')}\n${body ? `${body}\n` : ''}`;
}

export interface WriteSkillInput {
  id: string;
  /** Collision-free target identity for update/move operations. */
  qualifiedId?: string;
  /** Exact existing source selected by the server; clients cannot choose arbitrary paths. */
  sourcePath?: string;
  scope: 'project' | 'personal';
  user?: string;
  domain?: string;
  domains?: string[];
  modelAreaRefs?: string[];
  kind?: Skill['kind'];
  status?: Skill['status'];
  owner?: string;
  triggers?: string[];
  exclusions?: string[];
  description?: string;
  preferredMetrics?: string[];
  preferredBlocks?: string[];
  preferredDimensions?: string[];
  requiredFilters?: string[];
  clarifyWhen?: string[];
  examples?: string[];
  sourceRefs?: string[];
  vocabulary?: Record<string, string>;
  analyticalPolicy?: SkillAnalyticalPolicy;
  body?: string;
  isStarter?: boolean;
}

export interface SkillSourcePatch {
  path: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface SkillChangePreview {
  operation: 'create' | 'update' | 'move';
  qualifiedId: string;
  sourceHash: string;
  patches: SkillSourcePatch[];
  fingerprint: string;
}

/** Normalize a partial input into a full Skill (with a resolved sourcePath). */
function toSkill(projectRoot: string, input: WriteSkillInput): Skill {
  // New skills are shared, Git-backed project guidance. Legacy personal skills
  // are retained only for migration and are never written by this path.
  const scope = 'project';
  return {
    id: input.id,
    scope,
    user: undefined,
    domain: input.domain || undefined,
    domains: input.domains?.length ? input.domains : (input.domain ? [input.domain] : []),
    modelAreaRefs: input.modelAreaRefs ?? [],
    kind: input.kind ?? 'custom',
    status: input.status ?? 'active',
    owner: input.owner,
    triggers: input.triggers ?? [],
    exclusions: input.exclusions ?? [],
    description: input.description,
    preferredMetrics: input.preferredMetrics ?? [],
    preferredBlocks: input.preferredBlocks ?? [],
    preferredDimensions: input.preferredDimensions ?? [],
    requiredFilters: input.requiredFilters ?? [],
    clarifyWhen: input.clarifyWhen ?? [],
    examples: input.examples ?? [],
    sourceRefs: input.sourceRefs ?? [],
    vocabulary: input.vocabulary ?? {},
    analyticalPolicy: input.analyticalPolicy,
    body: input.body ?? "",
    sourcePath: input.sourcePath ?? skillPath(
      projectRoot,
      input.id,
      input.domains?.length
        ? input.domains
        : input.domain
          ? [input.domain]
          : [],
    ),
    isStarter: input.isStarter,
  };
}

/** Write a skill to `skills/<id>.skill.md`, the shared source location. */
export function writeSkill(projectRoot: string, input: WriteSkillInput): Skill {
  const existing = resolveSkillForWrite(projectRoot, input.qualifiedId ?? input.id);
  const skill = toSkill(projectRoot, {
    ...input,
    sourcePath: input.sourcePath ?? existing?.sourcePath,
  });
  const dir = dirname(skill.sourcePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const before = existsSync(skill.sourcePath) ? readFileSync(skill.sourcePath, 'utf8') : '';
  writeFileSync(skill.sourcePath, renderSkillPreservingUnknown(skill, before), 'utf-8');
  return parseSkill(readFileSync(skill.sourcePath, 'utf-8'), skill.sourcePath) ?? skill;
}

/** Preview one exact Skill create/update/move without writing governed source. */
export function previewSkillChange(
  projectRoot: string,
  input: WriteSkillInput,
  targetQualifiedId?: string,
  expectedSourceHash?: string,
): SkillChangePreview {
  const existing = targetQualifiedId ? resolveSkillForWrite(projectRoot, targetQualifiedId) : undefined;
  if (targetQualifiedId && !existing) throw new Error(`Skill not found: ${targetQualifiedId}`);
  // Updates are partial patches. Preserve every known field the caller did not
  // mention (especially analytical_policy), while unknown frontmatter is
  // preserved separately by renderSkillPreservingUnknown.
  const desired = toSkill(projectRoot, {
    ...(existing ? {
      ...existing,
      sourcePath: existing.sourcePath,
    } : {}),
    ...input,
    qualifiedId: targetQualifiedId,
  });
  const sourcePath = existing?.sourcePath;
  const before = sourcePath && existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '';
  const sourceHash = hashSkillSource(before);
  if (expectedSourceHash && sourceHash !== expectedSourceHash) {
    throw new Error('Skill source changed after it was loaded. Refresh the proposal before saving.');
  }
  const destination = desired.sourcePath;
  const destinationBefore = existsSync(destination) ? readFileSync(destination, 'utf8') : '';
  if (sourcePath && resolve(sourcePath) !== resolve(destination) && destinationBefore) {
    throw new Error(`Skill target already exists: ${relative(projectRoot, destination)}`);
  }
  const after = renderSkillPreservingUnknown(desired, before);
  const patches: SkillSourcePatch[] = sourcePath && resolve(sourcePath) !== resolve(destination)
    ? [
        { path: sourcePath, before, after: '', changed: before !== '' },
        { path: destination, before: destinationBefore, after, changed: destinationBefore !== after },
      ]
    : [{ path: destination, before: destinationBefore, after, changed: destinationBefore !== after }];
  const operation: SkillChangePreview['operation'] = !existing ? 'create' : patches.length > 1 ? 'move' : 'update';
  const qualifiedId = qualifySkill({ ...desired, sourcePath: destination }, desired.domain).qualifiedId!;
  return {
    operation,
    qualifiedId,
    sourceHash,
    patches,
    fingerprint: createHash('sha256').update(JSON.stringify(patches.map(({ path, before: valueBefore, after: valueAfter }) => ({ path: resolve(path), before: valueBefore, after: valueAfter })))).digest('hex'),
  };
}

/** Apply only the bytes that were previewed. */
export function applySkillChange(
  projectRoot: string,
  input: WriteSkillInput,
  expectedFingerprint: string,
  targetQualifiedId?: string,
  expectedSourceHash?: string,
): SkillChangePreview {
  const preview = previewSkillChange(projectRoot, input, targetQualifiedId, expectedSourceHash);
  if (!expectedFingerprint || preview.fingerprint !== expectedFingerprint) {
    throw new Error('Skill source changed after the preview. Refresh the proposal before saving.');
  }
  for (const patch of preview.patches) {
    if (!patch.changed) continue;
    if (!patch.after) rmSync(patch.path, { force: true });
    else {
      mkdirSync(dirname(patch.path), { recursive: true });
      writeFileSync(patch.path, patch.after, 'utf8');
    }
  }
  return preview;
}

export function hashSkillSource(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function resolveSkillForWrite(projectRoot: string, identity: string): Skill | undefined {
  const matches = loadSkills(projectRoot).skills.filter((skill) => skill.qualifiedId === identity || skill.id === identity);
  if (matches.length > 1 && !identity.includes('::skill::')) {
    throw new Error(`Skill id is ambiguous; use a qualified id: ${identity}`);
  }
  return matches[0];
}

function renderSkillPreservingUnknown(skill: Skill, existingRaw: string): string {
  if (!existingRaw.trim()) return renderSkill(skill);
  const existingMatch = existingRaw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const rendered = renderSkill(skill);
  const nextMatch = rendered.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!existingMatch || !nextMatch) return rendered;
  const existing = yaml.load(existingMatch[1]) as Record<string, unknown> | undefined;
  const next = yaml.load(nextMatch[1]) as Record<string, unknown> | undefined;
  if (!existing || !next || Array.isArray(existing) || Array.isArray(next)) return rendered;
  const knownKeys = [
    'id', 'domain', 'domains', 'model_areas', 'kind', 'status', 'owner', 'description',
    'preferred_metrics', 'preferred_blocks', 'preferred_dimensions', 'triggers', 'exclusions',
    'required_filters', 'clarify_when', 'examples', 'source_refs', 'vocabulary',
    'analytical_policy', 'starter', 'user',
  ];
  const merged = { ...existing };
  for (const key of knownKeys) delete merged[key];
  Object.assign(merged, next);
  const frontmatter = yaml.dump(merged, { noRefs: true, lineWidth: -1, sortKeys: false }).trimEnd();
  return `---\n${frontmatter}\n---\n${skill.body.trim() ? `${skill.body.trim()}\n` : ''}`;
}

/** Alias for `writeSkill` — create-or-update by id. */
export function upsertSkill(projectRoot: string, input: WriteSkillInput): Skill {
  return writeSkill(projectRoot, input);
}

/** Delete a skill from its actual source path. Returns true when a file was removed. */
export function deleteSkill(projectRoot: string, id: string): boolean {
  const existing = loadSkills(projectRoot).skills.find((skill) => skill.qualifiedId === id || skill.id === id);
  const path = existing?.sourcePath ?? skillPath(projectRoot, id);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * Explicit one-way OSS layout upgrade. Moves legacy skills into the visible
 * source tree without overwriting a skill already migrated by a teammate.
 */
export function migrateLegacySkills(projectRoot: string): { moved: string[]; skipped: string[] } {
  const legacyRoot = legacySkillsDir(projectRoot);
  const visibleRoot = skillsDir(projectRoot);
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const source of walkMd(legacyRoot)) {
    const destination = join(visibleRoot, relative(legacyRoot, source));
    if (existsSync(destination)) {
      skipped.push(relative(projectRoot, source));
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
    moved.push(relative(projectRoot, destination));
  }
  return { moved, skipped };
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function pickStringArray(v: unknown): string[] {
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : [];
}

function parseSkillKind(value: string | undefined): Skill['kind'] {
  return ['domain_reference', 'metric_policy', 'glossary', 'analysis_pattern', 'sql_policy', 'custom'].includes(value ?? '')
    ? value as Skill['kind']
    : 'custom';
}

function parseSkillStatus(value: string | undefined): Skill['status'] {
  return ['draft', 'active', 'deprecated'].includes(value ?? '') ? value as Skill['status'] : 'active';
}

function parseSkillFrontmatter(text: string): Record<string, unknown> {
  try {
    const parsed = yaml.load(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return parseMiniYaml(text);
  }
}

function pickStringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function parseSkillAnalyticalPolicy(
  value: unknown,
): SkillAnalyticalPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const completenessPolicy = pickString(
    record.completeness_policy ?? record.completenessPolicy,
  );
  const comparisonAlignment = pickString(
    record.comparison_alignment ?? record.comparisonAlignment,
  );
  const defaultRankingPeriod = pickString(
    record.default_ranking_period ?? record.defaultRankingPeriod,
  );
  const policy: SkillAnalyticalPolicy = {
    metricIds: pickStringArray(record.metric_ids ?? record.metricIds),
    timeRole: pickString(record.time_role ?? record.timeRole),
    calendarId: pickString(record.calendar_id ?? record.calendarId),
    timezone: pickString(record.timezone),
    completenessPolicy:
      completenessPolicy === "partial_current" ||
      completenessPolicy === "latest_complete" ||
      completenessPolicy === "closed_period"
        ? completenessPolicy
        : undefined,
    comparisonAlignment:
      comparisonAlignment === "elapsed_period" ||
      comparisonAlignment === "calendar_period" ||
      comparisonAlignment === "fiscal_period"
        ? comparisonAlignment
        : undefined,
    defaultRankingPeriod:
      defaultRankingPeriod === "current" ||
      defaultRankingPeriod === "comparison"
        ? defaultRankingPeriod
        : undefined,
    narrativeGuidance: pickStringArray(
      record.narrative_guidance ?? record.narrativeGuidance,
    ),
  };
  return Object.values(policy).some((item) =>
    Array.isArray(item) ? item.length > 0 : Boolean(item),
  )
    ? policy
    : undefined;
}

/**
 * Tiny YAML parser tailored to skill frontmatter.
 *
 * Supports:
 *   key: scalar
 *   key: [item1, item2]
 *   key:
 *     subkey: value
 *
 * Not a real YAML implementation. If a skill needs richer YAML, point users
 * at js-yaml manually and we'll widen the surface.
 */
function parseMiniYaml(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const out: Record<string, unknown> = {};
  let inObject: { key: string; obj: Record<string, string> } | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (inObject) {
      // Match either a quoted key ("key with spaces": value) or a bare key.
      const subMatch = line.match(/^\s+("([^"]+)"|'([^']+)'|([a-zA-Z0-9_.-]+))\s*:\s*(.+)$/);
      if (subMatch && line.startsWith(' ')) {
        const k = subMatch[2] ?? subMatch[3] ?? subMatch[4];
        const v = stripQuotes(subMatch[5].trim());
        if (k) inObject.obj[k] = v;
        continue;
      }
      out[inObject.key] = inObject.obj;
      inObject = null;
    }

    const top = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!top) continue;
    const key = top[1];
    const value = top[2].trim();
    if (!value) {
      inObject = { key, obj: {} };
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
      continue;
    }
    out[key] = stripQuotes(value);
  }
  if (inObject) out[inObject.key] = inObject.obj;
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Compose Skills into a single system-prompt fragment for the agent.
 * Filtered by user when a persona is active.
 */
export function buildSkillsPrompt(skills: Skill[], userId: string | null): string {
  const relevant = activeSkills(skills, userId);
  if (relevant.length === 0) return '';
  const sections = relevant.map((s) => {
    const header = s.description ? `${s.id} — ${s.description}` : s.id;
    const metrics = s.preferredMetrics.length > 0 ? `\nPreferred metrics: ${s.preferredMetrics.join(', ')}` : '';
    const blocks = s.preferredBlocks.length > 0 ? `\nPreferred blocks: ${s.preferredBlocks.join(', ')}` : '';
    const dimensions = (s.preferredDimensions?.length ?? 0) > 0 ? `\nPreferred dimensions: ${s.preferredDimensions?.join(', ')}` : '';
    const filters = (s.requiredFilters?.length ?? 0) > 0 ? `\nRequired filters: ${s.requiredFilters?.join(', ')}` : '';
    const clarify = (s.clarifyWhen?.length ?? 0) > 0 ? `\nClarify when: ${s.clarifyWhen?.join('; ')}` : '';
    const vocab = Object.keys(s.vocabulary).length > 0
      ? `\nVocabulary: ${Object.entries(s.vocabulary).map(([k, v]) => `"${k}" → ${v}`).join(', ')}`
      : '';
    return `### Skill: ${header}${metrics}${blocks}${dimensions}${filters}${clarify}${vocab}${renderAnalyticalPolicy(s.analyticalPolicy)}\n\n${s.body}`;
  });
  return [
    '## Active Skills',
    '',
    'Skills are advisory business preferences. Use them for vocabulary, preferred metrics, and stakeholder context, but never let them override DQL certification status, runtime schema, SQL safety, permissions, or the user\'s requested grain.',
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
}

/**
 * CTX-008: the reporting conventions a domain has already decided — which
 * calendar, how a period is closed, how a comparison is aligned. This was
 * parsed, indexed, and threaded into the plan, but never shown to a model, so
 * every answer re-derived conventions the project had already written down.
 * Only `policyId`/`sourceHash` survived downstream; the substance is here.
 */
function renderAnalyticalPolicy(policy: SkillAnalyticalPolicy | undefined): string {
  if (!policy) return '';
  const lines = [
    policy.timeRole ? `time role: ${policy.timeRole}` : '',
    policy.calendarId ? `calendar: ${policy.calendarId}` : '',
    policy.timezone ? `timezone: ${policy.timezone}` : '',
    policy.completenessPolicy ? `period completeness: ${policy.completenessPolicy}` : '',
    policy.comparisonAlignment ? `comparison alignment: ${policy.comparisonAlignment}` : '',
    policy.defaultRankingPeriod ? `default ranking period: ${policy.defaultRankingPeriod}` : '',
  ].filter(Boolean);
  const guidance = (policy.narrativeGuidance ?? []).filter(Boolean);
  if (lines.length === 0 && guidance.length === 0) return '';
  return [
    '\nReporting policy: ' + (lines.join('; ') || 'see narrative guidance'),
    guidance.length ? `\nWhen narrating: ${guidance.join('; ')}` : '',
  ].join('');
}

export function activeSkills(skills: Skill[], userId: string | null): Skill[] {
  void userId;
  // In-memory callers and older fixture data may not carry the persisted
  // `scope` field. Treat that legacy absence as a project skill; explicitly
  // personal skills remain excluded from OSS agent retrieval.
  return skills.filter((s) => (s.scope ?? 'project') === 'project' && (s.status ?? 'active') === 'active');
}

/** @deprecated The Ask vocabulary reads a skill's preferred refs from the pack projection (`projectVocabularySource`); this hint builder has no runtime consumer and is removed in the next release. */
export function buildSkillBlockHints(skills: Skill[], userId: string | null): string[] {
  const hints = new Set<string>();
  for (const skill of activeSkills(skills, userId)) {
    for (const block of skill.preferredBlocks) {
      const normalized = normalizeBlockHint(block);
      if (normalized) hints.add(normalized);
    }
    for (const target of Object.values(skill.vocabulary)) {
      if (!/^block:/i.test(target.trim())) continue;
      const normalized = normalizeBlockHint(target);
      if (normalized) hints.add(normalized);
    }
  }
  return Array.from(hints);
}

/** Metric ids a selected skill may prefer, including vocabulary aliases. */
/** @deprecated The Ask vocabulary reads a skill's preferred refs from the pack projection (`projectVocabularySource`); this hint builder has no runtime consumer and is removed in the next release. */
export function buildSkillMetricHints(skills: Skill[], userId: string | null): string[] {
  const hints = new Set<string>();
  for (const skill of activeSkills(skills, userId)) {
    for (const metric of skill.preferredMetrics) if (metric.trim()) hints.add(metric.trim());
    for (const target of Object.values(skill.vocabulary)) {
      const match = target.trim().match(/^metric:(.+)$/i);
      if (match?.[1]?.trim()) hints.add(match[1].trim());
    }
  }
  return Array.from(hints);
}

/** Add governed metric aliases to retrieval text without changing the user request. */
export function expandQuestionWithSkillVocabulary(question: string, skills: Skill[], userId: string | null): string {
  const normalized = question.toLowerCase();
  const additions = new Set<string>();
  for (const skill of activeSkills(skills, userId)) {
    for (const [term, target] of Object.entries(skill.vocabulary)) {
      if (!term || !normalized.includes(term.toLowerCase())) continue;
      const governedRef = target.trim().match(/^(?:metric|term|entity|block|dimension):(.+)$/i)?.[1]?.trim();
      if (governedRef) additions.add(governedRef);
    }
  }
  return additions.size > 0 ? `${question} ${Array.from(additions).join(' ')}` : question;
}

function normalizeBlockHint(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^block:(.+)$/i);
  return (match ? match[1] : trimmed).trim() || undefined;
}

// ─── Skill selection (spec 16) ────────────────────────────────────────────────

export interface SelectRelevantSkillsOptions {
  /** SKILL-001: scope is established before ranking, never by a score bonus. */
  /** Active user — gates personal skills (only this user's are eligible). */
  userId?: string | null;
  /** Max skills to return after pinned ones. Default 6. */
  budget?: number;
  /**
   * Skill ids that are ALWAYS kept regardless of match (e.g. SQL conventions).
   * Defaults to the seeded `sql-conventions` starter. Pinned skills are only
   * kept when they are in-scope for the active user.
   */
  pinnedIds?: string[];
  /** Domains inferred from the retrieved metadata context for this question. */
  domains?: string[];
  /** Optional focused Model Areas selected in the Model workspace. */
  modelAreaIds?: string[];
  /** Exact canonical model/relationship focus. Ranking only; never authority. */
  focusObjectKeys?: string[];
}

const DEFAULT_PINNED_SKILL_IDS = ['sql-conventions'];

const SKILL_TOKEN_RE = /[\p{L}\p{N}_]+/gu;

function skillTokens(text: string): string[] {
  return (text.toLowerCase().match(SKILL_TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

/** Area refs may be authored as a local id or a compiled qualified id. */
function modelAreaKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const qualified = trimmed.split('::');
  return qualified.at(-1) ?? trimmed;
}

function matchesSkillExclusion(skill: Skill, question: string): boolean {
  const normalizedQuestion = skillTokens(question).join(' ');
  if (!normalizedQuestion) return false;
  return (skill.exclusions ?? []).some((exclusion) => {
    const normalizedExclusion = skillTokens(exclusion).join(' ');
    return normalizedExclusion.length > 0 && normalizedQuestion.includes(normalizedExclusion);
  });
}

/**
 * Rank in-scope skills by topic/vocabulary match to `question` and return the
 * SELECTED subset the answer-loop / build engine should inject — not all skills.
 * Pinned project skills (SQL conventions by default) are always kept. The rest
 * are ordered by lexical overlap (vocabulary + description + body) and capped to
 * the budget. Deterministic and offline.
 */
export function selectRelevantSkills(
  skills: Skill[],
  question: string,
  options: SelectRelevantSkillsOptions = {},
): Skill[] {
  const inScope = activeSkills(skills, options.userId ?? null);
  if (inScope.length === 0) return [];
  // One pinned governance/conventions skill plus at most three topical skills is
  // enough context for an answer. The previous default of six let several large
  // domain prompts compete in enterprise repos and diluted the retrieved evidence.
  const budget = Math.max(1, options.budget ?? 4);
  const pinnedIds = new Set((options.pinnedIds ?? DEFAULT_PINNED_SKILL_IDS).map((id) => id.toLowerCase()));
  const queryTokens = new Set(skillTokens(question));
  const domains = new Set((options.domains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean));
  const modelAreaIds = new Set((options.modelAreaIds ?? []).map(modelAreaKey).filter(Boolean));
  const focusObjectKeys = new Set((options.focusObjectKeys ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));

  const pinned: Skill[] = [];
  const rest: Array<{ skill: Skill; score: number }> = [];
  for (const skill of inScope) {
    const skillDomains = [skill.domain, ...(skill.domains ?? [])].map((domain) => domain?.trim().toLowerCase()).filter((domain): domain is string => Boolean(domain));
    // An explicit domain scope is an eligibility boundary, not merely a score
    // boost. Global skills remain eligible; caller-provided domains already
    // include permitted ancestors and certified imports.
    // Cross-domain guidance is eligible only when *every* participating domain
    // is present in the server-authorized envelope. Partial overlap must never
    // leak policy from another domain.
    if (domains.size > 0 && skillDomains.length > 0 && !skillDomains.every((domain) => domains.has(domain))) continue;
    const skillAreas = (skill.modelAreaRefs ?? []).map(modelAreaKey).filter(Boolean);
    // Area refs further focus a skill within its already-authorized domain.
    // An area never broadens domain eligibility or grants cross-domain access.
    if (modelAreaIds.size > 0 && skillAreas.length > 0 && !skillAreas.some((id) => modelAreaIds.has(id))) continue;
    // Exclusions are a negative eligibility boundary. They are evaluated before
    // pinning so a conventions skill cannot silently apply outside its scope.
    if (matchesSkillExclusion(skill, question)) continue;
    if (pinnedIds.has(skill.id.toLowerCase()) || (skill.qualifiedId && pinnedIds.has(skill.qualifiedId.toLowerCase()))) {
      pinned.push(skill);
      continue;
    }
    const overlap = (values: string[]) => {
      const tokens = new Set(values.flatMap(skillTokens));
      let hits = 0;
      for (const token of tokens) if (queryTokens.has(token)) hits += 1;
      return hits;
    };
    const triggerHits = overlap(skill.triggers ?? []);
    const vocabularyHits = overlap([...Object.keys(skill.vocabulary), ...Object.values(skill.vocabulary)]);
    const governedRefHits = overlap([
      ...skill.preferredMetrics,
      ...skill.preferredBlocks,
      ...(skill.preferredDimensions ?? []),
      ...(skill.sourceRefs ?? []),
    ]);
    const descriptorHits = overlap([skill.id, skill.description ?? '', ...(skill.examples ?? [])]);
    // Body prose is recall-only. Count unique tokens and cap its contribution
    // so repeated words in a long cheat sheet cannot outrank exact structured
    // triggers, vocabulary, or governed references.
    const bodyHits = Math.min(2, overlap([skill.body]));
    const topicalScore = triggerHits * 12 + vocabularyHits * 10 + governedRefHits * 8 + descriptorHits * 4 + bodyHits;
    const domainMatch = skillDomains.some((domain) => domains.has(domain));
    const areaMatch = skillAreas.some((id) => modelAreaIds.has(id));
    const focusMatch = (skill.sourceRefs ?? []).some((ref) => focusObjectKeys.has(ref.trim().toLowerCase()));
    // Scope only breaks ties among topically relevant guidance. A domain bonus
    // by itself must not select an arbitrary skill in a large microdomain.
    if (topicalScore === 0 && !focusMatch) continue;
    rest.push({ skill, score: topicalScore + (focusMatch ? 40 : 0) + (domainMatch ? 4 : 0) + (areaMatch ? 3 : 0) });
  }

  // Keep only skills with at least one topical hit; ordered by score desc, then
  // stable by original order. Pinned skills are prepended and never dropped.
  const ranked = rest
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.skill);

  const remainingBudget = Math.max(0, budget - pinned.length);
  return [...pinned, ...ranked.slice(0, remainingBudget)];
}
