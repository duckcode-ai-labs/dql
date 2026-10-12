# {{PROJECT_NAME}}

A DQL project scaffolded by `create-dql-app`.

DQL means **Domain Query Language**. It is the open-source analytics language
for turning source data, SQL, dbt models, business terms, notebooks,
dashboards, apps, and lineage into one Git-versioned project.

The core path is:

```text
source data -> DQL block -> business_view -> dashboard/app/AI answer
```

Shared source includes `domains/`, `skills/`, `blocks/`, `notebooks/`, `apps/`,
tests, and governed learning evidence under `.dql/hints/`, `.dql/traces/`,
`.dql/evaluations/`, and `.dql/reviews/`. Rebuildable indexes, connectors,
credentials, and private state remain ignored under their granular `.dql/`
subdirectories. Do not broadly ignore `.dql/`.

Run `npm run compile` to produce `dql-manifest.json`, the local manifest that
connects technical lineage with business lineage.

## Connect your warehouse

Edit `dql.config.json` or open the notebook connection panel. DQL uses a flat
install by default: Databricks SQL works through the built-in HTTP connector,
and DuckDB or Snowflake drivers can be installed project-locally when needed.
Add your warehouse connection in the notebook or config.

```bash
npm install
npm run doctor
```

Choose one database path before running queries:

| Database | Extra install | Notes |
| --- | --- | --- |
| Databricks SQL | none | Built into DQL through HTTPS |
| DuckDB or local CSV/Parquet/JSON files | `npm install --prefix .dql/connectors duckdb` | Needed for `duckdb` and `file` connections |
| Snowflake | `npm install --prefix .dql/connectors snowflake-sdk` | Needed for Snowflake connections |

The notebook Connections page can also install DuckDB or Snowflake into
`.dql/connectors/`. For local files, add a DuckDB/file connection and query CSV
or Parquet data with functions such as `read_csv_auto('./file.csv')`.
See the [connector reference](https://github.com/duckcode-ai-labs/dql/blob/main/docs/reference/connectors.md).

## Start the notebook

```bash
npm run notebook
```

Open `notebooks/welcome.dqlnb` first. It shows the starter workflow:

1. Explore data with SQL.
2. Add a business domain under `domains/`, then keep its DQL blocks, terms, and views together.
3. Add shared agent guidance under `skills/`.
4. Compose business outcomes under `domains/<domain>/views/`.
5. Use Lineage to trace source data into business views and consumption.

## Connect an AI agent

After `npm run doctor` passes, DQL can expose the same governed project context
to Claude Code, Codex, Cursor, Claude Desktop, or any MCP client:

```bash
npm run compile
npx dql mcp test
npx dql connect claude-code
# or: npx dql connect codex
# or: npx dql connect all
```

Claude Code uses project `.mcp.json` and `CLAUDE.md`. Codex uses project
`.codex/config.toml` and `AGENTS.md`. Agents should start with
`inspect_dql_project`, route questions through `ask_dql`, use certified blocks
when the grain exactly fits, and mark generated SQL as uncertified.
The generated `.mcp.json`, `.codex/`, and `.cursor/` files are ignored by
default because they can contain local machine paths.

## Have a dbt project?

Point `dql.config.json` at it (auto-wired if a sibling dbt project was
detected at scaffold time), then:

```bash
dbt parse          # inside the dbt project
npx dql sync dbt   # import models + lineage into DQL
```

No dbt project handy? Try the example repo:
[github.com/duckcode-ai/jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb).
