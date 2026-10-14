import { describe, expect, it } from 'vitest';
import { appTrustSummary, readerTileTrust, readerTrustSummary } from './reader-trust.js';

describe('shared reader trust (RFC 0008 steps 6 and 10)', () => {
  it('gives the server and the reader one answer for the same run tile', () => {
    expect(readerTileTrust({ query: {} }, { status: 'ok', dataset: { trust: 'certified', validation: { outcome: 'adapted' } } })?.state).toBe('certified');
    expect(readerTileTrust({ query: {} }, { status: 'ok', dataset: { trust: 'certified', validation: { outcome: 'needs_review' } } })?.state).toBe('review');
    expect(readerTileTrust({ semantic: {} }, { status: 'ok', tileType: 'semantic' })?.state).toBe('governed');
    expect(readerTileTrust({ block: {} }, { status: 'error' })?.state).toBe('blocked');
    expect(readerTileTrust({ text: { markdown: 'x' } }, { status: 'ok', tileType: 'text' })).toBeNull();
  });

  it('summarises a page', () => {
    const certified = readerTileTrust({ block: {} }, { status: 'ok', certificationStatus: 'certified' });
    const review = readerTileTrust({ block: {} }, { status: 'ok' });
    expect(readerTrustSummary([certified, certified, null])).toEqual({ certified: 2, total: 2, text: 'All 2 tiles certified' });
    expect(readerTrustSummary([certified, review]).text).toBe('1 of 2 tiles certified');
    expect(readerTrustSummary([null]).text).toBe('');
  });

  it('gives an App page one aggregate trust from its current run, never from saved claims', () => {
    const items = [{ i: 'a', block: { ref: 'blocks/_drafts/x.dql' } }, { i: 'note', text: { markdown: 'x' } }];
    expect(appTrustSummary(items, undefined)).toMatchObject({ state: 'pending', allCertified: false, total: 1 });
    const review = appTrustSummary(items, new Map([['a', { status: 'ok', trustState: 'review_required' }]]));
    expect(review).toMatchObject({ state: 'review', certified: 0, total: 1, allCertified: false, text: '0 of 1 tile certified' });
    const certified = appTrustSummary(items, [{ tileId: 'a', status: 'ok', certificationStatus: 'certified' }]);
    expect(certified).toMatchObject({ state: 'certified', allCertified: true, label: 'All data certified', text: 'All 1 tile certified' });
    expect(appTrustSummary(items, [{ tileId: 'a', status: 'ok', certificationStatus: 'certified' }], { pendingDrafts: 1 }).allCertified).toBe(false);
  });
});
