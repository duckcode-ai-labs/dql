/**
 * ONE PERSON'S HOME (RFC 0010, HH-16).
 *
 * What a person's Home summarises is theirs alone, kept in the project's
 * private folder (`.dql/local/private/home/<person>.json`, never in git):
 *
 *   - the App pages they follow (a host with a `follows` hook keeps those
 *     itself, so it can tell them about new editions);
 *   - the pages they opened recently;
 *   - for each page, the governed figures of their own last two complete
 *     runs, so "What moved" compares what *they* saw — with their row rules,
 *     their persona — and never another person's numbers.
 *
 * Only certified or governed tiles' single figures are kept (never a tile
 * that needs review, never rows). With a host, each person's file is keyed
 * by a hash of their id; without one, there is one local person.
 *
 * A page's published editions (scheduled runs) are kept apart, with no
 * figures: only when the last one ran and a fingerprint of what it showed,
 * so DQL can tell a new edition from a repeat.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bindingCaption, figureLabel, formatStoryValue, type StoryBinding, type StoryBindingCatalog } from '@duckcodeailabs/dql-core';
import type { DqlFollow, DqlPrincipal } from '../host/request-context.js';

export interface HomeFigure {
  key: string;
  tileId: string;
  label: string;
  value: number;
  display: string;
  unit?: StoryBinding['unit'];
}

export interface HomeEdition {
  runId: string;
  at: string;
  figures: HomeFigure[];
}

export interface HomePageState {
  appId: string;
  pageId: string;
  /** The filters, parameters and persona the figures were read under: editions compare only within one. */
  scope: string;
  lastRunAt: string;
  /** Oldest first; at most two. */
  editions: HomeEdition[];
}

export interface HomeState {
  version: 1;
  follows: DqlFollow[];
  recent: Array<{ appId: string; pageId: string; openedAt: string }>;
  pages: Record<string, HomePageState>;
}

export interface MovedFigure {
  label: string;
  from: string;
  to: string;
  /** "+12" / "−$3,400" / "+4.5%". */
  change: string;
  direction: 'up' | 'down';
}

export interface MovedPage {
  appId: string;
  pageId: string;
  /** When the person's latest run was. */
  at: string;
  /** The run it is compared with, when there is one. */
  since?: string;
  changes: MovedFigure[];
  /** Figures that stayed the same, counted. */
  unchanged: number;
  /** A scheduled run gave a newer edition than the person's last look. */
  newEditionAt?: string;
}

export const MAX_RECENT = 20;
export const MAX_FOLLOWS = 100;
export const MAX_PAGE_STATES = 60;
export const MAX_FIGURES_PER_PAGE = 8;

const empty = (): HomeState => ({ version: 1, follows: [], recent: [], pages: {} });

/** Whose Home: `local` without a host, else a hash of the host's id for the person. */
export function homePersonKey(principal: DqlPrincipal | null | undefined): string {
  if (!principal || principal.source === 'local') return 'local';
  return `p-${createHash('sha256').update(`${principal.source}:${principal.id}`).digest('hex').slice(0, 32)}`;
}

export function homeStatePath(projectRoot: string, personKey: string): string {
  const safe = /^[a-z0-9-]{1,64}$/.test(personKey) ? personKey : createHash('sha256').update(personKey).digest('hex').slice(0, 32);
  return join(projectRoot, '.dql', 'local', 'private', 'home', `${safe}.json`);
}

export function readHomeState(projectRoot: string, personKey: string): HomeState {
  const path = homeStatePath(projectRoot, personKey);
  if (!existsSync(path)) return empty();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<HomeState>;
    return {
      version: 1,
      follows: Array.isArray(raw.follows) ? raw.follows.filter((follow) => follow && typeof follow.appId === 'string') : [],
      recent: Array.isArray(raw.recent) ? raw.recent.filter((entry) => entry && typeof entry.appId === 'string' && typeof entry.pageId === 'string') : [],
      pages: raw.pages && typeof raw.pages === 'object' ? raw.pages as Record<string, HomePageState> : {},
    };
  } catch {
    return empty();
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}

function writeHomeState(projectRoot: string, personKey: string, state: HomeState): void {
  writeJson(homeStatePath(projectRoot, personKey), state);
}

