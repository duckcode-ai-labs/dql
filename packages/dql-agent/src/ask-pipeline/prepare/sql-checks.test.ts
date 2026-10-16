import { describe, expect, it } from 'vitest';
import { aggregatesRows, appliedConditions, groupedColumns, joinKeyPairs, mentionsColumn, missingRequiredFilters, missingStatedValues, requiredFilterFromText, statedValues, withRowGuard, aggregatesColumnOf } from './sql-checks.js';

describe('the checks an AI-drafted statement passes before it runs', () => {
  const office = 'Lost opportunities count ,Lost Amount by month for fiscal year FY26 and competitor involved is Splunk';

  it('reads the values a question states: a fiscal year and a name, never its analytic words', () => {
    expect(statedValues(office)).toEqual([{ value: 'FY26', kind: 'fiscal_year' }, { value: 'Splunk', kind: 'text' }]);
    expect(statedValues('What share of orders were placed on a weekend in 2017?')).toEqual([{ value: '2017', kind: 'year' }]);
    expect(statedValues('Top customers by "beverage" revenue in Q2')).toEqual([{ value: 'Q2', kind: 'quarter' }, { value: 'beverage', kind: 'text' }]);
    // A flag value the reading chose is not a value the question stated: the
    // statement may apply it as a join or `= 1`. A text literal still counts.
    const reading = { filters: [{ ref: 'dimension:orders.has_refund', op: 'eq', values: ['true'] }, { ref: 'dimension:orders.status', op: 'eq', values: ['shipped'] }], measures: [], unresolved: [] } as unknown as Parameters<typeof statedValues>[1];
    expect(statedValues('What is the average order size of refunded orders?', reading)).toEqual([{ value: 'shipped', kind: 'text' }]);
    expect(statedValues('how many opportunities did we lose to splunk', { version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [{ ref: 'column:a.b.c', op: 'eq', values: ['Splunk'], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' } as never)).toEqual([{ value: 'Splunk', kind: 'text' }]);
  });

  it('a statement that leaves a stated value out is caught; a fiscal year stored as its digits or its calendar years passes', () => {
    const stated = statedValues(office);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE fiscal_year = 2026", stated)).toEqual([{ value: 'Splunk', kind: 'text' }]);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE fiscal_year = 2026 AND tags ILIKE '%splunk%'", stated)).toEqual([]);
    // A date range that spans a stated year applies it, like the year itself.
    expect(missingStatedValues("SELECT SUM(pts) FROM stats WHERE game_date >= '2016-01-01' AND game_date < '2018-01-01'", [{ value: '2016', kind: 'year' }, { value: '2017', kind: 'year' }])).toEqual([]);
    expect(missingStatedValues("SELECT SUM(pts) FROM stats WHERE game_date >= '2016-01-01' AND game_date <= '2016-12-31'", [{ value: '2017', kind: 'year' }])).toEqual([{ value: '2017', kind: 'year' }]);
    // The two digits the question used, on a fiscal-year field, apply it; the rows decide how it is stored.
    expect(missingStatedValues("SELECT COUNT(*) FROM opp oe WHERE oe.FISCAL_YEAR = 26 AND LOWER(tags) LIKE '%splunk%'", stated)).toEqual([]);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE amount = 26 AND LOWER(tags) LIKE '%splunk%'", stated)).toEqual([{ value: 'FY26', kind: 'fiscal_year' }]);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE close_date >= '2025-02-01' AND competitor_c = 'Splunk'", stated)).toEqual([]);
  });

  it('reads a required filter and catches a statement that does not apply it', () => {
    const required = [requiredFilterFromText('is_test = false')!, requiredFilterFromText("region in ('EMEA', 'APAC')")!];
    expect(required[1]).toEqual({ text: "region in ('EMEA', 'APAC')", column: 'region', values: ['EMEA', 'APAC'] });
    expect(missingRequiredFilters('SELECT 1 FROM t WHERE is_test = false AND region IN (\'EMEA\', \'APAC\')', required)).toEqual([]);
    expect(missingRequiredFilters('SELECT 1 FROM t WHERE region IN (\'EMEA\')', required).map((item) => item.text)).toEqual(['is_test = false', "region in ('EMEA', 'APAC')"]);
    expect(missingRequiredFilters('SELECT 1 FROM t WHERE NOT is_test AND region in (\'emea\',\'apac\')', required)).toEqual([]);
  });

  it('says what a statement filters on, in its own words', () => {
    expect(appliedConditions("SELECT COUNT(*) FROM opp WHERE is_won = false AND tags ILIKE '%splunk%' GROUP BY 1 ORDER BY 1")).toBe("is_won = false AND tags ILIKE '%splunk%'");
    expect(appliedConditions('SELECT 1 FROM t')).toBeUndefined();
  });

  it('resolves join keys through aliases and leaves CTEs out', () => {
    expect(joinKeyPairs('SELECT COUNT(*) FROM sales.opportunities o JOIN crm.deal_notes AS d ON d.deal_ref = o.deal_ref')).toEqual([
      { left: { relation: 'crm.deal_notes', column: 'deal_ref', qualifier: 'd' }, right: { relation: 'sales.opportunities', column: 'deal_ref', qualifier: 'o' } },
    ]);
    expect(joinKeyPairs('WITH lost AS (SELECT * FROM sales.opportunities) SELECT COUNT(*) FROM lost l JOIN crm.deal_notes d ON d.deal_ref = l.deal_ref')).toEqual([]);
  });

  it('guards the rows a statement returns and recognises aggregation', () => {
    expect(withRowGuard('SELECT a FROM t ORDER BY a;', 501)).toBe('SELECT a FROM t ORDER BY a\nLIMIT 501');
    expect(withRowGuard('SELECT a FROM t LIMIT 10', 501)).toBe('SELECT a FROM t LIMIT 10');
    expect(aggregatesRows('SELECT COUNT(*) FROM t')).toBe(true);
    expect(aggregatesRows('SELECT a FROM t')).toBe(false);
  });

  it('a column of the one side summed across a join that repeats its key is found; a distinct count and the many side are not', () => {
    const sql = 'SELECT SUM(oi.product_price) - SUM(o.order_cost) AS profit FROM dev.order_items oi JOIN dev.orders o ON oi.order_id = o.order_id';
    expect(joinKeyPairs(sql)[0]).toMatchObject({ left: { relation: 'dev.order_items', column: 'order_id', qualifier: 'oi' }, right: { relation: 'dev.orders', column: 'order_id', qualifier: 'o' } });
    expect(aggregatesColumnOf(sql, 'o')).toBe(true);
    expect(aggregatesColumnOf('SELECT COUNT(DISTINCT o.order_id) FROM dev.order_items oi JOIN dev.orders o ON oi.order_id = o.order_id', 'o')).toBe(false);
    expect(aggregatesColumnOf('SELECT SUM(oi.product_price) FROM dev.order_items oi JOIN dev.orders o ON oi.order_id = o.order_id', 'o')).toBe(false);
  });

  it('reads what a statement groups by: aliases resolved, positions read from the select list, expressions skipped', () => {
    const bare = 'SELECT location_id, SUM(order_total) / COUNT(DISTINCT order_id) AS aov\nFROM "jaffle_shop"."dev"."orders"\nGROUP BY location_id\nORDER BY location_id';
    expect(groupedColumns(bare)).toEqual([{ column: 'location_id', relation: '"jaffle_shop"."dev"."orders"' }]);
    const joined = 'SELECT l.location_name, o.location_id AS store, AVG(o.order_total) FROM dev.orders AS o JOIN dev.locations l ON o.location_id = l.location_id GROUP BY 1, 2';
    expect(groupedColumns(joined)).toEqual([
      { column: 'location_name', relation: 'dev.locations', qualifier: 'l' },
      { column: 'location_id', relation: 'dev.orders', qualifier: 'o' },
    ]);
    // A bare column over several tables names no relation; a CTE is not a relation; an expression is not a column.
    expect(groupedColumns('WITH t AS (SELECT o.customer_id, SUM(o.order_total) AS s FROM dev.orders o GROUP BY o.customer_id) SELECT c.customer_name, t.s FROM t JOIN dev.customers c ON c.customer_id = t.customer_id'))
      .toEqual([{ column: 'customer_id', relation: 'dev.orders', qualifier: 'o' }]);
    expect(groupedColumns("SELECT DATE_TRUNC('month', ordered_at), COUNT(*) FROM dev.orders GROUP BY DATE_TRUNC('month', ordered_at)")).toEqual([]);
    expect(groupedColumns('SELECT location_id, COUNT(*) FROM dev.orders o JOIN dev.locations l ON o.location_id = l.location_id GROUP BY location_id')).toEqual([{ column: 'location_id' }]);
    expect(mentionsColumn(joined, 'location_name')).toBe(true);
    expect(mentionsColumn(bare, 'location_name')).toBe(false);
    expect(mentionsColumn('SELECT "location_name" FROM t', 'location_name')).toBe(true);
  });
});
