import { describe, expect, it } from 'vitest';
import { EDGE_TITLES, EDGE_TYPE_COLORS, lineageEdgeLabel } from './lineage-constants';

describe('lineage edge labels', () => {
  it('a retired block points at its replacement with a "replaced by" label; data-flow edges stay unlabelled', () => {
    expect(EDGE_TITLES.replaced_by).toBe('replaced by');
    expect(EDGE_TYPE_COLORS.replaced_by).toBeTruthy();
    expect(lineageEdgeLabel('replaced_by')).toBe('replaced by');
    expect(lineageEdgeLabel('reads_from')).toBeUndefined();
  });
});
