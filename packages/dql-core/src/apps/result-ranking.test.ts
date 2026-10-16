import { describe, expect, it } from 'vitest';
import { compareResultMembers, rankResultRows } from './result-ranking.js';

const members = <Row extends { m: unknown }>(ranked: Array<{ row: Row }>) => ranked.map((entry) => entry.row.m);

describe('result ranking', () => {
  const rows = [
    { m: 'b', v: 30 },
    { m: 'a', v: null },
    { m: 'd', v: -30 },
    { m: 'c', v: 30 },
    { m: 'e', v: 5 },
    { m: 'f', v: Number.NaN },
  ];

  it('ranks by magnitude, then sign, then member, with missing values last', () => {
    const ranked = rankResultRows(rows, { measure: (row) => row.v, member: (row) => row.m });
    expect(members(ranked)).toEqual(['b', 'c', 'd', 'e', 'a', 'f']);
    expect(ranked.map((entry) => entry.value)).toEqual([30, 30, -30, 5, null, null]);
  });

  it('ranks by value for a leader', () => {
    expect(members(rankResultRows(rows, { measure: (row) => row.v, member: (row) => row.m, by: 'value' })))
      .toEqual(['b', 'c', 'e', 'd', 'a', 'f']);
  });

  it('ranks the same rows the same way in any input order', () => {
    const expected = rankResultRows(rows, { measure: (row) => row.v, member: (row) => row.m });
    for (let shift = 1; shift < rows.length; shift += 1) {
      const rotated = [...rows.slice(shift), ...rows.slice(0, shift)];
      expect(rankResultRows(rotated, { measure: (row) => row.v, member: (row) => row.m })).toEqual(expected);
    }
    const noMember = [{ x: 1, v: 2 }, { x: 0, v: 2 }];
    expect(rankResultRows([...noMember].reverse(), { measure: (row) => row.v }))
      .toEqual(rankResultRows(noMember, { measure: (row) => row.v }));
  });

  it('orders members naturally and without the locale', () => {
    expect(compareResultMembers(2, 10)).toBeLessThan(0);
    expect(compareResultMembers(new Date('2026-02-01'), new Date('2026-10-01'))).toBeLessThan(0);
    expect(compareResultMembers('Z', 'a')).toBeLessThan(0);
    expect(compareResultMembers(null, 'a')).toBeGreaterThan(0);
    expect(compareResultMembers(undefined, null)).toBe(0);
  });
});
