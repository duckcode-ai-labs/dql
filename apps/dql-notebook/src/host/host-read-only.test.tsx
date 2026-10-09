import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostRefusalNoticeView, ReadOnlyStrip } from '../components/shell/HostReadOnly';
import { HOST_REFUSAL_EVENT, reportHostRefusal } from '../api/server-auth';
import { HostUiProvider, hostReadOnly, navItemAllowed, navKeyForView, type HostUi, type HostUiState } from './host-ui';

const NO_HOST: HostUiState = { host: false };
const SCREENS = ['files', 'block_library', 'lineage', 'domains'];

function hosted(capabilities: Record<string, boolean>, refusals?: HostUi['refusals']): HostUi {
  return { host: true, person: { id: 'u1', name: 'Vic', kind: 'person' }, capabilities, links: [], answerActions: [], ...(refusals ? { refusals } : {}) };
}

describe('read-only Production screens', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('with project.read only, the four screens show and are read-only', () => {
    const viewer = hosted({ 'project.read': true });
    for (const key of SCREENS) {
      expect(navItemAllowed(viewer, key)).toBe(true);
      expect(hostReadOnly(viewer, key)).toBe(true);
    }
  });

  it('without project.read or any write, the screens stay hidden', () => {
    for (const key of SCREENS) expect(navItemAllowed(hosted({ ask: true }), key)).toBe(false);
  });

  it('with the write action the screen is unchanged: shown and editable', () => {
    const author = hosted({ 'project.read': true, 'project.write': true, 'dataset.author': true });
    for (const key of SCREENS) {
      expect(navItemAllowed(author, key)).toBe(true);
      expect(hostReadOnly(author, key)).toBe(false);
    }
  });

  it('without a host everything shows and is writable', () => {
    for (const key of SCREENS) {
      expect(navItemAllowed(NO_HOST, key)).toBe(true);
      expect(hostReadOnly(NO_HOST, key)).toBe(false);
    }
  });

  it('says read-only once, with the host\'s sentence, only on those screens', () => {
    const html = (state: HostUiState, view: string) => renderToStaticMarkup(<HostUiProvider initial={state}><ReadOnlyStrip mainView={view} /></HostUiProvider>);
    const viewer = hosted({ 'project.read': true }, { 'dataset.author': { reason: 'Production follows main.' } });
    expect(html(viewer, 'domains')).toContain('Production follows main.');
    expect(html(viewer, 'notebook')).toContain('Read-only.');
    expect(html(viewer, 'ask')).toBe('');
    expect(html(NO_HOST, 'domains')).toBe('');
    expect(navKeyForView('lineage_detail')).toBe('lineage');
  });

  it('shows a refused change with the host\'s sentence and its next link', () => {
    const html = renderToStaticMarkup(<HostRefusalNoticeView refusal={{ message: 'Production follows main.', next: { label: 'Open my draft space', href: '/e/draft' } }} />);
    expect(html).toContain('Production follows main.');
    expect(html).toContain('Open my draft space');
    expect(html).toContain('href="/e/draft"');
  });

  it('reports only refused changes (403 on a write), never reads', () => {
    const seen: unknown[] = [];
    vi.stubGlobal('window', { dispatchEvent: (event: CustomEvent) => { seen.push([event.type, event.detail]); return true; } });
    vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; constructor(type: string, init: { detail: unknown }) { this.type = type; this.detail = init.detail; } });
    expect(reportHostRefusal(403, 'GET', { message: 'no' })).toBe(false);
    expect(reportHostRefusal(500, 'PUT', { message: 'no' })).toBe(false);
    expect(reportHostRefusal(403, 'PUT', { message: 'No saves in Production.', next: { label: 'Open my draft space', href: '/e/draft' } })).toBe(true);
    expect(seen).toEqual([[HOST_REFUSAL_EVENT, { message: 'No saves in Production.', next: { label: 'Open my draft space', href: '/e/draft' } }]]);
  });
});
