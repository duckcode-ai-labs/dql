# ZLens Documentation

Everything needed to use, extend, and contribute to ZLens. Plain markdown —
reads on github.com, in your editor, or in a terminal.

## New here? Read in order

1. [Quickstart](./01-quickstart.md) — add ZLens to a dbt repo (yours, or the
   [example repo](https://github.com/duckcode-ai/jaffle-shop-duckdb))
2. [ZLens in 5 concepts](./04-dql-in-5-concepts.md) — Block, Certified Block, App, Manifest, Lineage
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

How ZLens is built.

- [Overview](./architecture/overview.md)
- [dbt integration](./architecture/dbt-integration.md)
- [Lineage model](./architecture/lineage-model.md)
- [Plugin API](./architecture/plugin-api.md)
- [OpenLineage](./architecture/openlineage.md)

## Contributing

- [Current ZLens truth](./contribute/current-dql-truth.md)
- [OSS delivery orchestration](./contribute/delivery-orchestration.md)
- [Repo layout](./contribute/repo-layout.md)
- [Testing](./contribute/testing.md)
- [Releasing](./contribute/releasing.md)
- [OSS readiness checklist](./oss-readiness-checklist.md)

The product was called DQL before it was renamed ZLens; DQL is now the name of
its query language. Design records written before the rename (the
[RFCs](./rfcs/), the [domain-context specs](./specs/dql-2-domain-context/),
[performance plans](./performance/), the current-truth snapshot and the
readiness checklist) still use "DQL" for the product and the old package and
command names.

---

Bug or feature request? [Open an issue](https://github.com/duckcode-ai-labs/zlens/issues).
