import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiPinsPanel } from './AppSidePanels';
import { HostUiProvider, type HostUiState } from '../../host/host-ui';
import type { AppDocumentSummary } from '../../api/client';

/** With a host, an AI pin is its pinner's own, not shared App content; the panel says so. */
describe('AI pins in an App', () => {
  const appDoc = { aiPins: [{ id: 'p1', title: 'Open claims', certification: 'review_required', reviewStatus: 'needs_review' }] } as unknown as AppDocumentSummary;
  const hosted = { host: true, capabilities: {}, links: [] } as unknown as HostUiState;

  it('says only the pinner sees them, with a host', () => {
    const html = renderToStaticMarkup(<HostUiProvider initial={hosted}><AiPinsPanel appDoc={appDoc} /></HostUiProvider>);
    expect(html).toContain('Only you see these pins. Keep one as a live tile to share it.');
    const empty = renderToStaticMarkup(<HostUiProvider initial={hosted}><AiPinsPanel appDoc={{ aiPins: [] } as unknown as AppDocumentSummary} /></HostUiProvider>);
    expect(empty).toContain('only you see them');
  });

  it('is as before without a host', () => {
    const html = renderToStaticMarkup(<HostUiProvider initial={{ host: false }}><AiPinsPanel appDoc={appDoc} /></HostUiProvider>);
    expect(html).not.toContain('Only you see');
    expect(html).toContain('Open claims');
  });
});
