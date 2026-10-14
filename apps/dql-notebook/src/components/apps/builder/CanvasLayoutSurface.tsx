import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, BarChart3, Hash, Heading, Pilcrow, Settings2, SquareDashed, Trash2 } from 'lucide-react';
import {
  canvasContainerPath,
  canvasNodeAt,
  canvasPieceKind,
  checkCanvasHtml,
  insertCanvasNodes,
  moveCanvasNode,
  parseCanvasHtml,
  rebindCanvasValue,
  removeCanvasNode,
  replaceCanvasNode,
  serializeCanvasNodes,
  type CanvasIssue,
  type CanvasNode,
  type CanvasPath,
  type CanvasPieceKind,
} from '@zlens/core/apps/canvas-page';
import { bindingCaption, figureLabel, type StoryBinding, type StoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import type { CanvasFrameEditing } from '../CanvasPageFrame';

type PageTile = { tileId: string; title: string };

const PIECE_LABELS: Record<CanvasPieceKind, string> = {
  tile: 'Tile',
  value: 'Number',
  heading: 'Heading',
  text: 'Text',
  list: 'List',
  table: 'Table',
  rule: 'Divider',
  group: 'Section',
};
const TEXT_STYLES: Array<[string, string]> = [['h1', 'Title'], ['h2', 'Heading'], ['h3', 'Subheading'], ['p', 'Paragraph']];
const INLINE = new Set(['span', 'strong', 'em', 'b', 'i', 'small', 'mark', 'br']);
const TABLE_PARTS = new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot']);
const EDIT_STYLES = `
[data-dql-hover]{outline:1px dashed var(--dql-accent);outline-offset:4px;cursor:pointer}
[data-dql-selected]{outline:2px solid var(--dql-accent)!important;outline-offset:4px;border-radius:2px}
[contenteditable="true"]{cursor:text;outline:2px solid var(--dql-accent)!important;outline-offset:4px;caret-color:var(--dql-accent)}
[contenteditable="true"]:focus{outline-style:solid}
.dql-value{cursor:pointer;border-radius:4px;box-shadow:0 0 0 2px var(--dql-accent-soft);background:var(--dql-accent-soft)}
.dql-tile{cursor:pointer}
.dql-value-label{border-bottom:1px dotted var(--dql-accent)}
body{padding:10px}
`;

const text = (value: string): CanvasNode => ({ kind: 'text', text: value });
const el = (tag: string, children: CanvasNode[] = [], attrs: Array<[string, string]> = []): CanvasNode => ({ kind: 'element', tag, attrs, children });
const samePath = (left: CanvasPath | null | undefined, right: CanvasPath | null | undefined) => Boolean(left && right && left.join('.') === right.join('.'));
const pathOf = (node: Element) => {
  const raw = node.getAttribute('data-dql-path') ?? '';
  return raw ? raw.split('.').map(Number) : [];
};
/** Labels may name a period ("Revenue 2026"); a governed page never types a number, so digits are dropped. */
const wordsOnly = (label: string) => label.replace(/\S*\d\S*/g, '').replace(/\s{2,}/g, ' ').trim() || 'Value';

/** Plain words for the checker's refusals, as an author reads them. */
export function layoutRefusal(issue: CanvasIssue): string {
  if (issue.code === 'NAKED_NUMBER') return 'Numbers on this page come from your data, so typed numbers are not saved. Remove the number, or use Insert number to add one from the data.';
  if (issue.code === 'UNSAFE_TAG' || issue.code === 'UNSAFE_ATTRIBUTE' || issue.code === 'UNSAFE_CSS') return `That formatting is not allowed on a governed page and was not saved. ${issue.message}`;
  return issue.message;
}

/** The label a selected piece shows in its toolbar. */
export function layoutPieceLabel(node: CanvasNode | undefined, catalog: StoryBindingCatalog, tiles: PageTile[]): string {
  if (!node) return '';
  const kind = canvasPieceKind(node);
  if (node.kind === 'element' && kind === 'tile') {
    const id = node.attrs.find(([name]) => name === 'tile')?.[1] ?? '';
    return `Tile · ${tiles.find((tile) => tile.tileId === id)?.title ?? id}`;
  }
  if (node.kind === 'element' && kind === 'value') {
    const key = node.attrs.find(([name]) => name === 'bind')?.[1] ?? '';
    return `Number · ${catalog[key]?.label ?? key}`;
  }
  return PIECE_LABELS[kind];
}

type Popover = { kind: 'insert-number' | 'change-number' | 'add-number' | 'add-tile' } | null;

/**
 * Custom layout editing in place: click any piece to select it, type on
 * text, click a number to change what it shows, and move, add or remove
 * pieces. A tile opens the same tile settings as a dashboard. Every change
 * goes through the governed check before it is saved; a refusal says why
 * and saves nothing.
 */
export function CanvasLayoutSurface({
  html,
  catalog,
  tiles,
  disabled,
  selectedTileId,
  preview,
  onSave,
  onSelectTile,
}: {
  html: string;
  catalog: StoryBindingCatalog;
  tiles: PageTile[];
  disabled: boolean;
  selectedTileId: string | null;
  preview: (editing: CanvasFrameEditing) => ReactNode;
  onSave: (html: string) => void;
  onSelectTile: (tileId: string | null) => void;
}): JSX.Element {
  const savedNodes = useMemo(() => parseCanvasHtml(checkCanvasHtml(html).html), [html]);
  // A change saved here but not yet back from the server: the next edit builds on it, not on the older layout.
  const pendingRef = useRef<{ from: string; nodes: CanvasNode[] } | null>(null);
  const nodes = pendingRef.current && pendingRef.current.from === html ? pendingRef.current.nodes : savedNodes;
  const tileIds = useMemo(() => new Set(tiles.map((tile) => tile.tileId)), [tiles]);
  const [selected, setSelected] = useState<CanvasPath | null>(null);
  const [typing, setTyping] = useState(false);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [popover, setPopover] = useState<Popover>(null);
  const [toolbarAt, setToolbarAt] = useState<{ top: number; left: number } | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const remeasureRef = useRef<() => void>(() => undefined);
  const typingRef = useRef<{ element: HTMLElement; path: CanvasPath; dirty: boolean } | null>(null);
  /** After a save redraws the frame: start typing in this piece, selecting its words. */
  const typeNextRef = useRef<CanvasPath | null>(null);
  const latest = useRef({ nodes, selected, catalog, tiles, disabled });
  latest.current = { nodes, selected, catalog, tiles, disabled };

  const selectedNode = selected ? canvasNodeAt(nodes, selected) : undefined;
  const selectedKind = selectedNode ? canvasPieceKind(selectedNode) : undefined;
  const container = useMemo(() => canvasContainerPath(nodes), [nodes]);
  const numbers = useMemo(() => Object.values(catalog).filter((binding) => binding.kind === 'number'), [catalog]);

  // Closing the tile settings clears a selected tile here too.
  useEffect(() => {
    if (selectedKind === 'tile' && selectedNode?.kind === 'element') {
      const id = selectedNode.attrs.find(([name]) => name === 'tile')?.[1];
      if (id !== selectedTileId) setSelected(null);
    }
  }, [selectedTileId]);
  useEffect(() => {
    showSelection();
  }, [selected, nodes]);
  // A click elsewhere or Esc closes an open list.
  useEffect(() => {
    if (!popover) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !(event.target as Element | null)?.closest?.('.layout-addbar-menu, .layout-toolbar')) setPopover(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [popover]);

  const doc = () => frameRef.current?.contentDocument ?? null;
  const elementAt = (path: CanvasPath | null) => (path ? doc()?.querySelector<HTMLElement>(`[data-dql-path="${path.join('.')}"]`) ?? null : null);

  function showSelection() {
    const frameDoc = doc();
    if (!frameDoc) return;
    frameDoc.querySelectorAll('[data-dql-selected]').forEach((node) => node.removeAttribute('data-dql-selected'));
    const target = elementAt(latest.current.selected);
    if (!target) { setToolbarAt(null); return; }
    target.setAttribute('data-dql-selected', '');
    const rect = target.getBoundingClientRect();
    const frame = frameRef.current!;
    const top = frame.offsetTop + rect.top;
    // A number's toolbar sits below it, so its caption stays readable.
    const below = target.classList.contains('dql-value') || top <= 44;
    setToolbarAt({ top: below ? frame.offsetTop + rect.bottom + 8 : top - 44, left: Math.max(0, frame.offsetLeft + rect.left - 4) });
  }

  /** Check the whole layout and save it; a refusal is shown and nothing changes. */
  function save(next: CanvasNode[], select: CanvasPath | null): boolean {
    const markup = serializeCanvasNodes(next);
    const checked = checkCanvasHtml(markup, { catalog: latest.current.catalog, tileIds });
    const blocking = checked.issues.filter((issue) => issue.code !== 'UNKNOWN_BINDING');
    if (blocking.length) {
      setMessage(layoutRefusal(blocking[0]!));
      return false;
    }
    setMessage(null);
    pendingRef.current = { from: html, nodes: parseCanvasHtml(checked.html) };
    latest.current = { ...latest.current, nodes: pendingRef.current.nodes };
    setSelected(select);
    onSave(checked.html);
    return true;
  }

  function startTyping(element: HTMLElement, path: CanvasPath, selectWords = false) {
    element.contentEditable = 'true';
    // Numbers and their bound captions are data: they move with the words but cannot be typed into.
    element.querySelectorAll<HTMLElement>('.dql-value, .dql-value-label').forEach((chip) => { chip.contentEditable = 'false'; });
    typingRef.current = { element, path, dirty: false };
    setTyping(true);
    if (selectWords) {
      // Keys go to the frame only once it has focus; then to the piece.
      frameRef.current?.focus();
      frameRef.current?.contentWindow?.focus();
      element.focus();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      const selection = element.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  /** Save what was typed. Returns false when the check refused it; the words stay so the author can fix them. */
  function finishTyping(): boolean {
    const current = typingRef.current;
    if (!current) return true;
    const { element, path, dirty } = current;
    typingRef.current = null;
    element.removeAttribute('contenteditable');
    setTyping(false);
    if (!dirty) return true;
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.dql-value[data-bind], .dql-value-label[data-bind]').forEach((chip) => {
      const value = element.ownerDocument.createElement('dql-value');
      value.setAttribute('bind', chip.getAttribute('data-bind') ?? '');
      if (chip.classList.contains('dql-value-label')) value.setAttribute('show', 'label');
      chip.replaceWith(value);
    });
    for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
      for (const name of ['data-dql-path', 'data-dql-selected', 'data-dql-hover', 'contenteditable']) node.removeAttribute(name);
    }
    const fragment = checkCanvasHtml(clone.innerHTML);
    const blocking = fragment.issues.filter((issue) => issue.code !== 'UNKNOWN_BINDING');
    const node = canvasNodeAt(latest.current.nodes, path);
    if (blocking.length || node?.kind !== 'element') {
      if (blocking[0]) setMessage(layoutRefusal(blocking[0]));
      startTyping(element, path);
      typingRef.current!.dirty = true;
      return false;
    }
    const saved = save(replaceCanvasNode(latest.current.nodes, path, { ...node, children: parseCanvasHtml(fragment.html) }), path);
    if (!saved) {
      startTyping(element, path);
      typingRef.current!.dirty = true;
    }
    return saved;
  }

  function cancelTyping() {
    typingRef.current = null;
    setTyping(false);
    setMessage(null);
    setRevision((value) => value + 1);
  }

  /** The piece a click lands on: a number or tile first, else the nearest block, never the page frame itself. */
  function pieceFor(target: Element | null): HTMLElement | null {
    if (!target) return null;
    const chip = target.closest<HTMLElement>('.dql-value[data-dql-path]');
    if (chip) return chip;
    const tile = target.closest<HTMLElement>('.dql-tile[data-dql-path]');
    if (tile) return tile;
    let piece = target.closest<HTMLElement>('[data-dql-path]');
    while (piece && INLINE.has(piece.tagName.toLowerCase())) {
      const parent = piece.parentElement?.closest<HTMLElement>('[data-dql-path]');
      if (!parent) break;
      piece = parent;
    }
    if (piece && TABLE_PARTS.has(piece.tagName.toLowerCase())) piece = piece.closest<HTMLElement>('table[data-dql-path]');
    if (!piece || samePath(pathOf(piece), canvasContainerPath(latest.current.nodes))) return null;
    return piece;
  }

  function select(path: CanvasPath | null) {
    setSelected(path);
    setPopover(null);
    const node = path ? canvasNodeAt(latest.current.nodes, path) : undefined;
    const tileId = node?.kind === 'element' && node.tag === 'dql-tile' ? node.attrs.find(([name]) => name === 'tile')?.[1] ?? null : null;
    onSelectTile(tileId);
  }

  const handlersRef = useRef<{
    mousedown: (event: MouseEvent) => void;
    mouseover: (event: MouseEvent) => void;
    input: () => void;
    paste: (event: ClipboardEvent) => void;
    focusout: (event: FocusEvent) => void;
    keydown: (event: KeyboardEvent) => void;
  }>(null!);
  handlersRef.current = {
    mousedown: (event) => {
      if (latest.current.disabled) return;
      const target = event.target as Element;
      const current = typingRef.current;
      const chip = target.closest('.dql-value');
      if (current && current.element.contains(target) && !chip) return; // placing the caret
      if (current && !finishTyping()) { event.preventDefault(); return; }
      const piece = pieceFor(target);
      if (!piece) { select(null); return; }
      const path = pathOf(piece);
      const node = canvasNodeAt(latest.current.nodes, path);
      select(path);
      const kind = node ? canvasPieceKind(node) : 'group';
      // Words take the caret where the author clicked; other pieces are only selected.
      if ((kind === 'text' || kind === 'heading') && !typingRef.current) startTyping(piece, path);
      else event.preventDefault();
    },
    mouseover: (event) => {
      const frameDoc = doc();
      if (!frameDoc) return;
      frameDoc.querySelectorAll('[data-dql-hover]').forEach((node) => node.removeAttribute('data-dql-hover'));
      const piece = pieceFor(event.target as Element);
      if (piece && !piece.hasAttribute('data-dql-selected')) piece.setAttribute('data-dql-hover', '');
    },
    input: () => {
      if (typingRef.current) typingRef.current.dirty = true;
      remeasureRef.current();
      showSelection();
    },
    paste: (event) => {
      if (!typingRef.current) return;
      // Pasted formatting could carry markup the page refuses; paste words only.
      event.preventDefault();
      doc()?.execCommand('insertText', false, event.clipboardData?.getData('text/plain') ?? '');
    },
    focusout: (event) => {
      const current = typingRef.current;
      if (current && !current.element.contains(event.relatedTarget as Node | null)) finishTyping();
    },
    keydown: (event) => {
      const current = typingRef.current;
      if (current) {
        if (event.key === 'Escape') { event.preventDefault(); cancelTyping(); return; }
        const heading = /^H[1-4]$/.test(current.element.tagName);
        if (event.key === 'Enter' && ((heading && !event.shiftKey) || event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          current.element.blur();
        }
        return;
      }
      const path = latest.current.selected;
      if (!path || latest.current.disabled) return;
      if (event.key === 'Escape') { event.preventDefault(); select(null); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); return; }
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); move(event.key === 'ArrowUp' ? -1 : 1); return; }
      if (event.key === 'Enter') {
        const piece = elementAt(path);
        const node = canvasNodeAt(latest.current.nodes, path);
        if (piece && node && ['text', 'heading'].includes(canvasPieceKind(node))) { event.preventDefault(); startTyping(piece, path, true); }
      }
    },
  };

  function onFrameLoad(frame: HTMLIFrameElement, remeasure: () => void) {
    frameRef.current = frame;
    remeasureRef.current = remeasure;
    const frameDoc = frame.contentDocument;
    if (!frameDoc) return;
    const style = frameDoc.createElement('style');
    style.textContent = EDIT_STYLES;
    frameDoc.head.appendChild(style);
    remeasure();

    // Listeners call through a ref so they always see this render's state and props.
    frameDoc.addEventListener('mousedown', (event) => handlersRef.current.mousedown(event), true);
    frameDoc.addEventListener('mouseover', (event) => handlersRef.current.mouseover(event));
    frameDoc.addEventListener('mouseleave', () => frameDoc.querySelectorAll('[data-dql-hover]').forEach((node) => node.removeAttribute('data-dql-hover')));
    frameDoc.addEventListener('input', () => handlersRef.current.input());
    frameDoc.addEventListener('paste', (event) => handlersRef.current.paste(event));
    frameDoc.addEventListener('focusout', (event) => handlersRef.current.focusout(event));
    frameDoc.addEventListener('keydown', (event) => handlersRef.current.keydown(event));

    // The frame was redrawn: show the selection again, and start typing in a piece just added.
    showSelection();
    const pending = typeNextRef.current;
    typeNextRef.current = null;
    const piece = elementAt(pending);
    if (pending && piece) startTyping(piece, pending, true);
  }

  function move(direction: -1 | 1) {
    const path = latest.current.selected;
    if (!path || !finishTyping()) return;
    const moved = moveCanvasNode(latest.current.nodes, path, direction);
    if (moved) save(moved.nodes, moved.path);
  }

  function remove() {
    const path = latest.current.selected;
    if (!path) return;
    typingRef.current = null;
    setTyping(false);
    if (save(removeCanvasNode(latest.current.nodes, path), null)) onSelectTile(null);
  }

  function selectParent() {
    const path = latest.current.selected;
    if (!path || path.length <= container.length + 1) return;
    if (!finishTyping()) return;
    select(path.slice(0, -1));
  }

  function changeStyle(tag: string) {
    const path = latest.current.selected;
    if (!path || !finishTyping()) return;
    const node = canvasNodeAt(latest.current.nodes, path);
    if (node?.kind !== 'element' || node.tag === tag) return;
    save(replaceCanvasNode(latest.current.nodes, path, { ...node, tag }), path);
  }

  /** Add pieces after the selected one, or at the end of the page; words start in typing mode. */
  function add(pieces: CanvasNode[], typeInto = false) {
    if (!finishTyping()) return;
    const selectedPath = latest.current.selected;
    // A piece inside a number or a word goes after the block that holds it.
    let after = selectedPath;
    while (after && after.length > container.length + 1) after = after.slice(0, -1);
    const inserted = insertCanvasNodes(latest.current.nodes, pieces, after ?? undefined);
    if (typeInto) typeNextRef.current = inserted.path;
    setPopover(null);
    save(inserted.nodes, inserted.path);
  }

  function pickNumber(binding: StoryBinding) {
    const kind = popover?.kind;
    setPopover(null);
    if (kind === 'change-number') {
      const path = latest.current.selected;
      const node = path ? canvasNodeAt(latest.current.nodes, path) : undefined;
      if (!path || node?.kind !== 'element') return;
      // The words about the number change with it: bound captions in the same
      // piece follow, and a typed caption naming the old number is replaced.
      const oldKey = node.attrs.find(([name]) => name === 'bind')?.[1] ?? '';
      const old = latest.current.catalog[oldKey];
      const oldTile = old ? latest.current.tiles.find((tile) => tile.tileId === old.tileId)?.title : undefined;
      const captions = old ? [old.label, figureLabel(old.label), bindingCaption(old, latest.current.catalog), wordsOnly(old.label), wordsOnly(bindingCaption(old, latest.current.catalog)), ...(oldTile ? [oldTile] : [])] : [];
      save(rebindCanvasValue(latest.current.nodes, path, path.slice(0, container.length + 1), binding.key, captions), path);
      return;
    }
    if (kind === 'insert-number' && typingRef.current) {
      // Put the number where the caret is, as a chip that cannot be typed into.
      const { element } = typingRef.current;
      const frameDoc = element.ownerDocument;
      const chip = frameDoc.createElement('span');
      chip.className = 'dql-value';
      chip.setAttribute('data-bind', binding.key);
      chip.contentEditable = 'false';
      chip.textContent = binding.display;
      const selection = frameDoc.getSelection();
      const range = selection && selection.rangeCount && element.contains(selection.getRangeAt(0).startContainer) ? selection.getRangeAt(0) : null;
      if (range) {
        range.deleteContents();
        range.insertNode(chip);
      } else element.appendChild(chip);
      typingRef.current.dirty = true;
      finishTyping();
      return;
    }
    add([el('div', [
      // The caption is bound too, so it always names the number beside it.
      el('small', [el('dql-value', [], [['bind', binding.key], ['show', 'label']])]),
      el('strong', [el('dql-value', [], [['bind', binding.key]])], [['style', 'display:block;font-size:26px;line-height:1.2']]),
    ], [['style', 'display:inline-grid;gap:2px;margin:4px 0;padding:12px 16px;border:1px solid var(--dql-line);border-radius:12px;background:var(--dql-surface)']])]);
  }

  const usedTiles = new Set(Array.from(serializeCanvasNodes(nodes).matchAll(/<dql-tile tile="([^"]*)"/g), (match) => match[1]));
  const inFrame = selected ? selected.length > container.length + 1 : false;
  const siblingMoves = selected ? { up: Boolean(moveCanvasNode(nodes, selected, -1)), down: Boolean(moveCanvasNode(nodes, selected, 1)) } : { up: false, down: false };
  const hold = (event: React.MouseEvent) => event.preventDefault(); // keep the caret in the page

  const toolbar = selected && selectedNode && toolbarAt ? (
    <div className="layout-toolbar" style={{ top: toolbarAt.top, left: toolbarAt.left }} role="toolbar" aria-label={`${layoutPieceLabel(selectedNode, catalog, tiles)} tools`}>
      <span className="layout-piece-label">{layoutPieceLabel(selectedNode, catalog, tiles)}</span>
      {(selectedKind === 'text' || selectedKind === 'heading') && selectedNode.kind === 'element' && TEXT_STYLES.some(([tag]) => tag === selectedNode.tag) ? (
        <select aria-label="Text style" value={selectedNode.tag} disabled={disabled} onChange={(event) => changeStyle(event.target.value)}>
          {TEXT_STYLES.map(([tag, label]) => <option key={tag} value={tag}>{label}</option>)}
        </select>
      ) : null}
      {(selectedKind === 'text' || selectedKind === 'heading') ? <button type="button" onMouseDown={hold} disabled={disabled || !numbers.length} onClick={() => {
        const piece = elementAt(selected);
        if (piece && !typingRef.current) startTyping(piece, selected);
        setPopover({ kind: 'insert-number' });
      }}><Hash size={13} aria-hidden="true" /> Insert number</button> : null}
      {selectedKind === 'value' ? <button type="button" onMouseDown={hold} disabled={disabled} onClick={() => setPopover({ kind: 'change-number' })}><Hash size={13} aria-hidden="true" /> Change number</button> : null}
      {selectedKind === 'tile' ? <button type="button" onMouseDown={hold} disabled={disabled} onClick={() => {
        const id = selectedNode.kind === 'element' ? selectedNode.attrs.find(([name]) => name === 'tile')?.[1] ?? null : null;
        onSelectTile(id);
      }}><Settings2 size={13} aria-hidden="true" /> Tile settings</button> : null}
      <span className="layout-toolbar-sep" aria-hidden="true" />
      <button type="button" className="icon" onMouseDown={hold} disabled={disabled || !siblingMoves.up} aria-label="Move up" title="Move up (Alt+↑)" onClick={() => move(-1)}><ArrowUp size={14} /></button>
      <button type="button" className="icon" onMouseDown={hold} disabled={disabled || !siblingMoves.down} aria-label="Move down" title="Move down (Alt+↓)" onClick={() => move(1)}><ArrowDown size={14} /></button>
      {inFrame ? <button type="button" className="icon" onMouseDown={hold} disabled={disabled} aria-label="Select the section around it" title="Select the section around it" onClick={selectParent}><SquareDashed size={14} /></button> : null}
      <button type="button" className="icon danger" onMouseDown={hold} disabled={disabled} aria-label={selectedKind === 'tile' ? 'Remove from layout' : 'Delete'} title={selectedKind === 'tile' ? 'Remove from this layout. The tile stays on the page.' : 'Delete (Del)'} onClick={remove}><Trash2 size={14} /></button>
      {popover && (popover.kind === 'insert-number' || popover.kind === 'change-number') ? <NumberList numbers={numbers} catalog={catalog} tiles={tiles} hold={hold} searchable={popover.kind === 'change-number'} onPick={pickNumber} /> : null}
    </div>
  ) : null;

  return (
    <div className="layout-surface">
      <div className="layout-addbar" role="toolbar" aria-label="Add to the layout">
        <span>Add</span>
        <button type="button" onMouseDown={hold} disabled={disabled} onClick={() => add([el('h2', [text('New heading')])], true)}><Heading size={14} aria-hidden="true" /> Heading</button>
        <button type="button" onMouseDown={hold} disabled={disabled} onClick={() => add([el('p', [text('Write something here.')])], true)}><Pilcrow size={14} aria-hidden="true" /> Text</button>
        <span className="layout-addbar-menu">
          <button type="button" onMouseDown={hold} disabled={disabled || !numbers.length} aria-expanded={popover?.kind === 'add-number'} title={numbers.length ? undefined : 'Run the page to list its numbers'} onClick={() => setPopover(popover?.kind === 'add-number' ? null : { kind: 'add-number' })}><Hash size={14} aria-hidden="true" /> Number</button>
          {popover?.kind === 'add-number' ? <NumberList numbers={numbers} catalog={catalog} tiles={tiles} hold={hold} searchable onPick={pickNumber} /> : null}
        </span>
        <span className="layout-addbar-menu">
          <button type="button" onMouseDown={hold} disabled={disabled || !tiles.length} aria-expanded={popover?.kind === 'add-tile'} onClick={() => setPopover(popover?.kind === 'add-tile' ? null : { kind: 'add-tile' })}><BarChart3 size={14} aria-hidden="true" /> Tile</button>
          {popover?.kind === 'add-tile' ? (
            <div className="layout-popover" role="menu" aria-label="Tiles on this page">
              {tiles.map((tile) => (
                <button key={tile.tileId} type="button" role="menuitem" onMouseDown={hold} onClick={() => add([el('dql-tile', [], [['tile', tile.tileId]])])}>
                  <strong>{tile.title}</strong>{usedTiles.has(tile.tileId) ? <small>Already in the layout</small> : null}
                </button>
              ))}
              <p>To make a new tile, click fields in the Data panel.</p>
            </div>
          ) : null}
        </span>
        <small className="layout-hint">{typing ? 'Typing. Click outside or press Esc to cancel; headings finish with Enter.' : 'Click any part to edit it. Numbers and tiles come from your data.'}</small>
      </div>
      {message ? <p className="layout-refusal" role="alert">{message}</p> : null}
      {preview({ onFrameLoad, frozen: typing, revision, overlay: toolbar })}
    </div>
  );
}

