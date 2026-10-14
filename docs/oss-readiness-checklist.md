# OSS Readiness Checklist

This checklist tracks what DQL needs in order to feel complete, trustworthy, and easy to adopt as an open-source project.

It is written as a practical maintainer checklist, not a marketing document.

## Status Key

- `[x]` done or mostly in place
- `[ ]` still missing or blocked
- `[~]` partially complete and needs polish

---

## 1. Install and First Run

- `[x]` source-based install path is documented
- `[x]` local-first quickstart exists
- `[x]` starter project can be scaffolded with `dql init`
- `[ ]` starter project includes local sample data (it does not: the starter has a
  welcome notebook and config only; try the sample dbt project in the README)
- `[x]` users can create new assets with `dql new block`
- `[x]` users can create dashboards and workbooks with `dql new dashboard` and `dql new workbook`
- `[x]` users can create semantic scaffolds with `dql new semantic-block`
- `[x]` published npm install path validated in a network-enabled environment
- `[x]` `npx @duckcodeailabs/dql-cli --help` validated against the published latest package

---

## 2. Local Experimentation Loop

- `[x]` `dql doctor` exists for local setup checks
- `[x]` `dql preview` exists for browser preview
- `[x]` `dql build` exists for static bundle generation
- `[x]` `dql serve` exists for local serving of built output
- `[x]` local CSV/file-first flow is documented
- `[x]` DuckDB local example exists
- `[~]` preview/serve browser smoke — re-run against the starter template and
  the jaffle-shop-duckdb flow after the examples restructure

---

## 3. Documentation

- `[x]` root README explains the project clearly
- `[x]` README has CI, npm, license, and Node badges
- `[x]` README has Community and Support section
- `[x]` README has Contributing link
- `[x]` README lists four semantic layer providers (including Snowflake)
- `[x]` quickstart guide exists
- `[x]` getting-started guide exists
- `[x]` FAQ exists
- `[x]` compatibility matrix exists
- `[x]` migration guides exist
- `[x]` examples guide exists
- `[x]` package-level READMEs exist
- `[x]` `why-dql.md` exists for positioning and differentiation
- `[x]` authoring-blocks.md shows real `@metric()`/`@dim()` patterns (no `@import`)
- `[x]` dbt-first Block Studio guide explains SQL blocks, semantic blocks, import, certification, and lineage
- `[x]` project layout docs reflect Apps as View/Build with dashboard pages, notebooks, AI pins, and drafts
- `[x]` docs were re-verified after full build/test and package smoke checks

---

## 3a. dbt-First Block Studio

- `[x]` left navigation focuses on Blocks / Block Studio; Import SQL is a top action, not a separate main surface
- `[x]` compatibility redirect opens Block Studio with the import wizard for older `imports` routes
- `[x]` empty Block Studio state shows dbt status and four start paths
- `[x]` SQL Block and Semantic Block creation paths are separate
- `[x]` SQL blocks do not silently mix selected semantic metrics into raw SQL
- `[x]` Semantic Block builder updates metric/dimension/time/chart fields without raw SELECT editing
- `[x]` Import SQL wizard supports paste, file path, folder path, split preview, review, save, and session resume
- `[x]` Tableau and Power BI helpers remain collapsed planned migration helpers
- `[~]` AI Assist is review-gated, but richer patch/diff presentation still needs polish

---

## 3b. Apps OSS UX

- `[x]` Apps use View / Build language instead of Stakeholder / Analyst Studio in the main UI
- `[x]` dashboard tabs are treated as dashboard pages in product docs
- `[x]` App creation starts from empty, notebook, template, or import
- `[x]` notebooks can be attached to Apps and previewed read-only
- `[x]` local AI pins and promoted draft blocks remain private/review-first
- `[~]` dashboard tile drag/resize works, but one final manual desktop/mobile polish pass is still recommended

---

## 4. Examples and Templates

The repo ships **no bundled example projects** (dbt-core style). One starter
template lives in `create-dql-app`; the example dbt project is external.

- `[x]` single `starter` template scaffolds config, welcome notebook, and npm scripts
- `[x]` starter auto-wires a detected sibling/parent dbt project
- `[x]` external example dbt repo exists:
  [jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb)
- `[x]` tutorials work on either the user's dbt repo or the example repo
- `[ ]` add a polished business-facing example repo if community feedback asks for it

---

## 5. CLI Surface

- `[x]` parse, fmt, certify are documented
- `[x]` init, doctor, preview, build, serve are documented
- `[x]` new block/dashboard/workbook/semantic-block are documented
- `[x]` `dql test` deprecated with clear migration path to `dql certify --connection`
- `[x]` `dql certify` runs live test assertions against real data (not just governance metadata)
- `[x]` `--skip-tests` flag available for governance-only checks
- `[x]` `defaultConnection` from config used automatically (no `--connection` required)
- `[~]` `dql migrate` is correctly documented as scaffold-only, but could be improved later with richer source-specific helpers

