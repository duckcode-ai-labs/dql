/**
 * Drafting a governed HTML page (RFC 0008 step 9).
 *
 * The model designs the page (layout, headings, wording, CSS) and places
 * data only through <dql-value bind> and <dql-tile tile>. Every draft goes
 * through the same checker as a saved page: unsafe markup, unknown bindings
 * or tiles, and literal numbers are refused; one retry gets the reasons, and
 * a plain template built from the bindings is the fallback.
 */
import type { DashboardCanvas, StoryBindingCatalog } from '@duckcodeailabs/dql-core';
import { checkCanvasHtml } from '@duckcodeailabs/dql-core';
import { promptBindings, type StoryDraftComplete, type StoryDraftInput } from './story-draft.js';

export type CanvasDraftInput = StoryDraftInput;

export interface CanvasDraftResult {
  canvas: DashboardCanvas;
  generatedBy: 'ai' | 'deterministic';
  attempts: number;
  issues: string[];
}

export const CANVAS_DRAFT_SYSTEM_PROMPT = [
  'You design one page of a governed analytics App as an HTML fragment: a clear, editorial layout for the named audience.',
  'Rules you must follow exactly:',
  '1. Data only through <dql-value bind="KEY"></dql-value> (one figure; KEY copied exactly from the list) and <dql-tile tile="TILE_ID"></dql-tile> (a chart, table or KPI DQL draws). Both stay empty.',
  '2. Never write a number, amount, percentage or date digit in the text. Every figure is a <dql-value>.',
  '3. Allowed elements only: section article header footer main aside nav div span p h1 h2 h3 h4 ul ol li strong em b i small mark br hr blockquote figure figcaption table thead tbody tr th td dl dt dd style, plus dql-value and dql-tile.',
  '4. No script, links, images, forms, iframes, SVG, event handlers (onclick…), or CSS that loads anything (no url(), @import, @font-face).',
  '5. One <style> block first. Use class selectors and these theme variables: --dql-ink, --dql-muted, --dql-line, --dql-surface, --dql-accent, --dql-accent-soft, --dql-font, --dql-font-display. Use CSS grid or flex; keep it readable at narrow widths.',
  '6. Do not claim causes the bindings do not show.',
  'Reply with the HTML fragment only: no explanation, no code fence, no <html>, <head> or <body>.',
].join('\n');

export function canvasDraftUserPrompt(input: CanvasDraftInput): string {
  // Outside the privacy boundary a grouped tile's members are named by position, never by member (story-draft.ts).
  const shown = promptBindings(input.catalog, input.includeValues).catalog;
  const bindings = Object.values(shown).slice(0, 80).map((binding) => (
    `${binding.key} — ${binding.label}${input.includeValues ? ` (now ${binding.display})` : ''}`
  ));
  return [
    `Page: ${input.pageTitle}`,
    input.goal ? `Decision this page supports: ${input.goal}` : '',
    input.audience ? `Audience: ${input.audience}` : '',
    input.instruction ? `Author's request: ${input.instruction}` : '',
    '',
    'Tiles (for <dql-tile tile="…">):',
    ...input.tiles.map((tile) => `- ${tile.tileId}: ${tile.title} (${tile.kind})`),
    '',
    'Bindings (for <dql-value bind="…">, the only way to show a figure):',
    ...bindings,
  ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '').join('\n');
}

function extractHtml(reply: string): string {
  let text = reply.trim();
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  text = text.replace(/<\/?(?:html|head|body)[^>]*>/gi, '').replace(/<!doctype[^>]*>/gi, '').trim();
  const first = text.indexOf('<');
  return first > 0 ? text.slice(first) : text;
}

