/**
 * Governed HTML pages (RFC 0008 step 9).
 *
 * A canvas page is an HTML fragment an author or AI writes for layout and
 * wording. Data enters only through two elements:
 *
 *   <dql-value bind="tile.field"></dql-value>   one bound figure (story binding keys)
 *   <dql-tile tile="tileId"></dql-tile>         one tile, drawn by DQL
 *
 * The fragment is checked, not repaired: anything outside a small allowlist
 * (scripts, event handlers, links, images, forms, external URLs, CSS that
 * fetches) is refused with a reason, and so is a number written into the
 * text. The host fills the bindings with escaped values and shows the page in
 * a sandboxed frame with no scripts and no network, and draws the trust frame
 * outside it, so generated markup can neither fetch data nor fake a badge.
 * Browser-safe: no Node imports, no DOM.
 */
import { bindingCaption, validateStoryText, type StoryBindingCatalog } from './story-bindings.js';

export const MAX_CANVAS_HTML = 60_000;
const MAX_DEPTH = 40;

const ALLOWED_TAGS = new Set([
  'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'div', 'span', 'p',
  'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'small', 'mark', 'br', 'hr',
  'blockquote', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'dl', 'dt', 'dd', 'style', 'dql-value', 'dql-tile',
]);
const VOID_TAGS = new Set(['br', 'hr']);
const GLOBAL_ATTRS = new Set(['class', 'id', 'style', 'title', 'role', 'lang', 'dir']);
const TAG_ATTRS: Record<string, Set<string>> = {
  // show="label" draws the binding's caption instead of its number, so a
  // figure's words can never disagree with the number beside them.
  'dql-value': new Set(['bind', 'show']),
  'dql-tile': new Set(['tile', 'height']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  td: new Set(['colspan', 'rowspan']),
  ol: new Set(['start', 'reversed']),
};
/** CSS that could fetch, run code or break out of the frame. */
const UNSAFE_CSS = /@import|url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding|<\/?\s*style|@font-face|image-set\s*\(|src\s*\(/i;

export interface CanvasIssue {
  code: 'TOO_LONG' | 'UNSAFE_TAG' | 'UNSAFE_ATTRIBUTE' | 'UNSAFE_CSS' | 'MALFORMED' | 'NAKED_NUMBER' | 'UNKNOWN_BINDING' | 'UNKNOWN_TILE' | 'MISSING_BINDING';
  message: string;
}

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'open'; tag: string; attrs: Array<[string, string]>; selfClosing: boolean }
  | { kind: 'close'; tag: string };

const decode = (value: string) => value
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/g, '&');
export const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function tokenize(html: string, issues: CanvasIssue[]): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let rawStyle = false;
  while (index < html.length) {
    if (rawStyle) {
      const end = html.toLowerCase().indexOf('</style', index);
      const css = html.slice(index, end < 0 ? html.length : end);
      tokens.push({ kind: 'text', text: css });
      index = end < 0 ? html.length : end;
      rawStyle = false;
      continue;
    }
    const lt = html.indexOf('<', index);
    if (lt < 0) { tokens.push({ kind: 'text', text: decode(html.slice(index)) }); break; }
    if (lt > index) tokens.push({ kind: 'text', text: decode(html.slice(index, lt)) });
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    const match = /^<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/.exec(html.slice(lt));
    if (!match) {
      issues.push({ code: 'MALFORMED', message: `Could not read the markup near "${html.slice(lt, lt + 24)}".` });
      tokens.push({ kind: 'text', text: '<' });
      index = lt + 1;
      continue;
    }
    const tag = match[2]!.toLowerCase();
    if (match[1]) tokens.push({ kind: 'close', tag });
    else {
      const attrs: Array<[string, string]> = [];
      for (const attr of match[3]!.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        attrs.push([attr[1]!.toLowerCase(), decode(attr[2] ?? attr[3] ?? attr[4] ?? '')]);
      }
      tokens.push({ kind: 'open', tag, attrs, selfClosing: Boolean(match[4]) || VOID_TAGS.has(tag) });
      if (tag === 'style' && !match[4]) rawStyle = true;
    }
    index = lt + match[0].length;
  }
  return tokens;
}

export interface CheckedCanvas {
  /** Canonical markup: re-serialized from the checked tokens. */
  html: string;
  bindings: string[];
  tiles: string[];
  issues: CanvasIssue[];
}

