import { checkCanvasHtml, escapeHtml, fillCanvasHtml } from '@zlens/core/apps/canvas-page';
import { splitStoryText, type StoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import type { DashboardCanvasV1, DashboardDocumentResponse, DashboardNarrativeV1, DashboardRunResponse } from '../../api/client';
import { drawCanvasTile } from './CanvasPageFrame';
import { readerTileTrust } from './reader-trust';

type LayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type RunTile = DashboardRunResponse['tiles'][number];

/** The width a snapshot page is drawn at; charts scale down with the page. */
export const SNAPSHOT_PAGE_WIDTH = 1100;

export interface SnapshotBodyInput {
  items: LayoutItem[];
  tiles: RunTile[];
  catalog: StoryBindingCatalog;
  cols: number;
  rowHeight: number;
  narrative?: DashboardNarrativeV1 | null;
  canvas?: DashboardCanvasV1 | null;
}

/**
 * The page as static markup for a signed snapshot (RFC 0008 step 10). Tiles
 * are drawn by the same code as governed HTML pages (ECharts SVG, KPI,
 * table, driver summary) in the light theme, so a snapshot prints and reads
 * the same everywhere. The server wraps and signs it; nothing here is
 * trusted for the figures, which the server records from its own run.
 */
export function buildSnapshotBody(input: SnapshotBodyInput): { body: string; tileIds: string[] } {
  const tileById = new Map(input.tiles.map((tile) => [tile.tileId, tile]));
  const shown = new Set<string>();
  const drawTile = (item: LayoutItem, width: number, height: number) => {
    shown.add(item.i);
    return drawCanvasTile(item, tileById.get(item.i), input.catalog, 'light', width, height);
  };
  const tileCard = (item: LayoutItem, style: string, width: number) => {
    if (item.text) {
      return `<div class="snap-tile snap-text" style="${style}">${paragraphs(item.text.markdown ?? '')}</div>`;
    }
    const trust = readerTileTrust(item, tileById.get(item.i));
    const height = Math.max(200, Math.min(520, item.h * input.rowHeight - 60));
    return [
      `<article class="snap-tile" style="${style}">`,
      `<header class="snap-tile-head"><h2>${escapeHtml(item.title ?? item.i)}</h2>${trust ? `<span class="snap-tile-trust ${trust.state}">${escapeHtml(trust.label)}</span>` : ''}</header>`,
      drawTile(item, width, height),
      '</article>',
    ].join('');
  };

  if (input.canvas) {
    const checked = checkCanvasHtml(input.canvas.html);
    if (checked.issues.length === 0) {
      const byId = new Map(input.items.map((item) => [item.i, item]));
      const body = fillCanvasHtml(checked.html, input.catalog, (tileId, height) => {
        const item = byId.get(tileId);
        if (!item) return '<p class="muted">This tile is not on the page.</p>';
        return drawTile(item, 640, height ?? 280);
      });
      // Figures count toward trust through the tile they come from.
      for (const key of checked.bindings) if (input.catalog[key]) shown.add(input.catalog[key]!.tileId);
      return { body: `<div class="snap-canvas">${body}</div>`, tileIds: [...shown] };
    }
  }

  if (input.narrative?.presentation === 'story') {
    const byId = new Map(input.items.map((item) => [item.i, item]));
    const blocks = input.narrative.blocks.map((block) => {
      if (block.kind === 'text') {
        for (const part of splitStoryText(block.markdown)) {
          if (part.kind === 'binding' && input.catalog[part.key]) shown.add(input.catalog[part.key]!.tileId);
        }
        return `<section>${storyMarkdown(block.markdown, input.catalog)}</section>`;
      }
      const item = byId.get(block.tileId);
      return item ? tileCard(item, '', 760) : '';
    });
    return { body: `<article class="snap-story">${blocks.join('')}</article>`, tileIds: [...shown] };
  }

  const ordered = [...input.items].sort((left, right) => left.y - right.y || left.x - right.x);
  const cards = ordered.map((item) => {
    const span = Math.max(1, Math.min(12, Math.round((item.w / input.cols) * 12)));
    const start = Math.max(1, Math.min(12 - span + 1, Math.round((item.x / input.cols) * 12) + 1));
    return tileCard(item, `grid-column:${start} / span ${span}`, Math.round((span / 12) * SNAPSHOT_PAGE_WIDTH) - 28);
  });
  return { body: `<section class="snap-grid">${cards.join('')}</section>`, tileIds: [...shown] };
}

function paragraphs(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => {
      const heading = /^#{1,3}\s+/.exec(paragraph);
      const text = inline(escapeHtml(heading ? paragraph.slice(heading[0].length) : paragraph));
      return heading ? `<h3>${text}</h3>` : `<p>${text}</p>`;
    })
    .join('');
}

