import { describe, expect, it } from 'vitest';
import { extractBlockContract } from '../block-contract.js';

const base = (tail: string, select = 'region, COUNT(DISTINCT claim_id) AS open_claims') =>
  extractBlockContract({ name: 'b', sql: `SELECT ${select} FROM claims WHERE status = 'open' ${tail}` });

describe('the block grain is what the SQL groups by', () => {
  it('accepts GROUP BY equal to the plain select items, by name, ordinal or ALL', () => {
    for (const tail of ['GROUP BY region', 'GROUP BY 1', 'GROUP BY ALL', 'GROUP BY region ORDER BY open_claims DESC LIMIT 5']) {
      expect(base(tail).grainUnparsed).toBeUndefined();
    }
  });

  it('flags a GROUP BY wider than the select list', () => {
    expect(base('GROUP BY region, channel').grainUnparsed).toEqual(['GROUP BY region, channel']);
  });

  it('flags a GROUP BY narrower than the plain select items', () => {
    expect(base('GROUP BY region', 'region, channel, COUNT(DISTINCT claim_id) AS open_claims').grainUnparsed).toEqual(['GROUP BY region']);
  });

  it('flags a GROUP BY on an aggregate ordinal', () => {
    expect(base('GROUP BY 2').grainUnparsed).toEqual(['GROUP BY 2']);
  });
});
