import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadOnlyStrip } from '../components/shell/HostReadOnly';
import { HostUiProvider, hostReadOnly, navItemAllowed, navKeyForView, readOnlyReason, type HostUi, type HostUiState } from './host-ui';

const NO_HOST: HostUiState = { host: false };
const REASON = 'Production follows main.';

function hosted(capabilities: Record<string, boolean>, refusals?: HostUi['refusals']): HostUi {
  return { host: true, person: { id: 'u1', name: 'Ana', kind: 'person' }, capabilities, links: [], answerActions: [], ...(refusals ? { refusals } : {}) };
}

const strip = (state: HostUiState, view: string) =>
  renderToStaticMarkup(<HostUiProvider initial={state}><ReadOnlyStrip mainView={view} /></HostUiProvider>);

// Settings in Production, which follows main: the host refuses settings.manage and connection.manage for everyone,
// and marks the refusal readOnly for the people who hold the action by role (admins).
describe('Settings when Production follows main', () => {
  const admin = hosted({ 'project.read': true }, {
    'settings.manage': { reason: REASON, readOnly: true },
    'connection.manage': { reason: REASON, readOnly: true },
  });

  it('shows read-only to an admin the host marks readOnly, with the reason in the strip', () => {
    expect(navItemAllowed(admin, 'settings')).toBe(true);
    expect(hostReadOnly(admin, 'settings')).toBe(true);
    expect(readOnlyReason(admin, 'settings')).toBe(REASON);
    expect(strip(admin, 'settings')).toContain(REASON);
    expect(strip(admin, 'connection')).toContain(REASON);
  });

  it('shows read-only when only one of the two actions is marked readOnly', () => {
    const state = hosted({ 'project.read': true }, { 'connection.manage': { reason: REASON, readOnly: true } });
    expect(navItemAllowed(state, 'settings')).toBe(true);
    expect(hostReadOnly(state, 'settings')).toBe(true);
  });

  it('stays hidden from people who are refused without the readOnly mark, or not refused at all', () => {
    expect(navItemAllowed(hosted({ 'project.read': true }), 'settings')).toBe(false);
    expect(navItemAllowed(hosted({ 'project.read': true }, { 'settings.manage': { reason: REASON } }), 'settings')).toBe(false);
    // A draft-space link alone never opens Settings.
    const drafter = hosted({ 'project.read': true }, { 'settings.manage': { reason: REASON, next: { label: 'Open my draft space', href: '/e/draft' } } });
    expect(navItemAllowed(drafter, 'settings')).toBe(false);
  });

  it('is editable, with no strip, for an admin the host allows', () => {
    const allowed = hosted({ 'project.read': true, 'settings.manage': true, 'connection.manage': true });
    expect(navItemAllowed(allowed, 'settings')).toBe(true);
    expect(hostReadOnly(allowed, 'settings')).toBe(false);
    expect(strip(allowed, 'settings')).toBe('');
    // One of the two allowed is enough to edit what that action covers.
    const connectionsOnly = hosted({ 'project.read': true, 'connection.manage': true }, { 'settings.manage': { reason: REASON, readOnly: true } });
    expect(hostReadOnly(connectionsOnly, 'settings')).toBe(false);
  });

  it('is unchanged without a host', () => {
    expect(navItemAllowed(NO_HOST, 'settings')).toBe(true);
    expect(hostReadOnly(NO_HOST, 'settings')).toBe(false);
    expect(strip(NO_HOST, 'settings')).toBe('');
  });

  it('maps both the settings and connection views to the Settings screen', () => {
    expect(navKeyForView('settings')).toBe('settings');
    expect(navKeyForView('connection')).toBe('settings');
  });
});