---

## 6. Packaging and Release

- `[x]` public package manifests are present
- `[x]` `docs/contribute/releasing.md` exists for maintainers
- `[x]` CHANGELOG.md has proper version history
- `[x]` full workspace install validated in a network-enabled environment
- `[x]` full `pnpm build` completes successfully
- `[x]` full `pnpm test` completes successfully
- `[x]` `pnpm release:dry-run -- --tag <latest|next> --expected-version <version>` completes successfully
- `[x]` published package smoke test recorded against npm latest

---

## 7. Contributor Experience

- `[x]` `CONTRIBUTING.md` exists with setup, code style, versioning, and first-issue guidance
- `[x]` `ROADMAP.md` exists with known limitations and planned work
- `[x]` `SECURITY.md` exists with vulnerability reporting process
- `[x]` scope boundaries are documented
- `[x]` open-source/product boundary is documented
- `[x]` GitHub issue templates exist (bug report, feature request, config)
- `[x]` PR template exists with validation checklist

---

## 8. CI / Automation

- `[x]` CI workflow exists (`ci.yml`) — runs build and test on push and PR
- `[x]` CI runs on Node 20 and Node 22 (matrix build)
- `[x]` Release workflow exists (`release.yml`)
- `[x]` `.gitignore` covers `.env`, `.env.*`, `*.log`, `node_modules`, `dist`, `.turbo`

---

## 9. Final Pre-Launch Checks

- `[x]` run `pnpm install` in a network-enabled environment
- `[x]` run `pnpm build`
- `[x]` run `pnpm test`
- `[x]` verify `dql init ./dql` from a clean dbt-style environment
- `[x]` verify `dql preview` from a clean environment
- `[x]` verify `dql new semantic-block` from a clean dbt-style environment
- `[x]` verify package publishing flow and `npx` usage

---

## Current Release Decision

The manifests and starter CLI range read `0.1.0`, the first release under the
ZLens package names. The `@duckcodeailabs/*` packages ended at `1.17.2`;
versions `1.13.5` through `1.17.2` were published by hand and have no git
tags, so no tag-driven release has run since `v1.14.3-rc.1`. Registry, tag,
and exact-version clean-install evidence must be captured before this document
calls `0.1.0` published.

The `1.14.3-rc.1` candidate contained the Ask AI governed-cascade recovery, stable
conversation selection persistence, phase-specific provider diagnostics, and
Research receipts. Its local OSS evidence does not verify the private office
repository, metadata/vector indexes, fiscal calendar, provider configuration,
or warehouse; those require a separate office replay.

Historical `1.13.4` release evidence follows. It does not establish
publication or end-to-end office validation for `1.14.3-rc.1`. The tracked
`PERF-001` scale fixture has no route-parity, concept-resolution,
certified-execution, or invented-ID failures, but several cold-start and
warm-context latency budgets remain above target. RFC 0005 acceptance remains
implementer-validated pending independent verification. The semantic
identity/runtime acceptance set also remains implementer-validated pending
independent verification. The governed semantic path, target-bound execution,
semantic source-integrity, bounded Snowflake runtime, resilient request
handling, and Trust & Steps acceptance set remains implementer-validated
pending an enterprise dbt Cloud and Snowflake replay. Maintainer approval
records these conditions as disclosed `v1.13.4` OSS release exceptions; none is
a GA performance claim.

Validated release gates (re-run the browser smoke after the examples
restructure — bundled examples were removed in favor of the external
jaffle-shop-duckdb repo):

- Clean copy install, build, and test pass.
- `dql notebook` launches the starter template; Block Studio, Import SQL, and
  Apps dashboard/notebook smoke checks pass in the browser.
- `dql preview` works for KPI, line chart, and RLS-decorated block examples.
- `pnpm release:dry-run -- --tag <latest|next> --expected-version <version>` completes successfully.
- The plan-first and analytical-composition suites pass across core, agent, CLI,
  and the built notebook; the remaining independent-verification and
  `PERF-001` latency exceptions are documented in the changelog and roadmap.
- Local `node apps/cli/dist/index.js --help` and
  `node apps/cli/dist/index.js --version` resolve successfully.
- After publishing `1.14.3-rc.1`, verify exact artifacts with
  `npx @duckcodeailabs/dql-cli@1.14.3-rc.1 --version` and
  `npx create-dql-app@1.14.3-rc.1 --help`, then separately verify both npm
  `next` dist-tags point to `1.14.3-rc.1`. `@latest` remains `1.14.2` and is
  not RC evidence.

## Recommended Next Actions

1. Keep the package manifests, starter CLI range, changelog, roadmap, and
   current-truth snapshot synchronized for the next release.
2. Re-run the built-CLI browser smoke against the external
   jaffle-shop-duckdb example after changes to Notebook navigation or database
   execution.
3. Continue closing the disclosed independent-verification and `PERF-001`
   latency gaps without expanding the OSS/commercial boundary.
