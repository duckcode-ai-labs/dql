# FAQ

## What is DQL?

An open-source analytics language, CLI, and notebook. Every analytics answer
— SQL, chart config, owner, tests, parameters — lives in a single `.dql`
file in git. See [Concepts](../02-concepts.md).

## Do I need a cloud warehouse to try it?

No. DQL supports local DuckDB and file queries. Install the project-local
DuckDB driver, then query CSV, Parquet, or JSON files from the notebook:

```bash
npm install --prefix .dql/connectors duckdb
```

Databricks SQL is built in. Snowflake uses a project-local `snowflake-sdk`
install.

## Do I need dbt?

No. DQL works standalone. But if you already use dbt, `create-dql-app`
auto-detects a sibling dbt project. Run `dbt build`, then `dql compile .`,
`dql sync dbt .`, and `dql agent reindex` to refresh manifest metadata,
semantic metrics, lineage, and the agent index. See
[Import a dbt project](./import-dbt.md).

## How is this different from a Jupyter notebook?

|                   | Jupyter        | DQL notebook          |
| ----------------- | -------------- | --------------------- |
| Primary language  | Python         | SQL                   |
| Runtime           | Python kernel  | DuckDB (or your warehouse) |
| Chart setup       | matplotlib/Plotly code | declarative, auto-rendered |
| File format       | `.ipynb` JSON  | `.dqlnb` JSON         |
| Git diff          | noisy (outputs embedded) | clean (outputs sidecar) |

## How is this different from Metabase, Looker, or Hex?

Those are BI tools — queries live in a database or cloud service. DQL keeps
every artifact in git. You get code review, diff, branching, and blame on
your analytics. See [Migrate from Metabase / Looker / Hex](./migrate.md).

## What's the difference between `custom` and `semantic` blocks?

- **`type = "custom"`** — the block's SQL executes directly against a connection
- **`type = "semantic"`** — the block references a semantic-layer metric; SQL is generated

Start with `custom` blocks if you're new.

## Can I use DQL from code, not just the CLI?

Yes. The useful entry points:

- `@duckcodeailabs/dql-core` — parser, AST, formatter, semantic analysis
- `@duckcodeailabs/dql-compiler` — IR lowering, codegen
- `@duckcodeailabs/dql-runtime` — browser runtime
- `@duckcodeailabs/dql-connectors` — database drivers

## Does certification hit a real database?

Yes. `dql certify <file.dql> --connection <driver>` runs block assertions
against the configured connection. In generated OSS projects, prefer
`dql validate` for structural checks and `dql certify` for the local trust gate.

## What's **not** in the open-source repo?

Hosted multi-user workspaces, governed secrets, audit logs, organization
memory, approval workflows, managed alerting, regulatory governance packs, and
permissions-aware team retrieval. See [Compatibility](../reference/compatibility.md).

## Where do I report bugs or request features?

[github.com/duckcode-ai-labs/dql/issues](https://github.com/duckcode-ai-labs/dql/issues).
