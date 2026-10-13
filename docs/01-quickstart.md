# Quickstart

> ~10 minutes · ends with the dbt DAG imported, a certified block, a
> manifest, and end-to-end lineage

ZLens adds an analytics layer on top of a dbt project: certified blocks,
dashboards in Apps, notebooks, and governed agent answers — all as files in
git. This quickstart adds ZLens to **your own dbt repo**. No external warehouse,
hosted account, SSO, or team RBAC is required.

> **Just want to see it running?** Use the separate
> [jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb)
> example and follow its
> [Jaffle Shop tutorial](https://github.com/duckcode-ai/jaffle-shop-duckdb/blob/main/docs/tutorials/jaffle/README.md).
> The rest of this page builds a ZLens workspace from scratch on your repo.

## 1. Make your dbt manifest fresh

```bash
cd your-dbt-repo
dbt parse        # or dbt build — either writes target/manifest.json
```

## 2. Scaffold the ZLens workspace

From the dbt repo root:

```bash
npx create-zlens-app@latest dql
cd dql
npm install
```

The scaffolder detects the parent dbt project and wires it into
`dql.config.json`. ZLens stays isolated under `./dql`; your dbt files are
untouched. The generated project installs the ZLens CLI locally, so `npm run
...` works without a global `zlens` binary.

If you already installed the CLI globally, that only installs the command. It
does not create a `dql/` folder. Use this equivalent path:

```bash
cd your-dbt-repo
zlens init ./dql
cd dql
zlens doctor
```

Point the default connection at your dbt warehouse in `dql.config.json`. For a
local DuckDB file that's:

```json
"connections": {
  "default": { "driver": "duckdb", "filepath": "../my_warehouse.duckdb" }
}
```

(Databricks, DuckDB/local files, and Snowflake — see
[connectors](reference/connectors.md).)

Install only the database driver your project uses:

| Database | Extra install before running queries | Notes |
| --- | --- | --- |
| Databricks SQL | none | Built into ZLens through HTTPS |
| DuckDB or local CSV/Parquet/JSON files | `npm install --prefix .dql/connectors duckdb` | Needed for `duckdb` and `file` connections |
| Snowflake | `npm install --prefix .dql/connectors snowflake-sdk` | Needed for Snowflake connections |

The notebook Connections page can also install DuckDB or Snowflake into
`.dql/connectors/`.

## 3. Check the setup and sync dbt

```bash
npm run doctor
npm run sync
```

`zlens doctor` verifies the project shape, notebook assets, and default
connection. `zlens sync dbt` imports the dbt models and sources into the DQL
manifest so lineage connects end to end.

## 4. Start the notebook

```bash
npm run notebook
```

The CLI starts a local server on **http://127.0.0.1:3474** and opens the
browser UI. Query a dbt model from a notebook cell, then open **Blocks** to
create your first block from a dbt model (the
[authoring tutorial](tutorials/02-authoring-blocks.md) walks through a full
certified block).

Before asking composed metric questions, confirm the dbt semantic model exposes
the measure/metric, its primary entity, compatible dimensions, relationship
paths, and an authoritative time dimension. If your business uses a specific
timezone, completeness rule, comparison alignment, or ranking period, declare
those defaults in a versioned Domain Skill. Skills guide the plan but cannot
make an incompatible metric executable.

In **Ask**, try these progressively richer checks:

1. `What is revenue today?`
2. `What is revenue from Zoom customer?`
3. `Show current revenue and last-year revenue for the top 5 customers.`

Open **How it was answered** after each run. A complete setup shows the selected
metric/entity/dimension roles and governed time policy. A failed run keeps the
plan plus any compiled DQL/SQL and offers only safe derived repair actions; it
is not eligible for **Save as block** until it produces a reviewable result.

## 5. Compile the manifest and view lineage

```bash
npm run compile
npm run lineage
```

`zlens compile` writes `dql-manifest.json`, the dbt-like artifact for the ZLens
workspace: blocks, notebooks, Apps, dashboard pages, semantic objects, dbt
imports, and lineage edges. `npm run lineage` summarizes how data flows from
sources through dbt models into blocks, dashboard pages, and Apps.

## Verify it worked

You should have:

- A running local notebook at `http://127.0.0.1:3474`
- The dbt DAG visible in the **Lineage** view
- `dql-manifest.json` written in the workspace root

## Where to go next

- [Tutorials — end to end](tutorials/README.md) *(blocks → dashboards & Apps → agent → CI)*
- [ZLens in 5 concepts](04-dql-in-5-concepts.md)
- [Block Studio dbt-first workflow](guides/block-studio.md)
- [Import your dbt project](guides/import-dbt.md)
