# DQL

[![CI](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml/badge.svg)](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@duckcodeailabs/dql-cli?label=dql-cli)](https://www.npmjs.com/package/@duckcodeailabs/dql-cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024%20LTS-green)](https://nodejs.org)

**DQL — Domain Query Language — is a Git-versioned, governed analytics layer for
dbt teams, with an AI agent that answers from reviewed context instead of
guessing.**

It turns dbt models, semantic metrics, SQL, notebooks, and Apps into reviewable
files, then answers business questions through a governed cascade — certified
blocks first, semantic metrics next, generated SQL last — with every answer
carrying a trust label. dbt stays the source of truth; the analytics layer on
top becomes trustworthy too, with certified blocks, lineage, tests, and source
control.

**Why DQL is different**

- **Grounded, not hallucinated.** Generated SQL is grounded in your schema,
  validated, and executed. A query that returns no rows or can't be grounded is
  flagged **review-required** — never dressed up as a confident, "trusted" number.
- **Works with your coding agent.** A built-in MCP server lets Claude Code,
  Codex, Cursor, and Claude Desktop ask questions and build governed blocks with
  the same trust guards as the UI → [Connect an AI agent](./docs/guides/mcp.md).
- **Runs on your terms.** Use your Claude or ChatGPT subscription, an API key,
  or a fully local model via Ollama.

## Architecture flow

DQL turns governed analytics work into executable, reviewable files. Certified
blocks serve trusted answers first; notebooks and AI-generated SQL stay
review-required until promoted.

> Click the diagram to open the full-size SVG in a browser tab, where you can
> zoom or use full-screen mode.

<p align="center">
  <a href="docs/assets/architecture/dql-flow.svg">
    <img src="docs/assets/architecture/dql-flow.svg" alt="DQL architecture flow from dbt and optional DataLex context to certified blocks, manifest, apps, notebooks, agents, review drafts, and CI" width="100%" />
  </a>
</p>

**Why users care:** DQL makes dashboards, notebook research, and AI answers use
the same reviewed assets, with clear labels when analysis is still draft.

## Start here

Use one of these two paths.

### Path 1: Try the separate Jaffle Shop example

This is the fastest way to see DQL working end to end without embedding example
fixtures in this product repo.

```bash
git clone https://github.com/duckcode-ai/jaffle-shop-duckdb.git
cd jaffle-shop-duckdb
./setup.sh

cd dql
npm install
npm install --prefix .dql/connectors duckdb
npm run notebook
```

Open the local URL printed in the terminal, usually `http://127.0.0.1:3474`.

What to check first:

1. Home shows dbt artifacts, database connection, blocks, notebooks, and Apps.
2. Blocks shows certified examples built on top of the dbt project.
3. Apps opens the Jaffle Growth Command Center.
4. Lineage shows how sources, dbt models, blocks, dashboards, and Apps connect.

Follow the example repo's
[Jaffle Shop tutorial](https://github.com/duckcode-ai/jaffle-shop-duckdb/blob/main/docs/tutorials/jaffle/README.md)
for the full DataLex + DQL story.

### Path 2: Add DQL to your own dbt repo

Run this from the root of an existing dbt project.

```bash
cd your-dbt-repo
dbt parse

npx create-dql-app@latest dql
cd dql
npm install
npm run doctor
npm run sync
npm run notebook

# Optional, only before running queries with these drivers:
# npm install --prefix .dql/connectors duckdb        # DuckDB or local files
# npm install --prefix .dql/connectors snowflake-sdk # Snowflake
# Databricks does not need an extra package.
```

`dbt parse` should create `target/manifest.json`. DQL also reads dbt artifacts
such as `catalog.json`, `semantic_manifest.json`, and `run_results.json` when
they exist.

Install only the database driver your project uses:

| Database | Extra install before running queries | Notes |
| --- | --- | --- |
| Databricks SQL | none | Built into DQL through HTTPS |
| DuckDB or local CSV/Parquet/JSON files | `npm install --prefix .dql/connectors duckdb` | Needed for `duckdb` and `file` connections |
| Snowflake | `npm install --prefix .dql/connectors snowflake-sdk` | Needed for Snowflake password, key-pair, SSO, OAuth, PAT, MFA, and workload identity auth |

The notebook Connections page can also install DuckDB or Snowflake into
`.dql/connectors/`. This keeps the base DQL install fast while each project
opts into the warehouse package it actually needs.

If you installed the CLI globally, installation only gives you the `dql`
command. It does not create a `dql/` folder by itself. Bootstrap the folder
explicitly:

```bash
cd your-dbt-repo
dql init ./dql
cd dql
dql doctor
dql compile
dql sync dbt
dql notebook
```

## Install and upgrade the CLI

DQL is plain npm packages. Most users install the CLI project-locally (via
`create-dql-app`, above), but you can also install it globally:

```bash
npm i -g @duckcodeailabs/dql-cli        # install
dql --version
```

Upgrading is just re-installing the latest — there is no separate updater:

```bash
npm i -g @duckcodeailabs/dql-cli@latest # global
npm i -D @duckcodeailabs/dql-cli@latest # project-local (then: npx dql --version)
```

### How to run project-local and global commands

Project-local installation is recommended because each repository keeps the
CLI version it was tested with. npm links that CLI at
`node_modules/.bin/dql`; it does not add the link to your interactive shell's
`PATH`.

| Installation | Use | Example |
| --- | --- | --- |
| Scaffolded/project-local | A provided npm script | `npm run doctor` |
| Project-local, any command | `npm exec -- dql <command>` | `npm exec -- dql model list` |
| Project-local shorthand | `npx dql <command>` | `npx dql --help` |
| Global | `dql <command>` | `dql doctor` |

This means `npm run doctor` can work while a bare `dql doctor` says
`command not found`: the former uses the repository's local binary, while the
latter requires the global installation shown above. Confirm which CLI you are
using with:

```bash
npm exec -- dql --version   # project-local
dql --version               # global, if installed
```

The starter project includes scripts for the daily workflow. Use
`npm exec -- dql ...` for every other command:

| Goal | Project-local command |
| --- | --- |
| Check installation and configuration | `npm run doctor` |
| Open the notebook UI | `npm run notebook` |
| Refresh dbt artifacts and indexes | `npm run sync` |
| Compile and validate the project | `npm run compile` then `npm run validate` |
| Inspect lineage | `npm run lineage` |
| List or validate Domain Packages | `npm exec -- dql model list` / `npm exec -- dql model validate` |
| Create or import governed content | `npm exec -- dql new ...` / `npm exec -- dql import sql ...` |
| Format, diff, certify, and verify | `npm exec -- dql fmt ...`, `npm exec -- dql diff ...`, `npm exec -- dql certify ...`, `npm exec -- dql verify` |
| Ask, evaluate, or connect an agent | `npm exec -- dql agent ...`, `npm exec -- dql eval ...`, `npm exec -- dql connect ...` |

Run `npm exec -- dql --help` for the live command list, or use the
[complete CLI reference](./docs/reference/cli.md) for commands, subcommands,
flags, examples, and exit codes.

> **Stuck on `dql: command not found` after installing?** Before **1.6.30** a
> global install could fail on Node 23/24 (the current LTS is Node 24), and a
> failed `npm i -g` never links the `dql` binary. Just reinstall `@latest` on any
> Node ≥20 — you don't need a working `dql` or an older Node. The escape hatch
> that needs no PATH setup at all is `npx @duckcodeailabs/dql-cli@latest notebook`.
> More in the [install guide](docs/03-install.md#upgrade) and
> [troubleshooting](docs/guides/troubleshooting.md#dql-says-command-not-found).

## Before you install

- Use Node `20` or newer — `20`, `22`, or `24` LTS. (Releases before 1.6.30
  capped at Node 22; 1.6.30+ installs on Node 23 and 24 too.)
- Use npm `10+`.
- Use a dbt project if you want dbt import and lineage.
- Python and native build tools are only needed when native database packages
  cannot use prebuilt binaries.

On macOS, if npm falls back to native compilation, install the command-line
tools once:

```bash
xcode-select --install
```

## Why install can feel slow

DQL uses a flat CLI install by default. Heavy warehouse drivers are not bundled
into the global install. Databricks SQL works through the built-in HTTP
connector, while DuckDB and Snowflake can be installed project-locally from the
notebook connection panel when needed.

Most slow installs now come from optional native packages installed for a
specific project, older Node versions, locked-down networks, or missing build
tools.

If install is slow, check this first:

```bash
node -v
npm -v
python3 --version
# macOS only:
xcode-select -p
```

Expected Node versions are `v20.x` or `v22.x`. If an optional connector install
shows `node-gyp rebuild`, switch to Node `22` LTS and retry:

```bash
rm -rf node_modules package-lock.json
npm install --foreground-scripts
```

For Linux, install `python3`, `make`, and `g++`. For Windows, install the
Microsoft C++ Build Tools.

## First 10-minute tutorial

1. Open Home.
   Confirm DQL found your dbt project and compiled artifacts.

2. Connect the database.
   If dbt `profiles.yml` or `profiles.yaml` exists, DQL can read the connection
   shape. Enter any local credentials that are not stored in the profile, then
   test the connection.

3. Review imported objects.
   Check dbt models, sources, semantic metrics, and database tables before
   building blocks.

4. Create your first block.
   Use a dbt model, a semantic metric, imported SQL, or the local AI builder.
   Keep the block small and tied to one trusted business question.

5. Run and certify.
   Run the block, review results, add validation/tests where needed, then mark
   it ready for review or certification.

6. Use notebooks.
   Search blocks, add cells, edit SQL/DQL, run research from source cells, and
   promote reviewed SQL into draft DQL blocks.

7. Push to an App.
   Build a local App from certified blocks and notebooks so stakeholders see a
   clean dashboard-style view.

8. Check lineage and source control.
   Confirm the path from source tables to dbt models, blocks, notebooks,
   dashboards, and Apps. Review file changes before committing.

## Daily commands

Run these from the `dql/` workspace.

```bash
npm run notebook   # open the local UI
npm run sync       # refresh dbt models, artifacts, and lineage
npm run compile    # compile DQL files
npm run validate   # validate blocks and project files
npm run lineage    # inspect lineage from the CLI
```

## Connect AI agents

DQL includes an MCP server for Claude Code, Codex, Cursor, Claude Desktop, and
other MCP clients. The server routes questions through certified blocks first,
uses project metadata for safe generated SQL previews, and saves uncertified
drafts for review.

```bash
npm exec -- dql mcp test
npm exec -- dql connect claude-code   # writes .mcp.json and CLAUDE.md
npm exec -- dql connect codex         # writes .codex/config.toml and AGENTS.md
```

See [Connect an AI agent](./docs/guides/mcp.md) for Claude Desktop, Cursor,
remote MCP server config, and SDK provider notes.

## Core concepts

- **Term**: a governed business definition.
- **Block**: a reusable SQL or semantic answer with owner, description, tests,
  chart intent, and AI context.
- **Business view**: a composed business object that groups terms, blocks, and
  nested views.
- **Notebook**: analysis as code, with SQL/DQL cells and live results.
- **App**: a stakeholder-facing local app built from governed blocks and
  notebooks.
- **Lineage**: the graph from source data to dbt models, DQL blocks, notebooks,
  dashboards, and Apps.

## Documentation

All docs live in [`docs/`](./docs/). Start with these:

- [Quickstart](./docs/01-quickstart.md)
- [Install](./docs/03-install.md)
- [Tutorials](./docs/tutorials/README.md)
- [Import dbt](./docs/guides/import-dbt.md)
- [Block Studio](./docs/guides/block-studio.md)
- [Notebook research engine](./docs/guides/notebook-research.md)
- [Author a block](./docs/guides/authoring-blocks.md)
- [Connectors](./docs/reference/connectors.md)
- [CLI reference](./docs/reference/cli.md)
- [Troubleshooting](./docs/guides/troubleshooting.md)
- [End-to-end Jaffle Shop example](https://github.com/duckcode-ai/jaffle-shop-duckdb/blob/main/docs/tutorials/jaffle/README.md)

## What is included in OSS

- Local notebook UI
- Block Studio
- dbt artifact import
- dbt `profiles.yml` connection discovery
- Database connectors for local and warehouse development
- Apps
- Lineage
- Source control workflow
- Local agent/MCP runtime
- Telemetry off by default

DQL OSS is a single-user local workspace. Hosted multi-user governance,
managed secrets, audit logs, approval workflows, and permissions-aware team
retrieval belong to the commercial product.

## Privacy and telemetry

Telemetry is off by default and collects no PII. It does not send file names,
query contents, warehouse URLs, or block names. If enabled with
`dql telemetry on`, DQL sends only anonymized event names, enum-valued counters,
and durations. Opt out with `dql telemetry off`, `DO_NOT_TRACK=1`, or
`DQL_TELEMETRY_DISABLED=1`.

The full event schema is documented in
[`packages/dql-telemetry/README.md`](./packages/dql-telemetry/README.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and
[docs/contribute/repo-layout.md](./docs/contribute/repo-layout.md). Bugs and
feature requests: [open an issue](https://github.com/duckcode-ai/dql/issues).

## License

[Apache-2.0](./LICENSE), except four packages that are MIT:
`create-dql-app`, `@duckcodeailabs/dql-openlineage`,
`@duckcodeailabs/dql-plugin-api` and `@duckcodeailabs/dql-telemetry`. Each
package's `package.json` names its license.
