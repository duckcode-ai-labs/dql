# DQL Documentation

Everything needed to use, extend, and contribute to DQL. Plain markdown —
reads on github.com, in your editor, or in a terminal.

## New here? Read in order

1. [Quickstart](./01-quickstart.md) — add DQL to a dbt repo (yours, or the
   [example repo](https://github.com/duckcode-ai/jaffle-shop-duckdb))
2. [DQL in 5 concepts](./04-dql-in-5-concepts.md) — Block, Certified Block, App, Manifest, Lineage
3. [Tutorials](./tutorials/README.md) — blocks → dashboards & Apps → agent → CI
4. [Concepts](./02-concepts.md) — the broader mental model
5. [Install](./03-install.md) — npm and Docker paths

## Guides

Task-oriented walkthroughs.

- [Connect your warehouse](./guides/connect-warehouse.md)
- [Import a dbt project](./guides/import-dbt.md)
- [Block Studio dbt-first workflow](./guides/block-studio.md)
- [Author a certified block](./guides/authoring-blocks.md)
- [Build a dashboard](./guides/dashboards.md)
- [Connect an AI agent (MCP)](./guides/mcp.md) — Claude Code, Claude Desktop, Cursor, Codex
- [Versioning & git workflow](./guides/versioning.md)
- [Migrate from Looker / Metabase](./guides/migrate.md)
- [Troubleshooting](./guides/troubleshooting.md)
- [FAQ](./guides/faq.md)

## Reference

Look-it-up material.

- [CLI command reference](./reference/cli.md) — local/global invocation, all commands, flags, and exit codes
- [Language](./reference/language.md)
- [Connectors](./reference/connectors.md)
- [Semantic layer](./reference/semantic-layer.md)
- [File formats](./reference/file-formats.md)
- [Project layout](./reference/project-layout.md)
- [Compatibility](./reference/compatibility.md)

## Architecture

How DQL is built.

- [Overview](./architecture/overview.md)
- [dbt integration](./architecture/dbt-integration.md)
- [Lineage model](./architecture/lineage-model.md)
- [Plugin API](./architecture/plugin-api.md)
- [OpenLineage](./architecture/openlineage.md)

## Contributing

- [Current DQL truth](./contribute/current-dql-truth.md)
- [OSS delivery orchestration](./contribute/delivery-orchestration.md)
- [Repo layout](./contribute/repo-layout.md)
- [Testing](./contribute/testing.md)
- [Releasing](./contribute/releasing.md)
- [OSS readiness checklist](./oss-readiness-checklist.md)

---

Bug or feature request? [Open an issue](https://github.com/duckcode-ai-labs/dql/issues).
