import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoryBindingCatalog } from '@duckcodeailabs/dql-core';
import {
  editionFingerprint,
  homePersonKey,
  homeStatePath,
  movedOnPage,
  pageFiguresFrom,
  readHomeState,
  recordPageVisit,
  recordPublishedEdition,
  setLocalFollow,
} from './home-state.js';

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'dql-home-state-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const catalog = (claims: number, paid: number, review = 7): StoryBindingCatalog => ({
  'filed.claim_count': { key: 'filed.claim_count', tileId: 'filed', label: 'Claims filed — claim count', kind: 'number', value: claims, display: String(claims) },
  'paid.paid_amount': { key: 'paid.paid_amount', tileId: 'paid', label: 'Claims paid — paid amount', kind: 'number', value: paid, unit: { kind: 'currency', currency: 'USD' }, display: `$${paid}` },
  'byregion.claims[West]': { key: 'byregion.claims[West]', tileId: 'byregion', label: 'By region — claims for West', kind: 'number', value: 3, display: '3' },
  'draft.value': { key: 'draft.value', tileId: 'draft', label: 'Draft — value', kind: 'number', value: review, display: String(review) },
});
const trust = { filed: 'certified', paid: 'governed', byregion: 'certified', draft: 'review' };

describe('one person\'s Home state (HH-16)', () => {
  it('keeps only single governed figures, never a tile that needs review or grouped members', () => {
    const figures = pageFiguresFrom(catalog(10, 500), trust);
    expect(figures.map((figure) => [figure.key, figure.label])).toEqual([['filed.claim_count', 'Claims filed'], ['paid.paid_amount', 'Claims paid']]);
    expect(pageFiguresFrom(undefined, trust)).toEqual([]);
  });

  it('compares a person\'s last two runs under one scope, and starts over under another', () => {
    const dir = root();
    const key = homePersonKey({ id: 'u-priya', kind: 'person', source: 'host' });
    expect(key).toMatch(/^p-[0-9a-f]{32}$/);
    expect(homePersonKey(undefined)).toBe('local');
    recordPageVisit(dir, key, { appId: 'claims', pageId: 'weekly', runId: 'r1', scope: 's1', figures: pageFiguresFrom(catalog(10, 500), trust), now: new Date('2026-09-21T08:00:00Z') });
    // The same figures again: a visit, not an edition.
    recordPageVisit(dir, key, { appId: 'claims', pageId: 'weekly', runId: 'r2', scope: 's1', figures: pageFiguresFrom(catalog(10, 500), trust), now: new Date('2026-09-22T08:00:00Z') });
    expect(readHomeState(dir, key).pages['claims/weekly']!.editions.map((edition) => edition.runId)).toEqual(['r1']);
    recordPageVisit(dir, key, { appId: 'claims', pageId: 'weekly', runId: 'r3', scope: 's1', figures: pageFiguresFrom(catalog(12, 450), trust), now: new Date('2026-09-28T08:00:00Z') });
    const moved = movedOnPage(readHomeState(dir, key).pages['claims/weekly']!);
    expect(moved).toMatchObject({ appId: 'claims', pageId: 'weekly', since: '2026-09-21T08:00:00.000Z', unchanged: 0 });
    expect(moved.changes).toEqual([
      { label: 'Claims filed', from: '10', to: '12', change: '+2', direction: 'up' },
      { label: 'Claims paid', from: '$500', to: '$450', change: '−$50', direction: 'down' },
    ]);
    // Another filter or persona: its own comparison.
    recordPageVisit(dir, key, { appId: 'claims', pageId: 'weekly', runId: 'r4', scope: 's2', figures: pageFiguresFrom(catalog(1, 1), trust) });
    expect(movedOnPage(readHomeState(dir, key).pages['claims/weekly']!).changes).toEqual([]);
    // Nothing of the figures is kept for another person.
    expect(readHomeState(dir, homePersonKey({ id: 'u-dan', kind: 'person', source: 'host' })).pages).toEqual({});
    expect(readFileSync(homeStatePath(dir, key), 'utf-8')).not.toContain('Draft');
  });

  it('says when a scheduled edition is newer than the person\'s last look, and keeps follows', () => {
    const dir = root();
    recordPageVisit(dir, 'local', { appId: 'claims', pageId: 'weekly', runId: 'r1', scope: 's', figures: [], now: new Date('2026-09-21T08:00:00Z') });
    const fingerprint = editionFingerprint(catalog(10, 500), 'fallback');
    const first = recordPublishedEdition(dir, { appId: 'claims', pageId: 'weekly', runId: 's1', fingerprint, scheduleId: 'monday', now: new Date('2026-09-28T07:00:00Z') });
    expect(first).toMatchObject({ runId: 's1', scheduleId: 'monday' });
    expect(recordPublishedEdition(dir, { appId: 'claims', pageId: 'weekly', runId: 's2', fingerprint })).toBeNull();
    expect(editionFingerprint(undefined, 'fallback')).toBe('fallback');
    expect(movedOnPage(readHomeState(dir, 'local').pages['claims/weekly']!, first!.at).newEditionAt).toBe('2026-09-28T07:00:00.000Z');
    expect(setLocalFollow(dir, 'local', { appId: 'claims', pageId: 'weekly', title: 'Claims Weekly' }, true)).toEqual([expect.objectContaining({ appId: 'claims', pageId: 'weekly' })]);
    expect(setLocalFollow(dir, 'local', { appId: 'claims', pageId: 'weekly' }, false)).toEqual([]);
  });
});
