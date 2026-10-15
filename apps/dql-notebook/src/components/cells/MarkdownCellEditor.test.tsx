import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { themes } from '../../themes/notebook-theme';
import { renderMarkdown } from './MarkdownCellEditor';

const html = (text: string) => renderToStaticMarkup(<>{renderMarkdown(text, themes.paper)}</>);

describe('renderMarkdown', () => {
  it('renders **bold** as bold, with no stray asterisks', () => {
    const markup = html('ZLens is written in DQL (**Domain Query Language**), its query language.');
    expect(markup).toContain('<strong>Domain Query Language</strong>');
    expect(markup).not.toContain('<em>');
    expect(markup).not.toContain('*');
  });

  it('keeps *italic* and ***bold italic*** distinct from bold', () => {
    const markup = html('**Core path:** source *data* and ***both***.');
    expect(markup).toContain('<strong>Core path:</strong>');
    expect(markup).toContain('<em>data</em>');
    expect(markup).toContain('font-style:italic">both</strong>');
    expect(markup).not.toContain('*');
  });

  it('renders the starter welcome notebook intro without stray asterisks', () => {
    const template = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../../packages/create-dql-app/templates/starter/notebooks/welcome.dqlnb', import.meta.url)), 'utf-8'));
    const intro = template.cells.find((cell: { id: string }) => cell.id === 'intro');
    const markup = html(intro.source);
    expect(markup).toContain('<strong>Domain Query Language</strong>');
    expect(markup).toContain('<strong>Core path:</strong>');
    expect(markup).not.toContain('*');
  });
});
