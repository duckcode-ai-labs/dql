# DQL Roadmap

DQL OSS is a local-first, single-user analytics-as-code workspace. The near-term
goal is adoption: make it easy for one analyst or analytics engineer to create
certified reusable blocks, package them into Apps, compile a dbt-like manifest,
and inspect lineage from source data to dashboard pages.

For completed changes, see [CHANGELOG.md](./CHANGELOG.md).

## Current State (v1.17.3 in the manifests)

The release manifests and the starter CLI range read `1.17.3`. Versions
`1.13.5` through `1.17.2` were published to npm by hand; the last git tag is
`v1.14.3-rc.1`, and the tag-driven release workflow has not published since.
Check the registry (`npm view @duckcodeailabs/dql-cli dist-tags`) before stating
what is published. See
[docs/contribute/current-dql-truth.md](./docs/contribute/current-dql-truth.md)
for the dated snapshot.

DQL OSS is ready for local-first use cases:

- Author `.dql` blocks with SQL or semantic intent, metadata, chart specs, and
  tests.
- Mark blocks with local trust states: `draft`, `review`, `certified`,
  `deprecated`, or `pending_recertification`.
- Run the notebook locally against DuckDB/file data and supported warehouse
  connectors.
- Use Block Studio to create SQL blocks, semantic blocks, imported SQL drafts,
  and locally certified blocks.
- Run Blocks with results foregrounded, inspect generated SQL on demand, and
  resolve save, validation, test, chart, lineage, and certification blockers
  through one progressive checklist with focused corrective actions.
- Build Apps manually or with a dedicated App AI orchestrator over one
  snapshot-backed, paginated catalog that keeps certified, review, and draft
  executable blocks visible with qualified identities and exact revisions.
- Review an AI App plan with visible planning progress, retain explicitly added
  canonical sources across revision and resume, and add manual draft blocks
  through an explicit one-click local review lane.
- Preview draft/review App sources locally with explicit trust labels while
  keeping Project publication fail-closed until every source is certified,
  current, and bound to its reviewed revision.
- Use the same metric-first governed composer in Notebook and Block Studio:
  insertion is available after compatibility planning, only common approved
  dimensions are selectable, and preview remains an optional execution check.
- Edit Raw SQL blocks visually without losing runtime parameters, parameter
  policies, filter bindings, chart series/color, tests, or unknown DQL
  metadata; remove one exact saved block through a confirmed guarded action.
- Keep semantic, Raw SQL, and DQL-source Block Studio edits synchronized before
  save; organize blocks in Git-backed folders and subfolders, move exact block
  and companion artifacts safely, and delete from the library, detail, or
  toolbar.
- Compile `dql-manifest.json`, the dbt-like project artifact for blocks,
  notebooks, Apps, dashboards, metrics, dimensions, sources, dbt imports, and
  lineage.
- View answer-layer lineage across source tables, dbt models, semantic metrics,
  DQL blocks, dashboard pages, and Apps.
- Adopt on an existing dbt repo as the primary path, with
  [jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb) as
  the example dbt project for users without one.
- Use local agent/MCP/Slack surfaces that prefer certified blocks and label
  fallback generated SQL as uncertified.
- Resolve analytical questions into typed plans that bind semantic measures,
  dimensions, entities, time dimensions, joins, filters, domains, skills, and
  evidence before execution.
- Compose governed metrics with compatible time, customer, comparison, ranking,
  member-filter, and output roles without rebuilding certified meaning.
- Preserve model-scoped dbt semantic identities across import, retrieval,
  compatibility, generated DQL, and execution while showing both business
  labels and exact technical metric/group-by names.
- Preserve every explicitly requested measure through planning, execution,
  result contracts, lossless visualization, and human-readable narration.
- Run Ask AI, Notebook AI, and Block AI through one durable orchestration
  lifecycle with canonical progress, failure diagnostics, history hydration,
  and explicit surface-specific artifact actions.
