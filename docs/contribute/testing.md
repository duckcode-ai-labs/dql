# Testing

Run the same gates maintainers use for an OSS release candidate:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
node scripts/check-doc-links.mjs
pnpm release:dry-run -- --tag latest --expected-version 0.2.0
```

## Unit and Package Tests

`pnpm test` runs the workspace package tests through Turbo. Coverage is focused
on the surfaces that make ZLens adoptable:

- parser, formatter, semantic analysis, manifest, and lineage in `dql-core`
- compiler/chart lowering in `dql-compiler`
- certification and governance rules in `dql-governance`
- project storage, manifest cache, persona preview, MCP tools, local agent, and
  Slack formatting
- CLI commands and local runtime helpers
- `create-zlens-app` scaffold smoke checks

## Template Adoption Checks

The test suite verifies adoption-critical templates:

- generated projects use the current `zlens` version
- generated scripts avoid deprecated `zlens test`
- template and fixture `.dql` files use canonical syntax
- the `apps/cli/test/fixtures/lineage-app` fixture compiles
  source-table -> block -> dashboard -> App lineage
- a fixture certified block passes the local certifier with passing test results

## Docs and Release Checks

`node scripts/check-doc-links.mjs` validates relative markdown links under
`docs/`.

`pnpm release:dry-run -- --tag latest --expected-version 0.2.0` builds, tests,
and packs every publishable package into `.release-artifacts/` without
publishing. Use `--tag next --expected-version 0.2.0-rc.1` for a prerelease
candidate; the script rejects an incompatible version/tag pair or manifest
version before it builds or packs. Calling the script directly needs the same
flags (`node scripts/release-packages.mjs --dry-run --tag latest
--expected-version <version>`); it rebuilds the workspace before packing.

## Stress Test

The synthetic dbt stress scripts are available for scale checks:

```bash
node scripts/bench/gen-dbt-project.mjs --models 4000 --out /tmp/stress
ZLENS_CLI="node $PWD/apps/cli/dist/index.js" node scripts/bench/run-bench.mjs /tmp/stress
```

CI runs this on pushes to `main`, not on every PR.

## Browser E2E

A hard-gated Playwright happy path for notebook, Block Studio, certification,
compile, and lineage is still a GA hardening item. Until it lands, public
release language should say “release candidate” or “public beta,” not imply
browser E2E coverage blocks merges.

## CI

Required PR gates are build/test, scaffold smoke, docs link check, and DQL
format check. Optional or future-hardening jobs must not be described as
required until they are part of the `ci-ok` dependency chain.
