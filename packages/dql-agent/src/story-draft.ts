/**
 * Drafting a story page (RFC 0008 step 8).
 *
 * The model writes prose around `{{binding}}` keys and never sees a place to
 * put a number of its own: every figure a reader sees is filled in from the
 * page's governed results at run time. Each draft is checked (known
 * bindings, no literal numbers, real tiles); one retry gets the problems
 * back, and a deterministic draft built from the bindings alone is the
 * fallback, so the author always gets a valid story.
 */
import type { DashboardNarrative, DashboardNarrativeBlock, StoryBindingCatalog } from '@duckcodeailabs/dql-core';
import { MAX_STORY_BLOCKS, STORY_BINDING_PATTERN, validateStoryText } from '@duckcodeailabs/dql-core';

export interface StoryDraftInput {
  pageTitle: string;
  goal?: string;
  audience?: string;
  /** What the author asked for, if anything. */
  instruction?: string;
  catalog: StoryBindingCatalog;
  tiles: Array<{ tileId: string; title: string; kind: string }>;
  /**
   * Whether the model may see current values. True only for a model inside
   * the privacy boundary; any other model gets binding names and labels,
   * never results — and a grouped tile's members are results too, so its
   * bindings reach that model named by position ("group 1"), never by member.
   */
  includeValues: boolean;
}

/**
 * The bindings as a model outside the privacy boundary may read them. A grouped tile's per-member bindings carry
 * the member (a result value: a region, a person's name) in their key and label; here they are named by position
 * instead — `{{tile.column[group 1]}}`, "… for group 1" — and `realKey` maps each such key back once a draft has
 * passed its checks. Every other binding is unchanged. With values allowed, the catalog is returned as it is.
 */
export function promptBindings(catalog: StoryBindingCatalog, includeValues: boolean): { catalog: StoryBindingCatalog; realKey: (key: string) => string; neutral: boolean } {
  if (includeValues) return { catalog, realKey: (key) => key, neutral: false };
  const shown: StoryBindingCatalog = {};
  const real = new Map<string, string>();
  const groups = new Map<string, Map<string, number>>();
  for (const binding of Object.values(catalog)) {
    const rest = binding.key.startsWith(`${binding.tileId}.`) ? binding.key.slice(binding.tileId.length + 1) : '';
    const open = rest.indexOf('[');
    if (open <= 0 || !rest.endsWith(']')) {
      // Its key and label name no member; its value (a leader's name, a figure) stays here.
      shown[binding.key] = { ...binding, value: null, display: '' };
      continue;
    }
    const column = rest.slice(0, open);
    const member = rest.slice(open + 1, -1);
    const members = groups.get(binding.tileId) ?? new Map<string, number>();
    groups.set(binding.tileId, members);
    if (!members.has(member)) members.set(member, members.size + 1);
    const position = members.get(member)!;
    const key = `${binding.tileId}.${column}[group ${position}]`;
    const suffix = ` for ${member}`;
    const label = binding.label.endsWith(suffix) ? `${binding.label.slice(0, -suffix.length)} for group ${position}` : `${binding.tileId} ${column}, group ${position}`;
    // No value, display or member text travels with it.
    shown[key] = { key, tileId: binding.tileId, label, kind: binding.kind, value: null, display: '', ...(binding.unit ? { unit: binding.unit } : {}) };
    real.set(key, binding.key);
  }
  return { catalog: shown, realKey: (key) => real.get(key) ?? key, neutral: real.size > 0 };
}