/**
 * Check a canvas fragment. With a catalog and tile ids, bindings and tiles
 * must also exist on the page. The returned `html` is only safe to use when
 * `issues` is empty.
 */
export function checkCanvasHtml(html: string, page?: { catalog?: StoryBindingCatalog; tileIds?: ReadonlySet<string> }): CheckedCanvas {
  const issues: CanvasIssue[] = [];
  if (html.length > MAX_CANVAS_HTML) issues.push({ code: 'TOO_LONG', message: `The page must be at most ${MAX_CANVAS_HTML} characters.` });
  const tokens = tokenize(html, issues);
  const out: string[] = [];
  const stack: string[] = [];
  const bindings = new Set<string>();
  const tiles = new Set<string>();
  const prose: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'text') {
      if (stack.at(-1) === 'style') {
        if (UNSAFE_CSS.test(token.text)) issues.push({ code: 'UNSAFE_CSS', message: 'Styles may not load fonts, images or other files, or import other styles.' });
        out.push(token.text.replace(/<\/?\s*style/gi, ''));
      } else {
        if (stack.includes('dql-value') || stack.includes('dql-tile')) {
          if (token.text.trim()) issues.push({ code: 'MALFORMED', message: '<dql-value> and <dql-tile> must be empty; ZLens fills them.' });
          continue;
        }
        prose.push(token.text);
        out.push(escapeHtml(token.text));
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(token.tag)) {
      issues.push({ code: 'UNSAFE_TAG', message: `<${token.tag}> is not allowed on a governed page. Use layout and text elements, <dql-value> and <dql-tile>.` });
      continue;
    }
    if (token.kind === 'close') {
      if (VOID_TAGS.has(token.tag)) continue;
      const at = stack.lastIndexOf(token.tag);
      if (at < 0) { issues.push({ code: 'MALFORMED', message: `</${token.tag}> closes nothing.` }); continue; }
      while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }
    const allowed = TAG_ATTRS[token.tag];
    const kept: string[] = [];
    for (const [name, value] of token.attrs) {
      const ok = GLOBAL_ATTRS.has(name) || name.startsWith('aria-') || allowed?.has(name);
      if (!ok) {
        issues.push({ code: 'UNSAFE_ATTRIBUTE', message: `The ${name} attribute is not allowed${name.startsWith('on') ? ': pages cannot run code' : ''}.` });
        continue;
      }
      if (name === 'style' && UNSAFE_CSS.test(value)) { issues.push({ code: 'UNSAFE_CSS', message: 'Inline styles may not load files or run code.' }); continue; }
      if (name === 'show' && value !== 'label' && value !== 'value') {
        issues.push({ code: 'UNSAFE_ATTRIBUTE', message: 'show must be "label" or "value".' });
        continue;
      }
      if ((name === 'colspan' || name === 'rowspan' || name === 'start' || name === 'height') && !/^\d{1,4}$/.test(value)) {
        issues.push({ code: 'UNSAFE_ATTRIBUTE', message: `${name} must be a whole number.` });
        continue;
      }
      kept.push(value === '' && name === 'reversed' ? name : `${name}="${escapeHtml(value)}"`);
    }
    if (token.tag === 'dql-value') {
      const key = token.attrs.find(([name]) => name === 'bind')?.[1]?.trim();
      if (!key) issues.push({ code: 'MISSING_BINDING', message: '<dql-value> needs bind="…".' });
      else {
        bindings.add(key);
        if (page?.catalog && !page.catalog[key]) issues.push({ code: 'UNKNOWN_BINDING', message: `bind="${key}" is not a value on this page.` });
      }
    }
    if (token.tag === 'dql-tile') {
      const id = token.attrs.find(([name]) => name === 'tile')?.[1]?.trim();
      if (!id) issues.push({ code: 'MISSING_BINDING', message: '<dql-tile> needs tile="…".' });
      else {
        tiles.add(id);
        if (page?.tileIds && !page.tileIds.has(id)) issues.push({ code: 'UNKNOWN_TILE', message: `tile="${id}" is not a tile on this page.` });
      }
    }
    out.push(`<${token.tag}${kept.length ? ` ${kept.join(' ')}` : ''}>`);
    if (VOID_TAGS.has(token.tag)) continue;
    if (token.selfClosing) { out.push(`</${token.tag}>`); continue; }
    stack.push(token.tag);
    if (stack.length > MAX_DEPTH) { issues.push({ code: 'MALFORMED', message: `Elements nest more than ${MAX_DEPTH} deep.` }); break; }
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  for (const issue of validateStoryText(prose.join(' '))) {
    if (issue.code === 'NAKED_NUMBER') issues.push({ code: 'NAKED_NUMBER', message: `${issue.message.replace('Bind it with {{…}}', 'Use <dql-value bind="…"> instead')}` });
  }
  return { html: out.join(''), bindings: [...bindings], tiles: [...tiles], issues: dedupeIssues(issues) };
}

