/**
 * The office golden lane: the same harness over `test/fixtures/office-golden`,
 * a Snowflake-shaped dbt inventory with no semantic layer and no certified
 * blocks, where the competitor lives in a different table (SFDC.OPPORTUNITY)
 * from the amounts (SALES.OPPORTUNITY_ENHANCED), reps tag competitors in
 * SALESLOFT.OPPORTUNITIES.TAGS, and the fiscal year starts on February 1.
 * It carries the office question verbatim. Selecting the fixture is an
 * environment variable read at module load, so this file sets it and imports
 * the harness.
 */
process.env.ZLENS_ASK_GOLDEN_FIXTURE = 'office-golden';
await import('./ask-golden.test.js');
