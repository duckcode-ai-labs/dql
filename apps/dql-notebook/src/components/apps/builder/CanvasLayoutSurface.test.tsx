import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseCanvasHtml } from '@zlens/core/apps/canvas-page';
import type { StoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import { CanvasLayoutSurface, NumberList, layoutPieceLabel, layoutRefusal } from './CanvasLayoutSurface';
import { CanvasEditor } from './CanvasEditor';

const catalog: StoryBindingCatalog = {
  'kpi.revenue': { key: 'kpi.revenue', tileId: 'kpi', label: 'Revenue — revenue', kind: 'number', value: 110, display: '$110' },
  'by_region.revenue[US]': { key: 'by_region.revenue[US]', tileId: 'by_region', label: 'Revenue by region — revenue for US', kind: 'number', value: 85, display: '$85' },
};
const tiles = [{ tileId: 'kpi', title: 'Revenue' }, { tileId: 'by_region', title: 'Revenue by region' }];

describe('editing a Custom layout in place', () => {
  it('labels the selected piece the way an author thinks of it', () => {
    const [tile, value, heading] = parseCanvasHtml('<dql-tile tile="kpi"></dql-tile><dql-value bind="kpi.revenue"></dql-value><h2>Summary</h2>');
    expect(layoutPieceLabel(tile, catalog, tiles)).toBe('Tile · Revenue');
    expect(layoutPieceLabel(value, catalog, tiles)).toBe('Number · Revenue — revenue');
    expect(layoutPieceLabel(heading, catalog, tiles)).toBe('Heading');
  });

  it('explains a refused edit in plain words', () => {
    expect(layoutRefusal({ code: 'NAKED_NUMBER', message: 'x' })).toContain('typed numbers are not saved');
    expect(layoutRefusal({ code: 'UNSAFE_TAG', message: '<img> is not allowed.' })).toContain('not allowed on a governed page');
  });

  it('lists numbers under their tile, without repeating the tile name', () => {
    const markup = renderToStaticMarkup(<NumberList numbers={Object.values(catalog)} tiles={tiles} hold={() => undefined} searchable onPick={() => undefined} />);
    expect(markup).toContain('aria-label="Revenue by region"');
    expect(markup).toContain('<strong>Revenue for US</strong><small>$85</small>');
    expect(markup).not.toContain('Revenue by region — revenue for US</strong>');
  });

  it('shows the Add row and the editing hint around the layout', () => {
    const markup = renderToStaticMarkup(<CanvasLayoutSurface html="<h1>Title</h1>" catalog={catalog} tiles={tiles} disabled={false} selectedTileId={null} preview={() => <div id="frame" />} onSave={() => undefined} onSelectTile={() => undefined} />);
    expect(markup).toContain('aria-label="Add to the layout"');
    for (const label of ['Heading', 'Text', 'Number', 'Tile']) expect(markup).toContain(`</svg> ${label}</button>`);
    expect(markup).toContain('Click any part to edit it.');
    expect(markup).toContain('<div id="frame"></div>');
  });

  it('starts an empty layout from the page tiles or AI, and keeps HTML as the advanced view', () => {
    const empty = renderToStaticMarkup(<CanvasEditor canvas={undefined} catalog={catalog} pageTiles={tiles} disabled={false} preview={() => null} onChange={() => undefined} onDraft={() => undefined} drafting={false} />);
    expect(empty).toContain('Start your custom layout');
    expect(empty).toContain('Start from this page&#x27;s tiles');
    expect(empty).toContain('>Layout</button>');
    expect(empty).toContain('>HTML (advanced)</button>');
    expect(empty).toContain('Design layout with AI');
  });
});
