import { useEffect, useState, type ReactNode } from 'react';
import { checkCanvasHtml } from '@zlens/core/apps/canvas-page';
import type { StoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import type { DashboardCanvasV1 } from '../../../api/client';
import type { CanvasFrameEditing } from '../CanvasPageFrame';
import { CanvasLayoutSurface } from './CanvasLayoutSurface';

/**
 * Studio's governed HTML page editor (RFC 0008 step 9). Design shows the
 * page as readers see it; Code shows the markup, checked as the author
 * types. Markup that fails the check is never saved.
 */
export function CanvasEditor({
  canvas,
  catalog,
  pageTiles,
  disabled,
  preview,
  onChange,
  onDraft,
  drafting,
  draftBlockedReason,
  selectedTileId = null,
  onSelectTile = () => undefined,
}: {
  canvas: DashboardCanvasV1 | undefined;
  catalog: StoryBindingCatalog;
  pageTiles: Array<{ tileId: string; title: string }>;
  disabled: boolean;
  /** Renders a canvas the way readers see it; with `editing`, as the in-place editor. */
  preview: (canvas: DashboardCanvasV1, editing?: CanvasFrameEditing) => ReactNode;
  onChange: (canvas: DashboardCanvasV1) => void;
  onDraft: (instruction: string) => void;
  drafting: boolean;
  draftBlockedReason?: string | null;
  /** The tile whose settings are open, so a tile picked in the layout opens them. */
  selectedTileId?: string | null;
  onSelectTile?: (tileId: string | null) => void;
}): JSX.Element {
  const [tab, setTab] = useState<'design' | 'code'>('design');
  const [html, setHtml] = useState(canvas?.html ?? '');
  const [instruction, setInstruction] = useState('');
  useEffect(() => setHtml(canvas?.html ?? ''), [canvas?.html]);
  const tileIds = new Set(pageTiles.map((tile) => tile.tileId));
  const checked = checkCanvasHtml(html, { catalog, tileIds });
  // Unknown bindings show as a dash until the page returns them; everything else blocks saving.
  const blocking = checked.issues.filter((issue) => issue.code !== 'UNKNOWN_BINDING');
  const save = () => {
    if (!html.trim() || blocking.length || html === canvas?.html) return;
    onChange({ version: 1, html, generatedBy: 'author' });
  };
  const startFromTemplate = () => {
    // Only a tile's own single number makes a headline figure, captioned with the tile's title; a
    // grouped tile's "leader" or a driver's parts read oddly out of context and stay in their tiles.
    const figures = Object.values(catalog)
      .filter((binding) => binding.kind === 'number' && /^[^.[\]]+\.[^.[\]]+$/.test(binding.key) && !/\.(leader_value|current|prior|change|change_percent|top_member_change)$/.test(binding.key))
      .filter((binding, index, all) => all.findIndex((other) => other.tileId === binding.tileId) === index)
      .slice(0, 4)
      .map((binding) => ({ ...binding, label: pageTiles.find((tile) => tile.tileId === binding.tileId)?.title ?? binding.label }));
    const next = [
      '<style>.page{display:grid;gap:20px}.band{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.figure{padding:14px;border:1px solid var(--dql-line);border-radius:12px;background:var(--dql-surface)}.figure strong{display:block;font-size:24px}</style>',
      '<article class="page">',
      '<h1>Page title</h1>',
      figures.length ? `<section class="band">${figures.map((binding) => `<div class="figure"><small><dql-value bind="${binding.key}" show="label"></dql-value></small><strong><dql-value bind="${binding.key}"></dql-value></strong></div>`).join('')}</section>` : '',
      ...pageTiles.slice(0, 12).map((tile) => `<dql-tile tile="${tile.tileId}"></dql-tile>`),
      '</article>',
    ].join('\n');
    setHtml(next);
    if (checkCanvasHtml(next).issues.length === 0) onChange({ version: 1, html: next, generatedBy: 'author' });
  };
  const saved = canvas?.html ?? '';
  const savedIssues = saved ? checkCanvasHtml(saved, { catalog, tileIds }).issues.filter((issue) => issue.code !== 'UNKNOWN_BINDING') : [];
  return (
    <div className="studio-canvas-editor">
      <div className="layout-topbar">
        <form className="layout-ai" aria-label="Design the layout with AI" onSubmit={(event) => { event.preventDefault(); onDraft(instruction.trim()); }}>
          <input
            aria-label="What should the layout show?"
            placeholder={canvas ? 'Ask AI to redesign: what should change?' : 'Describe the layout you want (optional)'}
            value={instruction}
            disabled={disabled || drafting}
            onChange={(event) => setInstruction(event.target.value)}
          />
          <button type="submit" className="primary" disabled={disabled || drafting || Boolean(draftBlockedReason)} title={draftBlockedReason ?? 'AI arranges the layout and wording. Numbers stay bound to your data, and every design is checked before you see it. A local model can take a few minutes.'}>
            {drafting ? 'Designing…' : canvas ? 'Redesign layout with AI' : 'Design layout with AI'}
          </button>
        </form>
        <div className="studio-canvas-tabs" role="tablist" aria-label="Layout view">
          <button type="button" role="tab" aria-selected={tab === 'design'} className={tab === 'design' ? 'on' : ''} onClick={() => setTab('design')}>Layout</button>
          <button type="button" role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>HTML (advanced)</button>
        </div>
      </div>
      {draftBlockedReason ? <small className="field-help">{draftBlockedReason}</small> : null}
      {tab === 'design'
        ? (saved.trim() && savedIssues.length === 0
          ? <CanvasLayoutSurface
            html={saved}
            catalog={catalog}
            tiles={pageTiles}
            disabled={disabled}
            selectedTileId={selectedTileId}
            preview={(editing) => preview({ version: 1, html: saved, ...(canvas?.generatedBy ? { generatedBy: canvas.generatedBy } : {}), ...(canvas?.model ? { model: canvas.model } : {}) }, editing)}
            onSave={(next) => onChange({ version: 1, html: next, generatedBy: 'author' })}
            onSelectTile={onSelectTile}
          />
          : saved.trim()
            ? <div className="layout-empty"><strong>This layout's HTML has a problem</strong><span>{savedIssues[0]?.message}</span><button type="button" onClick={() => setTab('code')}>Open HTML (advanced)</button></div>
            : <div className="layout-empty">
              <strong>Start your custom layout</strong>
              <span>Arrange this page's numbers and tiles your way. You can edit every part afterwards by clicking it.</span>
              <div>
                <button type="button" className="primary" disabled={disabled || !pageTiles.length} onClick={startFromTemplate}>Start from this page's tiles</button>
                <button type="button" disabled={disabled || drafting || Boolean(draftBlockedReason)} onClick={() => onDraft(instruction.trim())}>{drafting ? 'Designing…' : 'Design with AI'}</button>
              </div>
            </div>)
        : <div className="studio-canvas-code">
          <textarea aria-label="Page markup" spellCheck={false} disabled={disabled} value={html} onChange={(event) => setHtml(event.target.value)} onBlur={save} />
          <p className="field-help">Show figures with <code>{'<dql-value bind="…"></dql-value>'}</code> and tiles with <code>{'<dql-tile tile="…"></dql-tile>'}</code>. Values on this page: {Object.keys(catalog).length}; tiles: {pageTiles.map((tile) => tile.tileId).join(', ') || 'none'}.</p>
          {checked.issues.length ? (
            <ul className="studio-story-issues" role="alert">
              {checked.issues.slice(0, 8).map((issue, index) => <li key={index} className={issue.code === 'UNKNOWN_BINDING' ? 'warn' : ''}>{issue.message}</li>)}
            </ul>
          ) : <p className="field-help">Checked: safe to publish.</p>}
        </div>}
    </div>
  );
}
