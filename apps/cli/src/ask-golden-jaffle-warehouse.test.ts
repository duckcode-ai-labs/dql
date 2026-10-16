/**
 * The warehouse-only golden lane: jaffle-golden's questions over the same
 * seed, on `test/fixtures/jaffle-warehouse-golden` — a database-only workspace
 * (synced warehouse catalog, drafted and certified joins) with no dbt
 * manifest, blocks or metrics. It reports its score and fails only below the
 * floor in `test/ask-golden/jaffle-warehouse-golden/baseline.json`; see
 * `golden.json` there. Selecting the fixture is an environment variable read
 * at module load, so this file sets it and imports the harness.
 */
process.env.ZLENS_ASK_GOLDEN_FIXTURE = 'jaffle-warehouse-golden';
await import('./ask-golden.test.js');