const followKey = (follow: Pick<DqlFollow, 'appId' | 'pageId'>) => `${follow.appId}/${follow.pageId ?? ''}`;

/** Follow or stop following a page, in this person's own file. */
export function setLocalFollow(projectRoot: string, personKey: string, follow: DqlFollow, following: boolean, now = new Date()): DqlFollow[] {
  const state = readHomeState(projectRoot, personKey);
  const rest = state.follows.filter((entry) => followKey(entry) !== followKey(follow));
  state.follows = following
    ? [...rest, { appId: follow.appId, ...(follow.pageId ? { pageId: follow.pageId } : {}), ...(follow.title ? { title: follow.title.slice(0, 200) } : {}), followedAt: now.toISOString() }].slice(-MAX_FOLLOWS)
    : rest;
  writeHomeState(projectRoot, personKey, state);
  return state.follows;
}

/** Whether a follow list covers this page (a follow of the App covers its home page too). */
export function followsPage(follows: DqlFollow[], appId: string, pageId: string | undefined): boolean {
  return follows.some((follow) => follow.appId === appId && (follow.pageId ?? '') === (pageId ?? ''));
}

const SKIP_SUFFIX = /\.(prior|change|change_percent|top_member_change)$/;

/**
 * The figures of one run worth watching: single values (a KPI's number, a
 * driver's current value, a leader's value) from certified or governed tiles
 * only. Grouped members, deltas the page computes itself and anything from a
 * tile that needs review are left out.
 */
export function pageFiguresFrom(catalog: StoryBindingCatalog | undefined, tileTrust: Record<string, string | null | undefined> | undefined, titles: Record<string, string | undefined> = {}): HomeFigure[] {
  if (!catalog) return [];
  const bindings = Object.values(catalog).filter((binding) => binding.kind === 'number'
    && typeof binding.value === 'number' && Number.isFinite(binding.value)
    && !binding.key.includes('[') && !SKIP_SUFFIX.test(binding.key)
    && (tileTrust?.[binding.tileId] === 'certified' || tileTrust?.[binding.tileId] === 'governed'));
  const perTile = new Map<string, number>();
  for (const binding of bindings) perTile.set(binding.tileId, (perTile.get(binding.tileId) ?? 0) + 1);
  return bindings.slice(0, MAX_FIGURES_PER_PAGE).map((binding) => {
    const title = titles[binding.tileId] ?? (binding.label.includes(' — ') ? binding.label.slice(0, binding.label.indexOf(' — ')) : binding.label);
    // A KPI tile's one figure reads as the tile's title; otherwise the figure's own caption.
    const label = perTile.get(binding.tileId) === 1 && !binding.key.endsWith('.leader_value') ? title : figureLabel(`${title} — ${bindingCaption(binding, catalog)}`);
    return {
      key: binding.key,
      tileId: binding.tileId,
      label: label.slice(0, 120),
      value: binding.value as number,
      display: binding.display,
      ...(binding.unit ? { unit: binding.unit } : {}),
    };
  });
}

const sameFigures = (left: HomeFigure[], right: HomeFigure[]) => left.length === right.length
  && left.every((figure) => right.some((other) => other.key === figure.key && other.value === figure.value));

/**
 * Record that this person ran a whole page: it is recent, and its figures
 * become the latest of their editions when they differ from the last one.
 * Figures read under another scope (other filters or persona) start over.
 */
