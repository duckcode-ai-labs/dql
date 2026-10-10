import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadOnlyStrip } from '../components/shell/HostReadOnly';
import { HostUiProvider, hostReadOnly, navItemAllowed, navKeyForView, type HostUi, type HostUiState } from './host-ui';

const NO_HOST: HostUiState = { host: false };
const DRAFT = { label: 'Open my draft space', href: '/e/draft' };
const REASON = 'Production follows main.';

function hosted(capabilities: Record<string, boolean>, refusals?: HostUi['refusals']): HostUi {
  return { host: true, person: { id: 'u1', name: 'Cleo', kind: 'person' }, capabilities, links: [], answerActions: [], ...(refusals ? { refusals } : {}) };
}

const strip = (state: HostUiState, view: string) =>
  renderToStaticMarkup(<HostUiProvider initial={state}><ReadOnlyStrip mainView={view} /></HostUiProvider>);

// Each screen, the action that edits it, and a main view that shows it.
const SCREENS = [
  { key: 'git', action: 'git.review', view: 'git' },
  { key: 'ask_observability', action: 'hint.review', view: 'ask_observability' },
];

describe.each(SCREENS)('$key when Production follows main', ({ key, action, view }) => {
  it('is hidden from a viewer or explorer: refused with no next step, or no refusal at all', () => {
    const viewer = hosted({ 'project.read': true });
    expect(navItemAllowed(viewer, key)).toBe(false);
    const refused = hosted({ 'project.read': true }, { [action]: { reason: REASON } });
    expect(navItemAllowed(refused, key)).toBe(false);
  });

  it('shows read-only with the draft-space link when refused with a next step', () => {
    const creator = hosted({ 'project.read': true }, { [action]: { reason: REASON, next: DRAFT } });
    expect(navItemAllowed(creator, key)).toBe(true);
    expect(hostReadOnly(creator, key)).toBe(true);
    const html = strip(creator, view);
    expect(html).toContain(REASON);
    expect(html).toContain('Open my draft space');
    expect(html).toContain('href="/e/draft"');
  });

  it('shows editable, with no strip, when the action is allowed', () => {
    const drafter = hosted({ 'project.read': true, [action]: true }, { [action]: { reason: REASON, next: DRAFT } });
    expect(navItemAllowed(drafter, key)).toBe(true);
    expect(hostReadOnly(drafter, key)).toBe(false);
    expect(strip(drafter, view)).toBe('');
  });

  it('is unchanged without a host', () => {
    expect(navItemAllowed(NO_HOST, key)).toBe(true);
    expect(hostReadOnly(NO_HOST, key)).toBe(false);
  });
});

describe('navKeyForView', () => {
  it('maps the Ask observability views to one screen', () => {
    expect(navKeyForView('ask_observability')).toBe('ask_observability');
    expect(navKeyForView('ask_trace')).toBe('ask_observability');
  });
});
