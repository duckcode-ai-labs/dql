# Third-party notices

DQL is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)). It
ships the following third-party material under its own licence.

## Fonts

**Inter** 3.019, by The Inter Project Authors (https://github.com/rsms/inter),
licensed under the SIL Open Font License, Version 1.1.

- Source: `packages/dql-ui/src/styles/fonts/` (`inter-latin.woff2`,
  `inter-latin-ext.woff2`, Latin subsets of the upright variable font) with
  the licence text in `OFL.txt` beside them.
- Built app: the licence ships beside the font files as `Inter-OFL.txt`
  (`apps/dql-notebook/dist/assets/`, and in the CLI package under
  `dist/assets/dql-notebook/assets/`). Any app that loads the shared styles can
  do the same with the Vite plugin `@duckcodeailabs/dql-ui/font-licence`.

Code text uses JetBrains Mono only where the computer already has it, else the
system's monospace face; DQL does not ship that font.

## Packages

Every npm package DQL depends on carries its own licence in its package.

## Test fixtures

These fixtures are used only by the test suite. They are not part of any npm
package or built app. Upstream licences were checked on 2026-10-13.

**`apps/cli/test/fixtures/bigrepo-arr`** is a reduced slice of the dbt
manifest of GitLab's `snowflake-dbt` project (`transform/snowflake-dbt` in the
`gitlab-data/analytics` repository, dbt project `gitlab_snowflake`): model
names, descriptions and column lists only, with SQL, tests, macros and data
removed. Upstream licence: MIT, Copyright GitLab B.V. The full upstream
licence text is in
[`UPSTREAM-LICENSE`](apps/cli/test/fixtures/bigrepo-arr/UPSTREAM-LICENSE)
beside the fixture. The upstream project on gitlab.com now requires sign-in;
the licence was read from public copies of the repository on GitHub
(for example `tconbeer/gitlab-analytics-sqlfmt`, `LICENSE.md`).

**`apps/cli/test/fixtures/jaffle-golden`** holds a dbt manifest
(`target/manifest.json`, including model SQL, semantic models and metrics) built
from dbt Labs' [`jaffle-shop`](https://github.com/dbt-labs/jaffle-shop)
project, and a subset of its sample rows (`seeds/seed.json`). That repository
does not publish a licence file (GitHub reports no licence for it). Its sample
data is produced by dbt Labs'
[`jaffle-shop-generator`](https://github.com/dbt-labs/jaffle-shop-generator),
which is Apache-2.0, and its predecessors
[`jaffle-shop-classic`](https://github.com/dbt-labs/jaffle-shop-classic) and
[`jaffle_shop_duckdb`](https://github.com/dbt-labs/jaffle_shop_duckdb) are
Apache-2.0. jaffle_shop and jaffle-shop are dbt Labs' sample projects.

**`apps/cli/test/fixtures/jaffle-semantic`**,
**`apps/cli/test/fixtures/jaffle-supply-chain`** and
**`packages/dql-mcp/src/tools/__tests__/fixtures/jaffle-shop.datalex-manifest.json`**
were written for this repository. They reuse the jaffle-shop table and column
names but no upstream SQL or data, and are covered by the DQL licence.
