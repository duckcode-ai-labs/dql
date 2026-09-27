import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CitedDocuments } from './CitedDocuments';
import { themes } from '../../themes/notebook-theme';

const t = themes.dark;

describe('cited documents under an answer (RFC 0010 HH-15)', () => {
  it('shows the note and each page, linked only when the link is http(s)', () => {
    const html = renderToStaticMarkup(
      <CitedDocuments
        t={t}
        run={{
          knowledge: {
            version: 1,
            note: 'The Claims handbook defines a paid claim as one with a cleared payment.',
            contextOnly: true,
            citations: [
              { sourceId: 'confluence', sourceLabel: 'Confluence', docId: 'p1', title: 'Claims handbook', url: 'https://harbor.atlassian.net/wiki/p1' },
              { sourceId: 'confluence', sourceLabel: 'Confluence', docId: 'p2', title: 'Region glossary', url: 'javascript:alert(1)' },
            ],
          },
        }}
      />,
    );
    expect(html).toContain('From team documents');
    expect(html).toContain('defines a paid claim');
    expect(html).toContain('href="https://harbor.atlassian.net/wiki/p1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Region glossary');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('never change how far to trust this answer');
  });

  it('renders nothing without citations', () => {
    expect(renderToStaticMarkup(<CitedDocuments t={t} run={{}} />)).toBe('');
  });
});