function dedupeIssues(issues: CanvasIssue[]): CanvasIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => (seen.has(issue.message) ? false : (seen.add(issue.message), true)));
}

/**
 * Fill a checked fragment: each <dql-value> becomes its escaped display
 * value, each <dql-tile> the markup DQL drew for it. Anything the run did
 * not return shows as a dash.
 */
export function fillCanvasHtml(checkedHtml: string, catalog: StoryBindingCatalog, drawTile: (tileId: string, height?: number) => string): string {
  // An editor's path annotation (annotateCanvasHtml) rides along so the
  // Studio can tell which source element a click landed on.
  const pathOf = (attrs: string) => {
    const path = /data-dql-path="([\d.]*)"/.exec(attrs)?.[1];
    return path === undefined ? '' : ` data-dql-path="${path}"`;
  };
  return checkedHtml
    .replace(/<dql-value([^>]*)><\/dql-value>/g, (_, attrs: string) => {
      const key = decode(/bind="([^"]*)"/.exec(attrs)?.[1] ?? '');
      const binding = catalog[key];
      if (/show="label"/.test(attrs)) {
        return `<span class="dql-value-label" data-bind="${escapeHtml(key)}" data-show="label"${pathOf(attrs)}>${binding ? escapeHtml(bindingCaption(binding, catalog)) : '—'}</span>`;
      }
      return binding
        ? `<span class="dql-value" data-bind="${escapeHtml(key)}"${pathOf(attrs)} title="${escapeHtml(binding.label)}">${escapeHtml(binding.display)}</span>`
        : `<span class="dql-value missing" data-bind="${escapeHtml(key)}"${pathOf(attrs)} title="${escapeHtml(`${key} is not in this run's results`)}">—</span>`;
    })
    .replace(/<dql-tile([^>]*)><\/dql-tile>/g, (_, attrs: string) => {
      const id = decode(/tile="([^"]*)"/.exec(attrs)?.[1] ?? '');
      const height = Number(/height="(\d+)"/.exec(attrs)?.[1]) || undefined;
      return `<div class="dql-tile" data-tile="${escapeHtml(id)}"${pathOf(attrs)}>${drawTile(id, height)}</div>`;
    });
}

// ─── Editing a canvas as a tree (Custom layout editing in Studio) ───────────

/** A checked canvas as a tree. Paths are child indexes from the root. */
export type CanvasNode =
  | { kind: 'element'; tag: string; attrs: Array<[string, string]>; children: CanvasNode[] }
  | { kind: 'text'; text: string };
export type CanvasPath = number[];

/**
 * Read markup into a tree. Pass checked markup (`checkCanvasHtml(...).html`):
 * the tree keeps what it is given and does not check it again.
 */