- Prepare Ask AI and Notebook SQL through one target-bound execution gateway,
  resolve physical source references before execution, isolate failed turns
  from subsequent questions, and offer one bounded same-target repair action
  without mutating the original attempt.
- Keep conversation recaps inside the current AI surface, recognize common
  recap wording and typos without launching another data query, and summarize
  the latest substantive analytical turn instead of recursively summarizing a
  previous recap.
- Browse Blocks, Notebooks, and the Domain workspace across all Domain Packages
  or a selected domain, with one consistent domain selector and direct routing
  to the selected source artifact.
- Continue active AI runs across navigation, restore DQL, compiled SQL,
  lineage, trust evidence, steps, and safe repair guidance after reload, and
  fail closed when all requested metrics cannot share one governed execution
  path.
- Delete local Ask sessions durably from the persisted conversation store and
  prevent overlapping stale history responses from restoring deleted threads.
- Add generated DQL to a notebook or replace the selected cell only after an
  explicit user action; save ownerless Block AI proposals as Git-backed draft
  artifacts and open them directly in Block Studio's visual builder.
- Validate generated SQL identifiers inside their actual `SELECT` and CTE
  scopes, fail closed on ambiguous ownership, and hand DQL or SQL inspector
  scripts into focused editable notebook cells.
- Lock semantic execution to one tested dbt Cloud, local MetricFlow, or native
  adapter per request without silently changing engines after a failure.
- Bind the semantic compiler target to the active warehouse account, database,
  schema, role, and warehouse before compilation; preflight and execute through
  the same bounded connector lease.
- Treat Snowflake account locators and preferred `organization-account_name`
  identifiers as bounded aliases for the same account while continuing to
  block genuine account, database, schema, role, and warehouse drift.
- Capture the complete paginated dbt Cloud metric inventory only during
  explicit Test & Apply, bind its fingerprint separately from the local dbt
  snapshot, and fail closed with `SEMANTIC_SOURCE_DRIFT` when the configured
  environment cannot resolve a selected metric.
- Preserve failing physical identifiers, bounded SQL context, target proof, and
  safe reapply actions in Trust & Steps while keeping the local Notebook server
  alive after rejected semantic runtime requests.
- Scope the semantic composer to exact model-owned, runtime-compatible
  dimensions and use the same compatibility evidence for agent planning.
- Isolate notebook execution by stable cell and run identity, keep independent
  Run-all branches moving after a failure, and retain DQL, SQL, target, receipt,
  and structured failure proof inside each cell's Trust & Steps inspector.
- Search the physical warehouse catalog only through question-scoped,
  paginated discovery when governed dbt context is insufficient, instead of
  eagerly loading every table and column.
- Stream and cap Snowflake results while retaining vendor error code, SQL
  state, query ID, line, position, cancellation, and truncation evidence.
- Resolve repeated MetricFlow dimensions through an explicit governed entity
  path, keep the DQL authoring identity stable, and expose the runtime-qualified
  member used by the selected adapter.
- Inspect Plan, DQL, Compiled SQL, Lineage, Trust & evidence, Actual steps, and
  Failure & repair, including safe same-plan repair actions for failed runs.
- Use local hybrid retrieval across exact matches, BM25/lexical text,
  embeddings, graph relationships, and bounded dbt repository text without
  requiring an external vector database.
- Route root-cause and deep-research questions through governed relational SQL
  when certified metrics do not cover the requested analysis, with explicit
  uncertified status, source receipts, and policy validation.
- Require existing OSS projects to preview and reapply dbt context after an npm
  CLI upgrade so their immutable snapshot matches the running DQL version.
- Keep one explicit warehouse connection bound across Ask metadata retrieval,
  semantic compilation, generated/certified execution, and bounded validation,
  with the selected target visible in the Ask composer.
