# Install

Two paths. Pick whichever matches your toolchain.

## Option A — Docker (zero local toolchain) · 60 seconds

The fastest way. No Node, no pnpm, no native build deps.

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
export DQL_SERVER_TOKEN="$(openssl rand -hex 24)"   # any long random string
docker compose up
```

> First build takes ~3 minutes (deps + workspace build). Subsequent runs
> reuse cached layers and start in seconds.

The container binds `0.0.0.0`, which DQL treats as a network binding. It
refuses to start without `DQL_SERVER_TOKEN` (and `DQL_ALLOWED_ORIGINS`, which
the compose file sets for `127.0.0.1:3474` and `localhost:3474`). Compose stops
with a clear message if the token is unset. If you map a different host port,
set `DQL_ALLOWED_ORIGINS` to match.

The notebook is live at **http://127.0.0.1:3474**. Open the link that
`docker compose up` prints, `http://127.0.0.1:3474/#dql_token=<your token>`. The
token stays in that browser tab's session. `/api/health` needs no token. If you run this from
the DQL framework source repo, Docker creates and opens an ignored starter
project under `.dql/docker-starter/`. If you run the same image from a folder
that already has `dql.config.json`, that folder opens as the project.

To run the Slack bot or a local Ollama daemon in the same compose stack:

```bash
docker compose --profile slack  up   # adds the bot on :3479
docker compose --profile ollama up   # adds local Ollama on :11434
```

## Option B — npm (Node 20 or newer) · 2 minutes

If you already have Node, scaffold a project and run the notebook with the
project-local DQL CLI:

```bash
npx create-dql-app@latest my-analytics
cd my-analytics
npm install
npm run doctor
npm run notebook

# Optional, only before running queries with these drivers:
# npm install --prefix .dql/connectors duckdb        # DuckDB/local files
# npm install --prefix .dql/connectors snowflake-sdk # Snowflake
# Databricks does not need an extra package.
```

Open **http://127.0.0.1:3474**. The starter is a clean project with
`dql.config.json`, a welcome notebook, and npm scripts for the local workflow.
Run it inside a dbt repo and the dbt project is wired in automatically (see
below). To try DQL on a sample dbt project, clone
[jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb).

Install only the database driver the project uses:

| Database | Extra install before running queries | Notes |
| --- | --- | --- |
| Databricks SQL | none | Built into DQL through HTTPS |
| DuckDB or local CSV/Parquet/JSON files | `npm install --prefix .dql/connectors duckdb` | Needed for `duckdb` and `file` connections |
| Snowflake | `npm install --prefix .dql/connectors snowflake-sdk` | Needed for Snowflake connections |

The notebook Connections page can also install DuckDB or Snowflake into
`.dql/connectors/`.

For an existing DQL project, install only the CLI:

```bash
npm i -D @duckcodeailabs/dql-cli
npm exec -- dql doctor
npm exec -- dql notebook
```

## Existing dbt repo

If you already have a dbt repo, keep DQL isolated in a `dql/` folder inside
that repo — this is the recommended path:

```bash
cd my-dbt-repo
dbt parse                        # ensure target/manifest.json exists
npx create-dql-app@latest dql    # detects the dbt project, wires the config
cd dql
npm install
npm run sync                     # import dbt models + lineage
npm run notebook

# Optional, only before running queries with these drivers:
# npm install --prefix .dql/connectors duckdb        # DuckDB/local files
# npm install --prefix .dql/connectors snowflake-sdk # Snowflake
# Databricks does not need an extra package.
```

Global or local CLI install alone does not create the project folders. If you
installed `dql` globally, bootstrap the folder explicitly:

```bash
cd my-dbt-repo
dbt parse
dql init ./dql
cd dql
dql doctor
dql compile
dql sync dbt
dql notebook
```

Equivalent project-local manual path:

```bash
cd my-dbt-repo
npm i -D @duckcodeailabs/dql-cli
npx dql init ./dql
```

The resulting layout is:

```text
my-dbt-repo/
├─ dbt_project.yml
├─ models/
├─ target/manifest.json
└─ dql/
   ├─ dql.config.json
   ├─ blocks/
   ├─ notebooks/
   ├─ apps/
   └─ .dql/
```

`dql.config.json` will point at the local dbt project:

```json
{
  "semanticLayer": { "provider": "dbt", "projectPath": ".." },
  "dbt": { "projectDir": "..", "manifestPath": "target/manifest.json" }
}
```

Use the sibling layout instead when you want dbt and DQL in separate folders:
`analytics/dbt/` plus `analytics/dql/`.

Global install is optional, but project-local scripts avoid stale global CLIs:

```bash
npm i -g @duckcodeailabs/dql-cli
dql --version
```

After a global install, run `dql init ./dql` from your dbt repo root before
trying `cd dql`.

Works on macOS, Linux, and Windows.

## Verify

For a project-local installation:

```bash
npm exec -- dql --version
# prints the installed version, for example: dql 1.17.3
```

For a global installation:

```bash
dql --version
# prints the installed version
```

If you see the version number, jump to the [Quickstart →](01-quickstart.md).

## Upgrade

DQL ships as regular npm packages, so upgrading is a normal `npm install` of the
latest version — no separate updater.

**Global CLI:**

```bash
npm i -g @duckcodeailabs/dql-cli@latest
dql --version        # should print the new version
```

**Project-local CLI** (the recommended install — avoids stale global CLIs):

```bash
npm i -D @duckcodeailabs/dql-cli@latest
npm exec -- dql --version
```

If `dql --version` still shows the old version (or `command not found`) after
upgrading, see the two bullets below.

## Troubleshooting

- **`command not found: dql` (or `dql --version` shows an old version)** — the
  quickest fix works with no PATH setup at all:
  ```bash
  npx @duckcodeailabs/dql-cli@latest notebook   # always runs the latest, ignores PATH
  ```
  To fix a global install so plain `dql` works, walk these in order:
  ```bash
  which -a dql                 # any stale copy (Homebrew, a venv, an old global) shadowing it?
  hash -r                      # clear the shell's cached command path (or open a new terminal)
  npm ls -g @duckcodeailabs/dql-cli   # is it actually installed globally?
  npm prefix -g                # your global prefix; ensure "<prefix>/bin" is on $PATH
  npm i -g @duckcodeailabs/dql-cli@latest   # reinstall if a prior install had failed
  ```
  A failed `npm i -g` never links the `dql` binary, which shows up as
  `command not found` — reinstalling `@latest` fixes it.
  In a scaffolded project you can always use `npm run notebook` / `npx dql ...`
  instead of a global command.
- **Node version** — DQL needs Node 20 or newer (CI tests 20, 22, and 24). Manage Node
  with [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm).
- **Port already in use** — edit `docker-compose.yml` and change
  `127.0.0.1:3474:3474` to map a different host port (e.g. `:3475:3474`).
- **Container exits with "Non-loopback DQL server binding requires
  DQL_SERVER_TOKEN"** — export `DQL_SERVER_TOKEN` before `docker compose up`.
  Use the same token in the `#dql_token=` link.
- **Browser says the origin is refused** — set `DQL_ALLOWED_ORIGINS` to the
  exact origin you browse from, for example `http://127.0.0.1:3475` after a
  port change.
- **Container can't see your project** — confirm `volumes: ./:/workspace`
  in `docker-compose.yml`; if you `cd` to a different directory before
  `docker compose up`, that's the project that gets mounted.
