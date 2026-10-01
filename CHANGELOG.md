# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## Unreleased

### Retired blocks name their replacement (`replacedBy`, `deprecatedOn`)

- A deprecated block can declare `replacedBy = "<block>"` (name or `.dql`
  path) and `deprecatedOn = "YYYY-MM-DD"`. The parser, formatter, manifest
  and lineage carry both.
- Checks (`kind: 'retirement'` manifest diagnostics, shown by `dql validate`
  and `dql compile`): a replacement that is not a block or that loops is an
  error; a replacement that is itself deprecated, the fields on a block that
  is not deprecated, and blocks or App pages still using a deprecated block
  are warnings.
- Block Studio and the block library show **Replaced by `<name>`** with a link,
  and a retired block offers **Open the replacement**.
- Ask never answers from a deprecated block. A question naming one is
  answered from its replacement when that fits, under the replacement's own
  trust, and **How it answered** says "`<old>` was retired on `<date>`; answered
  from `<new>`".
- App Studio shows "Retired — replaced by `<new>`" on tiles bound to a retired
  block; the publish check names the replacement. Readers see the tile's
  normal trust state.
- Lineage adds a dashed `replaced_by` edge from the old block to the new
  one. Impact and path walks do not follow it.

### Where a result goes; downloads made on the server; your own connections (RFC 0010 HH-17)

- Every statement a request runs tells a host's `rowPolicy` where its
  result goes (`destination`: `person`, `model`, `delivery` or `export`) and
  the request's route action, so a host can treat a question, a scheduled
  delivery and a file differently.
- **Downloads made on the server**: `POST /api/query/export` and
  `POST /api/apps/:app/dashboards/:page/export` run a statement or one tile
  again for a CSV, JSON or Excel file, under the host's export rules. With a
  host, the app's download buttons use them; without one nothing changes.
  CSV cells a spreadsheet would read as a formula are prefixed with `'`.
- **`sensitiveQuestions: 'columns'`**: a host that refuses personal data by
  column replaces Ask's wording check for payment, health, contact and
  protected attributes (identifiers and one person's pay stay refused by
  wording). A row policy's refusal ends an answer with its reason.
- **Your own connections**: `.dql/local/private/connections.json` (outside
  git) adds or replaces connections for you alone and can set your default
  connection — for example a development copy of the warehouse.

### A Home that summarises, following pages, and who an App is for (RFC 0010 HH-16)

- **Home**, above Ask on a new chat: **My Apps** (followed first, then
  recently opened) and **What moved** on the pages you follow or opened —
  your own figures from your own last two runs (certified or governed
  single figures only; per person, never cached across people). A host can
  add cards such as **Open requests** (`homeCards`).
- **Follow** an App page. Without a host it is your own state in
  `.dql/local/private/home/`; a host's `follows` hook keeps it and tells you
  about each new edition — a scheduled run whose figures changed
  (`pageEdition`, which carries no figure).
- **Ask about this App**: one question box per App, scoped to the App, its
  domain and the filters on screen, through the governed Ask loop.
- **App audience groups**: `audienceGroups` in `dql.app.json`, edited in App
  settings (from a host's `directoryGroups`, or typed). With a host that
  signs people in, only those groups, the owners, granted people and authors
  open the App.
- Story editions are kept per person when a host signs people in (they held
  one person's values).
- Team documents: definition and conversation replies about a governed term
  cite them under the same contract; Research says **Team documents not
  read** when pages are held back from an off-machine model.

### Ask analyst: one plan, five tools

- The model-facing tool surface is five tools: `describe_relation`,
  `search_values`, `propose_plan`, `request_clarification`, `finish_answer`.
  `propose_plan` is the one build contract — measures, dimensions, filters,
  time, ordering, a row bound — whose ids may name a certified block, a
  semantic metric, or a `<relation>.<column>`. The HOST resolves the tier
  (certified, then semantic, then a composed single-relation governed
  program; `sql {text, reads}` is the review-required last resort) and
  assigns trust; the model can no longer pick a trust label by picking a
  tool. `describe_relation` on a metric id describes the metric.
- The tier handlers (`run_certified`, `compile_and_run_semantic`,
  `compile_and_run_dql`, `validate_and_run_sql`, `describe_metric`, the
  `inspect_*` inspectors) stay in the dispatch table as hidden aliases of the
  advertised tool: still kernel-gated, still observed under their own names
  in the receipt, callable by the host floor, host-first and older
  transcripts, never declared to a model. Tool definitions gained
  `hidden`/`aliasOf`; the loops admit an alias exactly when its advertised
  tool is admitted.
- Inspections are host work: the certified, semantic and relational cards
  were already prefilled; a definition/business turn now also gets its
  business-context cards, and a follow-up its trusted prior-result bindings,
  before the first dispatch. A kernel that still wants an inspection
  recorded before an execution gets it from the plan dispatcher.
- A post-execution prose reply is the narration. Every transport used to
  discard a model that wrote the answer text without the `finish_answer`
  envelope and spend another send asking for the same words. The
  narration-phase prose now goes to the host's own finish control (the
  route, trust and facts were always host-composed); a turn that never
  executed is never adopted.
- Native multi-model semantic joins are proven. The composer's fanout probe
  runs BEFORE the governed query in the V2 lane: a join that multiplies base
  rows is a typed block (`SEMANTIC_FANOUT_DUPLICATE_KEY`, nothing shown); a
  probe that cannot be evaluated leaves the answer review-required.
- The deterministic display-key clarification is back, host-side: "the top
  names by revenue" over a metric whose capability contract declares several
  rank entities is asked, not guessed, before any dispatch; each option
  carries the authored dimension id and the question to resubmit.
- A semantic compile failure says what the compiler said. "MetricFlow could
  not group average_order_value by 'location_name' … valid options include
  location__location_name" replaces "the query did not complete on the
  current connection"; the failure's origin is validation (nothing reached
  the warehouse), so the host floor may still walk the lower tiers, and a
  plan proposed after a frozen plan failed counts as the one admitted
  same-plan repair without the model having to know the flag.
- An admitted relation card proves its own execution closure when the
  context pack's allowed-SQL list happens not to carry it.
- Every transport hides the tier handlers. The Claude Code SDK and native
  SDK loops declared every tool to the model, hidden ones included; a model
  then called `run_certified` by name until its budget died. Hidden names
  are also rewritten out of every string a tool returns and out of the
  opening cards, and a refused hidden certified call is answered with the
  plan-level guidance instead of a fifth identical denial.
- Contextual prefill is host evidence. Routing the host's own prior-result
  and business-context prefill through the analyst's tool gate had the
  kernel refuse it, and the follow-up lost the one fact it needed: which
  column the prior-result member came from. It is now recorded directly,
  and the bound member is carried into a prior-result plan as a filter on
  its own dimension.
- A bound member keeps its column. A filter that put a prior-result value
  on another dimension (`customer_type = 'Ryan Byrd'`) passed the literal
  proof and shipped a governed null; it is refused before compilation.
- A plan never broadens a qualified question silently. A plan whose
  measures, dimensions and filter values bind none of the question's
  qualifying terms still runs when the analyst bound the term by judgment
  (`beverage` → `drink_revenue`), but the answer is review-required and says
  which admitted cards carry the term; the host has no synonym authority to
  refuse it.
- A certified block's authored scope counts. `top_beverage_customers`
  (tags beverage/customer, output `beverage_revenue`, `WHERE is_drink_item`)
  is now complete for "top customers by beverage": a term the parser read as
  a grouping is satisfied by an output NAME that declares it, the column's
  structural words (`item`) are not scope, and a question that entails one
  of the block's non-structural tags has asked for the scope its WHERE
  clause implements. The verbatim-example rule still governs filters.
- A plan's `orderBy` that names none of the selected fields ("revenue" for
  `drink_revenue`) resolves to the selected field it names, else to the
  measure, instead of freezing an unrunnable plan.
- A frozen plan that failed ends the turn. After a frozen semantic plan's
  compilation failed, every different plan was correctly refused as a
  post-freeze mutation — and the analyst kept proposing anyway: four
  denials, seventeen tool calls and forty-two seconds to reach a refusal
  the first denial already knew. The first denial still teaches (the one
  permitted same-plan repair is unaffected); a second closes the turn with
  the execution failure that actually happened.
- A ranking of entities is labelled, not keyed. A plan that groups by an
  entity key when the snapshot admits a label for the same entity is
  rewritten to the label, so "top customers" cannot answer with opaque
  identifiers. The key is kept when the question asks for the identifier
  itself, and never replaced by a label the snapshot did not admit.
- The never-broaden rule covers follow-up turns, not only first questions.
- An Ask turn is executed once, and its answer is never replaced by a
  second, worse one. The engine's repair loop did not recognise a V2 Ask as
  frozen, so a failing evaluation ran the executor again; the second pass
  opened a fresh lane over a state that had already finished, and a result
  the first pass had validated and preserved was replaced by that pass's
  budget refusal. Live, a governed relational query returned rows and the
  run reported "DQL stopped at its own orchestration budget" with zero
  facts. The engine now treats an authoritative V2 decision as frozen, and
  the lane memoizes its answer per turn state so any other re-entry returns
  what the turn already proved.
- An unadmitted `expectedOutputIds` refusal names which identifier failed
  and offers real `<relation>.<column>` examples. It used to answer "not
  admitted" with a list of card ids while asking for column ids, so the
  model guessed again and the same refusal repeated until the budget died.
- A prior-result member filter binds the member's dimension, never the
  member-value card the host minted for it.
- A physical relation whose catalog name already carries a quoted segment
  (Snowflake's `"ANALYTICS_PROD".schema.table`) is quoted once per segment.
  Wrapping the quoted segment again produced a triple-quoted identifier that
  ended the composed block's own triple-quoted query, so the parser refused
  every governed relational program on the enterprise warehouse.

### The V1 answer loop is gone

- `answer()` and the V1 execution body of `answer-loop.ts` (≈9,900 lines)
  are deleted, with the V1-only tests. The file is now the answer CONTRACT
  (the `AgentAnswer` / `AnswerLoopInput` types) plus the small helper
  library the V2 host still uses; `cascade/packer.ts` went with it. Public
  export of `answer` is removed.
- `dql agent ask` and `dql agent eval` drive the running runtime over HTTP
  (`POST /api/agent-runs`), exactly as the notebook and the MCP server do;
  the eval's in-process `--via loop` driver is removed. The Slack bot proxies
  to the runtime at `DQL_RUNTIME_URL` (default `http://127.0.0.1:3474`).

### Persisted runs: each artifact payload once, each receipt once

- The SQLite run store is content-addressed: every artifact payload is
  stored once under the fingerprint of its canonical JSON
  (`agent_run_artifacts`), the run row keeps `{ id, kind, title,
  trustState, ref, payloadRef }`, a ref table ties blobs to the runs that
  cite them, and retention prunes orphans. Two runs with the same payload
  share one blob; `get` hydrates `payload` back so every reader sees the
  artifact as written; `list` returns index rows with `payloadRef` only.
  Rows written before this are externalized in batches as the store opens.
- Diagnostic receipts live on the run root only. The engine no longer
  stamps the eight receipt copies into the answer artifact's payload and
  the runtime no longer re-stamps them after dispatch accounting; the
  transport projection presents the root receipts on the answer artifact
  for readers that expect them there, as a view.
- `diagnosticReceiptV7` (the "concise inspector") is removed: nothing
  produced it. V1–V6 and V8 remain; unifying them into one receipt type is
  deliberately out of scope (V5/V6 are still produced by restart recovery
  and Research roots; V8 is the V2 kernel receipt).

### The hybrid router is gone

- `createHybridRouter` (`router.ts`, 7,255 lines) is deleted with its
  tests. It was unreachable: the engine routes every forced non-Ask mode
  (sql, block, app, modeling, skill) deterministically without consulting
  a router, and every Ask request (`auto`, `ask`, `research`) is the V2
  runtime's. The V2 runtime no longer takes a `legacyRouter`; a non-Ask
  request reaching it is reported as a wiring fault. Public exports
  `createHybridRouter`, `compileAskAnalyticalProgramV1`,
  `bindAskAnalystProgramMeaningV1`, `buildMeaningSystemPrompt`,
  `buildMeaningUserPrompt`, `parseMeaningResolution` and the router types
  are removed.

### Ask runtime: one runtime, and a floor under it

- `authoritative_v2` is now the default Ask runtime. `shadow_v2` — which built
  V2's decision for every question and then discarded it in favour of V1 —
  is removed, along with `dql agent shadow-report`. A project config or
  `--ask-runtime-mode` naming `shadow_v2` now fails loudly.
- The V1 analyst runtime (`createAskAnalystRuntimeV1`) and the `legacy_v1`
  rollback mode are deleted. `authoritative_v2` is the only Ask runtime;
  non-Ask modes (sql, block, app, modeling, skill) keep the hybrid router.
  Public exports of the V1 runtime are removed (minor version bump).
  Still present, deliberately: `answer()` in `answer-loop.ts` (the MCP
  `query-via-metadata` / `query-via-block` tools run through it), the Ask
  branches of `router.ts` (reachable only for non-Ask modes), and the V1–V4
  diagnostic receipts on persisted runs. Those go with the MCP tools' move to
  the V2 lane and the receipt collapse in a later release.
- The host floor: when the analyst's turn ends with nothing executed (a spent
  budget, a provider fault, a plan that would not compile, an analyst that
  declined to act), the host walks the tier ladder itself — the proven
  certified block, the exactly-bound semantic metric, a single-relation
  program composed from the question over admitted columns (labelled
  review-required), or a refusal that names the measures that exist. It never
  answers a narrower question more broadly and never replaces a plan that
  reached the warehouse.
- Deleted the gates that only ever spent dispatches: inspection-order
  requirements before execution, the refusal of a repeated parameterless
  inspector, the kernel's dead dispatch/duration budgets, the provider
  wrapper's hardcoded dispatch cap and the silent per-provider default of two
  sends. The run-scoped dispatch ledger is the one dispatch authority.
- Persisted runs keep each artifact payload once; the server no longer grows
  ~4 MB per question.
- Under a native tool loop (Claude OAuth, OpenAI) every Ask tool result —
  even `{ finished: true }` — was reported to the model as a blocked row
  payload by the egress guard, so the model never saw its finish and spent
  the whole budget re-calling it (nine or ten dispatches for a one-metric
  question). The lane now marks its tool outputs as host vocabulary; the
  guard keeps its strict reading of unmarked payloads. Live: "beverage
  revenue" went from 9 dispatches to 2.
- A composed relational program names the warehouse's physical relation
  (`"dev"."customers"`, quoted per segment), a refusal repeated twice steers
  the analyst to the next tier, and a semantic tier with no executable
  metric is no longer advertised as available.
- The run index reads only the requested page; stored runs written before
  slimming are slimmed in place a few at a time (a 1.2 GB history no longer
  crashes the server when the notebook lists runs).
- A project with no AI provider configured still gets its certified blocks,
  its exactly-bound semantic metrics and host-composed relational answers:
  the V2 lane runs host-first execution and the floor around an absent
  analyst instead of stopping at provider preflight.
