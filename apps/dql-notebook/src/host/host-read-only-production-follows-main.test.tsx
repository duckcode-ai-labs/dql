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

// Each screen, the action that edits it, a main view that shows it, and what a refusal must carry to show it
// read-only. Source control opens read-only for anyone sent to a draft space (`next`); Ask observability is for
// stewards and admins, whom the host marks `readOnly` (every creator gets a `next` link too).
const SCREENS = [
  { key: 'git', action: 'git.review', view: 'git', shown: { next: DRAFT } },
  { key: 'ask_observability', action: 'hint.review', view: 'ask_observability', shown: { next: DRAFT, readOnly: true } },
];

describe.each(SCREENS)('$key when Production follows main', ({ key, action, view, shown }) => {
  it('is hidden from a viewer or explorer: refused with no next step, or no refusal at all', () => {
    const viewer = hosted({ 'project.read': true });
    expect(navItemAllowed(viewer, key)).toBe(false);
    const refused = hosted({ 'project.read': true }, { [action]: { reason: REASON } });
    expect(navItemAllowed(refused, key)).toBe(false);
  });

  it('shows read-only with the draft-space link when refused with the signal that screen needs', () => {
    const creator = hosted({ 'project.read': true }, { [action]: { reason: REASON, ...shown } });
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

describe('Ask observability is for stewards and admins', () => {
  it('stays hidden from a creator whose refusal carries a next link, in Production and in a draft space', () => {
    const production = hosted({ 'project.read': true }, { 'hint.review': { reason: REASON, next: DRAFT } });
    expect(navItemAllowed(production, 'ask_observability')).toBe(false);
    const draftSpace = hosted({ 'project.read': true }, { 'hint.review': { reason: 'Only a steward may review.' } });
    expect(navItemAllowed(draftSpace, 'ask_observability')).toBe(false);
  });

  it('shows for a steward: read-only where Production refuses the write, editable where it is allowed', () => {
    expect(navItemAllowed(hosted({ 'project.read': true }, { 'hint.review': { reason: REASON, next: DRAFT, readOnly: true } }), 'ask_observability')).toBe(true);
    expect(navItemAllowed(hosted({ 'project.read': true, 'hint.review': true }), 'ask_observability')).toBe(true);
  });

  it('keeps Source control for a creator with a next link', () => {
    expect(navItemAllowed(hosted({ 'project.read': true }, { 'git.review': { reason: REASON, next: DRAFT } }), 'git')).toBe(true);
  });
});

describe('navKeyForView', () => {
  it('maps the Ask observability views to one screen', () => {
    expect(navKeyForView('ask_observability')).toBe('ask_observability');
    expect(navKeyForView('ask_trace')).toBe('ask_observability');
  });
});