/** Draft a governed HTML page, checked, with one corrective retry and a template fallback. */
export async function draftCanvasPage(input: CanvasDraftInput, complete: StoryDraftComplete | null, options: { model?: string } = {}): Promise<CanvasDraftResult> {
  const issues: string[] = [];
  let attempts = 0;
  const tileIds = new Set(input.tiles.map((tile) => tile.tileId));
  const shown = promptBindings(input.catalog, input.includeValues);
  if (complete && Object.keys(input.catalog).length > 0) {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: CANVAS_DRAFT_SYSTEM_PROMPT },
      { role: 'user', content: canvasDraftUserPrompt(input) },
    ];
    for (attempts = 1; attempts <= 2; attempts += 1) {
      let reply = '';
      try {
        reply = await complete(messages);
      } catch (error) {
        issues.push(`The model did not answer: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      const html = extractHtml(reply);
      const checked = checkCanvasHtml(html, { catalog: shown.catalog, tileIds });
      const problems = checked.issues.map((issue) => issue.message);
      if (!html) problems.push('The reply had no HTML.');
      if (checked.bindings.length === 0 && checked.tiles.length === 0) problems.push('The page shows no data: use <dql-value> or <dql-tile>.');
      if (problems.length === 0) {
        const placed = shown.neutral ? withRealBindings(checked.html, shown.realKey) : checked.html;
        return {
          canvas: { version: 1, html: placed, generatedBy: 'ai', ...(options.model ? { model: options.model } : {}) },
          generatedBy: 'ai',
          attempts,
          issues: [],
        };
      }
      issues.push(...problems);
      messages.push(
        { role: 'assistant', content: reply },
        { role: 'user', content: `That page broke the rules:\n${problems.slice(0, 12).map((problem) => `- ${problem}`).join('\n')}\nReply again with the corrected HTML fragment only.` },
      );
    }
  }
  return { canvas: deterministicCanvasPage(input), generatedBy: 'deterministic', attempts: Math.min(attempts, 2), issues };
}

const plain = (title: string) => title.replace(/\S*\d\S*/g, '').replace(/\s+/g, ' ').trim() || 'This tile';
const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A clean page from the bindings alone: headline figures, then each tile. */
export function deterministicCanvasPage(input: Pick<CanvasDraftInput, 'catalog' | 'tiles' | 'pageTitle' | 'goal'>): DashboardCanvas {
  const catalog: StoryBindingCatalog = input.catalog;
  // Headline figures come from single-value tiles (KPIs); charts, grouped
  // tiles and drivers are shown as tiles.
  const derived = /\.(leader|leader_value|current|prior|change|change_percent|top_dimension|top_member|top_member_change)$/;
  const singleValue = (tileId: string) => {
    const own = Object.values(catalog).filter((binding) => binding.tileId === tileId);
    return own.length > 0 && own.every((binding) => binding.kind === 'number' && !binding.key.includes('[') && !derived.test(binding.key));
  };
  const figures = input.tiles
    .filter((tile) => singleValue(tile.tileId))
    .map((tile) => Object.values(catalog).find((binding) => binding.tileId === tile.tileId))
    .filter((binding): binding is NonNullable<typeof binding> => Boolean(binding))
    .slice(0, 4);
  const html = [
    '<style>',
    '.page{display:grid;gap:24px;font-family:var(--dql-font);color:var(--dql-ink)}',
    '.hero h1{margin:0;font:600 32px/1.2 var(--dql-font-display)}',
    '.hero p{margin:6px 0 0;color:var(--dql-muted)}',
    '.band{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}',
    '.figure{padding:14px 16px;border:1px solid var(--dql-line);border-radius:12px;background:var(--dql-surface)}',
    '.figure small{display:block;color:var(--dql-muted)}',
    '.figure strong{display:block;margin-top:4px;font-size:24px}',
    '.tiles{display:grid;gap:16px}',
    '</style>',
    '<article class="page">',
    `<header class="hero"><h1>${esc(plain(input.pageTitle))}</h1>${input.goal ? `<p>${esc(plain(input.goal))}</p>` : ''}</header>`,
    figures.length ? `<section class="band">${figures.map((binding) => `<div class="figure"><small>${esc(plain(input.tiles.find((tile) => tile.tileId === binding.tileId)?.title ?? binding.label))}</small><strong><dql-value bind="${esc(binding.key)}"></dql-value></strong></div>`).join('')}</section>` : '',
    `<section class="tiles">${input.tiles.filter((tile) => !figures.some((binding) => binding.tileId === tile.tileId)).slice(0, 6).map((tile) => `<dql-tile tile="${esc(tile.tileId)}"></dql-tile>`).join('')}</section>`,
    '</article>',
  ].join('');
  const checked = checkCanvasHtml(html);
  return { version: 1, html: checked.html, generatedBy: 'deterministic' };
}

const unescapeAttribute = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A checked page with each position-named binding (`bind="tile.column[group 1]"`) placed back as its real key. */
function withRealBindings(html: string, realKey: (key: string) => string): string {
  return html.replace(/(<dql-value\b[^>]*?\bbind=)(["'])([^"']*)\2/gi, (_whole, head: string, quote: string, key: string) => `${head}"${esc(realKey(unescapeAttribute(key)))}"`);
}