export type StoryDraftComplete = (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => Promise<string>;

export interface StoryDraftResult {
  narrative: DashboardNarrative;
  generatedBy: 'ai' | 'deterministic';
  attempts: number;
  /** Problems with the model's drafts, when it fell back. */
  issues: string[];
}

export const STORY_DRAFT_SYSTEM_PROMPT = [
  'You write the story page of a governed analytics App: short, plain business prose for the named audience.',
  'Rules you must follow exactly:',
  '1. Never write a number, amount, percentage or date digit in the text. Every figure must be a binding copied exactly from the list, written {{key}}.',
  '2. Use only binding keys from the list. Do not invent keys, and do not change their spelling.',
  '3. Do not claim causes the bindings do not show. Say "moved most" or "was largest", not "because".',
  '4. Embed the tiles that support the text with {"kind":"tile","tileId":"<id from the list>"}.',
  '5. Four to eight blocks. Text blocks are one short paragraph of markdown each (at most three sentences).',
  'Reply with JSON only, in this shape: {"blocks":[{"kind":"text","markdown":"..."},{"kind":"tile","tileId":"..."}]}',
].join('\n');

export function storyDraftUserPrompt(input: StoryDraftInput): string {
  const shown = promptBindings(input.catalog, input.includeValues).catalog;
  const bindings = Object.values(shown).slice(0, 80).map((binding) => (
    `{{${binding.key}}} — ${binding.label}${input.includeValues ? ` (now ${binding.display})` : ''}`
  ));
  const lines = [
    `Page: ${input.pageTitle}`,
    input.goal ? `Decision this page supports: ${input.goal}` : '',
    input.audience ? `Audience: ${input.audience}` : '',
    input.instruction ? `Author's request: ${input.instruction}` : '',
    '',
    'Tiles you can embed:',
    ...input.tiles.map((tile) => `- ${tile.tileId}: ${tile.title} (${tile.kind})`),
    '',
    'Bindings (the only way to show a number):',
    ...bindings,
  ];
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}

/** Check a candidate list of blocks against the page. */
export function validateStoryBlocks(value: unknown, input: Pick<StoryDraftInput, 'catalog' | 'tiles'>): { blocks: DashboardNarrativeBlock[]; issues: string[] } {
  const issues: string[] = [];
  const raw = value && typeof value === 'object' && Array.isArray((value as { blocks?: unknown }).blocks) ? (value as { blocks: unknown[] }).blocks : undefined;
  if (!raw) return { blocks: [], issues: ['The reply was not {"blocks":[...]}.'] };
  const keys = new Set(Object.keys(input.catalog));
  const tileIds = new Set(input.tiles.map((tile) => tile.tileId));
  const blocks: DashboardNarrativeBlock[] = [];
  for (const [index, entry] of raw.slice(0, MAX_STORY_BLOCKS).entries()) {
    const block = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const id = `b${index + 1}`;
    if (block.kind === 'text' && typeof block.markdown === 'string' && block.markdown.trim()) {
      const problems = validateStoryText(block.markdown.trim(), keys);
      if (problems.length) issues.push(...problems.map((problem) => `Block ${index + 1}: ${problem.message}`));
      else blocks.push({ id, kind: 'text', markdown: block.markdown.trim() });
    } else if (block.kind === 'tile' && typeof block.tileId === 'string') {
      if (tileIds.has(block.tileId)) {
        if (!blocks.some((existing) => existing.kind === 'tile' && existing.tileId === block.tileId)) blocks.push({ id, kind: 'tile', tileId: block.tileId });
      } else issues.push(`Block ${index + 1}: ${block.tileId} is not a tile on this page.`);
    } else {
      issues.push(`Block ${index + 1} is neither a text block nor a tile block.`);
    }
  }
  if (!blocks.some((block) => block.kind === 'text')) issues.push('The story needs at least one text block.');
  return { blocks, issues };
}

function parseJsonReply(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Draft a story with the model, checked, with one corrective retry and a deterministic fallback. */
export async function draftStoryNarrative(input: StoryDraftInput, complete: StoryDraftComplete | null, options: { model?: string } = {}): Promise<StoryDraftResult> {
  const issues: string[] = [];
  let attempts = 0;
  // The model reads (and is checked against) the bindings as it may see them; the draft is mapped back after.
  const shown = promptBindings(input.catalog, input.includeValues);
  if (complete && Object.keys(input.catalog).length > 0) {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: STORY_DRAFT_SYSTEM_PROMPT },
      { role: 'user', content: storyDraftUserPrompt(input) },
    ];
    for (attempts = 1; attempts <= 2; attempts += 1) {
      let reply = '';
      try {
        reply = await complete(messages);
      } catch (error) {
        issues.push(`The model did not answer: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      const checked = validateStoryBlocks(parseJsonReply(reply), { catalog: shown.catalog, tiles: input.tiles });
      if (checked.issues.length === 0) {
        const blocks = shown.neutral
          ? checked.blocks.map((block) => (block.kind === 'text' ? { ...block, markdown: block.markdown.replace(STORY_BINDING_PATTERN, (_whole, key: string) => `{{${shown.realKey(key.trim())}}}`) } : block))
          : checked.blocks;
        return {
          narrative: { version: 1, presentation: 'story', blocks, generatedBy: 'ai', ...(options.model ? { model: options.model } : {}) },
          generatedBy: 'ai',
          attempts,
          issues: [],
        };
      }
      issues.push(...checked.issues);
      messages.push(
        { role: 'assistant', content: reply },
        { role: 'user', content: `That draft broke the rules:\n${checked.issues.slice(0, 12).map((issue) => `- ${issue}`).join('\n')}\nReply again with corrected JSON only. Every number must be a {{key}} from the list.` },
      );
    }
  }
  return {
    narrative: deterministicStoryNarrative(input),
    generatedBy: 'deterministic',
    attempts: Math.min(attempts, 2),
    issues,
  };
}

const plain = (title: string) => title.replace(/\S*\d\S*/g, '').replace(/\s+/g, ' ').trim() || 'This tile';

/** A story written from the bindings alone, with no model. */
export function deterministicStoryNarrative(input: Pick<StoryDraftInput, 'catalog' | 'tiles' | 'goal' | 'pageTitle'>): DashboardNarrative {
  const blocks: DashboardNarrativeBlock[] = [];
  const add = (block: Omit<DashboardNarrativeBlock, 'id'> & Partial<Pick<DashboardNarrativeBlock, 'id'>>) => blocks.push({ ...block, id: `b${blocks.length + 1}` } as DashboardNarrativeBlock);
  const byTile = new Map<string, StoryBindingCatalog[string][]>();
  for (const binding of Object.values(input.catalog)) byTile.set(binding.tileId, [...(byTile.get(binding.tileId) ?? []), binding]);
  const sentences: string[] = [];
  for (const tile of input.tiles) {
    const bindings = byTile.get(tile.tileId) ?? [];
    const key = (suffix: string) => bindings.find((binding) => binding.key === `${tile.tileId}.${suffix}`)?.key;
    if (key('change')) {
      const topMember = key('top_member');
      sentences.push(`${plain(tile.title)} changed by {{${key('change')}}}${key('change_percent') ? ` ({{${key('change_percent')}}})` : ''} against the period before${topMember ? `; the largest move was {{${topMember}}} ({{${key('top_member_change')}}}) by {{${key('top_dimension')}}}` : ''}.`);
    } else if (key('leader') && key('leader_value')) {
      sentences.push(`In ${plain(tile.title).toLowerCase()}, {{${key('leader')}}} is highest at {{${key('leader_value')}}}.`);
    } else {
      const single = bindings.find((binding) => binding.kind === 'number' && !binding.key.includes('['));
      if (single) sentences.push(`${plain(tile.title)} is {{${single.key}}}.`);
    }
  }
  add({ kind: 'text', markdown: sentences.length ? sentences.slice(0, 3).join(' ') : `${plain(input.pageTitle)}: the current picture.` } as DashboardNarrativeBlock);
  for (const tile of input.tiles.slice(0, 6)) add({ kind: 'tile', tileId: tile.tileId } as DashboardNarrativeBlock);
  if (sentences.length > 3) add({ kind: 'text', markdown: sentences.slice(3, 6).join(' ') } as DashboardNarrativeBlock);
  return { version: 1, presentation: 'story', blocks, generatedBy: 'deterministic' };
}
