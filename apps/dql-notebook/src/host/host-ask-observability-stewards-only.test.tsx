import { describe, expect, it } from 'vitest';
import { navItemAllowed, type HostUi } from './host-ui';

const DRAFT = { label: 'Open my draft space', href: '/e/draft' };
const REASON = 'Production follows main.';

function hosted(capabilities: Record<string, boolean>, refusals?: HostUi['refusals']): HostUi {
  return { host: true, person: { id: 'u1', name: 'Cleo', kind: 'person' }, capabilities, links: [], answerActions: [], ...(refusals ? { refusals } : {}) };
}

// Source control opens read-only for anyone sent to a draft space (`next`); Ask observability is for stewards and
// admins, whom the host marks `readOnly` (every creator gets a `next` link too).
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
