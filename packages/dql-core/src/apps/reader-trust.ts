/**
 * One trust vocabulary for App readers (RFC 0008 step 6). Every data tile
 * shows exactly one of four states, worked out from the governed run
 * evidence the server returned, never from the tile's own claims alone:
 *
 * - certified: a certified source ran exactly as reviewed
 * - governed:  a governed semantic query (metrics and dimensions from the
 *              model), or a checked calculation over certified measures;
 *              not individually certified
 * - review:    not certified yet, adapted, out of date, or AI-generated
 * - blocked:   governance or the source stopped this tile from showing data
 *
 * Shared by the reader, signed snapshots and scheduled digests (step 10), so
 * a page says the same thing wherever it is read. Pure: no I/O.
 */
export type ReaderTrustState = 'certified' | 'governed' | 'review' | 'blocked';

export interface ReaderTrust {
  state: ReaderTrustState;
  label: string;
  /** One sentence a reader can act on. */
  detail: string;
}

/** The parts of a layout item trust depends on. */
export interface ReaderTrustItem {
  text?: unknown;
  block?: unknown;
  semantic?: unknown;
  query?: unknown;
  aiPin?: unknown;
  draftAnalysis?: unknown;
}

/** The parts of a run tile trust depends on. */
export interface ReaderTrustTile {
  status: string;
  tileType?: string;
  repair?: unknown;
  aiPin?: { certification?: string; reviewStatus?: string } | null;
  dataset?: { trust?: string; validation?: { outcome?: string } | null } | null;
  artifact?: { trustState?: string; sourceKind?: string } | null;
  certificationStatus?: string | null;
  trustState?: string;
}

export const READER_TRUST_LABELS: Record<ReaderTrustState, string> = {
  certified: 'Certified',
  governed: 'Governed',
  review: 'Needs review',
  blocked: 'Blocked',
};

const trust = (state: ReaderTrustState, detail: string): ReaderTrust => ({ state, label: READER_TRUST_LABELS[state], detail });

/** Text and heading tiles carry no data, so they carry no trust label. */
export function isDataTileForTrust(item: ReaderTrustItem, tile?: Pick<ReaderTrustTile, 'tileType'>): boolean {
  if (item.text || tile?.tileType === 'text') return false;
  return Boolean(tile || item.block || item.semantic || item.query || item.aiPin || item.draftAnalysis);
}

export function readerTileTrust(item: ReaderTrustItem, tile?: ReaderTrustTile): ReaderTrust | null {
  if (!isDataTileForTrust(item, tile)) return null;
  if (!tile) return null;
  if (tile.status === 'unauthorized') return trust('blocked', 'You do not have access to this data.');
  if (tile.status === 'unresolved') return trust('blocked', 'This tile’s source could not be found in the project.');
  if (tile.status === 'error') return trust('blocked', 'This tile could not run with the current source and filters.');
  if (tile.status === 'stale') return trust('review', 'This result is out of date; refresh the page.');
  if (tile.repair) return trust('review', 'This tile was repaired automatically and needs a person to check it.');

  if (tile.aiPin || item.aiPin) {
    const pin = tile.aiPin;
    return pin?.certification === 'certified' || pin?.reviewStatus === 'certified'
      ? trust('certified', 'An AI answer that a person reviewed and certified.')
      : trust('review', 'An AI answer that nobody has reviewed yet.');
  }

  const dataset = tile.dataset;
  if (dataset) {
    const outcome = dataset.validation?.outcome;
    if (outcome === 'rejected') return trust('blocked', 'The Dataset contract rejected this query.');
    const calculated = Boolean((item.query as { calculations?: unknown[] } | undefined)?.calculations?.length);
    if (dataset.trust === 'certified' && outcome !== 'needs_review' && calculated) {
      // Checked arithmetic over certified measures is governed, not certified:
      // nobody reviewed this formula. Promoting it into the Dataset certifies it.
      return trust('governed', 'Calculated on a certified Dataset: checked arithmetic over its certified measures.');
    }
    if (dataset.trust === 'certified' && outcome !== 'needs_review') {
      return outcome === 'adapted'
        ? trust('certified', 'Certified Dataset; the query was adapted within its contract.')
        : trust('certified', 'Runs on a certified Dataset, within its contract.');
    }
    return trust('review', outcome === 'needs_review'
      ? 'The query goes beyond what the Dataset certifies.'
      : 'The Dataset is not certified yet.');
  }

  if (tile.certificationStatus === 'certified' || tile.artifact?.trustState === 'certified' || tile.trustState === 'certified') {
    return trust('certified', 'Runs a certified block exactly as it was reviewed.');
  }
  if (tile.tileType === 'semantic' || item.semantic || tile.artifact?.sourceKind === 'semantic_query') {
    return trust('governed', 'Metrics and dimensions come from the governed semantic model.');
  }
  return trust('review', 'This source is not certified yet; check it before relying on it.');
}

