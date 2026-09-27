/**
 * Story editions (RFC 0008 step 8). Each complete run of a published story
 * page records the values its bindings showed, so readers can see what
 * changed since the last edition. Editions are local to this project
 * (`.dql/local`), never in git, and keep only bound values, not rows.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { storyBindingKeys, type DashboardNarrative, type StoryBindingCatalog } from '@duckcodeailabs/dql-core';

export interface StoryEdition {
  runId: string;
  createdAt: string;
  resultFingerprint: string;
  /** The run's filter fingerprint, kept for older readers. */
  filterFingerprint: string;
  /**
   * Editions compare only within one scope: the page's effective filter and
   * parameter values. Unlike the run's filter fingerprint it does not change
   * with how a run was requested, so the same filters always meet again.
   */
  scope?: string;
  values: Record<string, { display: string; value: number | string | null; label: string }>;
}

export const MAX_STORY_EDITIONS = 30;

const safe = (value: string) => `${value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;

/**
 * Where a page's editions live. With a host each person has their own
 * (`person`, a hash of who they are): an edition holds the values that
 * person's run showed under their row rules, so it is never shown to anyone
 * else. Without a host there is one local person and one file, as before.
 */
export function storyEditionsPath(projectRoot: string, appId: string, dashboardId: string, person?: string): string {
  const owner = person && person !== 'local' ? `.${person.replace(/[^a-z0-9-]/gi, '').slice(0, 64)}` : '';
  return join(projectRoot, '.dql', 'local', 'story-editions', safe(appId), `${safe(dashboardId)}${owner}.json`);
}

export function listStoryEditions(projectRoot: string, appId: string, dashboardId: string, person?: string): StoryEdition[] {
  const path = storyEditionsPath(projectRoot, appId, dashboardId, person);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is StoryEdition => Boolean(entry && typeof entry === 'object' && typeof (entry as StoryEdition).runId === 'string')) : [];
  } catch {
    return [];
  }
}

/**
 * Record an edition for a complete run. A run with the same results and
 * filters as the latest edition adds nothing: an edition marks a change.
 */
export function recordStoryEdition(input: {
  projectRoot: string;
  appId: string;
  dashboardId: string;
  narrative: DashboardNarrative;
  catalog: StoryBindingCatalog;
  runId: string;
  resultFingerprint: string;
  filterFingerprint: string;
  scope: string;
  now?: Date;
  /** Whose editions (see `storyEditionsPath`). */
  person?: string;
}): StoryEdition | null {
  if (input.narrative.presentation !== 'story') return null;
  const keys = Array.from(new Set(input.narrative.blocks.flatMap((block) => (block.kind === 'text' ? storyBindingKeys(block.markdown) : []))));
  const values: StoryEdition['values'] = {};
  for (const key of keys) {
    const binding = input.catalog[key];
    if (binding) values[key] = { display: binding.display, value: binding.value, label: binding.label };
  }
  const existing = listStoryEditions(input.projectRoot, input.appId, input.dashboardId, input.person);
  const latest = [...existing].reverse().find((edition) => edition.scope === input.scope);
  // An edition marks a change in the data, not in how a value is printed.
  const sameValues = (left: StoryEdition['values'], right: StoryEdition['values']) => {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => left[key]?.value === right[key]?.value);
  };
  if (latest && (latest.resultFingerprint === input.resultFingerprint || sameValues(latest.values, values))) return null;
  const edition: StoryEdition = {
    runId: input.runId,
    createdAt: (input.now ?? new Date()).toISOString(),
    resultFingerprint: input.resultFingerprint,
    filterFingerprint: input.filterFingerprint,
    scope: input.scope,
    values,
  };
  const next = [...existing, edition].slice(-MAX_STORY_EDITIONS);
  const path = storyEditionsPath(input.projectRoot, input.appId, input.dashboardId, input.person);
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
  return edition;
}

/**
 * The scope an edition belongs to: the page's declared filters and
 * parameters with their effective values (defaults applied), plus any
 * cross-filter or drill. Order-independent and stable across runs.
 */
export function storyEditionScope(
  dashboard: { filters?: Array<{ id: string }>; params?: Array<{ id: string }> },
  effectiveValues: Record<string, unknown>,
  interactions: unknown[] = [],
): string {
  const ids = [...(dashboard.filters ?? []), ...(dashboard.params ?? [])].map((entry) => entry.id).sort();
  const values = ids.map((id) => {
    const value = effectiveValues[id];
    const normalized = Array.isArray(value) ? [...value].map(String).sort() : value === undefined || value === '' ? null : value;
    return [id, normalized];
  });
  return `scope:${createHash('sha256').update(JSON.stringify({ values, interactions })).digest('hex')}`;
}