- The certified top-N proof accepts a block whose fixed `LIMIT` equals the
  requested N on a verbatim authored example or a unique complete fit, and
  refuses a ranked block for an unranked "each customer" listing and a
  grouped block for a scalar ask. Only a verbatim example lets a block answer
  a question with a filter or a dropped qualifier ("top BCM customers").
- The native semantic compiler is selected for a metric it alone can serve
  even when a MetricFlow binary is installed but not ready.
- Known gap: the deterministic display-key clarification ("Show the top names
  by revenue" → choose Customer Name / Product Name) is a V1 mechanism. Under
  `authoritative_v2` a configured analyst may still ask through
  host-validated rival candidates; the zero-provider clarification returns
  with the single turn/clarification owner in the next release.

---

## v1.14.3-rc.1 - 2026-08-25

### Ask AI orchestration and observability

- Implemented the Ask-first analytical recovery contract: one host-owned
  analytical frame carries explicit measures, entities, display keys,
  dimensions, outputs, ranking, time, and conversation binding through the
  certified, semantic, governed-relational, and safe exploratory cascade.
- Hardened generated-SQL and relationship authorization around frozen plans,
  exact output/source bindings, target and snapshot closure, read-only policy,
  and one bounded in-lane repair. Exploratory results remain
  `review_required`; only proven certified or semantic execution can be
  governed.
- Added durable, redacted Ask/Research trace summaries that distinguish plan,
  compile, provider, execution, and branch failures; surface a meaningful
  partial-Research limitation and safe next action without turning a successful
  root finding into a false blocked run.
- Tightened provider dispatch and result-row egress: ordinary Ask retains no
  result-row narration; explicitly opted-in Research records bounded
  receipt-backed research narration and phase-aware provider attempts.

### Release-candidate status

- `1.14.3-rc.1` is an unpublished npm prerelease target for `next`, not a
  released `latest` version. The post-publish smoke must install the exact
  `@duckcodeailabs/dql-cli@1.14.3-rc.1` package.
- The changes above are implemented with local OSS test/build evidence. They
  do not independently verify private office metadata, fiscal calendars,
  provider configuration, vector indexes, or warehouse behavior; those remain
  separate office replay gates.

## v1.14.2 - 2026-08-21

### Ask AI analytical-cascade recovery

- Restored answerability without weakening the governed boundary: Ask AI now
  evaluates complete certified, semantic, governed-relational, and bounded
  exploratory-SQL routes in order before it asks for clarification or reports
  a gap.
- Preserved explicit analytical roles through retrieval and selection, so a
  requested measure, entity/display key, time role, or relationship cannot be
  replaced by an unrelated but lexically similar candidate.
- Tightened certified fit: a certified answer must prove the requested measure
  from its own declared output instead of borrowing coverage from a pooled
  candidate set.

### Conversation, diagnostics, and research receipts

- Persisted stable clarification selections, the original question, and the
  typed partial analytical frame so reloads and follow-ups do not repeat or
  reinterpret a completed choice.
- Added redacted, phase-specific provider diagnostics for authentication,
  model, rate-limit, gateway, network, timeout, admission, budget, and
  cancellation failures.
- Added structured Ask and Research receipts for source coverage, candidate
  admission/exclusion, cascade attempts, frozen-plan state, and
  evidence-supported Research branch verdicts.

### Validation limit

- This release candidate is verified against the local OSS fixtures and
  packaged runtime. The private office repository, its metadata/vector indexes,
  fiscal calendar, provider configuration, and warehouse remain outside this
  repository and require a separate office replay before claiming those
  customer-specific questions are fixed.

---

## v1.13.5 - 2026-08-14

### Ask AI answers in sentences again

Ordinary Ask had stopped narrating. Answer synthesis was gated on
`requestedMode === 'research'`, but the Ask panel sends `auto`, so every normal
question shipped the answer loop's internal `column: value` record as its
answer. This release restores the language lane and makes failures say what
actually went wrong.

### Added

- **Bounded result-row egress with an admin kill-switch.** A model that cannot
  see the values it is describing cannot describe them, so a redacted sample of
  up to 20 rows now accompanies narration. Set
  `agent.providerResultRowEgress.mode` to `"disabled"` in `dql.config.json` to
  keep every cell value on the host — narration still runs, grounded in column
  names and computed statistics only. Every run emits an egress receipt naming
  the policy that applied, whether or not rows were sent.
- **Claim-verified narration.** On analytical-graph routes the model drafts
  claims that each cite a fact id, and each is checked against the immutable
  fact set before display: causal wording, unknown facts, numbers absent from
  the cited facts, and hidden material caveats are all rejected, retried once,
  and only then replaced by the deterministic record — which now says so.

### Improved

- **Narration has its own dispatch budget.** It previously shared the generation
  bucket, so a run could compute the right numbers and then have nothing left to
  say them with.
- **Dispatch admission is latency-aware.** DQL measures what your provider
  actually costs and refuses to start a call the deadline cannot finish, instead
  of being killed mid-flight with nothing to show. Subscription-CLI providers
  benefit most.
- **Clarification cards are readable and answerable.** Duplicate labels are
  disambiguated by kind, raw semantic-layer records are summarized into a
  sentence instead of pasted as YAML, and choosing an option keeps your original
  question rather than re-asking the option's own label.
- **Follow-ups ask instead of guessing.** "This customer" after a ten-row answer
  silently bound the first row as the referent; ambiguous references now become
  clarification options.

### Fixed

- **A DQL-side stop is no longer reported as your AI provider failing.** Run
  budget exhaustion, the orchestration soft target, and a mid-run project
  snapshot rebuild were all surfaced as `<provider> failed`, sending users to
  re-authenticate a provider that was working.
- **A refusal no longer reads "Needs input".** Terminal refusals are labelled
  `Refused`, clarifications keep `Needs input`, and the reason the run actually
  recorded now reaches the card instead of a generic headline.

---

## v1.13.4 - 2026-08-11

### Reliable App authoring and durable Block certification

This patch makes App AI source selection deterministic, keeps manually authored
draft blocks available through an explicit local review lane, and makes Block
certification progress recover correctly across navigation and busy histories.

### Added

- **Visible App AI activity.** App Studio shows honest planning phases while it
  understands the request, searches certified and draft blocks, validates trust
  and capabilities, and prepares the source review.
- **Authoritative source selection.** Sources explicitly added in AI review are
  resolved by canonical ID and retained through proposal revision, composition,
  preview, retry, and resume.
- **One-click draft composition.** A manually authored draft can atomically
  enable the local review lane, add its source and tile, and create the required
  review task without changing its lifecycle or publication eligibility.

### Improved

- **Simpler App library and Studio layout.** Existing Apps appear first, the new
  App form expands on demand, source filters fit the compact sidebar, and source
  rows provide adding, added, retry, and add-another feedback.
- **Actionable publication review.** One toolbar action opens the governed
  checklist, and its blocker count now matches the exact actionable rows.
- **Durable certification progress.** Active operations survive list limits and
  remounts, exact operation IDs win recovery, terminal states remain monotonic,
  and Task Center coalesces superseded attempts by block artifact identity.

### Fixed

- **App source provenance.** Generated Ask and research drafts stay out of the
  reusable App catalog unless explicitly tagged for reuse, while ordinary
  semantic drafts with parameters or time metadata remain discoverable.
- **Large-repository freshness.** Root and domain block changes invalidate the
  indexed project snapshot without capped recursive warm scans.
- **AI coverage integrity.** Provider and fallback plans cannot claim that an
  unrelated measure, dimension, or filter satisfies a visible App requirement.
- **Draft publication boundary.** Draft and review-required sources execute in
  local preview but continue to block Project publication until certified,
  replaced, or removed.

### Verification

- Independent pre-release verification passed 1,331 agent tests, 306 Notebook
  tests, and 764 CLI tests with three intentional skips.
- Built `dql notebook` acceptance verified App AI activity, certified and draft
  source selection, server composition, partial preview, compact source filters,
  and fail-closed publication in an isolated local fixture.
- The synchronized release dry run passed all 22 workspace builds, all 41 test
  tasks, and packed all 19 npm packages.
- All 19 npm packages report `version=1.13.4` and
  `dist-tags.latest=1.13.4`.
- Fresh project-local and global CLI installs both report `dql 1.13.4`, and
  `create-dql-app@1.13.4 --help` resolves successfully.

## v1.13.3 - 2026-08-11

### Enterprise App AI and clearer Block Studio recovery

This patch replaces the split App Builder paths with one snapshot-backed,
server-owned Studio workflow and makes Block Studio runs and certification
failures easier to understand and correct. Certified and draft blocks are
discoverable without weakening the boundary that keeps review-required Apps
local until their sources are governed.

### Added

- **Dedicated App orchestration.** App AI uses a stateful App-specific
  orchestrator over the shared provider, immutable snapshot, meaning,
  execution, repair, trust, and evidence foundations used by Ask and Notebook.
- **Snapshot-backed source catalog.** Manual and AI authoring search the same
  paginated catalog across certified, review, and draft executable blocks,
  preserve qualified path identities and duplicate names, and resolve exact
  source revisions on the server.
- **Canonical App composition.** The server owns proposal revisions, source
  allow-lists, source-to-tile bindings, requirement coverage, four-worker
  preview coordination, filter capabilities, and restart-safe receipts.

### Improved

- **Block Studio guidance.** Draft, run, validation, and certification states
  now use focused step-level messages and corrective actions instead of noisy
  raw diagnostic text.
- **Results-first runs.** Successful Block runs foreground result data and keep
  generated SQL available as supporting evidence rather than the default view.
- **Draft-to-certification flow.** Save, run, validation, tests, chart, lineage,
  and certification blockers remain visible as one progressive checklist while
  unrelated background work stays out of the primary action path.

### Fixed

- **Draft App sources.** Review-required blocks remain visible and selectable
  for local Apps, execute with explicit trust labels, and are blocked from
  Project publication until certified, replaced, or removed.
- **Large and ambiguous catalogs.** Server search, cursor pagination, exact
  resolution, and path-qualified identity replace request-time top-50 scans
  and same-name collapse.
- **Publication drift safety.** Certified block sources and tiles without a
  bound revision now fail closed; current-looking preview or preflight receipts
  cannot publish an unversioned binding.

### Verification

- The synchronized release dry run passed all 22 workspace builds, the full
  workspace test graph, and packed all 19 npm packages.
- Independent focused verification passed all 76 Apps API tests, including the
  unversioned-source publication regression and zero-write assertion.
- All 19 npm packages report `version=1.13.3` and
  `dist-tags.latest=1.13.3`.
- Fresh project-local and global CLI installs both report `dql 1.13.3`, and
  `create-dql-app@1.13.3 --help` resolves successfully.

## v1.13.2 - 2026-08-10

### Governed App Studio authoring, filters, and publication

This patch completes the unified local App Studio workflow for manual and AI
authoring. Ask AI, source selection, dashboard filters, automatic previews, and
Project publication now share the same guarded `AppBuildDraft` lifecycle.

### Added

- **Governed dashboard filters.** Authors can select declared block filters,
  semantic dimensions, and safe settled-result columns, choose App or page
  scope, and explicitly include every compatible tile. Date controls show
  ephemeral data availability before save, and all linked tiles refresh from
  one filter change.
- **Ask AI to App Studio.** Certified Ask results retain their source identity
  and fingerprints, while exploratory SQL is stored as referenced local review
  DQL. Both open the exact editable App draft and page without writing governed
  Project source.
- **Direct publication fixes.** The publish review groups blockers and places a
  corrective action beside each one. The final Project write consumes the
  reviewed receipt and remains atomically revalidated server-side.

### Fixed

- **App navigation and draft continuity.** Back returns directly to the unified
  Apps library, clears stale App selection, and no longer opens the retired
  empty workspace. Ask, global Copilot, and App Copilot additions refresh the
  same Studio draft.
- **Filter compatibility and date feedback.** Certified computed result
  dimensions are available when safe, measures remain excluded, unsupported
  tiles explain why they are unaffected, and empty date fields cannot create a
  misleading filter.
- **Preview and review flow.** Adding a governed view runs the page preview
  automatically, stale responses are ignored, review-required local analysis
  has a direct remove/replace path, and repeated readiness-check loops are
  eliminated.

### Verification

- The synchronized release dry run passed all 22 workspace builds, the full
  workspace test graph, and packed all 19 npm packages.
- All 19 npm packages report `version=1.13.2` and
  `dist-tags.latest=1.13.2`.
- Fresh project-local and global CLI installs both report `dql 1.13.2`, and
  `create-dql-app@1.13.2 --help` resolves successfully.

## v1.13.1 - 2026-08-04

### Recoverable Block Studio editing and governed context authoring

This patch ships the post-`1.13.0` authoring work on `main`. Block Studio now
keeps invalid drafts editable and offers bounded AI repair, while Modeling and
Skills share a write-free proposal lifecycle with explicit review and commit.

### Added

- **Governed context proposals.** Manual Modeling, dbt discovery, YAML import,
  Modeling AI, and Skills AI can produce immutable, review-required proposals
  with source snapshots, dependency fingerprints, exact patches, validation,
  and explicit commit.
- **Atomic authoring review.** Context proposal commits validate the expected
  proposal hash, compile the complete candidate, reject source or dependency
  drift, and restore prior bytes instead of leaving partial writes.
- **Modeling workspace actions.** The dbt-first workspace exposes clearer
  connected-dbt, YAML import, manual-start, batch-binding, and relationship
  review paths without promoting suggestions to certified proof.

### Fixed

- **Editable Block Studio syntax failures.** Invalid DQL is rejected before a
  block file is written, the source editor remains available, and the error
  explains that the draft was not saved instead of reopening a frozen block.
- **Bounded AI repair and run.** `Fix with AI & run` repairs one malformed DQL
  draft on the same target, validates the repaired source, and returns its run
  result without automatically saving or certifying the change.
- **Recoverable validation.** Parameter parsing and structural diagnostics now
  return actionable validation responses, while missing semantic runtime setup
  does not incorrectly prevent a structurally valid draft from being saved.

### Verification

- The synchronized release dry run passed all 22 workspace builds, all 41 test
  tasks, and packed all 19 npm packages.
- All 19 npm packages report `version=1.13.1` and
  `dist-tags.latest=1.13.1`.
- Fresh project-local and global CLI installs both report `dql 1.13.1`, and
  `create-dql-app@1.13.1 --help` resolves successfully.

## v1.13.0 - 2026-08-03

### Governed App Builder, asynchronous workflows, and durable AI analysis

This minor release brings every post-`1.12.11` feature on `main` into one
synchronized distribution. It expands governed Apps into a multi-page story
builder, keeps long-running local work alive across navigation, and closes the
remaining Ask/Notebook target-continuity gaps without weakening review or
certification boundaries.

### Added

- **Governed multi-source App Builder.** Build complete Apps from certified
  blocks, governed semantic sources, and review-required exploratory sources,
  with incremental page generation, editable proposals, explicit commit, and
  source-tier evidence retained in each component.
- **App-level analysis controls.** App viewers can switch supported results
  between table and chart views, inspect DQL, SQL, lineage, and answer evidence,
  open work in Notebook, and run bounded same-target repair from an individual
  failed App component.
- **Responsive App Copilot.** Copilot results support wider/expandable layouts,
  adjustable height, readable wide tables, visible Add-to-App state, and quick
  navigation to the added component.
- **Durable background operations.** Ask AI, Notebook AI, and App Builder runs
  continue across route changes and remounts, with persisted run identity,
  recovery, cancellation, and a shared task center instead of blocking the UI.
- **Recoverable App deletion.** Apps can be removed through a confirmed,
  guarded action alongside View and Edit.

### Improved

- **Asynchronous application shell.** Project refresh, metadata refresh,
  Notebook execution, saving, certification, and other long-running local work
  use coordinated background operations so unrelated pages and activities stay
  responsive.
- **App presentation quality.** Auto-layout Apply is durable, component result
  cards expose complete context, and currency, date, time, and decimal values
  use meaningful display formatting.
- **Ask clarification continuity.** Structured clarification choices retain the
  original analytical question and receive the correct analytical deadline even
  after reload or when conversation storage is unavailable.
- **Research continuity.** Research deeper carries the successful Ask SQL, DQL,
  result sample, and exact execution target. If deeper composition cannot
  produce a safer executable query, DQL revalidates and retains the successful
  baseline instead of replacing it with a noisy failure.

### Fixed

- **Target-grounded schema repair.** Complete live Snowflake, Databricks, and
  DuckDB schemas remain authoritative for execution, while partial retrieval
  cards and certified source SQL are merged without reintroducing stale columns
  or triggering an unnecessary second AI generation.
- **Research target drift.** Research schema inspection, certified execution,
  generated SQL, preview, cancellation, and fallback now remain bound to the
  same connection selected by the originating Ask run.
- **Certified Block Studio state.** Save and certification actions retain their
  intended status while background work proceeds without freezing the page.

### Verification

- The synchronized release dry run passed all 22 workspace builds, every
  workspace test task, and packed all 19 npm packages.
- Full DQL Agent suite: 107 files and 1,299 tests passed.
- Full local-runtime integration suite: 259 tests passed.
- Full Notebook suite: 48 files and 224 tests passed.
- All 19 npm packages report `version=1.13.0` and
  `dist-tags.latest=1.13.0`.
- Fresh project-local and global CLI installs both report `dql 1.13.0`, and
  `create-dql-app@1.13.0 --help` resolves successfully.

## v1.12.11 - 2026-08-01

### Quiet Notebook repair and governed authoring context

This patch brings Ask AI's bounded repair experience into Notebook, makes
business-domain choices consistent across authoring surfaces, and replaces the
eager warehouse tree with a dbt-scoped database browser.

### Added

- **Quiet Notebook repair.** Failed SQL and SQL-backed DQL cells offer a simple
  `Fix and retry` action that repairs and reruns the same cell on the same data
  target without opening Notebook AI or adding repair chatter to its context.
- **Reviewable repair evidence.** A successful repair replaces only the current
  cell, marks changed artifacts as review-required, and retains the original
  source, SQL, error, run, and target evidence in Trust & Steps.
- **dbt-scoped Database browser.** Database search now returns only physical
  models and sources from the connected dbt manifest, loads 25 objects at a
  time, searches on the server, and fetches columns only when a relation is
  expanded.

### Fixed

- **Safe repair eligibility.** Permission, policy, credential, parameter,
  dependency, cross-engine, target-drift, semantic, ambiguous, and stale-cell
  failures remain explicit user decisions instead of being rewritten
  automatically.
- **Uniform authored domains.** Notebook, Block Studio, Models, Skills, Apps,
  and related filters now use only first-class domains created in the Domain
  workspace. Metric and dimension catalog folders no longer appear as business
  domains, while legacy assignments remain visible until the user remaps them.
- **Display-only catalog scope.** Restricting the Database browser to dbt
  relations does not mutate the DQL manifest or the metadata and indexes used
  by agent retrieval.

### Verification

- The synchronized release gate passed all 22 workspace builds and all 41
  workspace test tasks.
- Full DQL Agent suite: 107 files and 1,290 tests passed.
- Full CLI suite: 55 files passed with 685 tests passed and 3 skipped.
- Full Notebook suite: 47 files and 210 tests passed.
- The release dry run packed all 19 npm packages successfully.
- All 19 npm packages report `version` and `latest` as `1.12.11`.
- Fresh project-local and global CLI installs both report `dql 1.12.11`;
  published CLI help and `create-dql-app@1.12.11 --help` also resolve.

## v1.12.10 - 2026-08-01

### Smooth, bounded Ask AI query repair

This patch removes the main execution-path differences that let a query fail in
Ask AI even when the same analytical work could run in Notebook. Failed Ask
turns now offer a clean, reviewable repair action without contaminating the
context used by the user's next question.

### Fixed

- **Shared Ask and Notebook SQL preparation.** Both surfaces now use the same
  execution preparation path for generated SQL and DQL-derived SQL, including
  physical `source::` reference resolution and target-aware validation.
- **Bounded one-click repair.** A failed read-only analytical query can create
  one immutable derived repair attempt on the same execution target. DQL first
  applies deterministic corrections, then permits at most one AI repair retry
  instead of entering an open-ended regeneration loop.
- **Failure isolation.** Rejected SQL and repair-only diagnostics are excluded
  from the normal context for a following user question, so one bad turn does
  not cause otherwise valid follow-up questions to inherit the same failure.
- **Clean failure presentation.** Ask AI shows typed, concise failure states and
  replaces the failed answer in place after a successful repair instead of
  exposing internal blocker and parser noise as the primary result.
- **Notebook behavior preserved.** Notebook keeps its existing review-first AI
  correction flow while sharing the same preparation and execution boundary.

### Verification

- The synchronized release dry run passed all 22 workspace builds and all 41
  workspace test tasks.
- Full DQL Agent suite: 107 files and 1,290 tests passed.
- Full CLI suite: 55 files passed with 678 tests passed and 3 skipped.
- Full Notebook suite: 45 files and 204 tests passed.
- All 4 Ask AI and Notebook execution-parity tests passed.
- Built-CLI browser QA verified the repaired Ask AI experience.
- All 19 npm packages report `version` and `latest` as `1.12.10`.
- Fresh project-local and global CLI installs both report `dql 1.12.10`.

## v1.12.3 - 2026-07-30

### Durable Ask AI execution and faster Notebook navigation

This patch completes the Ask AI and Notebook execution-parity work, makes chat
deletion durable across refreshes, and removes avoidable UI and metadata-cache
work from normal Notebook navigation.

### Fixed

- **Connection-scoped Ask execution.** Ask AI now carries the selected
  connection and its current metadata snapshot through planning, generated DQL,
  semantic-table resolution, execution, and Notebook handoff instead of
  resolving part of the run against a stale or different catalog.
- **Durable conversation deletion.** Deleting an Ask session removes its
  persisted thread, turns, and search rows, while UI tombstones prevent an
  overlapping stale history response from restoring the deleted session.
- **Notebook handoff parity.** Generated answers preserve the execution target
  when opened in Notebook so rerunning the artifact uses the same connection as
  the original governed run.

### Performance

- **Route-level UI loading.** Notebook routes and large analytical surfaces are
  loaded on demand instead of entering the initial shell bundle.
- **Narrow lineage import.** The UI imports derivation helpers through a focused
  DQL Core subpath rather than pulling the SQL parser barrel into the main
  bundle.
- **Reusable startup metadata.** A valid fingerprinted catalog is reused at
  startup, and immutable fingerprinted assets receive long-lived browser cache
  headers while HTML remains revalidated.

### Verification

- Full DQL Agent suite: 103 files and 1,228 tests passed.
- Full Notebook suite: 42 files and 188 tests passed.
- Focused CLI runtime/metadata suite: 10 tests passed.
- DQL Core, Notebook UI, and CLI production builds passed.
- A real loopback API check verified that deleted chat sessions remain deleted.
- Built-CLI browser checks against `jaffle-shop-duckdb` verified cached
  navigation with no browser errors.
- The synchronized workspace release gate passed: all 22 workspace builds,
  the full test graph, and all 19 npm tarballs completed successfully.
- All 19 npm packages report `version` and `latest` as `1.12.3`.
- Fresh project-local and global CLI installs both report `dql 1.12.3`, and
  `create-dql-app@1.12.3 --help` resolves successfully.

## v1.12.2 - 2026-07-30

### Ask AI and Notebook warehouse execution parity

This patch removes the main execution differences that allowed a DQL artifact
to run in Notebook while the equivalent Ask AI answer failed against the same
warehouse.

### Added

- **Explicit Ask execution target.** Ask AI shows the selected database beside
  Thinking and uses that one connection for metadata grounding, semantic
  compilation, certified/generated execution, and bounded validation.
- **Safe stale-session recovery.** A terminated warehouse session is evicted and
  reconnected once for a single read-only `SELECT` or `WITH` statement. DQL
  never replays mutating or multi-statement SQL automatically.

### Fixed

- **Snowflake physical identifiers.** Governed compilation preserves dbt
  `relation_name`, explicit quoting, and Snowflake's normal unquoted
  case-folding instead of turning lowercase dbt schema and column names into
  different case-sensitive objects.
- **Cross-surface connection drift.** Certified blocks, generated DQL, schema
  context, semantic queries, and exploratory validation no longer silently
  fall back to a different default connection during an Ask run.
- **Warehouse recovery classification.** Terminated sessions are explicitly
  retryable, while Snowflake's combined “does not exist or not authorized”
  relation message routes through metadata refresh instead of fabricated SQL
  repair or an unrecoverable permission dead end.

### Verification

- Full DQL Agent suite: 103 files and 1,226 tests passed.
- Full Notebook suite: 41 files and 186 tests passed.
- Full CLI suite and all 28 connector tests passed.
- Core dbt-first modeling tests and Agent, Connector, Core, CLI, and Notebook
  production builds passed.
- The built CLI was browser-verified against a dbt-first fixture with the
  selected Ask database visible beside Thinking.
- The synchronized workspace release gate passed: 22/22 builds, 41/41 test
  tasks, and all 19 npm tarballs completed successfully.
- All 19 npm packages report `version` and `latest` as `1.12.2`.
- Fresh project-local and global CLI installs both report `dql 1.12.2`, and
  `create-dql-app@1.12.2 --help` resolves successfully.

## v1.12.1 - 2026-07-30

### Governed correction lessons and fail-closed DQL SQL repair

This patch makes Teach DQL corrections reusable and reviewable while preventing
internal Hint Graph relation identifiers from leaking into executable warehouse
SQL.

### Added

- **Structured Teach DQL review.** A successful edit now opens a before/after
  review where the analyst confirms a reusable lesson, at least one meaningful
  domain/metric/model/term/block scope anchor, and an optional rationale.
- **Reviewer-visible correction evidence.** Agent Learning shows the analyst's
  rationale alongside the original question, previous SQL, current snapshot,
  dependencies, graph connections, evaluations, and lifecycle exclusions.
- **DQL-cell AI repair.** Notebook DQL failures can use the same focused,
  review-required AI repair path as SQL cells while preserving the DQL artifact
  and extracting its embedded SQL as repair context.

### Fixed

- **Physical relation enforcement.** `source::`, `dbt::`, and `semantic::`
  identities remain retrieval and lineage keys; generation, validation,
  Notebook execution, preview execution, and repair now resolve a uniquely
  inspected physical relation or fail closed before reaching the warehouse.
- **Reusable correction guidance.** SQL-only corrections no longer silently use
  raw corrected SQL as their human-readable lesson. Older clients receive a
  conservative reviewable fallback, while explicit analyst guidance remains
  authoritative.
- **Accidental project-wide learning.** Notebook teaching requires a confirmed
  high-signal scope anchor; comments remain provenance and cannot approve,
  certify, or directly activate shared learning.

### Verification

- Full DQL Agent and Notebook test suites pass.
- Governed correction HTTP lifecycle tests pass against the real local runtime.
- Agent and Notebook production builds pass.
- The synchronized workspace build, test, pack, and publish gates passed; all
  19 npm packages report `version` and `latest` as `1.12.1`.
- Fresh project-local and global CLI installs both report `dql 1.12.1`.

## v1.12.0 - 2026-07-30

### Domain-wide libraries and conversation-aware analytical follow-ups

This minor release makes Git-backed analytical assets easier to navigate across
Domain Packages and improves in-session AI recaps without merging context
between Ask, Notebook AI, and Block AI.

### Added

- **All-domain asset views.** Blocks, Notebooks, and the Domain workspace can
  show every available domain or narrow to one domain through the same compact
  selector pattern.
- **Global related products.** Domain workspaces expose all Apps and Notebooks
  when no domain is selected, while domain-scoped views continue to use
  owner/uses-domain metadata.
- **Live notebook discovery.** Related-product results merge Git-tracked
  notebook files with the compiled manifest so newly created notebooks appear
  before the next compile.

### Fixed

- **Conversation recap routing.** Phrases such as “what are we reviewing in
  this chat” are treated as in-session recap requests instead of new analytical
  queries, including bounded normalization for common spelling mistakes.
- **Substantive recap context.** Consecutive recap questions summarize the
  latest analytical or authoring turn and ignore prior recap-only turns.
- **Result recap fidelity.** Tuple-shaped and object-shaped result samples are
  both converted into grounded recap facts.
- **Domain navigation consistency.** Blocks, Notebooks, and Domain views share
  consistent all-domain semantics, counts, filtering, and artifact routing.

### Verification

- Full DQL agent suite: 102 files and 1,205 tests passed.
- Full Notebook suite: 39 files and 178 tests passed.
- Targeted CLI domain-related-products API test passed.
- Agent, CLI, and Notebook production builds passed.
- The complete release build, test, pack, publish, registry, and clean-install
  gates are recorded by the release workflow for this version.

## v1.11.2 - 2026-07-26

### Complete unified AI orchestration and explicit Block AI commit

This patch closes the remaining gaps between Ask AI, Notebook AI, Block AI,
manual authoring, and runtime execution. All surfaces now share one canonical
semantic artifact contract while preserving complete repair evidence.

### Fixed

- **Complete multi-metric output.** Exact metric identifiers remain metrics
  through planning and semantic member selection, including requests with five
  measures, instead of collapsing to a single metric plus inferred dimension.
- **One canonical DQL shape.** Semantic drafts use the shared
  `metrics = [...]` and `dimensions = [...]` renderer throughout proposal,
  formatting, Notebook, Block Studio, CLI, import, and execution paths.
- **Explicit Block AI routing.** New Block Studio chats request the governed
  block route directly, including projects whose catalog domain is
  `uncategorized`, rather than entering the generic answer route.
- **Consent-bound block writes.** Block AI generation returns a transient,
  ownerless review artifact and does not create block or domain files. Only the
  user-selected Add to Block Studio action writes the draft and opens it in the
  visual builder.
- **Unified Notebook and Block execution.** Cold Block AI and carried Ask
  artifacts reuse the same durable answer executor and evidence model used by
  Ask and Notebook AI.
- **Repairable failed responses.** Compilation and execution failures keep the
  attempted canonical DQL, attempted or explicitly unavailable SQL, lineage,
  trust evidence, actual steps, diagnostics, and safe Notebook repair actions.
- **Navigation-safe async runs.** Active work continues through navigation and
  completed turns restore the same DQL, SQL, lineage, and Trust & Steps
  evidence instead of reconnecting to or hydrating an incomplete response.

### Acceptance and verification

- Implemented acceptance IDs: `CONTRACT-002`, `AGT-017`, `AGT-021`, `API-007`,
  `API-008`, `UI-012`, `UI-013`, `UI-014`, `UI-015`, `UI-016`, and `E2E-015`.
- Core, agent, CLI, and Notebook suites pass with 534, 1,128, 571 plus 3
  skipped, and 125 tests respectively; all affected production builds pass.
- Built-CLI browser verification confirms explicit Block AI routing and the
  canonical draft path. Provider-backed final Add-to-Block-Studio replay
  remains pending independent verification because the fixture's configured
  Claude subscription was unreachable.
- The existing `PERF-001` latency exception remains unchanged.

## v1.11.1 - 2026-07-26

### Canonical semantic DQL and durable failed-query repair

This patch aligns semantic authoring across Ask AI, Notebook AI, Block AI, the
CLI, and manual Block Studio workflows while keeping failed analytical work
fully inspectable and editable.

### Fixed

- **Canonical semantic blocks.** One shared renderer now emits
  `metrics = [...]` and `dimensions = [...]` across AI generation, Notebook,
  Block Studio, CLI scaffolding, formatting, and runtime artifacts. AI drafts
  remain ownerless until a human saves or promotes them.
- **Complete multi-metric selection.** Ask preserves every explicitly requested
  metric, avoids treating technical metric identifiers as filters, retains
  prior selections in follow-ups such as “other metrics,” and uses a lossless
  result contract when multiple measures are returned.
- **Block AI domain handling.** Catalog fallback labels such as
  `uncategorized` no longer block Block AI before orchestration can resolve the
  governed business context.
- **Durable compilation failures.** SQL compilation and execution failures
  retain the immutable plan, canonical DQL attempt, any attempted SQL, lineage,
  trust evidence, actual steps, stable diagnostics, and safe repair actions.
- **Editable Ask recovery.** Failed DQL or SQL can be opened directly from Ask
  as an editable Notebook cell with its trust and compilation metadata intact.
- **Navigation-safe evidence.** Conversation persistence retains the complete
  bounded DQL artifact contract so DQL, SQL, lineage, and Trust & Steps remain
  available after leaving and returning to the AI surface.

### Release exceptions

- Provider-backed multi-metric and failed-compilation browser replay remains
  pending independent verification because the designated built-CLI fixture
  did not have a reachable Claude subscription.
- The existing `PERF-001` latency exception remains unchanged.

## v1.11.0 - 2026-07-26

### Unified AI orchestration for Ask, Notebook, and Block authoring

This minor release gives Ask AI, Notebook AI, and Block AI one durable,
governed execution lifecycle while keeping the final actions appropriate to
each product surface.

### Added

- **Durable universal AI runs.** Agent progress, plans, artifacts, diagnostics,
  and terminal receipts are checkpointed so active requests continue across
  navigation and completed history restores the same canonical evidence.
- **Notebook authoring actions.** Successful governed output can be added as a
  new notebook cell or used to replace the selected cell only after an explicit
  user action, preserving cell identity and execution provenance.
- **Block AI draft handoff.** Successful DQL proposals can be saved as
  ownerless, Git-backed draft blocks and opened immediately in Block Studio's
  visual builder without silently certifying or mutating canonical blocks.

### Fixed

- **Multi-metric Ask fidelity.** Every explicitly requested metric is retained.
  Compatible metrics resolve through one safe semantic adapter and model;
  incompatible or missing metrics fail closed with stable diagnostics.
- **Complete failure evidence.** Failed runs preserve the plan, DQL, compiled
  SQL, lineage, trust evidence, actual steps, failure code, and safe repair
  actions instead of dropping the inspector or displaying a stale answer.
- **Canonical history hydration.** Returning to Ask AI restores DQL and lineage
  together with SQL and Trust & Steps, while unfinished work polls durable
  progress instead of presenting a misleading reconnect state.
- **Safe surface actions.** Blocked or clarification runs cannot be added to a
  notebook or Block Studio, and generated output never mutates either surface
  before the user selects an explicit action.

### Release exceptions

- Acceptance IDs `AGT-021`, `API-008`, `UI-014`, `UI-015`, and `UI-016`
  remain implementer-validated. `E2E-015` remains specified pending independent
  built-CLI verification against the designated fixture.
- The tracked `PERF-001` latency exception remains unchanged. This release
  improves lifecycle durability, diagnostic completeness, and surface wiring
  without claiming GA-scale latency.

## v1.10.9 - 2026-07-25

### Multi-measure governed answers and organized Block Studio authoring

This patch preserves every explicitly requested measure through planning,
execution, visualization, and narration while making Block Studio a complete,
live-synchronized workspace for semantic and Raw SQL blocks.

### Fixed

- **Multi-measure answer fidelity.** Explicitly requested metrics remain in the
  immutable analytical plan and result contract. Multi-measure results default
  to a lossless table instead of silently selecting one chart measure, and
  deterministic narration describes both leading and supporting measures.
- **Scope-aware SQL validation.** Generated SQL resolves identifiers within
  each `SELECT` and CTE scope. Ambiguous ownership now fails closed and repair
  prompts preserve the requested output contract instead of guessing the first
  relation.
- **Editable notebook handoff.** DQL and SQL shown in the answer inspector can
  be inserted into a notebook cell, focused, and scrolled into view for
  research, correction, and rerun.
- **One live Block Studio draft.** Semantic, Raw SQL, and DQL-source authoring
  share the same draft state. Pasted SQL opens the complete visual builder and
  visual/source changes round-trip before save.
- **Nested block organization.** Block libraries render Git-backed folders and
  subfolders. Saving to a new folder safely moves the exact `.dql` block and
  semantic companion while rejecting traversal and hidden path segments.
- **Visible guarded deletion.** Saved blocks expose confirmed delete actions in
  the library row, block detail, and toolbar; save, move, and delete refresh the
  library immediately.

### Release exceptions

- Acceptance IDs `API-006`, `UI-001`, `UI-009`, `E2E-008`, `AGT-015`,
  `AGT-017`, `AGT-018`, `AGT-020`, `UI-012`, `UI-013`, `E2E-012`, and
  `E2E-014` remain implementer-validated. Independent enterprise Snowflake,
  dbt Cloud, and local MetricFlow verification is still required.
- The tracked `PERF-001` latency exception remains unchanged. This release
  improves answer fidelity, SQL safety, and authoring UX without claiming
  GA-scale latency.

## v1.10.8 - 2026-07-23

### Governed semantic authoring parity and safe block deletion

This patch makes the metric-first semantic composer consistent across Notebook
and Block Studio, restores missing Raw SQL visual-authoring controls, and adds
an exact, confirmed deletion path for saved blocks.

### Fixed

- **Notebook insertion without a mandatory preview.** After metric
  compatibility resolves successfully, users can add the governed semantic
  selection to a notebook cell immediately. Preview remains available as an
  optional execution check rather than an unrelated enablement gate.
- **One semantic composer across authoring surfaces.** Block Studio reuses the
  Notebook metric-first picker and applies the chosen metrics and dimensions to
  the visual block. A metric selection exposes only fresh, runtime-compatible
  dimensions that share a governed path with every selected metric.
- **Fail-closed selection reconciliation.** Loading, failed, or stale
  compatibility plans do not expose unrelated dimensions. Metric changes also
  remove dimensions, time grains, and filters that are no longer approved by
  the current compatibility result.
- **Raw SQL visual parity.** SQL blocks now retain runtime parameters,
  parameter policies, filter bindings, chart series/color configuration, and a
  generated DQL preview while users edit the visual builder.
- **Targeted DQL source edits.** Visual changes update the intended query or
  semantic clauses without normalizing away unknown metadata, tests,
  visualization settings, parameters, policies, or bindings.
- **Guarded saved-block deletion.** Block Studio can delete one exact saved
  `.dql` block and its matching semantic companion after explicit
  confirmation. Traversal, broad deletion, missing targets, and unrelated
  blocks remain protected.

### Release exceptions

- Acceptance IDs `API-006`, `UI-001`, `UI-009`, and `E2E-008` are
  implementer-validated through full package suites, production builds, and a
  built-CLI browser replay. Independent enterprise Snowflake, dbt Cloud, and
  local MetricFlow verification remains required before they can be marked
  verified.
- The tracked `PERF-001` latency exception remains unchanged. This patch
  improves authoring correctness and UI/runtime wiring rather than claiming
  GA-scale latency.

## v1.10.7 - 2026-07-23

### Semantic-model composition and isolated notebook execution

This patch makes dbt semantic composition model-aware from catalog discovery
through runtime execution, and prevents one notebook cell failure or stale
response from contaminating another cell.

### Fixed

- **Model-scoped semantic catalog.** Business metrics retain direct and derived
  semantic-model ownership, projected measures no longer appear as duplicate
  business metrics, and model-qualified dimension variants stay distinct.
- **Compatibility-first composition.** Selecting a metric exposes only
  dimensions with a governed runtime path to every selected metric. The same
  compatibility evidence now guides the Notebook composer and agent member
  selection.
- **Pinned preview and execution target.** Semantic previews and inserted DQL
  cells carry the same named execution target, compiler trace, compiled SQL,
  target binding, and execution receipt.
- **Cell-isolated execution.** Notebook cells receive unique IDs and per-run
  correlation IDs. Older aborted responses cannot overwrite newer runs, and a
  failed dependency branch no longer prevents independent branches from
  running.
- **Stable upstream results.** A completed upstream result remains available
  after the transient success indicator returns to idle, while stale, failed,
  missing, or ambiguous dependencies fail closed with structured codes.
- **Trust & Steps for every cell.** SQL and DQL cells expose the governed
  request, compiled/executed SQL, semantic bindings, effective warehouse
  target, execution receipt, duration, and stable failure details.
- **Server survival and target truth.** Raw SQL and semantic execution responses
  echo the effective cell/run identity and actual default or selected target;
  one failed request does not poison the next request or terminate the
  Notebook server.

### Release exceptions

- Acceptance IDs `ID-001`, `CONTRACT-002`, `AGT-014`, `API-004`, `API-006`,
  `API-007`, `UI-009`, `UI-012`, `E2E-008`, and `E2E-014` are
  implementer-validated. Independent replay against the enterprise Snowflake,
  dbt Cloud, and local MetricFlow fixture remains required before they can be
  marked verified.
- The tracked `PERF-001` latency exception remains unchanged. This patch
  improves semantic identity and notebook execution correctness rather than
  claiming GA-scale latency.

## v1.10.6 - 2026-07-23

### Canonical Snowflake semantic target identity

This patch fixes false semantic target drift when Snowflake represents the same
account with an immutable account locator in one path and the preferred
`organization-account_name` identifier in another. Existing dbt Cloud bindings
and local MetricFlow profiles can now match the active warehouse without
weakening the governed database, schema, role, or warehouse checks.

### Fixed

- **Canonical Snowflake account proof.** DQL observes `CURRENT_ACCOUNT()`,
  `CURRENT_ACCOUNT_NAME()`, and `CURRENT_ORGANIZATION_NAME()` on the active
  execution connection and retains the locator and client-facing account
  identifier in the redacted target contract.
- **Legacy binding compatibility.** Persisted dbt Cloud locator bindings and
  dbt profile account identifiers are compared through bounded Snowflake
  aliases instead of an obsolete exact fingerprint requirement.
- **MetricFlow and dbt Cloud parity.** Both semantic adapters use the same
  field-aware target comparison, preventing identifier-format drift from being
  mistaken for a cross-account execution request.
- **Fail-closed identity acquisition.** A failed Snowflake identity query no
  longer saves or validates configured fallback values as observed warehouse
  proof. Apply and execution stop with
  `WAREHOUSE_TARGET_IDENTITY_UNAVAILABLE`.
- **Strict true-drift protection.** Real account, database, schema, role, and
  warehouse changes still fail before semantic compilation or SQL execution.

### Release exceptions

- Acceptance IDs `AGT-014`, `API-006`, `API-007`, `SEC-004`, and `E2E-014`
  are implementer-validated. Independent replay against the enterprise
  Snowflake, dbt Cloud, and local MetricFlow fixture remains required before
  they can be marked verified.
- The tracked `PERF-001` latency exception remains unchanged. This patch
  changes target identity acquisition and comparison, not enterprise-scale
  latency.

## v1.10.5 - 2026-07-23

### Semantic source integrity and resilient execution diagnostics

This patch closes the remaining gap between local dbt authoring metadata and
the semantic project actually deployed to dbt Cloud. DQL now persists a
complete compiler-owned metric inventory during explicit Test & Apply, binds
that proof to execution, and keeps Notebook and agent failures inspectable
without terminating the local server.

### Fixed

- **Verified dbt Cloud metric inventory.** Test & Apply walks the paginated dbt
  Cloud metric catalog, stores its deterministic fingerprint and completeness
  state, and keeps that runtime proof separate from the local dbt semantic
  snapshot.
- **Fail-closed semantic source drift.** A missing, partial, or incompatible
  cloud inventory now returns `SEMANTIC_SOURCE_DRIFT` with the unavailable
  metrics and safe reapply action. DQL no longer treats a locally discovered
  metric as proof that the configured cloud environment can compile it.
- **Compiler-source target binding.** dbt Cloud execution requires both the
  governed local snapshot and the persisted remote catalog fingerprint before
  compilation. Compatibility checks expose the exact source proof used by the
  selected adapter.
- **Actionable physical preflight failures.** Snowflake validation preserves
  the failing identifier, source line and position, bounded SQL excerpt,
  compiled-SQL fingerprint, target binding, and safe repair actions instead of
  reducing the failure to a generic query error.
- **Complete Trust & Steps evidence.** “How it was answered” distinguishes the
  local semantic snapshot from the runtime metric inventory, shows physical
  preflight evidence, and links users directly to Project & dbt settings when
  the semantic runtime must be reapplied.
- **Notebook server resilience.** Async HTTP request rejections are caught and
  returned as structured failures, preventing semantic catalog or compiler
  errors from terminating the local Notebook process.
- **Supported Snowflake runtime guard.** Snowflake startup accepts Node 20, 22,
  and 24 and rejects unsupported Node majors, including Node 26, before loading
  the driver.

### Release exceptions

- Acceptance IDs `API-004`, `API-007`, `UI-009`, `UI-012`, `SEC-004`,
  `E2E-008`, and `E2E-014` are implementer-validated. Independent replay
  against the enterprise Snowflake and dbt Cloud fixture remains required
  before they can be marked verified.
- The tracked `PERF-001` latency exception remains. Complete remote inventory
  capture occurs only on explicit Test & Apply and is paginated, but this patch
  makes no GA latency claim.

## v1.10.4 - 2026-07-23

### Target-bound semantic execution and bounded Snowflake runtime

This patch makes semantic compilation and warehouse execution one auditable
operation. DQL now proves that dbt Cloud or local MetricFlow compiled for the
same warehouse target that will execute the SQL, preflights the physical query,
and retains the exact adapter, target, SQL, query ID, and failure evidence.

### Fixed

- **Compiler-to-warehouse target binding.** DQL observes the active account,
  database, schema, role, and warehouse through the same pooled connection used
  for execution. A dbt Cloud or MetricFlow target mismatch now fails with
  `EXECUTION_TARGET_MISMATCH` before compilation or query execution.
- **One pinned semantic runtime.** Notebook, preview, agent, freshness, and
  semantic artifact execution share one gateway and one adapter decision.
  Adapter failures remain visible and never silently downgrade to another
  compiler or generated SQL route.
- **Bounded Snowflake discovery and execution.** Startup no longer materializes
  every warehouse column. Physical schema fallback is question-scoped and
  paginated, while Snowflake rows are streamed with row, byte, batch, and
  deadline limits plus cancellation support.
- **Physical SQL preflight.** Compiler output is checked on the active warehouse
  connection before execution, catching missing columns, ambiguous identifiers,
  and permission failures without inventing semantic explanations.
- **Structured connector diagnostics.** Snowflake vendor code, SQL state, query
  ID, line, position, truncation, and cancellation evidence survive the
  connector boundary and are available to repair flows.
- **Target proof in Trust & Steps.** “How it was answered” reports the selected
  adapter, compiler target, execution target, target fingerprint, preflight,
  executed SQL fingerprint, query ID, and bounded execution receipt.
- **Version-safe setup.** Existing OSS projects must preview and reapply their
  dbt context after upgrading so saved dbt Cloud target binding is refreshed
  for the running CLI version.
- **Supported Node guardrail.** Snowflake runtime diagnostics accept supported
  Node 20, 22, and 24 releases and refuse unsupported Node 26 instead of
  continuing into unstable connector behavior.

### Release exceptions

- Acceptance IDs `CTX-005`, `AGT-014`, `API-006`, `API-007`, `UI-012`,
  `PERF-001`, `E2E-008`, and `E2E-014` are implementer-validated. Independent
  replay against the enterprise Snowflake and dbt Cloud fixture remains
  required before they can be marked verified.
- The tracked `PERF-001` latency exception remains. Bounded discovery and
  streaming remove the observed eager-memory failure mode, but this patch makes
  no GA latency claim.

## v1.10.3 - 2026-07-23

### Governed semantic paths and transparent execution

This patch makes repeated MetricFlow dimensions executable when more than one
entity path can reach the same business dimension, while exposing the complete
semantic decision and execution trace to notebook users.

### Fixed

- **Explicit governed path selection.** dbt Cloud ambiguity responses are
  parsed into stable choices instead of triggering an invented cross-model
  explanation or an unsafe SQL fallback. Users choose the intended entity path
  before DQL executes anything.
- **Runtime-qualified MetricFlow members.** DQL keeps the model-scoped
  authoring identity and records a compiler-owned `@via(...)` selector, then
  emits the exact MetricFlow runtime member such as
  `bcm_ccu_pc__bcm_dtl__report_as_of_dt`.
- **Preview-before-add semantics.** Semantic notebook cells can be added only
  after the selected metric and dimensions compile and execute successfully.
  A changed selection invalidates the previous preview.
- **Trust & Steps execution trace.** “How it was answered” now reports the
  selected adapter, authoring and runtime members, entity paths, compile state,
  execution state, failure details, and governed repair choices.
- **Accurate timeout and refusal behavior.** A timeout no longer claims that a
  cross-model join caused the failure without evidence. Semantic path
  ambiguity returns a clarification request and does not execute or silently
  widen to generated SQL.

### Release exceptions

- Acceptance IDs `AGT-013`, `AGT-014`, `API-006`, `API-007`, `UI-012`,
  `UI-013`, `E2E-008`, `E2E-009`, and `E2E-014` are implementer-validated
  pending independent verification against the enterprise dbt Cloud fixture.
- The existing tracked `PERF-001` latency exception remains unchanged. This
  patch makes no GA latency claim.

## v1.10.2 - 2026-07-23

### Enterprise semantic identity and runtime authority

This patch makes dbt semantic execution preserve the distinction between
business labels, DQL's stable model-scoped identities, MetricFlow group-by
names, and physical warehouse expressions.

### Fixed

- **Model-scoped semantic identity.** Repeated local dimension names remain
  distinct across semantic models. DQL persists references such as
  `customers.customer_name` and resolves a bare alias only when the selected
  metric supplies an unambiguous model context.
- **Adapter-bound qualification.** MetricFlow group-by names such as
  `customer__customer_name` are derived only at the runtime boundary. Business
  labels and physical SQL expressions are never substituted as semantic IDs.
- **Runtime-first compilation.** A tested dbt Cloud or local MetricFlow adapter
  produces the authoritative SQL for semantic notebook, Block Studio, preview,
  and Ask execution. Once selected, adapter failures remain visible and never
  silently downgrade to native SQL.
- **Derived-metric execution.** Derived and other complex metrics route through
  the selected full semantic runtime instead of failing in DQL's native
  composer before that runtime is called.
- **Transparent technical names.** The built semantic explorer displays both
  the business label and exact dbt technical metric or group-by identifier,
  while generated DQL retains the provider-neutral model-scoped reference.
- **Stable failures and retrieval identity.** Import, compatibility, catalog,
  knowledge-graph, and semantic-bridge paths now carry the same canonical
  identity and preserve stable runtime error codes without invented fallback
  objects.

### Release exceptions

- The semantic identity/runtime acceptance set is implementer-validated pending
  independent verification. The maintainer approved this `v1.10.2` release
  with that condition disclosed.
- The existing tracked `PERF-001` latency exception remains unchanged:
  enterprise-scale correctness passes, but this release makes no GA latency
  claim.

## v1.10.1 - 2026-07-22

### Analytical composition and transparent repair

This patch completes the plan-first answer engine by connecting governed metrics
to compatible entity, dimension, member, time, comparison, ranking, and output
roles before execution, then retaining a safe repair path when execution fails.

### Added

- **Analytical composition.** Metric questions now bind entity grain,
  dimension roles, canonical members, governed time/freshness, aligned periods,
  comparisons, ranking/ties, and requested outputs before route execution.
- **Receipt-backed stories.** Analytical numbers, comparisons, ranks,
  freshness statements, and material caveats are generated only from validated
  result facts bound to an execution receipt.
- **Transparent repair.** The built notebook exposes Plan, DQL, Compiled SQL,
  Lineage, Trust & evidence, Actual steps, and Failure & repair for both success
  and failure. Stable redacted errors retain immutable fingerprints and derive
  repairs without widening permissions or mutating the source run.
- **Authorized latest-complete lookup.** Relative periods perform at most one
  route-locked semantic freshness query; warehouse relation and permission
  failures retain their precise stable class.

### Release exceptions

- RFC 0005 acceptance remains implementer-validated pending independent
  verification. The maintainer explicitly approved this `v1.10.1` release.
- The tracked `PERF-001` latency budgets remain above target on the release
  workstation. Correctness and route-parity gates pass; this is a disclosed OSS
  exception, not a GA performance claim.

## v1.10.0 - 2026-07-22

### Plan-first governed analytics answer engine

This release turns analytical questions into a typed, inspectable plan before
execution. Certified metrics remain the preferred path, while deeper questions
can use governed model and column evidence without silently inventing semantic
objects or bypassing policy.

### Added

- **Resolved analytical plans.** Every answer route records the requested
  measures, dimensions, time grain, filters, joins, domains, skills, evidence,
  and execution strategy before SQL is compiled.
- **Governed relational fallback.** When no certified semantic metric covers a
  question, DQL can discover dbt models and columns through exact, BM25,
  embedding, graph, and bounded repository-text evidence, then compile
  exploratory SQL with explicit uncertified status and governance checks.
- **Semantic-model relationship validation.** Metric selection validates its
  owning measures, dimensions, entities, and time dimensions before execution,
  returning actionable incompatibility errors instead of generating guessed
  joins or invalid groupings.
- **Domain- and skill-aware retrieval.** Domains narrow the eligible business
  graph; skills contribute versioned analytical instructions and required
  evidence. Both are carried into answer receipts and route diagnostics.
- **Deep-research governance.** Multi-step investigations retain source,
  transformation, route, and confidence receipts across follow-up queries.
- **Cross-surface plan parity.** Ask, CLI, MCP, and notebook execution share the
  same plan-first routing and governed compilation contracts.
- **OSS dbt reapply on upgrade.** Updating the npm CLI now sends existing users
  to Guided Setup to preview and explicitly reapply their dbt project context
  before answering questions with a changed DQL version.

### Changed

- **Hybrid retrieval remains local.** Semantic embeddings augment the existing
  exact, lexical/BM25, and knowledge-graph indexes; this release does not
  require a second external vector database.
- **Snapshot refresh is explicit.** Connecting or reapplying a dbt project
  rebuilds the immutable context snapshot, while normal questions read that
  versioned snapshot instead of rescanning the repository.

### Known limitations

- The enterprise-scale correctness fixture passes, but the tracked `PERF-001`
  cold-start and warm-context latency budgets remain above target on the release
  workstation. This is an accepted OSS release exception, not a GA performance
  claim; the detailed measurements are recorded in the DQL 2.0 implementation
  evidence.

## v1.8.8 - 2026-07-21

### Ask and Apply execution integrity

This patch gives certified, semantic, and generated answers one executable DQL
contract, so the result shown by Ask and the result produced by Apply cannot be
silently compiled from different source or inputs.

### Fixed

- **Artifacts are finalized before execution.** Ask now executes the same DQL
  source, compiled SQL, parameters, and row bound that it returns to the UI;
  certified results preserve their literal executed source instead of rebuilding
  it afterward from catalog metadata.
- **Apply detects execution drift.** Redacted fingerprints bind source, compiled
  SQL, parameters, and results. Changed source or compiler output is rejected
  with a refresh instruction rather than displaying mismatched data.
- **Saved paths cannot replace transient answer source.** A `sourcePath` remains
  useful metadata, but it no longer overrides the exact DQL source attached to
  an AI answer.
- **Nested aliases remain query-local.** Snowflake aliases such as `subq_2` from
  nested SELECTs are classified as derived relations and excluded from physical
  warehouse probes while their underlying tables are still validated.
- **Top-N is stable across reruns.** Certified, semantic, and generated routes
  execute with the same global limit recorded on the reusable artifact.

## v1.8.7 - 2026-07-20

### Amount aggregation integrity

This patch prevents AI-generated SQL from changing governed amount semantics
through premature rounding, approximate numeric casts, non-additive aggregation,
or proven one-to-many fanout.

### Fixed

- **Financial precision is preserved until final presentation.** Generated SQL
  aggregates native `DECIMAL`/`NUMERIC` values before applying null defaults or
  outer rounding, instead of rounding individual rows before `SUM` or `AVG`.
- **Unsafe amount SQL is blocked before execution.** The agent and exploratory
  CLI lanes reject premature rounding, lossy floating-point casts, proven
  fanout, and hand aggregation of non-additive semantic measures; one bounded
  repair may produce a safe native-grain query.
- **Wrapped aggregates retain source lineage.** Expressions such as
  `SUM(ROUND(COALESCE(amount, 0), 2))` are attributed to their source relation
  and column so deterministic grain checks cannot be bypassed by wrappers.
- **Semantic metric contracts survive retrieval.** Knowledge-graph objects now
  retain backing measures, aggregation, time-grain, and non-additive metadata so
  Ask can preserve the governed calculation even in metric-only context.

## v1.8.6 - 2026-07-20

### Reliable governed metric compilation

This patch repairs two deterministic orchestration gaps that could make valid
MetricFlow and Snowflake queries fail before execution.

### Fixed

- **Offset metrics include their required time grain.** The shared semantic
  runtime detects dbt metric offset metadata and adds `metric_time` at the
  appropriate grain for Ask, Notebook, Block Studio, local MetricFlow, and dbt
  Cloud without overriding an explicit user selection.
- **Generated CTE aliases stay query-local.** Quoted aliases such as
  `"subq_2"` are classified as CTEs instead of Snowflake tables, so bounded
  validation probes only real warehouse relations.
- **Governed compiler failures do not trigger noisy replanning.** Once an exact
  governed metric reaches its semantic runtime, a compiler failure is returned
  as an actionable governed error rather than causing another AI selection pass
  or silently falling through to exploratory SQL.

## v1.8.5 - 2026-07-20

### Managed MetricFlow setup

This patch lets dbt users install and activate a compatible local MetricFlow
runtime directly from Guided Setup or Settings, with the same actionable path
available wherever a runtime-owned semantic metric is disabled.

### Added

- **Managed local MetricFlow setup.** Settings and Guided Setup can install a
  DQL-tested MetricFlow runtime into an isolated project-local environment,
  show progress and redacted diagnostics, activate it without a server restart,
  and leave system Python and existing dbt environments untouched.
- **Actionable disabled metrics.** Notebook, Build, and Block Studio explain
  why a complex metric is unavailable and navigate directly to the shared
  semantic-runtime setup instead of relying on a tooltip or terminal command.

## v1.8.4 - 2026-07-20

### Enterprise semantic execution and reusable Ask inputs

This patch gives imported dbt semantic metrics one consistent execution path
across Ask, Notebook, and Block Studio, while restoring parameterized certified
answers that can be inspected and rerun without another AI planning pass.

### Added

- **Shared semantic runtime selector.** Supported metrics compile natively;
  derived and MetricFlow-owned definitions can use a compatible local
  MetricFlow CLI or tested regional dbt Cloud Semantic Layer connection.
- **Enterprise semantic setup and capability states.** Settings tests and saves
  redacted dbt Cloud credentials, and semantic discovery reports whether each
  metric is ready, requires setup, or is unsupported without hiding it.
- **Scalable semantic selection.** Block Studio and the notebook use indexed,
  model-aware metric and dimension trees designed for thousands of members.
- **Typed certified-block invocation parity.** Ask, Notebook, native tools, CLI,
  and MCP share one values-only parameter contract with question and
  prior-result provenance.

### Fixed

- **Ask retains reusable DQL inputs.** Certified result cards show applied
  parameter values and the shared input controls; Apply reruns the saved block
  directly instead of starting another AI search.
- **Semantic metrics no longer degrade into guessed leaf SQL.** Runtime-owned
  derived, ratio, cumulative, and non-additive metrics either compile through
  their configured adapter or return an actionable setup state.
- **Repeated dimensions remain model-qualified.** Common names such as
  `report_date` resolve through the selected metric's owning semantic model,
  avoiding ambiguous-column SQL.
- **Generated SQL validation respects the active warehouse dialect.** Valid
  Snowflake and Databricks syntax is checked with the configured dialect while
  malformed SQL still fails before execution.
- **Block Studio refresh is truthful and automatic.** Large semantic catalogs
  show loading/setup status accurately, saved blocks refresh compiled lineage,
  and focused block views avoid unrelated graph noise.

## v1.8.3 - 2026-07-20

### Durable agent runs and coherent retrieval diagnostics

This patch hardens the local governed-agent runtime, exposes actionable search
health, and aligns the MCP and Claude Code tool surfaces used for retrieval and
SQL validation.

### Added

- **SQLite-backed agent run history.** Governed runs are retained in a bounded,
  WAL-enabled local store, with one-time migration from the legacy JSON file and
  compact event retention for older runs.
- **Retrieval health diagnostics.** The local health API and `dql doctor` report
  value-grounding mode, embedding capability, metadata catalog/context-pack
  state, run-store size, and immutable snapshot growth without exposing secrets.
- **Complete governed discovery tools.** MCP and Claude Code expose metadata
  search, table-schema inspection, and SQL validation through the same agentic
  registry used by the runtime.

### Fixed

- **Tool recommendations only name callable tools.** Ask responses no longer
  advertise a phantom clarification tool, and deprecated block generation is
  explicitly represented as an alias.
- **Retrieval degradations remain advisory.** Lexical embedding fallback,
  disabled value grounding, or a cold catalog are visible in `dql doctor`
  without incorrectly failing an otherwise healthy installation.

## v1.8.2 - 2026-07-20

### Grounded follow-ups and semantic notebook execution

This patch strengthens governed AI follow-ups so entity values remain bound to
the user request, improves multi-concept ranking safety, and makes imported dbt
semantic metrics easier to compose and execute from the notebook.

### Added

- **Typed member bindings across the answer loop.** Named customers, products,
  regions, and other result values are preserved as immutable request evidence
  through planning, block selection, SQL generation, repair, and validation.
- **Notebook semantic composer.** Users can search imported metrics and
  dimensions, inspect execution readiness, and insert a valid semantic query
  source without manually composing internal syntax.
- **Bounded repair accounting.** Regrounding, validation, and execution retries
  now have separate budgets and visible progress instead of sharing one opaque
  retry counter.

### Fixed

- **Generated SQL cannot silently drop or move member filters.** Validation
  rejects missing bindings and filters attached to the wrong dimension, while
  deterministic injection safely restores unique predicates on an existing
  governed query path.
- **Ranked questions preserve every requested grouping.** Product-by-region and
  similar questions must return both concepts, including governed semantic
  aliases such as a location dimension used for a requested region.
- **Certified blocks are selected by actual fit.** Broad customer or product
  blocks no longer win solely because their names overlap a follow-up question;
  grain, outputs, filters, and typed member coverage participate in routing.
- **dbt semantic execution status stays honest.** Imported MetricFlow and native
  semantic definitions expose whether they can run locally and retain their
  source metadata across refreshes.

## v1.8.1 - 2026-07-19

### Reliable dbt semantic discovery and upgrade preparation

This patch repairs projects where database objects were visible but dbt semantic
metrics were missing, and keeps the governed agent snapshot current after CLI
upgrades without adding work to normal warm restarts.

### Fixed

- **dbt semantic metrics load across enterprise project layouts.** MetricFlow
  artifacts may use array or object collections, dbt projects may use absolute
  roots, custom manifests, `target-path`, and `model-paths`, and source semantic
  YAML remains discoverable when compiled artifacts contain only technical models.
- **Setup and Settings see semantic changes immediately.** dbt Apply, Refresh,
  artifact changes, and manual reload now share one live semantic configuration;
  a failed reload preserves the last valid semantic layer.
- **CLI upgrades silently refresh governed search state.** A project-local runtime
  marker invalidates stale snapshots and indexes once per installed CLI version,
  rebuilds them in the background, and keeps ordinary restarts on the warm cache.

## v1.8.0 - 2026-07-19

### Enterprise domain context and faster governed AI orchestration

This release connects DQL manifests, dbt metadata, domain knowledge, governed
skills, and cross-domain lineage into one bounded retrieval path for accurate,
lower-latency answers at enterprise catalog scale.

### Added

- **Compiled knowledge graph and domain-skill references.** Manifests now carry
  compact, stable references across domains, products, models, metrics, blocks,
  relationships, and skills without embedding full skill documents.
- **Cross-domain technical and business lineage.** Domain views and lineage APIs
  expose connected dbt models, semantic metrics, governed blocks, and downstream
  products as one end-to-end graph.
- **Enterprise-scale modeling search.** The dbt-first modeler adds indexed model,
  relationship, and column search designed for thousands of models instead of
  relying on long select lists.
- **Bounded knowledge-context retrieval.** The agent loads only the ranked domain
  context and governed skill excerpts relevant to a question, with deterministic
  budgets and scale coverage for large manifests.

### Fixed

- **Follow-up questions use conversational data context.** Entity names, pronouns,
  result references, and phrases such as “this amount” are resolved before object
  retrieval instead of being mistaken for schema objects.
- **Governed evidence stays ahead of generated SQL.** Certified blocks and semantic
  metrics are selected when they satisfy the requested grain; generated SQL is the
  fallback, not the default route.
- **Failed governed SQL can recover safely.** Binder failures and ambiguous-column
  errors fall through to a grounded repair path instead of trapping the answer loop.
- **Less planning and retrieval noise.** Duplicate meaning calls, stale clarification
  state, prior result-value pollution, and unnecessary time/filter assumptions are
  removed from the orchestration path.
- **Business-readable results.** Ranking direction, compound labels, numeric and
  currency formatting, and answer synthesis now stay aligned with executed rows.

---

## v1.7.0 - 2026-07-16

### Governed agentic analytics: AI-drafts/human-certify onboarding, enforced trust, and data freshness

This release makes DQL a governed agentic-analytics layer end to end: AI proposes
draft analytics from your dbt evidence, humans certify, and the agent answers
certified-first with honest trust labels — never presenting generated or stale
results as certified. Everything here is OSS and local-first.

### Added

- **`dql propose` — AI drafts, humans certify.** Scans your dbt evidence
  (`manifest.json`, `catalog.json`, semantic metrics) and generates a value-ranked
  queue of **draft** blocks with inferred grain, pattern, outputs, and `llmContext`.
  Every proposal is run through the certifier and stored as `draft` — nothing is
  ever auto-certified.
- **Get Started onboarding flow** in the notebook — a readiness scan that surfaces
  the ranked draft proposals with trust badges and a per-draft "what's missing to
  certify" summary, routing each into the existing Review & Certify queue.
- **`dql eval` — routing-accuracy harness.** Replays each block's `examples` (plus
  optional `eval/*.yaml`) through the agent router and scores route, block
  selection, and grain match across the certified / generated / insufficient-context
  / conflict / wrong-grain cases. CI-gateable.