/** Counts for the Trust Lens legend, in a fixed order. */
export function readerTrustCounts(trusts: Array<ReaderTrust | null>): Array<{ state: ReaderTrustState; label: string; count: number }> {
  const order: ReaderTrustState[] = ['certified', 'governed', 'review', 'blocked'];
  return order
    .map((state) => ({ state, label: READER_TRUST_LABELS[state], count: trusts.filter((entry) => entry?.state === state).length }))
    .filter((entry) => entry.count > 0);
}

/** "All 6 tiles certified" or "4 of 6 tiles certified"; empty when no data tile ran. */
export function readerTrustSummary(trusts: Array<ReaderTrust | null>): { certified: number; total: number; text: string } {
  const total = trusts.filter(Boolean).length;
  const certified = trusts.filter((entry) => entry?.state === 'certified').length;
  const text = total === 0 ? '' : certified === total ? `All ${total} ${total === 1 ? 'tile' : 'tiles'} certified` : `${certified} of ${total} tiles certified`;
  return { certified, total, text };
}

/**
 * The one aggregate trust an App page shows (header badge, Trust Lens line,
 * story and canvas summaries), derived from its current tiles' run evidence.
 *
 * - `certified` only when every data tile ran from a certified source and the
 *   App has no pending drafts; nothing else may say "certified" or "verified".
 * - `pending` while no run evidence exists yet: a saved document's own claims
 *   (or a bare block reference) are never read as certified, because the
 *   source behind them may have been edited or demoted since.
 *
 * This is data trust. An App's lifecycle (draft / review / published) is a
 * separate axis and is labelled separately.
 */
export type AppTrustState = 'certified' | 'partial' | 'review' | 'pending' | 'empty';

export interface AppTrustSummary {
  state: AppTrustState;
  certified: number;
  total: number;
  allCertified: boolean;
  /** Short badge text: "All data certified", "0 of 1 tiles certified", "Trust not checked yet". */
  label: string;
  /** Sentence form for summaries; empty when no data tile ran. */
  text: string;
}

export function appTrustSummary<Item extends ReaderTrustItem & { i: string }>(
  items: ReadonlyArray<Item> | undefined,
  runTiles: ReadonlyMap<string, ReaderTrustTile> | ReadonlyArray<ReaderTrustTile & { i?: string; id?: string; tileId?: string }> | undefined,
  options: { pendingDrafts?: number } = {},
): AppTrustSummary {
  const tileFor = (id: string): ReaderTrustTile | undefined => {
    if (!runTiles) return undefined;
    if (runTiles instanceof Map) return runTiles.get(id);
    return (runTiles as ReadonlyArray<ReaderTrustTile & { i?: string; id?: string; tileId?: string }>)
      .find((tile) => (tile.i ?? tile.tileId ?? tile.id) === id);
  };
  const dataItems = (items ?? []).filter((item) => isDataTileForTrust(item, tileFor(item.i)));
  const total = dataItems.length;
  if (total === 0) {
    return { state: 'empty', certified: 0, total: 0, allCertified: false, label: 'No data tiles', text: '' };
  }
  if (!runTiles) {
    return { state: 'pending', certified: 0, total, allCertified: false, label: 'Trust not checked yet', text: '' };
  }
  // A tile with no run evidence counts as not certified, never as certified.
  const trusts = dataItems.map((item) => readerTileTrust(item, tileFor(item.i)));
  const certified = trusts.filter((entry) => entry?.state === 'certified').length;
  const drafts = options.pendingDrafts ?? 0;
  const allCertified = certified === total && drafts === 0;
  const text = certified === total
    ? `All ${total} ${total === 1 ? 'tile' : 'tiles'} certified`
    : `${certified} of ${total} ${total === 1 ? 'tile' : 'tiles'} certified`;
  return {
    state: allCertified ? 'certified' : certified > 0 ? 'partial' : 'review',
    certified,
    total,
    allCertified,
    label: allCertified ? 'All data certified' : text,
    text,
  };
}
