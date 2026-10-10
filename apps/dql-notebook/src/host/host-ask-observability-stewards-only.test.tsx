import { describe, expect, it } from 'vitest';
import { navItemAllowed, type HostUi } from './host-ui';

const DRAFT = { label: 'Open my draft space', href: '/e/draft' };
const REASON = 'Production follows main.';

function hosted(capabilities: Record<string, boolean>, refusals?: HostUi['refusals']): HostUi {
  return { host: true, person: { id: 'u1', name: 'Cleo', kind: 'person' }, capabilities, links: [], answerActions: [], ...(refusals ? { refusals } : {}) };
}

// Who sees Ask observability is the host's call: it sends a refusal (with or without a next link) only to the people
// it wants to see the screen read-only. A refusal that carries the `readOnly` mark (a steward whom Production refuses
// the write) is shown the same way as one with a next link.
describe('Ask observability in the sidebar', () => {
  it('is hidden when the host sends no refusal, or a refusal with no next link and no readOnly mark', () => {
    expect(navItemAllowed(hosted({ 'project.read': true }), 'ask_observability')).toBe(false);
    expect(navItemAllowed(hosted({ 'project.read': true }, { 'hint.review': { reason: 'Only a steward may review.' } }), 'ask_observability')).toBe(false);
  });

  it('shows for a steward whom Production refuses the write, and where the write is allowed', () => {
    expect(navItemAllowed(hosted({ 'project.read': true }, { 'hint.review': { reason: REASON, next: DRAFT, readOnly: true } }), 'ask_observability')).toBe(true);
    expect(navItemAllowed(hosted({ 'project.read': true, 'hint.review': true }), 'ask_observability')).toBe(true);
  });
});