function storyMarkdown(markdown: string, catalog: StoryBindingCatalog): string {
  return markdown
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => {
      const heading = /^#{1,3}\s+/.exec(paragraph);
      const body = heading ? paragraph.slice(heading[0].length) : paragraph;
      const text = splitStoryText(body).map((part) => {
        if (part.kind === 'text') return inline(escapeHtml(part.text));
        const binding = catalog[part.key];
        return binding
          ? `<span class="dql-story-value">${escapeHtml(binding.display)}</span>`
          : '<span class="dql-story-value">—</span>';
      }).join('');
      return heading ? `<h3>${text}</h3>` : `<p>${text}</p>`;
    })
    .join('');
}

/** Bold and italic only, on already-escaped text. */
function inline(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/** Save text or a blob as a file through the browser's download. */
export function downloadFile(fileName: string, content: Blob | string, type = 'text/html;charset=utf-8'): void {
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Load a snapshot document in an off-screen frame. The document has no
 * scripts and its CSP allows no network, so the host only reads its layout.
 */
function loadSnapshotFrame(html: string, width: number): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:800px;border:0;opacity:0;pointer-events:none`;
    const timer = window.setTimeout(() => { frame.remove(); reject(new Error('The snapshot did not load.')); }, 15_000);
    frame.onload = () => { window.clearTimeout(timer); resolve(frame); };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

/** Open the browser's print dialog for a snapshot; "Save as PDF" makes the PDF. */
export async function printSnapshot(html: string): Promise<void> {
  const frame = await loadSnapshotFrame(html, SNAPSHOT_PAGE_WIDTH);
  const win = frame.contentWindow;
  if (!win) { frame.remove(); throw new Error('The print view could not open.'); }
  const cleanup = () => window.setTimeout(() => frame.remove(), 1000);
  win.addEventListener('afterprint', cleanup, { once: true });
  win.focus();
  win.print();
  // Some browsers never fire afterprint for a frame.
  window.setTimeout(() => frame.remove(), 120_000);
}

/**
 * A PNG of a snapshot: the document is serialised as XHTML inside an SVG
 * foreignObject and drawn to a canvas. It holds no external resources, so
 * the canvas stays readable.
 */
export async function snapshotToPng(html: string, scale = 2): Promise<Blob> {
  const frame = await loadSnapshotFrame(html, SNAPSHOT_PAGE_WIDTH);
  try {
    const doc = frame.contentDocument;
    if (!doc?.documentElement) throw new Error('The snapshot did not load.');
    const width = SNAPSHOT_PAGE_WIDTH;
    const height = Math.min(16_000, Math.max(200, Math.ceil(doc.documentElement.scrollHeight)));
    const root = doc.documentElement.cloneNode(true) as HTMLElement;
    root.querySelectorAll('meta[http-equiv]').forEach((node) => node.remove());
    const xhtml = new XMLSerializer().serializeToString(root);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    const image = new Image();
    image.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The page could not be drawn as an image.'));
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw images.');
    context.scale(scale, scale);
    context.fillStyle = '#fbfaf7';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The image could not be saved.'))), 'image/png'));
  } finally {
    frame.remove();
  }
}
