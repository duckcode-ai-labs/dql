import type { DashboardRunResponse } from '../../api/client';

type DashboardRunTile = DashboardRunResponse['tiles'][number];

/**
 * The author-facing notice for a tile bound to a retired block. Readers keep
 * the tile's normal trust state; only App Studio shows this, so the author
 * can rebind the tile before the next publish (a retired block is never
 * certified, so the publish gate refuses it).
 */
export function retiredTileNotice(tile: DashboardRunTile | undefined): { label: string; detail: string } | undefined {
  if (!tile?.retirement) return undefined;
  const { replacedBy, deprecatedOn } = tile.retirement;
  const label = replacedBy ? `Retired — replaced by ${replacedBy}` : 'Retired';
  const block = tile.blockId ? `${tile.blockId} was retired` : 'This block was retired';
  const detail = `${block}${deprecatedOn ? ` on ${deprecatedOn}` : ''}. ${replacedBy ? `Rebind this tile to ${replacedBy} before you publish again.` : 'Rebind this tile to a certified block before you publish again.'}`;
  return { label, detail };
}