- Preserve dbt physical relation quoting and Snowflake's default identifier
  case-folding, and recover one read-only query from a terminated pooled session
  without replaying writes or multi-statement SQL.
- Reuse valid fingerprinted metadata catalogs at startup, lazy-load large
  Notebook routes, and cache fingerprinted static assets without caching the
  HTML shell.
- Capture successful AI-query corrections as reviewable reusable lessons with
  explicit domain, metric, model, term, block, and dialect scope while keeping
  comments as provenance and approval separate from certification.
- Keep internal Hint Graph relation identities out of executable SQL, resolve
  them only through inspected physical relations, and offer focused
  review-required repair for both SQL and DQL Notebook cells.
- Repair eligible failed SQL and SQL-backed DQL Notebook cells through one quiet
  same-target `Fix and retry` action without sending repair context into
  Notebook AI; keep unsafe or user-action failures explicit.
- Use only first-class, human-authored Domain workspace declarations in
  Notebook, Block Studio, Models, Skills, Apps, and their filters while keeping
  metric and dimension catalog folders separate.
- Browse only physical models and sources from the connected dbt manifest in
  the Database panel, with 25-object pages, server-side search, and columns
  loaded only on expansion; keep this display scope separate from agent
  metadata retrieval.

## OSS Boundaries

The OSS release is intentionally local and single-user:

- Certification is a local trust label, not an organization-wide approval
  workflow.
- Local personas, access policies, and RLS bindings are preview tools for
  testing consumption experiences, not hosted identity or enterprise RBAC.
- Secrets, auth, SSO, audit logs, multi-tenant hosting, managed approvals, and
  permissions-aware team retrieval are outside OSS.

## Known Limitations

- Block Studio metadata editing still has some regex-backed paths. Canonical
  file parsing, formatting, and compilation use the DQL parser/AST, but richer
  round-trip AST editing is still planned.
- `dql migrate` is scaffold-first. SQL import is active; Tableau and Power BI
  helpers remain planned migration helpers.
- Snowflake connector reads are streamed and capped before notebook rendering,
  but other connectors still need equivalent driver-level streaming and the UI
  does not yet expose interactive continuation pagination.
- Snowflake semantic views require a live Snowflake connection at notebook
  startup; offline cache and clearer unavailable-state messaging are planned.
- dbt semantic model discovery reads local project artifacts/files. Optional
  dbt Cloud Semantic Layer execution requires a tested environment ID, regional
  endpoint, and service token; DQL does not manage dbt Cloud projects or jobs.
- The notebook browser happy path needs a hard-gated Playwright suite before the
  project should be called GA.
- The `PERF-001` enterprise-scale correctness fixture passes, but several
  cold-start and warm-context latency budgets remain above target. The v1.12.11
  release treats this as a disclosed OSS exception, not a GA performance claim.

## Next Priorities

- First-run polish: keep `create-dql-app`, `dql doctor`, Block Studio, compile,
  certify, and lineage flows aligned around the 10-minute dbt-repo path.
- Documentation accuracy: keep every code sample parser-valid and keep release,
  testing, and OSS boundary docs in sync with CI.
- Browser E2E: add a required notebook/Block Studio/lineage happy-path test for
  public GA confidence.
- Better DQL authoring: complete AST round-trip metadata editing and improve LSP
  completions/diagnostics for block metadata, `@metric()`, and `@dim()` refs.
- Lineage depth: continue improving column-level lineage and dbt/OpenLineage
  interop.
- Local scale: add pagination/streaming for large result sets and keep the
  manifest stress gate healthy; bring every `PERF-001` latency measurement
  within its release budget.

## Not Planned for OSS

- Hosted cloud notebook or multi-tenant deployment
- Real authentication, OIDC, SSO, or password storage
- Managed secrets
- Organization RBAC enforcement
- Centralized audit logs
- Managed approval workflows

Have a feature request or found a bug? Open a GitHub issue or start a
Discussion in the public repo.
