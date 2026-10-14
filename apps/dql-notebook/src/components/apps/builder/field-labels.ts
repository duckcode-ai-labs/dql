import type { TileQuery } from '@zlens/core/apps/tile-query';
import { QUICK_CALC_LABELS } from '@zlens/core/apps/tile-calcs';
import { fieldKey, refName, type DashboardVizEncoding, type ShelfFieldRef } from '@zlens/core/apps/viz-encoding';
import { humanize } from './studio-ui';

/**
 * The name a field shows on shelves, Show Me and charts: the author's own
 * name, a calculation's name, "Running total of Revenue" for a quick
 * calculation, else the field's name in words.
 */
export function shelfFieldLabel(encoding: DashboardVizEncoding, query: TileQuery, ref: ShelfFieldRef): string {
  const own = encoding.fields?.[fieldKey(ref)]?.label;
  if (own) return own;
  const calculation = 'measure' in ref ? query.calculations?.find((entry) => entry.id.toLowerCase() === ref.measure.toLowerCase()) : undefined;
  if (calculation?.label) return calculation.label;
  if (calculation?.quick) {
    const of = calculation.quick.of;
    const measure = query.measures.find((entry) => (entry.alias ?? entry.measure).toLowerCase() === of.toLowerCase())?.measure ?? of;
    return `${QUICK_CALC_LABELS[calculation.quick.kind]} of ${shelfFieldLabel(encoding, query, { measure })}`;
  }
  return humanize(refName(ref));
}
