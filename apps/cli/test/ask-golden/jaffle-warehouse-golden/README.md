# Warehouse-only golden lane

jaffle-golden's questions (`../questions.json`) and five-turn conversation
(`../conversation.json`) over the same seed rows, on a project with **no dbt**:
`../../fixtures/jaffle-warehouse-golden` is a database-only workspace with a
synced warehouse catalog, entities and joins drafted from it, and five joins
checked on the data and certified. It has no dbt manifest, no blocks, no
metrics and no domain skills. It measures how far Ask gets for a team that only
has a database, and every Ask change can show its effect here.

## Files

| File | What it is |
|---|---|
| `golden.json` | Lane settings: borrow jaffle-golden's cases and seed; tiers `certified`, `governed` and `any` become `reviewable` (right rows, any honest label), because a database-only project has no dbt metrics or certified blocks; gate on a floor. |
| `baseline.json` | Per-case results and the floors CI enforces: `floor.askGolden` (this lane, cassette replay) and `floor.router` (router comparison). `askGolden` and `router` hold jaffle-golden's results next to this lane's, for the gap. |
| `../../fixtures/jaffle-warehouse-golden/test-cassettes/golden/` | The provider responses this lane replays, recorded live with the `claude-code` provider. |

## How the fixture was made

With the product's own steps, on a DuckDB holding jaffle-golden's seed rows
(schema `dev`): `zlens init --warehouse-first`, identity owner
`analytics@jaffle.shop`, `zlens sync warehouse --schemas dev`,
`zlens model discover --validate`, `zlens model apply-discovery --apply --validate`.
Review in Modeling: `product` grain `product_id` and `supply` grain
`supply_uuid` (both unique on the data); the five joins between the tables
certified with owner `analytics@jaffle.shop`. The Modeling page saves a
certified join into `modeling/areas/core.dql.yaml` and leaves its draft in
`model.dql.yaml` (duplicate id); those drafts were removed. The connection is
then set to `sqlite :memory:` like jaffle-golden's, because the harness serves
the seed through its SQLite executor.

## Run it

```bash
pnpm build
# Ask pipeline lane, replayed cassettes (what CI runs in `pnpm test`)
pnpm --filter @zlens/cli exec vitest run src/ask-golden-jaffle-warehouse.test.ts
# Router comparison, both fixtures (what CI's golden-eval job runs)
node scripts/eval-golden-router-compare.mjs --check apps/cli/test/ask-golden/jaffle-warehouse-golden/baseline.json
```

The lane prints `jaffle-warehouse-golden: N/45 passed (floor F)` with the cases
that started or stopped passing, and fails only when N < F.

## When a change moves the score

A change to Ask that changes its prompts makes this lane's cassettes miss, as
it does jaffle-golden's. Re-record against a live provider, then record the
new baseline:

```bash
cd apps/cli
# a folder whose .dql/provider-settings.json activates the provider, e.g. claude-code
ZLENS_ASK_GOLDEN_LIVE=1 ZLENS_ASK_GOLDEN_RECORD=1 ZLENS_ASK_GOLDEN_PROVIDER_PROJECT=<folder> \
  npx vitest run src/ask-golden-jaffle-warehouse.test.ts
# replay, write the per-case results and set floor.askGolden to the score
ZLENS_ASK_GOLDEN_BASELINE_OUT=$PWD/test/ask-golden/jaffle-warehouse-golden/baseline.json \
  npx vitest run src/ask-golden-jaffle-warehouse.test.ts
# router results and floor.router
node ../../scripts/eval-golden-router-compare.mjs --write test/ask-golden/jaffle-warehouse-golden/baseline.json
```

Delete `test-cassettes/golden/` before re-recording so no unused response stays
behind. Raise a floor in the PR that raises the score; lowering one needs a
reason in that PR.