export function recordPageVisit(projectRoot: string, personKey: string, input: {
  appId: string;
  pageId: string;
  runId: string;
  scope: string;
  figures: HomeFigure[];
  now?: Date;
}): void {
  const at = (input.now ?? new Date()).toISOString();
  const state = readHomeState(projectRoot, personKey);
  state.recent = [{ appId: input.appId, pageId: input.pageId, openedAt: at }, ...state.recent.filter((entry) => !(entry.appId === input.appId && entry.pageId === input.pageId))].slice(0, MAX_RECENT);
  const key = `${input.appId}/${input.pageId}`;
  const current = state.pages[key];
  const edition: HomeEdition = { runId: input.runId, at, figures: input.figures };
  if (!current || current.scope !== input.scope) {
    state.pages[key] = { appId: input.appId, pageId: input.pageId, scope: input.scope, lastRunAt: at, editions: input.figures.length ? [edition] : [] };
  } else {
    current.lastRunAt = at;
    const latest = current.editions.at(-1);
    if (input.figures.length && (!latest || !sameFigures(latest.figures, input.figures))) current.editions = [...current.editions, edition].slice(-2);
  }
  // Keep the file small: the pages opened longest ago go first.
  const keys = Object.keys(state.pages);
  if (keys.length > MAX_PAGE_STATES) {
    for (const old of keys.sort((a, b) => state.pages[a]!.lastRunAt.localeCompare(state.pages[b]!.lastRunAt)).slice(0, keys.length - MAX_PAGE_STATES)) delete state.pages[old];
  }
  writeHomeState(projectRoot, personKey, state);
}

function signedChange(delta: number, unit: StoryBinding['unit'] | undefined): string {
  const magnitude = unit?.kind === 'percent'
    ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Math.abs(delta) <= 1.5 ? Math.abs(delta) * 100 : Math.abs(delta))} pts`
    : formatStoryValue(Math.abs(delta), unit);
  return `${delta > 0 ? '+' : '−'}${magnitude}`;
}

/** What moved on one page between this person's last two runs of it. */
export function movedOnPage(page: HomePageState, publishedAt?: string): MovedPage {
  const [previous, latest] = page.editions.length >= 2 ? [page.editions.at(-2)!, page.editions.at(-1)!] : [undefined, page.editions.at(-1)];
  const changes: MovedFigure[] = [];
  let unchanged = 0;
  for (const figure of latest?.figures ?? []) {
    const before = previous?.figures.find((other) => other.key === figure.key);
    if (!before) continue;
    const delta = figure.value - before.value;
    if (delta === 0) {
      unchanged += 1;
      continue;
    }
    changes.push({ label: figure.label, from: before.display, to: figure.display, change: signedChange(delta, figure.unit), direction: delta > 0 ? 'up' : 'down' });
  }
  return {
    appId: page.appId,
    pageId: page.pageId,
    at: latest?.at ?? page.lastRunAt,
    ...(previous ? { since: previous.at } : {}),
    changes,
    unchanged,
    ...(publishedAt && publishedAt > page.lastRunAt ? { newEditionAt: publishedAt } : {}),
  };
}

// ── Published editions (scheduled runs) ───────────────────────────────────

export interface PublishedEdition { runId: string; at: string; fingerprint: string; scheduleId?: string }

const safeSegment = (value: string) => `${value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;

export function publishedEditionPath(projectRoot: string, appId: string, pageId: string): string {
  return join(projectRoot, '.dql', 'local', 'page-editions', safeSegment(appId), `${safeSegment(pageId)}.json`);
}

export function readPublishedEdition(projectRoot: string, appId: string, pageId: string): PublishedEdition | undefined {
  const path = publishedEditionPath(projectRoot, appId, pageId);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as PublishedEdition;
    return typeof raw.runId === 'string' && typeof raw.at === 'string' && typeof raw.fingerprint === 'string' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** A fingerprint of what a run showed: its bound values (no values are stored). */
export function editionFingerprint(catalog: StoryBindingCatalog | undefined, fallback: string): string {
  const values = Object.values(catalog ?? {}).map((binding) => [binding.key, binding.value] as const).sort(([left], [right]) => left.localeCompare(right));
  return values.length ? `sha256:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}` : fallback;
}

/**
 * Record a scheduled run of a page. Returns the edition when it is new — the
 * first, or one whose figures differ from the last scheduled run — else null.
 */
export function recordPublishedEdition(projectRoot: string, input: { appId: string; pageId: string; runId: string; fingerprint: string; scheduleId?: string; now?: Date }): PublishedEdition | null {
  const previous = readPublishedEdition(projectRoot, input.appId, input.pageId);
  if (previous && previous.fingerprint === input.fingerprint) return null;
  const edition: PublishedEdition = { runId: input.runId, at: (input.now ?? new Date()).toISOString(), fingerprint: input.fingerprint, ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}) };
  writeJson(publishedEditionPath(projectRoot, input.appId, input.pageId), edition);
  return edition;
}
