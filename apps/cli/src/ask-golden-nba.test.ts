/**
 * The NBA golden lane: the same harness over `test/fixtures/nba-golden`, a
 * Snowflake-shaped dbt inventory with no semantic layer, a parameterized
 * certified block grouped by a label, non-unique player names and games from
 * calendar 2016–2017. Selecting the fixture is an environment variable read
 * at module load, so this file sets it and imports the harness.
 */
process.env.ZLENS_ASK_GOLDEN_FIXTURE = 'nba-golden';
await import('./ask-golden.test.js');
