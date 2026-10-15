import { createHash } from 'node:crypto';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';

/**
 * The record left behind when a person certifies a block.
 *
 * ZLens's trust promise is that nothing becomes certified implicitly: saving a
 * block (AI-generated, imported, or hand-written) always writes a draft, and a
 * block turns certified only through an explicit Certify action that runs the
 * certification rules. That action writes this receipt into the block's
 * companion YAML (`semantic-layer/blocks/.../<slug>.yaml`) next to
 * `reviewStatus: certified`, so the tracked source says who certified it, when,
 * through which surface, under which rule set, and for exactly which source.
 */
export interface CertificationReceipt {
  /** Who certified: the host's signed-in person, else the local git/OS owner. */
  certifiedBy: string;
  /** ISO-8601 timestamp of the certification. */
  certifiedAt: string;
  /** The surface the explicit Certify action came from. */
  via: CertificationSurface;
  /** The rule set that was evaluated: OSS (owner + run + tests) or enterprise. */
  rules: 'oss' | 'enterprise';
  /** sha256 of the certified `.dql` source, so a later edit is detectable. */
  sourceSha256: string;
  /** Names of the passed checks, when the certifier reported them. */
  checks?: string[];
  /** Advisory warnings the certifier reported (not blockers). */
  warnings?: string[];
}

export type CertificationSurface =
  | 'block-studio'
  | 'sql-import'
  | 'app-dataset'
  | 'cli';

export type BlockLifecycleStatus = 'draft' | 'review' | 'certified' | 'deprecated';

const STATUS_LINE = /^\s*status\s*=\s*"([^"]*)"/m;

/** The `status = "…"` a `.dql` source declares, defaulting to draft. */
export function blockSourceStatus(source: string): BlockLifecycleStatus {
  const declared = STATUS_LINE.exec(source)?.[1]?.trim().toLowerCase();
  if (declared === 'certified' || declared === 'review' || declared === 'deprecated') return declared;
  return 'draft';
}

/** Returns the source with a certified `status` written as `draft`; other sources unchanged. */
export function demoteCertifiedSource(source: string): string {
  if (blockSourceStatus(source) !== 'certified') return source;
  return source.replace(/(\bstatus\s*=\s*)"certified"/, '$1"draft"');
}

/**
 * The lifecycle tag a draft carries while it waits for review. SQL import, AI
 * drafts and notebook research all add it; Ask never serves a block tagged
 * with it as certified evidence (a certified status beside "review required"
 * is a contradiction). Certifying is the review, so it removes the tag.
 */
const REVIEW_PENDING_TAG = /^\s*review[\s_-]*required\s*$/i;

export function isReviewPendingTag(tag: string): boolean {
  return REVIEW_PENDING_TAG.test(tag);
}

/** The `tags = [ … ]` list of a `.dql` source without the review-pending lifecycle tag. */
export function withoutReviewPendingTags(source: string): string {
  return source.replace(/(\btags\s*=\s*\[)([^\]]*)(\])/, (whole, open: string, body: string, close: string) => {
    const items = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!);
    const kept = items.filter((tag) => !isReviewPendingTag(tag));
    if (kept.length === items.length) return whole;
    return `${open}${kept.map((tag) => `"${tag}"`).join(', ')}${close}`;
  });
}

/**
 * Set a `.dql` source's lifecycle status. Certifying also removes the
 * review-pending tag, so a block certified through any surface is one Ask
 * serves as certified, never one it silently skips as contradictory.
 */
export function withBlockStatus(source: string, status: string): string {
  const next = /status\s*=\s*"[^"]*"/.test(source)
    ? source.replace(/status\s*=\s*"[^"]*"/, `status = "${status}"`)
    : source.replace(/block\s+"[^"]*"\s*\{/, (match) => `${match}\n  status = "${status}"`);
  return status === 'certified' ? withoutReviewPendingTags(next) : next;
}

export function sourceSha256(source: string): string {
  return createHash('sha256').update(source.trimEnd() + '\n').digest('hex');
}

