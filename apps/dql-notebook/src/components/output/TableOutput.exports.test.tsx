import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostUiProvider, type HostUi } from '../../host/host-ui';
import { TableOutput } from './TableOutput';

/**
 * RFC 0010 HH-17: with a host, a download is a file made on the server under
 * the host's export rules; without one, the table on screen is saved as today.
 */
const result = { columns: ['region', 'n'], rows: [{ region: 'CA', n: 3 }], rowCount: 1 };
const host: HostUi = { host: true, person: { id: 'u-1', name: 'Maria', kind: 'person' }, capabilities: {}, links: [], answerActions: [] };
const buttons = (markup: string) => [...markup.matchAll(/<\/svg>(CSV|JSON|Excel)<\/button>/g)].map((match) => match[1]);

describe('table downloads (HH-17)', () => {
  it('saves CSV and JSON from the table without a host', () => {
    expect(buttons(renderToStaticMarkup(<TableOutput result={result} themeMode="light" />))).toEqual(['CSV', 'JSON']);
  });

  it('offers no download of a hosted table that has no export route, and the server\'s three formats when it has one', () => {
    expect(buttons(renderToStaticMarkup(<HostUiProvider initial={host}><TableOutput result={result} themeMode="light" /></HostUiProvider>))).toEqual([]);
    const withRoute = renderToStaticMarkup(<HostUiProvider initial={host}><TableOutput result={result} themeMode="light" onExport={async () => 'file.csv'} /></HostUiProvider>);
    expect(buttons(withRoute)).toEqual(['CSV', 'JSON', 'Excel']);
  });
});