/** Numbers from the page's data, grouped under their tile, with a search when the list is long. */
export function NumberList({ numbers, catalog, tiles, hold, searchable, onPick }: { numbers: StoryBinding[]; catalog?: StoryBindingCatalog; tiles: PageTile[]; hold: (event: React.MouseEvent) => void; searchable: boolean; onPick: (binding: StoryBinding) => void }): JSX.Element {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const titleOf = (tileId: string) => tiles.find((tile) => tile.tileId === tileId)?.title ?? tileId;
  // "Revenue by region — revenue for US" reads as "Revenue for US" under its tile, and a leader is named.
  const short = (binding: StoryBinding) => bindingCaption(binding, catalog);
  const shown = numbers.filter((binding) => !needle || binding.label.toLowerCase().includes(needle) || binding.display.toLowerCase().includes(needle));
  const groups = Array.from(new Set(shown.map((binding) => binding.tileId)));
  return (
    <div className="layout-popover" role="menu" aria-label="Numbers from this page's data">
      {searchable && numbers.length > 8 ? <input className="layout-popover-search" aria-label="Find a number" placeholder="Find a number" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} /> : null}
      {groups.map((tileId) => (
        <div key={tileId} className="layout-popover-group" role="group" aria-label={titleOf(tileId)}>
          <span>{titleOf(tileId)}</span>
          {shown.filter((binding) => binding.tileId === tileId).map((binding) => (
            <button key={binding.key} type="button" role="menuitem" onMouseDown={hold} onClick={() => onPick(binding)}>
              <strong>{short(binding)}</strong><small>{binding.display}</small>
            </button>
          ))}
        </div>
      ))}
      {!numbers.length ? <p>Run the page to list its numbers.</p> : !shown.length ? <p>No number matches.</p> : null}
    </div>
  );
}