export function buildCertificationReceipt(input: {
  source: string;
  certifiedBy: string | undefined | null;
  via: CertificationSurface;
  enterprise?: boolean;
  checks?: string[];
  warnings?: string[];
  now?: Date;
}): CertificationReceipt {
  const certifiedBy = input.certifiedBy?.trim() || 'local';
  return {
    certifiedBy,
    certifiedAt: (input.now ?? new Date()).toISOString(),
    via: input.via,
    rules: input.enterprise ? 'enterprise' : 'oss',
    sourceSha256: sourceSha256(input.source),
    ...(input.checks && input.checks.length > 0 ? { checks: Array.from(new Set(input.checks)) } : {}),
    ...(input.warnings && input.warnings.length > 0 ? { warnings: Array.from(new Set(input.warnings)) } : {}),
  };
}

const CHECKLIST_LABELS: Record<string, string> = {
  metadata: 'metadata',
  validation: 'validation',
  run: 'run',
  tests: 'tests',
  chart: 'chart',
  lineage: 'lineage',
  aiReviewed: 'ai-reviewed',
};

/** Names of the checks a Block Studio certification checklist passed, for the receipt. */
export function passedCheckNames(checklist: unknown): string[] {
  if (!checklist || typeof checklist !== 'object') return [];
  const record = checklist as Record<string, unknown>;
  return Object.entries(CHECKLIST_LABELS)
    .filter(([key]) => record[key] === true)
    .map(([, label]) => label);
}

/**
 * Remove a top-level YAML key and every indented line that belongs to it.
 * The companion files are written by ZLens with two-space indentation, so a
 * line-based edit keeps the rest of the hand-readable file untouched.
 */
/** The companion's top-level `tags:` list without the review-pending lifecycle tag. */
function withoutCompanionReviewPendingTags(yaml: string): string {
  const lines = yaml.split(/\r?\n/);
  let inTags = false;
  return lines.filter((line) => {
    if (/^\S/.test(line)) inTags = /^tags:\s*$/.test(line);
    if (!inTags) return true;
    const item = /^\s+-\s+["']?(.*?)["']?\s*$/.exec(line);
    return !(item && isReviewPendingTag(item[1]!));
  }).join('\n');
}

function removeTopLevelKey(yaml: string, key: string): string {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      if (line.trim() === '' || /^\s/.test(line)) continue;
      skipping = false;
    }
    if (new RegExp(`^${key}:(\\s|$)`).test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Write the companion's lifecycle so it always agrees with the `.dql` source:
 * `reviewStatus` mirrors the block's status, and the `certification` receipt is
 * present only while the block is certified.
 */
export function applyCompanionCertification(
  companion: string,
  status: BlockLifecycleStatus,
  receipt: CertificationReceipt | null | undefined,
): string {
  let next = removeTopLevelKey(removeTopLevelKey(companion, 'reviewStatus'), 'certification').trimEnd();
  if (status === 'certified') next = withoutCompanionReviewPendingTags(next);
  next += `\nreviewStatus: ${status}\n`;
  if (status === 'certified' && receipt) {
    next += dumpYaml({ certification: receipt }, { lineWidth: 200, noRefs: true });
  }
  return next.endsWith('\n') ? next : `${next}\n`;
}

/** The certification receipt a companion YAML holds, when it holds a valid one. */
export function readCompanionCertification(companion: string | null | undefined): CertificationReceipt | null {
  if (!companion) return null;
  try {
    const parsed = loadYaml(companion) as { certification?: Partial<CertificationReceipt> } | null;
    const receipt = parsed?.certification;
    if (!receipt || typeof receipt !== 'object') return null;
    if (typeof receipt.certifiedBy !== 'string' || typeof receipt.certifiedAt !== 'string') return null;
    const certifiedAt = receipt.certifiedAt as unknown;
    return {
      certifiedBy: receipt.certifiedBy,
      certifiedAt: certifiedAt instanceof Date ? certifiedAt.toISOString() : String(certifiedAt),
      via: (receipt.via ?? 'block-studio') as CertificationSurface,
      rules: receipt.rules === 'enterprise' ? 'enterprise' : 'oss',
      sourceSha256: typeof receipt.sourceSha256 === 'string' ? receipt.sourceSha256 : '',
      ...(Array.isArray(receipt.checks) ? { checks: receipt.checks.map(String) } : {}),
      ...(Array.isArray(receipt.warnings) ? { warnings: receipt.warnings.map(String) } : {}),
    };
  } catch {
    return null;
  }
}
