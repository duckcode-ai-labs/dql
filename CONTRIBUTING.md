# Contributing to DQL

Thank you for your interest in DQL. Contributions that improve the language, tooling, connectors, or documentation are welcome.

---

## Scope

This repository covers the open DQL layer:

- Language core: lexer, parser, AST, semantic analysis, formatter
- Compiler: IR lowering, HTML/React code generation
- Runtime: browser data fetching and hot-reload
- Connectors: database driver abstraction (DuckDB, Postgres, BigQuery, Snowflake, etc.)
- Governance: certification rules and cost estimation
- LSP: language server for VS Code and compatible editors
- Project: Git-backed block registry and project primitives
- CLI: `dql` commands
- Docs and examples

The local notebook and governed agent workflows shipped by DQL are OSS scope.
Managed multi-tenancy, SSO/RBAC, centralized audit, managed secrets, hosted
approvals, and other commercial control-plane behavior are not.

Before a non-trivial change, read the
[current DQL truth](./docs/contribute/current-dql-truth.md) and follow the
[OSS delivery orchestration playbook](./docs/contribute/delivery-orchestration.md).

---

## Development Setup

Requires Node.js 20 or newer (CI tests 20, 22, and 24) and pnpm 9.

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
pnpm test
```

The repo uses [Turborepo](https://turbo.build/) for incremental builds. After the first full build, `pnpm build` only rebuilds changed packages.

Build through `pnpm build` (or each package's own `build` script, in dependency
order), not with `npx tsc -b` in `apps/cli` alone: TypeScript's project
references there do not build the UI packages (`@duckcodeailabs/dql-ui`,
`@duckcodeailabs/dql-charts`), so the notebook build then fails with
`TS2307: Cannot find module '@duckcodeailabs/dql-ui'`. To build only what the
CLI and the notebook need, dependencies first:

```bash
pnpm -r --filter "@duckcodeailabs/dql-cli..." --filter "@duckcodeailabs/dql-notebook-app..." run build
```

### Checks for hosted servers and the single-user product

`scripts/hardening-checks/` holds three helpers for checking a change to the
hosted (RFC 0010) paths against the single-user product. Nothing in `pnpm test`
runs them.

- `standalone-diff.mjs --baseline <checkout> --candidate <checkout> --out <dir>`
  starts `dql notebook` from two built checkouts on two copies of one scratch
  project, sends both the same requests (notebook, Ask, Apps, Block Studio, git,
  connectors, export, MCP) and lists every step whose answer differs.
  `HOST_CHECK_NETWORK_LOG=1` records what each server tries to reach off this
  machine; `HOST_CHECK_PG_NODE_MODULES` (a `node_modules` holding `pg`) adds a
  throwaway PostgreSQL connection.
- `run-oss-suites.sh <checkout> <dir>` runs the packages' suites one after
  another, the CLI suite with its network record and with its sockets sampled
  (`sample-sockets.sh`).

`pnpm --filter @duckcodeailabs/dql-cli test:offline` runs the CLI suite and fails
on any lookup or connection off this machine. Set `HOST_CHECK_EVIDENCE_DIR` to
keep the records the host-hook fault, concurrency and model-boundary tests
write.

### Running a single package

```bash
pnpm --filter @duckcodeailabs/dql-core build
pnpm --filter @duckcodeailabs/dql-core test
```

### Running the notebook dev server

```bash
pnpm --filter @duckcodeailabs/dql-notebook-app dev   # Vite dev server for the UI
pnpm --filter @duckcodeailabs/dql-cli build
node apps/cli/dist/index.js notebook                  # built CLI server, default port 3474
```

Vite alone does not count as UI verification: check UI changes against the
built `dql notebook` CLI (see [AGENTS.md](./AGENTS.md)).

---

## Project Structure

```
apps/
  cli/                   dql CLI entry point and local notebook server
  dql-notebook/          React notebook UI (Vite)
  notebook-browser/      Browser notebook build
  desktop/               Tauri desktop shell
  vscode-extension/      VS Code extension package
packages/
  dql-core/              Lexer, parser, AST, semantic layer, formatter
  dql-compiler/          IR lowering and code generation
  dql-runtime/           Browser runtime
  dql-connectors/        Database driver layer
  dql-governance/        Certification and cost rules
  dql-lsp/               Language server
  datalex-lsp/           DataLex language server
  dql-project/           Git-backed registry
  dql-notebook/          Notebook document model and execution helpers
  dql-charts/            React SVG chart components
  dql-ui/                Shared UI components and theme tokens
  dql-agent/             Ask and agent runtime
  dql-mcp/               MCP server
  dql-slack/             Slack bot
  dql-openlineage/       OpenLineage emitter
  dql-plugin-api/        Plugin API types
  dql-telemetry/         Deprecated, unused
  create-dql-app/        `npx create-dql-app` scaffolder
docs/                    All documentation
```

---

## Pull Requests

- Keep changes focused on the public DQL surface.
- Verify current repository state before relying on issues, memory, or roadmap snapshots.
- Add or update tests when behavior changes.
- Update docs or examples when syntax or CLI workflow changes.
- Run `pnpm build && pnpm test` before opening a PR.
- Fill out the PR template completely — especially the "Release Impact" section.

### Commit style

Use conventional commit prefixes:

- `feat:` — new feature or behavior
- `fix:` — bug fix
- `docs:` — documentation only
- `chore:` — build, release, or maintenance

---

## Good First Issues

Look for issues tagged [`good first issue`](https://github.com/duckcode-ai/dql/issues?q=label%3A%22good+first+issue%22) on GitHub. These are scoped tasks with clear acceptance criteria.

Common contribution areas:

- Adding a new database connector driver in `packages/dql-connectors/`
- Improving error messages from the parser (`packages/dql-core/src/parser/`)
- Extending test coverage for edge cases in governance rules
- Adding examples or improving existing documentation

---

## Versioning

DQL follows [Semantic Versioning](https://semver.org/):

- **Patch** (`1.x.Y`): bug fixes, documentation, internal improvements
- **Minor** (`1.X.0`): new features, new commands, new language constructs (backwards-compatible)
- **Major** (`X.0.0`): breaking changes to the language syntax, CLI flags, or public package APIs

The `1.x` packages are released together on the same version. `datalex-lsp`
versions on its own (currently `0.2.0`).

---

## Release Readiness

Before treating a change as OSS-ready, review the launch checklist:

- [`docs/oss-readiness-checklist.md`](./docs/oss-readiness-checklist.md)
- [`docs/contribute/releasing.md`](./docs/contribute/releasing.md)

## Shared design contract (Governed Analytics Cloud embed)

DQL is embedded by the Governed Analytics Cloud, which reskins it to the global
theme. A small set of names is a **shared contract** the cloud depends on — don't
rename them without coordinating: the `data-theme` values
(`paper`/`white`/`obsidian`), the `--bg-*`/`--text-*`/`--accent*`/`--border-*`
vars, and the `dql-theme` storage key (with its cross-tab `storage` listener). The
cloud's build runs a contract check that fails on a break. See [`AGENTS.md`](AGENTS.md)
for the full list and the canonical source (`@duckcodeai/design-tokens`).