- **Canonical trust-label vocabulary** — `Certified`, `Reviewed`, `AI-Generated`,
  `Insufficient-Context`, and `Conflict`, modeled as a base label plus optional
  qualifier and consumed consistently across the MCP server, agent, and UI.
- **Definition-conflict detection** — two certified terms or blocks that claim the
  same concept/grain but disagree are flagged at compile time and routed as a
  `conflict` (the agent surfaces both definitions and asks, instead of guessing).
- **Runtime invariant enforcement** — a block's declared `invariants` now execute
  against results at run and certification time. A violation blocks certification
  and downgrades the label to "Certified · invariant violated".
- **Grain / contract gate** — the agent refuses to serve a near-miss certified block
  whose grain doesn't match the question, demoting to a labeled generated query
  instead of a confidently-wrong governed answer.
- **Show-your-work** — a consumer-facing derivation walk (value → block →
  metric/term → dbt model → owner / review cadence / freshness), with depth hidden
  by default.
- **Freshness-aware trust** — folds dbt `run_results.json` and source freshness into
  a block's effective trust: a certified block over a failed or stale upstream shows
  "Certified · upstream failed" / "Certified · stale data".
- **Output-contract drift detection** — a new additive `outputContract` field;
  `dql compile`/`dql doctor` **warn** (never block) when a block `ref()`s a child
  column that no longer exists, keeping freeform composition safe.
