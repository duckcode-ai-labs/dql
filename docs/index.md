---
hide:
  - navigation
  - toc
---

# ZLens

> **Bringing dbt's discipline to the analytics layer — built on top of dbt.**

dbt governs your models; the *answers* built on them — the query behind a
dashboard tile, the metric pasted into Slack, the SQL an AI assistant just
improvised against your warehouse — usually aren't reviewed, tested, or owned.
ZLens carries that same discipline downstream: every answer becomes a
**certified block** (SQL + owner, domain, tests, chart intent, and LLM
context) in a git-tracked `.dql` file. Apps package certified blocks into
decision-facing dashboard pages and notebooks. `zlens compile` generates a
dbt-like manifest with lineage from sources and dbt models through blocks and
Apps — and the agent/MCP server answers from certified blocks first, flagging
anything improvised as *Uncertified*.

No hosted account is required. Certification is a local trust label. Personas
and policies are local previews, not hosted RBAC.

## Start Here

From your dbt repo:

```bash
dbt parse                        # ensure target/manifest.json exists
npx create-zlens-app@latest dql    # scaffolds ./dql, auto-wires dbt
cd dql
npm install
npm run sync                     # import dbt models + lineage
npm run notebook                 # http://127.0.0.1:3474

# Optional, only before running queries with these drivers:
# npm install --prefix .dql/connectors duckdb        # DuckDB/local files
# npm install --prefix .dql/connectors snowflake-sdk # Snowflake
# Databricks does not need an extra package.
```

If you installed `zlens` globally, initialize the project
folder first:

```bash
cd your-dbt-repo
zlens init ./dql
cd dql
zlens doctor
```

Then run:

```bash
npm run compile
npm run lineage
```

To see a finished DataLex + ZLens example, use the separate
[jaffle-shop-duckdb tutorial](https://github.com/duckcode-ai/jaffle-shop-duckdb/blob/main/docs/tutorials/jaffle/README.md).

## Why ZLens

- **Certified blocks.** Save reusable answer units with metadata, tests, and
  local trust status.
- **Apps in git.** Package dashboard pages, notebooks, text, AI pins, and draft
  blocks in local App folders.
- **dbt-aware lineage.** Connect sources, dbt models, semantic metrics, DQL
  blocks, dashboard pages, and Apps in `dql-manifest.json`.
- **Agent-safe defaults.** Local agent and MCP tools prefer certified blocks and
  label fallback generated SQL as uncertified.
- **OSS boundary clarity.** Local single-user workflows are open source; hosted
  auth, managed secrets, audit logs, organization RBAC, and approval workflows
  are outside OSS.

## Learn

1. [Quickstart](01-quickstart.md) — add ZLens to a dbt repo
2. [ZLens in 5 concepts](04-dql-in-5-concepts.md)
3. [Tutorials](tutorials/README.md) — blocks → dashboards & Apps → agent → CI
4. [Block Studio](guides/block-studio.md)
5. [Notebook research engine](guides/notebook-research.md)
6. [Author a certified block](guides/authoring-blocks.md)
7. [Import dbt](guides/import-dbt.md)

## What Ships

```mermaid
flowchart LR
    Project["ZLens project"] --> Compiler["zlens compile"]
    Compiler --> Manifest["dql-manifest.json"]
    Manifest --> Lineage["zlens lineage"]
    Manifest --> MCP["zlens mcp"]
    Manifest --> Notebook["zlens notebook + Apps"]
    Blocks["Certified blocks"] --> Apps["Apps"]
    Apps --> Notebook
```

| Package | What it does |
|---|---|
| [`zlens`](https://www.npmjs.com/package/zlens) | The `zlens` binary: notebook, compile, validate, certify, lineage, MCP |
| [`@zlens/core`](https://www.npmjs.com/package/@zlens/core) | Parser, formatter, semantic analyzer, manifest builder, lineage |
| [`@zlens/mcp`](https://www.npmjs.com/package/@zlens/mcp) | MCP tools for certified block search, query, certification, and lineage |
| [`@zlens/dql-lsp`](https://www.npmjs.com/package/@zlens/dql-lsp) | LSP for `.dql` files |
| [`@zlens/openlineage`](https://www.npmjs.com/package/@zlens/openlineage) | OpenLineage project snapshot events |

[GitHub](https://github.com/duckcode-ai-labs/dql) · [Roadmap](https://github.com/duckcode-ai-labs/dql/blob/main/ROADMAP.md) · [Support](https://github.com/duckcode-ai-labs/dql/blob/main/SUPPORT.md)