export function parseCanvasHtml(html: string): CanvasNode[] {
  const root: CanvasNode[] = [];
  const stack: Array<Extract<CanvasNode, { kind: 'element' }>> = [];
  const add = (node: CanvasNode) => (stack.at(-1)?.children ?? root).push(node);
  for (const token of tokenize(html, [])) {
    if (token.kind === 'text') {
      if (token.text) add({ kind: 'text', text: token.text });
      continue;
    }
    if (token.kind === 'close') {
      const at = stack.map((node) => node.tag).lastIndexOf(token.tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    const node: CanvasNode = { kind: 'element', tag: token.tag, attrs: token.attrs, children: [] };
    add(node);
    if (!token.selfClosing && !VOID_TAGS.has(token.tag)) stack.push(node);
  }
  return root;
}

/** Write a tree back as markup. `annotate` adds `data-dql-path` for an editor; never save annotated markup. */
export function serializeCanvasNodes(nodes: CanvasNode[], options: { annotate?: boolean } = {}, prefix: CanvasPath = [], inStyle = false): string {
  return nodes.map((node, index) => {
    if (node.kind === 'text') return inStyle ? node.text : escapeHtml(node.text);
    const path = [...prefix, index];
    const attrs = node.attrs.map(([name, value]) => (value === '' && name === 'reversed' ? name : `${name}="${escapeHtml(value)}"`));
    if (options.annotate && node.tag !== 'style') attrs.push(`data-dql-path="${path.join('.')}"`);
    const open = `<${node.tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
    if (VOID_TAGS.has(node.tag)) return open;
    return `${open}${serializeCanvasNodes(node.children, options, path, node.tag === 'style')}</${node.tag}>`;
  }).join('');
}

/** Checked markup with a `data-dql-path` on every element, for an editor to map clicks back to the source. */
export function annotateCanvasHtml(checkedHtml: string): string {
  return serializeCanvasNodes(parseCanvasHtml(checkedHtml), { annotate: true });
}

export function canvasNodeAt(nodes: CanvasNode[], path: CanvasPath): CanvasNode | undefined {
  let list = nodes;
  let node: CanvasNode | undefined;
  for (const index of path) {
    node = list[index];
    if (!node) return undefined;
    list = node.kind === 'element' ? node.children : [];
  }
  return node;
}

function updateChildren(nodes: CanvasNode[], parent: CanvasPath, update: (children: CanvasNode[]) => CanvasNode[]): CanvasNode[] {
  if (!parent.length) return update(nodes);
  const [head, ...rest] = parent as [number, ...number[]];
  return nodes.map((node, index) => (index === head && node.kind === 'element'
    ? { ...node, children: updateChildren(node.children, rest, update) }
    : node));
}

const isBlockSibling = (node: CanvasNode | undefined) => node?.kind === 'element' && node.tag !== 'style';
const CONTAINER_TAGS = new Set(['section', 'article', 'main', 'div', 'header', 'footer', 'aside', 'nav']);

/**
 * Where new pieces go: the page's main container. A layout wrapped in one
 * <article> or <main> puts new pieces inside it, not after it.
 */
export function canvasContainerPath(nodes: CanvasNode[]): CanvasPath {
  const path: CanvasPath = [];
  let list = nodes;
  for (;;) {
    const elements = list.map((node, index) => ({ node, index })).filter(({ node }) => isBlockSibling(node));
    const only = elements.length === 1 ? elements[0]! : undefined;
    if (!only || only.node.kind !== 'element' || !CONTAINER_TAGS.has(only.node.tag)) return path;
    // A lone container of inline text is a piece, not the page's frame.
    if (!only.node.children.some((child) => child.kind === 'element' && !INLINE_TAGS.has(child.tag))) return path;
    path.push(only.index);
    list = only.node.children;
  }
}

/** Move a piece before the previous piece or after the next one. Returns its new path, or null at the edge. */
export function moveCanvasNode(nodes: CanvasNode[], path: CanvasPath, direction: -1 | 1): { nodes: CanvasNode[]; path: CanvasPath } | null {
  if (!path.length) return null;
  const parent = path.slice(0, -1);
  const index = path.at(-1)!;
  const siblings = parent.length ? (canvasNodeAt(nodes, parent) as Extract<CanvasNode, { kind: 'element' }> | undefined)?.children : nodes;
  if (!siblings?.[index]) return null;
  let target = index + direction;
  while (target >= 0 && target < siblings.length && !isBlockSibling(siblings[target])) target += direction;
  if (target < 0 || target >= siblings.length) return null;
  const next = updateChildren(nodes, parent, (children) => {
    const copy = [...children];
    const [moved] = copy.splice(index, 1);
    copy.splice(target, 0, moved!);
    return copy;
  });
  return { nodes: next, path: [...parent, target] };
}

export function removeCanvasNode(nodes: CanvasNode[], path: CanvasPath): CanvasNode[] {
  if (!path.length) return nodes;
  return updateChildren(nodes, path.slice(0, -1), (children) => children.filter((_, index) => index !== path.at(-1)));
}

export function replaceCanvasNode(nodes: CanvasNode[], path: CanvasPath, replacement: CanvasNode): CanvasNode[] {
  if (!path.length) return nodes;
  return updateChildren(nodes, path.slice(0, -1), (children) => children.map((child, index) => (index === path.at(-1) ? replacement : child)));
}

/** Insert pieces after `after`, or at the end of the page's main container. Returns the first new piece's path. */
export function insertCanvasNodes(nodes: CanvasNode[], inserted: CanvasNode[], after?: CanvasPath): { nodes: CanvasNode[]; path: CanvasPath } {
  const parent = after?.length ? after.slice(0, -1) : canvasContainerPath(nodes);
  let at = 0;
  const next = updateChildren(nodes, parent, (children) => {
    at = after?.length ? after.at(-1)! + 1 : children.length;
    return [...children.slice(0, at), ...inserted, ...children.slice(at)];
  });
  return { nodes: next, path: [...parent, at] };
}

/**
 * Change which number a <dql-value> shows, and keep the words about it true:
 * inside the same piece (`blockPath`), captions bound to the old number
 * (`show="label"`) follow it, and a caption typed as plain text that names
 * the old number (`oldCaptions`) becomes a bound caption of the new one.
 * RFC 0009 evaluation D4: the number changed while its caption kept naming
 * the old one.
 */
export function rebindCanvasValue(nodes: CanvasNode[], valuePath: CanvasPath, blockPath: CanvasPath, newKey: string, oldCaptions: string[] = []): CanvasNode[] {
  const value = canvasNodeAt(nodes, valuePath);
  if (value?.kind !== 'element' || value.tag !== 'dql-value') return nodes;
  const oldKey = value.attrs.find(([name]) => name === 'bind')?.[1];
  const captions = new Set(oldCaptions.map((caption) => caption.trim().toLowerCase()).filter(Boolean));
  const boundLabel = (): CanvasNode => ({ kind: 'element', tag: 'dql-value', attrs: [['bind', newKey], ['show', 'label']], children: [] });
  const relabel = (node: CanvasNode): CanvasNode => {
    if (node.kind === 'text') return captions.has(node.text.trim().toLowerCase()) ? boundLabel() : node;
    if (node.tag === 'dql-value') {
      const bind = node.attrs.find(([name]) => name === 'bind')?.[1];
      const label = node.attrs.some(([name, attr]) => name === 'show' && attr === 'label');
      return label && bind === oldKey ? boundLabel() : node;
    }
    return { ...node, children: node.children.map(relabel) };
  };
  const rebound = replaceCanvasNode(nodes, valuePath, { ...value, attrs: [...value.attrs.filter(([name]) => name !== 'bind'), ['bind', newKey]] });
  const block = blockPath.length && blockPath.length < valuePath.length ? canvasNodeAt(rebound, blockPath) : undefined;
  return block?.kind === 'element' ? replaceCanvasNode(rebound, blockPath, relabel(block)) : rebound;
}

const INLINE_TAGS = new Set(['span', 'strong', 'em', 'b', 'i', 'small', 'mark', 'br', 'dql-value']);
const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'li', 'blockquote', 'figcaption', 'dt', 'dd', 'span', 'small', 'strong', 'em', 'td', 'th']);

export type CanvasPieceKind = 'tile' | 'value' | 'heading' | 'text' | 'list' | 'table' | 'rule' | 'group';

/** What a piece is, for the editor's label and tools. Text pieces can be typed into. */
export function canvasPieceKind(node: CanvasNode): CanvasPieceKind {
  if (node.kind === 'text') return 'text';
  if (node.tag === 'dql-tile') return 'tile';
  if (node.tag === 'dql-value') return 'value';
  if (/^h[1-4]$/.test(node.tag)) return 'heading';
  if (node.tag === 'ul' || node.tag === 'ol' || node.tag === 'dl') return 'list';
  if (node.tag === 'table') return 'table';
  if (node.tag === 'hr') return 'rule';
  if (TEXT_TAGS.has(node.tag)) return 'text';
  // A box of words and numbers (a figure card) is typed into like text.
  const inline = node.children.every((child) => child.kind === 'text' || INLINE_TAGS.has(child.tag)
    || (child.kind === 'element' && TEXT_TAGS.has(child.tag) && child.children.every((inner) => inner.kind === 'text' || (inner.kind === 'element' && INLINE_TAGS.has(inner.tag)))));
  return inline && node.children.length > 0 ? 'text' : 'group';
}