- **Impact & re-cert gate** — `dql diff --impact` reports a changed block's full
  transitive downstream, the affected cross-domain edges, the `domainTrust` delta,
  and the certified artifacts that need re-certification; exits non-zero in CI when
  certified downstream is invalidated.
- **Scoped correction memory** — Git-versioned, approved-only hints (scoped to a
  metric / model / domain / dialect) compiled into the agent knowledge graph, so
  reviewed corrections improve future drafts without weakening certification. Plus a
  pluggable `EmbeddingProvider` (offline default) for hybrid retrieval.

### Fixed

- **The redesigned application is wired end to end.** Ask AI, notebooks, Block
  Studio, Apps, domains, source control, Setup, and Settings now use the same
  project metadata, database connection, AI-provider state, and governed answer
  flow. Setup recognizes an existing workspace without overwriting its saved
  database or provider, and the Notebook catalog matches Block Studio.
- **Ask AI now returns business-readable, result-grounded explanations.** The
  response layer summarizes actual query results, keeps tables and charts in the
  conversation, moves technical evidence into the detail surface, and shares the
  same DQL-generation and follow-up behavior with Notebook and Block Studio AI.
- **AI-generated SQL is grounded in the real warehouse.** Generated SQL used bare
  table names (`FROM order_items`) that don't exist (`Catalog Error … did you mean
  "dev.order_items"?`). Both SQL paths now share one grounding layer: tables are
  presented as their qualified relation (`db.schema.table`) and `{{ ref() }}` form
  with real columns + join keys, only the relevant tables are retrieved, a
  deterministic resolver rewrites any bare name to its real relation, and the result
  is validated + repaired (re-prompted on a miss) before it runs — so the build path
  gets the validation the governed answer-loop already had.
- **Skills — teach the AI your business context.** A new **Skills** page lets you add,
  edit, and delete project-wide and personal "skills" (definitions, rules, vocabulary,
  preferred metrics/blocks) saved as Git-versioned `.dql/skills/*.skill.md`. `dql init`
  seeds three editable starters (a metrics glossary from your semantic layer, SQL
  conventions, and a domain-rules template). The agent applies the relevant skills per
  question and shows "guided by <skills>" on its answers.
- **Proposals show their work before you approve.** Each Get Started proposal now
  expands to the **SQL it will run**, its output columns, example questions, and a
  plain "what's missing to certify" — fetched on demand. You approve what you can
  see, not a checkbox.
- **One AI "Build", two destinations — and no more confusing AI dump.** "Ask AI to
  build a block" no longer routes through the governed Q&A answer-loop (which leaked
  its internal self-correction, evidence tiers, review-status churn, and named blocks
  after the literal question). Build is now its own surface: describe what you want →
  a clean result card with a **Cell ⇄ Block** toggle. Cell inserts SQL into the
  notebook; Block writes a complete, **semantically-named** draft
  (`orders_by_location_daily`, not `can_you_build_the_total_orders…`) with grain,
  outputs, examples, and "what's missing", then opens in Block Studio. The Notebook AI
  panel keeps **Ask** (governed Q&A) and **Build** as distinct modes.
- **A local owner identity, so nothing is born "missing owner".** A default owner is
  resolved once (git `user.email` → OS user → `guest@local`) and stamped on every
  draft (`propose`, generate, AI build); the UI shows "drafting as <owner>".
- **`dql propose` is now business-first and selective (was a `SELECT *`-per-model
  dump).** A convention-agnostic classifier (dbt `meta` → exposures → semantic
  manifest → folder/path → tags → name, configurable via a `propose` block in
  `dql.config.json`) splits the warehouse into a business layer and excluded
  plumbing, ranks cheaply across all models but runs inference + the Certifier only
  on a bounded per-domain selection (scales to thousands of models), and generates
  **real aggregation SQL** for semantic-metric models / narrowed projections for
  entity marts — never a passthrough per model. Get Started now shows a deterministic
  **plan** (domains, "will generate N / skip M", per-candidate evidence) that writes
  nothing until you **Approve & Generate** the scope you pick. On jaffle: 13 scanned →
  7 business, 6 staging excluded, 19 metrics detected.
- **Optional AI enrichment for proposed drafts (content only).** When "Approve &
  Generate" runs with an AI provider configured (`propose.aiEnrichment`), each
  drafted block's `llmContext` and example questions are written by the model, and a
  `description` is generated for models dbt left undescribed — a real human-authored
  dbt `description` always wins. Structure (classification, grain, outputs, SQL,
  invariants) stays fully deterministic; enrichment is best-effort with a timeout and
  falls back to dbt-derived content offline, so nothing requires a provider.
- **`dql propose --enrich`** brings the same AI enrichment to the CLI (off by default
  so CLI runs stay deterministic/CI-reproducible).
- **`dql init` auto-wires the DuckDB connection from the dbt project dir.** When the
  `.duckdb` lives next to `dbt_project.yml` a level up from the DQL workspace (the
  common layout), init now finds it and writes a workspace-relative connection
  (e.g. `../warehouse.duckdb`) instead of reporting "DuckDB file: none".
- **Clearer error when a query hits a missing table.** A DuckDB "table does not
  exist" / catalog error now appends a hint that the database may be empty or the
  connection may point at the wrong `.duckdb` file (run `dbt build` to populate it).
- **The Review & Certify queue lists draft blocks (was always empty).** It read only
  `apps/*.dql-app` apps, so the standalone draft blocks `dql propose` writes never
  appeared ("No Apps or drafts are waiting for review"). It now lists every draft /
  in-review governance block with its status, and each row opens that block in Block
  Studio to preview, edit, run tests, and certify. Nothing certifies automatically.
- **`dql agent ask` starts its own runtime.** It no longer assumes a notebook server
  on a hardcoded `127.0.0.1:3474` (which collides with unrelated services — e.g.
  Docker, whose health check returns `{"status":"ok"}` — producing a misleading "no
  database connection" error). With no `--runtime-url`/`DQL_RUNTIME_URL` it now starts
  an ephemeral runtime bound to the project on a free port and closes it on exit; an
  explicit runtime URL is validated as a real DQL runtime before use.
- **Lineage no longer self-references a block that wraps its own dbt model.** A block
  named after the dbt model it `ref()`s (e.g. `block "customers"` →
  `ref('customers')`) used to appear as its own upstream and downstream, distorting
  `dql lineage --impact` and risking false cycles. The dependency now resolves to the
  dbt-model node (`dbt_model:customers → block:customers`).
- **`dql propose` drafts are sharper.** Generated `examples` are now concrete business
  questions ("How many customers are there?", "What is the total <measure> per
  <entity>?") instead of a generic "What does X contain?", and the uncheckable
  `row_count >= 0` invariant is no longer emitted (row-count coverage lives in the
  block's tests; the runtime invariant evaluator only sees result columns).
- **Notebook no longer crashes (OOM) on every query.** The DQL parser could
  infinite-loop on input it didn't recognize — including the raw SQL the cell
  executor feeds it (e.g. `SELECT COUNT(*) …`) — exhausting the heap and killing the
  notebook runtime. The parser now guarantees forward progress and terminates on any
  input; a regression test exercises raw SQL and non-DQL text.
- **Local DuckDB connector works on the latest `duckdb` (1.4.x).** `COUNT(*)`/`SUM`/id
  results come back as `BIGINT`; the driver coerces them to numbers before marshaling
  and `serializeJSON` carries a BigInt replacer, so the full local path is BigInt-safe
  (verified on real data across UUID/BIGINT/decimal/datetime columns). The install spec
  is unpinned (`duckdb@^1.1.0`, latest 1.x) — no version pin needed.
- **dbt-profile DuckDB path now resolves against the dbt project, not the DQL
  workspace.** A relative `path:` in `profiles.yml` (e.g. `jaffle_shop.duckdb`) was
  resolved against the DQL workspace dir, so DuckDB silently opened/created an empty
  database and every query failed "table does not exist". The imported connection now
  resolves to an absolute path under the dbt project dir and warns when the file
  doesn't exist yet.
- **dbt import + freshness on the standard staging + mart layout.** The selective
  dbt import anchored **0 models** when a staging model's role-prefix-stripped alias
  (`stg_customers` → `customers`) collided with a same-named mart, which also
  prevented freshness-aware trust from surfacing. Anchor resolution now prefers exact
  model names; freshness resolution matches schema-qualified block refs
  (`dev.customers`) and treats upstream nodes with no run record (e.g. raw sources)
  as neutral rather than `unknown`.

### Notes

- Certification remains a **local** trust label. Organization-wide approval
  workflows, audit logs, and permission-aware retrieval are part of the commercial
  cloud product, not OSS.

---

## v1.6.17 - 2026-06-18

### Notebook startup patch

### Fixed

- Notebook startup no longer invents a hidden DuckDB-backed `file/:memory:`
  connection when a project has no default connection.
- Fresh projects can open the notebook UI before DuckDB or Snowflake optional
  connector packages are installed.
- Schema/catalog startup endpoints now degrade to project/file metadata when no
  runtime connection is active, while SQL execution returns a clear connection
  setup message.

---

## v1.6.16 - 2026-06-18

### MCP agent readiness for Claude Code and Codex

### Added

- `dql connect` configures Claude Code, Codex, Claude Desktop, Cursor, or all
  supported MCP clients from a DQL project.
- `dql mcp test` verifies manifest loading, metadata catalog freshness, the
  agent index, and the MCP tool surface before users ask an external agent.
- The DQL MCP server now exposes front-door workflow tools:
  `inspect_dql_project`, `ask_dql`, `build_dql_block`, and `build_dql_app`.

### Changed

- Generated Claude Code and Codex setup is project-local and includes
  `CLAUDE.md` / `AGENTS.md` guidance so agents route questions through DQL
  trust rules before writing SQL.
- Starter projects ignore generated local agent config files such as
  `.mcp.json`, `.codex/`, and `.cursor/`.
- MCP documentation and the starter README now show the full Claude/Codex
  testing path.

---

## v1.6.1 - 2026-06-10

### OSS release: clean foundation, external example, UI polish

### Changed

- **Repo restructured dbt-core style — no bundled example projects.**
  Removed `examples/` and the `acme-bank` / `jaffle-shop` templates;
  `create-dql-app` now ships a single `starter` template (the default) that
  auto-wires a detected dbt project. The example dbt project lives in its own
  repo: [jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb).
- Quickstart and README rewritten around two entry points with identical
  steps: your own dbt repo, or the cloned example repo
  (`create-dql-app` → `dql sync dbt` → `dql notebook`).
- Tutorials condensed from 11 to 5 (getting started, authoring blocks,
  dashboards & Apps, agentic analytics, CI & verify) and re-based on the
  example repo; troubleshooting moved to `docs/guides/troubleshooting.md`.
- Docker starter now scaffolds the minimal starter project instead of the
  removed Acme Bank template.

### Fixed

- `create-dql-app` no longer runs `git init` inside an existing git repo
  (previously nested a repo when scaffolding `./dql` inside a dbt project).
- Results table renders DATE values as `YYYY-MM-DD` instead of raw ISO
  timestamps; timestamps render as `YYYY-MM-DD HH:MM:SS` (exports keep raw
  values).
- Chart x-axis date labels are formatted in UTC — month boundaries no longer
  shift a day backwards in western timezones; line/area charts gained axis
  titles and date-aware tooltips.
- Notebook cell editor no longer paints a tinted slab behind the code: the
  always-on active-line highlight is now focus-scoped and the editor inherits
  the cell surface.
- Header is view-aware: static titles for Apps/Review/Settings/Source control
  and editor-only actions (Run all, Save, Share) hidden outside editor views.
- Sidebar panel headers wrap instead of overlapping their action buttons;
  Block Studio start cards and dbt-status panels reflow at narrow widths.
- Lineage side panel groups dashboards under "Dashboards" (was "Notebooks");
  row/duration counters use correct pluralization and rounded timings.
- Tutorial sample code used an inline `visualization { ...; ... }` form the
  parser rejects; corrected to the canonical multi-line form.
- `SECURITY.md` supported-versions table updated to 1.6.x/1.5.x.

### Added

- Privacy & telemetry disclosure in the README (off by default, no PII,
  `DO_NOT_TRACK` honored).
- Lineage fixture (`apps/cli/test/fixtures/lineage-app`) preserving
  source → block → dashboard → App compile coverage after the template
  removal.

## v1.6.0 - 2026-05-01

### Graduated trust + contracts

### Added

- **Graduated trust + Tier-2 promotion loop**: agent answers route through
  certified blocks first (Tier 1); LLM proposals are flagged *Uncertified*,
  saved as drafts under `blocks/_drafts/`, and promoted via
  `dql certify --from-draft` (optionally `--open-pr`).
- DataLex contracts end-to-end: certified blocks can cite a contract id;
  `--contract <id@version>` binding on certification.
- Column-level lineage extraction with honest `unresolved` marking.
- MCP server test coverage and tool hardening.
- `datalex-lsp`: schema-aware language server for `.model.yaml` semantic
  definitions.
- OpenLineage event emission for project snapshots.
- mkdocs-material public docs site.
- Community files: issue templates, PR template, support/triage policy.

## v1.5.3 - 2026-04-30

### OSS release candidate polish

### Added

- dbt-first Block Studio guide covering SQL blocks, semantic blocks, SQL import,
  certification, and lineage.
- OSS readiness checklist sections for Block Studio and Apps UX release gates.

### Changed

- Updated README and docs to position DQL as a local-first dbt companion where
  dbt owns models/semantics and DQL owns certified blocks, Apps, notebooks,
  AI pins, and answer-level lineage.
- Updated project layout docs to describe Apps as View/Build surfaces with
  dashboard pages, attached notebooks, AI conversations, pins, and drafts.
- Clarified that Import SQL is a Block Studio wizard, not a separate primary
  navigation area.

### Fixed

- Fixed standalone preview for `single_value` block visualizations by lowering
  them to KPI output.
- Fixed semantic analyzer validation so `@rls` decorators on block declarations
  pass the same way they do in notebook/App execution.

---

## v1.5.1 - 2026-04-29

### OSS app workspace structure and dbt repo onboarding

This patch publishes the OSS single-user App workspace flow on top of the
1.5.0 agentic Apps release.

### Changed

- Clarified OSS product language around local Apps, policies, personas, and
  commercial boundaries.
- Updated docs for the recommended isolated `./dql` folder inside existing dbt
  repositories.
- Added clean dbt-style init/compile/sync readiness coverage and release
  checklist updates.
- Bumped starter templates to use `@duckcodeailabs/dql-cli@^1.5.1`.

---

## v1.5.0 - 2026-04-27

### Agentic analytics evidence, app builder, and local-first AI setup

This release turns the first DQL agent surface into a governed analytics
workflow: certified assets first, semantic/dbt fallback second, and generated
answers clearly labeled for analyst review. It also makes Apps a stronger
stakeholder surface with editable layouts, local AI pins, scoped lineage, and
provider setup in Settings.

### Added

- Governed answer envelopes with source tier, certification state, SQL/result
  metadata, citations, confidence, review state, and evidence tabs.
- Evidence view for agent answers: Answer, Chart, Data, Lineage, Business
  Context, SQL / Block, and Review.
- Certified-first agent routing across certified blocks/dashboards/apps,
  semantic/dbt metadata, and manifest-backed SQL fallback.
- Local agent memory storage and Settings UI for scoped project/user/artifact
  memory.
- Provider setup cards for OpenAI, Gemini, Ollama, and custom OpenAI-compatible
  endpoints, with local Settings-backed provider selection.
- App Builder edit mode with Add tab, Add tile, text/summary tiles, section
  headings, domain-scoped certified block catalog, drag handles, size presets,
  and auto-packed layout movement.
- Local AI pins for Apps with refresh cadence, citations, review status, and
  promote-to-draft-block path.
- Add-to-App choices for AI answers: Chart + data, Chart only, or Data table.
- Scoped App lineage from Domain -> App -> Dashboard -> Tile -> Block ->
  semantic/dbt/source nodes.
- dbt semantic manifest and semantic YAML ingestion improvements.

### Changed

- Dashboard/App chat now uses the provider configured in Settings instead of
  asking users to pick a provider in every chat surface.
- App chat is a sticky, viewport-bounded side drawer with expand/collapse and
  close controls so the input remains visible.
- Chat answer cards are compact by default in App/Dashboard mode and keep route
  details out of the primary answer tab.
- Certified block answers can execute and return result data when the runtime
  host provides governed execution.

### Fixed

- Ollama/provider configuration persistence and default provider resolution.
- `@block("...")` execution path for block-backed notebook usage.
- Duplicate Add menus in empty App tabs.
- App dashboard AI pins previously added only chart views even when result rows
  were available.
- Lineage labels and notebook/dashboard node typing in scoped lineage views.

---

## v1.4.0 — 2026-04-25

### Apps, Agentic Analytics, programmable end-to-end DQL

A major scope expansion landing the consumption layer (Apps + first-class
dashboards), an OSS block-first agent (knowledge graph + Skills + multi-provider),
a Slack front-end, and CI-grade reproducibility. Identity stays single-user
in OSS; RBAC declarations are programmable and enforced via persona switching.

See `docs/tutorials/` for hands-on walkthroughs (Acme Bank scenario).

### Added

- **Apps** — first-class consumption-layer artifact at `apps/<id>/dql.app.json`.
  Members + roles + access policies + RLS bindings + schedules + homepage,
  validated by [`packages/dql-core/src/apps/app-document.ts`](packages/dql-core/src/apps/app-document.ts).
- **Dashboards (`.dqld`)** — first-class grid-layout artifact distinct from
  notebook-as-dashboard, validated by [`packages/dql-core/src/apps/dashboard-document.ts`](packages/dql-core/src/apps/dashboard-document.ts).
  Block refs by id or path; viz config per tile; params + filters.
- **Persona registry** — runtime active-user state in
  [`packages/dql-project/src/persona.ts`](packages/dql-project/src/persona.ts).
  Drives the existing PolicyEngine + a new
  [`personaVariables()`](packages/dql-project/src/persona-variables.ts) helper
  that supplies template values to `executor.executeQuery`'s `variables` map,
  so `@rls("col", "{user.var}")` decorators resolve at execution time.
- **Manifest extensions** — `apps[]`, `dashboards[]`, `ManifestApp`,
  `ManifestDashboard` in [`packages/dql-core/src/manifest/types.ts`](packages/dql-core/src/manifest/types.ts).
  Builder cross-checks homepage + schedule references and surfaces unresolved
  block refs as diagnostics.
- **Lineage** — populates the previously-reserved `app` node type and
  `dashboard → app` `contains` edges, completing the chain
  `Domain → App → Dashboard → Block → metric/dimension → dbt_model → source`.
- **SQLite registries** — `app_registry` + `dashboard_registry` tables in
  [`packages/dql-project/src/sqlite-storage.ts`](packages/dql-project/src/sqlite-storage.ts)
  for fast queries from the API layer (file format remains source of truth).
- **CLI: `dql app new|ls|show|build|reindex`** — see
  [`apps/cli/src/commands/app.ts`](apps/cli/src/commands/app.ts).
- **API endpoints** — `GET/POST /api/apps`, `/api/apps/:id`,
  `/api/apps/:id/dashboards/:did`, `/api/persona` in
  [`apps/cli/src/apps-api.ts`](apps/cli/src/apps-api.ts).
- **Desktop UI** — new `mainView: 'apps'` with
  [`AppsView`](apps/dql-notebook/src/components/apps/AppsView.tsx),
  [`PersonaSwitcher`](apps/dql-notebook/src/components/apps/PersonaSwitcher.tsx),
  and [`DashboardRenderer`](apps/dql-notebook/src/components/apps/DashboardRenderer.tsx)
  wired into `AppShell` + the activity bar.
- **`@duckcodeailabs/dql-agent`** — new package with:
  - SQLite + FTS5 knowledge graph at `.dql/cache/agent-kg.sqlite`,
    built from manifest + Skills.
  - Skills loader for `.dql/skills/*.skill.md` (YAML frontmatter +
    markdown body).
  - Block-first answer loop: certified blocks first, otherwise LLM-proposed
    SQL marked Uncertified and routed through analyst review.
  - Provider abstractions for Claude, OpenAI / OpenAI-compatible, Gemini,
    and local Ollama, with automatic `pickProvider()` fallback.
  - `getPromotionCandidates()` — surface uncertified answers ready for
    certification.
- **MCP tools** — `kg_search` and `feedback_record` join the existing 8
  tools (`search_blocks`, `get_block`, `query_via_block`, `list_metrics`,
  `list_dimensions`, `lineage_impact`, `certify`, `suggest_block`) in
  [`packages/dql-mcp/src/tools/kg.ts`](packages/dql-mcp/src/tools/kg.ts).
- **CLI: `dql agent ask|reindex|feedback`** — block-first answer loop on the
  command line, see [`apps/cli/src/commands/agent.ts`](apps/cli/src/commands/agent.ts).
- **`@duckcodeailabs/dql-slack`** — new package with a slash-command bot,
  Slack signature verification, Block-Kit reply formatting, and feedback
  buttons.
- **CLI: `dql slack serve`** — boots the bot.
- **CLI: `dql verify`** — proves `dql-manifest.json` is reproducible from
  source. Non-zero on drift; structured diagnostic; CI-ready.
- **Tutorials** — full Acme Bank walkthrough at `docs/tutorials/` covering
  setup, authoring, Apps + RBAC + personas, dashboards, schedules + Slack,
  agentic analytics, end-to-end fraud spike, promoting AI to certified,
  CI + verify, troubleshooting.
- **Tests** — 31 new tests across the new code (12 app-document, 6 dashboard-
  document, 6 persona, 3 manifest scan, 21 dql-agent, 8 dql-slack). All 489
  workspace tests green.

### Changed

- `dql app new` now scaffolds the new programmable schema (`dql.app.json`
  with members/roles/policies/RLS bindings/schedules) instead of the
  earlier `app.yml`-based prototype.
- `dql-mcp` now depends on `dql-agent` for the KG-backed tools.
- `ROADMAP.md` updated — multi-user identity / hosted SSO remains closed
  product; agent + apps + RBAC declarations are now OSS.

### Out of scope (still closed product)

- Real authentication (login screens, OIDC, password storage)
- Hosted cloud / multi-tenant deployment
- Approval workflows or run history as a managed service

---

## v1.0.3 — 2026-04-21

### v0.11 — Block-First Notebook (Tracks 1–6)

Collapses three authoring paths (notebook SQL, notebook DQL, Block Studio) into one mental model: **every notebook cell is a draft block; blocks are live-referenced with `bound` / `forked` state; promotion is certification-gated**.

### Added
- **Unified `@metric()` / `@dim()` resolver** — notebook SQL cells now resolve semantic refs the same way Block Studio does. `SELECT @metric(revenue) FROM @dim(date)` runs against the warehouse instead of throwing.
- **Block Picker as primary palette tile** — `Block` is the left-most tile in the Add-Cell palette; picking a block drops a **bound cell** (live reference, not `@include` SQL).
- **Semantic-aware cell pickers** — Chart / Pivot / SingleValue / Filter pickers read `QueryResult.semanticRefs` and show typed icons (`# metric`, `∴ dimension`, `abc column`); falls back to inference with a "no semantic binding" nag strip.
- **Save-as-Block governance gate** — `SaveAsBlockModal` runs `BUILTIN_RULES` inline; missing owner / domain / description blocks the save. Git metadata (commit SHA, repo, branch) auto-captured and written to the companion YAML.
- **Bound-cell state model** — `BlockBinding { path, commitSha?, version?, state, originalContent? }` on each cell. Green chrome for `bound`, yellow for `forked` after a local edit. Inline chip with path · 🔒 · Revert (forked only) · Unbind.
- **Bound cells in lineage** — bound cells flow into the lineage graph as `block:<name> → dashboard:<notebook>` edges. Draft SQL cells stay excluded (design preserved).

### Changed
- Palette surface: dropped `Python` / `Map` / `Writeback` "coming soon" tiles and the legacy `DQL block` entry; single row, block-first ordering.
- `SingleValueCell` / `ChartCell` / `PivotCell` / `FilterCell` empty states rewritten to guide the user toward the upstream cell.
- Git metadata moved from `.dql` block body into companion YAML (DQL parser drops unknown tokens; body now only carries parser-known keys).

### Fixed
- Notebook SQL cells containing `@metric()` / `@dim()` previously failed with a raw warehouse error. Resolver is now shared between the notebook path and the Block Studio path.
- `workspace:*` dependency resolution (retained from v0.8.2): release script rewrites to real `^x.y.z` before publish.

---

## v0.8.7 — 2026-04-14

### Added
- **14-driver schema introspection** — all database connectors now implement `listTables()` and `listColumns()` with a 3-tier fallback strategy (information_schema → connector methods → lazy loading)
- **Connection hot-swap** — changing the database connection via the notebook Connection Panel or `PUT /api/connections` re-initializes the executor at runtime without restarting the server
- **Block Studio improvements** — save guard opens NewBlockModal when metadata is missing, save/catalog errors shown as inline banners with retry, sidebar no longer forced closed
- **`dql doctor` notebook asset check** — verifies the notebook SPA assets (`index.html`) are bundled correctly
- **`dql --version` / `-V` flag** — prints the CLI version
- **Driver-aware welcome notebook** — `createWelcomeNotebook()` generates database-specific SQL (`SHOW TABLES` for DuckDB, `information_schema` for Postgres/Snowflake/etc.)
- **Semantic import uses project config** — re-resolve after import uses `dql.config.json` provider, not hardcoded `'dql'`
- **`/api/describe-table` endpoint** — lazy column loading for the schema sidebar and Block Studio
- **Type-colored column badges** — shared color utility for schema browser (blue=string, green=number, pink=boolean, gold=date, purple=json)

### Documentation
- **README rewrite** — three clear install paths (DQL-only, Jaffle Shop, Enterprise), Block Studio section, version 0.8.7
- **Quickstart rewrite** — two-track guide (Path A: DQL-only 2min, Path B: dbt+Jaffle Shop 5min) with Block Studio walkthrough
- **Getting Started rewrite** — fixed stale table references, added Block Studio step-by-step (Step 7), clarified auto-import behavior
- **NEW: Enterprise Getting Started** — 11-step guide for teams with existing dbt repos and production databases (Snowflake, Postgres, BigQuery, etc.)
- **Examples rewrite** — three-path table, Block Studio in learning path, parameterized block examples
- **Semantic Layer Guide** — added Snowflake provider section (Option D) with config and notebook UI import steps
- **Data Sources** — documented Connection Panel hot-swap workflow

---

## v0.8.2 — 2026-03-25

### Fixed
- **`workspace:*` dependency resolution** — published packages on npm previously contained raw `workspace:*` dependency versions, causing `EUNSUPPORTEDPROTOCOL` errors during `npm install -g`. The release script now explicitly resolves workspace dependencies to real `^x.y.z` versions before publishing.

---

## v0.8.1 — 2026-03-25

### Fixed
- **`dql init` detection improvements** — added more DuckDB filename candidates (`database.duckdb`, `analytics.duckdb`, `target/jaffle_shop.duckdb`), improved detection output with clear status for dbt project and DuckDB file discovery
- **`dql init` works on non-empty directories** — removed the "Target directory is not empty" guard so `dql init .` works inside existing dbt projects (e.g., Jaffle Shop)

### Changed
- Init output now shows detection results: dbt project (yes/no), DuckDB file path, and semantic layer provider

---

## v0.8.0 — 2026-03-25

### Added
- **Interactive lineage DAG visualization** — full React Flow + dagre-powered graph in the notebook, with node type filtering, click-to-focus highlighting, minimap, legend, and detail panel (`LineageDAG.tsx`)
- **Lineage fullscreen toggle** — "Open Graph View" button in lineage sidebar panel switches main content area to the DAG canvas
- **Jaffle Shop getting-started flow** — `dql init` auto-detects `dbt_project.yml` and `.duckdb` files, scaffolds config with dbt provider, creates welcome notebook

### Removed
- **Project templates** — removed `templates/` directory, `--template` CLI flag, and all template-based scaffolding. `dql init` now always creates a minimal project structure.
- **Example projects** — removed `examples/` and `my-dql-project/` directories

### Changed
- All documentation updated to use Jaffle Shop dbt project as the canonical getting-started path
- README, quickstart, CLI reference, FAQ, and use cases rewritten to remove template references
- Package versions bumped to 0.8.0 across all 10 packages

---

## v0.7.1 — 2026-03-24

### Added
- **Inline cell lineage** — SQL cells in the notebook now show upstream table dependencies and `@metric()` / `@dim()` tracking inline
- **Client-side ColumnMeta normalization** — backward-compatible normalization of `ColumnMeta[]` to `string[]` at the API boundary

### Fixed
- React crash from inconsistent ColumnMeta format at API boundary
- Added `@codemirror/autocomplete` and `@codemirror/search` dependencies, updated `sql-formatter`

---

## v0.7.0 — 2026-03-24

### Added
- **`dql compile` command** — generates `dql-manifest.json`, a complete project artifact containing all blocks, notebooks, metrics, sources, dependencies, and pre-computed lineage (similar to dbt's `manifest.json`)
- **Manifest system** (`packages/dql-core/src/manifest/`) — `DQLManifest` type with `ManifestBlock`, `ManifestNotebook`, `ManifestMetric`, `ManifestSource`, `ManifestLineage`
- **Recursive directory scanning** — blocks and notebooks in nested subdirectories are now discovered (no longer flat-only)
- **Config-driven semantic layer path** — reads `semanticLayer.path` from `dql.config.json` instead of hardcoding `semantic-layer/`
- **Notebook lineage** — `.dqlnb` notebook SQL/DQL cells are scanned for table and ref() dependencies; DQL cells declaring blocks are added to the lineage graph
- **dbt manifest import** — `dql compile --dbt-manifest path/to/manifest.json` imports dbt models and sources with column-level metadata as upstream nodes
- **Smart node lookup** — `dql lineage <name>` auto-resolves to block, table, metric, or dimension (no type prefix needed)
- **`dql lineage --table <name>`** — show lineage for a specific source table
- **`dql lineage --metric <name>`** — show lineage for a specific metric
- **`dql lineage --impact <name>`** — impact analysis now works on any node type (tables, metrics), not just blocks
- **`dql lineage --no-manifest`** — force live scan, skip reading `dql-manifest.json`
- **DuckDB reader function extraction** — `read_csv_auto()`, `read_parquet()`, `read_json()` calls in SQL are now extracted as source table dependencies
- **Rich lineage summary** — `dql lineage` now shows actual block/table/metric names, ownership, data flow relationships, and a DAG tree visualization

### Changed
- `dql lineage` reads from `dql-manifest.json` when available for faster lookups; falls back to live scanning
- Lineage output shows direct vs transitive upstream/downstream, with `*` marking direct connections
- `dql lineage` data flow tree renders from root source tables through all downstream nodes

---

## v0.6.0 — 2026-03-24

### Added
- **Answer-layer lineage engine** — tracks data flow from source tables through blocks, semantic metrics, business domains, and charts
- **`ref("block_name")` system** — declare explicit block-to-block dependencies in SQL queries, similar to dbt's `ref()`
- **`dql lineage` CLI command** — full lineage analysis with subcommands:
  - `dql lineage` — project summary with node counts, cross-domain flows, domain trust scores
  - `dql lineage <block>` — upstream/downstream for a specific block
  - `dql lineage --domain <name>` — domain-scoped view with data flows in/out
  - `dql lineage --impact <block>` — impact analysis showing affected downstream nodes by domain
  - `dql lineage --trust-chain <from> <to>` — certification status at every hop between two blocks
  - `dql lineage --format json` — export full lineage graph as JSON
- **Cross-domain flow detection** — automatic detection when data crosses business domain boundaries (e.g., data → finance → executive)
- **Trust chain scoring** — certified blocks are trust checkpoints; trust score = certified/total ratio
- **Lineage API endpoints** — `GET /api/lineage`, `/api/lineage/block/:name`, `/api/lineage/domain/:name`, `/api/lineage/impact/:block`, `/api/lineage/trust-chain`
- **Notebook Lineage Panel** — sidebar panel showing blocks, metrics, source tables, domains, and cross-domain flows
- **SQL table extractor** — lightweight regex-based parser for FROM/JOIN/INTO/CTE table extraction
- **Dependency resolver** — topological sort with circular dependency detection
- **DuckDB reader normalization** — `read_csv_auto('./data/revenue.csv')` normalizes to `revenue` in lineage nodes
- **Edge deduplication** — prevents duplicate edges in the lineage graph
- **Comprehensive lineage documentation** — new `docs/lineage.md` with tutorials, CLI reference, and dbt complement strategy
- **Unified package versioning** — all 10 packages now share a single version number (0.6.0)

### Changed
- Updated all documentation to cover lineage, ref(), and cross-domain flows
- README now includes Lineage & Trust Chains section
- ROADMAP updated with lineage as shipped feature

---

## v0.5.2 — 2026-03-23

### Added
- **Snowflake semantic layer provider** — `provider: "snowflake"` in `dql.config.json` now wires a live Snowflake connection into the semantic layer; no manual YAML duplication required
- **Time dimension picker in Compose Query UI** — select a date dimension and granularity (`day` / `week` / `month` / `quarter` / `year`); generates dialect-correct `DATE_TRUNC()` SQL
- **Live test execution in `dql certify`** — `assert` statements in `.dql` blocks now run against real data before governance checks; use `--skip-tests` to bypass for metadata-only validation
- **`defaultConnection` auto-detection** — `dql certify` and `dql test` now read `defaultConnection` from `dql.config.json` without requiring `--connection`
- **Auto-refresh semantic layer via SSE** — editing a YAML file in `semantic-layer/` while the notebook is open now triggers an automatic panel reload (no manual Retry click)
- **New Metric form in notebook sidebar** — create a new metric YAML file from inside the Semantic Panel without leaving the notebook
- **Block Governance Bar** — DQL cells with a `block { ... }` declaration show an inline form for editing `domain`, `owner`, `tags`, and `description` without touching the raw syntax
- **DQL / SQL cell type tooltips** — hover over the cell type badge to see what each cell type does
- **`dql test` deprecation notice** — `dql test` now prints a deprecation warning; use `dql certify --connection` instead (removal planned for v0.6.0)

### Fixed
- Removed non-existent `@import` syntax from authoring-blocks.md and notebook reference panel; replaced with the real `@metric()` / `@dim()` patterns and Compose Query workflow
- Removed dead `BlockImportView` component and all `@import` dead code from the notebook frontend
- `dql certify` no longer reports "✓ certified" when `tests-pass` governance rule would have failed on live data

### Changed
- Semantic layer section in Reference Panel now leads with Compose Query (canonical path) and marks `@metric()` / `@dim()` as advanced
- `dql test` marked `[deprecated]` in help text

---

## v0.5.1 — 2026-03-20

### Fixed
- Resolved `workspace:*` dependency resolution issue for npm publish
- Version bumps across all packages for v0.5.0 release alignment

---

## v0.5.0 — 2026-03-18

### Added
- **Semantic Compose Query** — Semantic Panel now has a Compose Query section: select metrics, dimensions, compose SQL, and insert as a cell with one click
- **"Insert as Cell" button** — composed SQL can be inserted directly as a new SQL cell
- **Notebook semantic panel** — browse metrics, dimensions, and hierarchies from the sidebar; click to insert refs into SQL cells
- **`type = "semantic"` block** — reference a metric by name from a DQL block (`metric = "total_revenue"`)
- **`@metric()` / `@dim()` inline refs** — use semantic metrics and dimensions directly inside SQL cells
- Comprehensive documentation overhaul: authoring-blocks guide, own-repo tutorial, progressive doc index
- Tutorial rewrite for getting-started, data-sources connector reference, notebook semantic panel guide

---

## v0.4.0

### Added
- Semantic layer core: DQL native YAML provider, dbt provider, Cube.js provider
- 14-database SQL dialect abstraction in `composeQuery()`
- `dql certify` command with governance rule evaluation
- `dql fmt` format-on-save for `.dql` files
- DQL Language Support VS Code extension packaging

---

## v0.3.0

### Added
- Multi-cell notebook with param cells, markdown cells, and auto-charting
- DQL block AST: `block { domain, owner, tags, params, query, visualization, tests }`
- `dql parse` semantic analysis
- `dql preview` and `dql build` for static HTML bundles
- `dql serve` for local preview serving

---

## v0.1.0

Initial public DQL release.

- Open-sourced the DQL language core, compiler, runtime, connectors, governance, LSP, and Git-backed project package
- Published the `dql` CLI and the `DQL Language Support` VS Code extension packaging path
- Added starter docs, examples, templates, and GitHub release automation for the OSS repo
