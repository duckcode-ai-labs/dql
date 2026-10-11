# RFC 0008: App Builder for commercial use — one pipeline, visible trust, three layouts

| Field              | Value                                                                        |
| ------------------ | ---------------------------------------------------------------------------- |
| **Author(s)**      | @KKranthi6881                                                                |
| **Status**         | Accepted; building step by step                                              |
| **Created**        | 2026-09-23                                                                   |
| **Builds on**      | RFC 0007 (Datasets and tile queries)                                         |
| **Implementation** | landed on `main` (RFC 0007 series rebased onto `main`)                       |

## Summary

Apps should be good enough to replace a Tableau, Power BI or Hex dashboard,
while keeping what those products lack: every number on the page can prove
where it came from. This RFC fixes the order of work and the file-format
changes. It adds no second execution path. Every author — a person in Studio,
the App AI planner, Autopilot, or an Ask answer added to an App — writes the
same draft operations into the same `.dqld` page, and every tile is checked
by `validateTileQuery`, run by the page-run endpoint and published through
preflight exactly as RFC 0007 describes.

## Principles

1. **One pipeline.** Manual and AI authoring differ only in who fills in a
   tile's query, `viz` and layout. The renderer never knows who authored it.
2. **Trust is visible.** Readers see one vocabulary — certified, governed,
   review, blocked — on every tile, with freshness and a receipt behind every
   number. Hashes stay in the evidence panel for authors.
3. **AI proposes, people apply.** Proposals stay typed and hashed. Page-level
   proposals become additive, with accept or reject per tile.
4. **Files stay reviewable.** A page stores one layout; phone and tablet
   layouts are derived. New fields are optional so v3 pages keep loading.

## Steps

Each step lands as its own commits with tests and leaves `main` releasable.

| Step | Scope | Exit check |
| ---- | ----- | ---------- |
| 1. Brand tokens | Deep-teal accent in every theme; caption contrast; one validated chart palette per theme; tabular numerals; no hard-coded purple | token test, palette test, notebook suite |
| 2. App type and colour system | App Studio and reader use the type scale (11–32), weights 400/500/600, radii 4/8/12, and status tokens only | style test extended |
| 3. Consolidate | Page AI targets the open page and is additive with per-tile accept; App copilot scoped to its App and filters server-side; schedules run every certified tile type; old editor and chat builder retired | apps-api, agent-run and schedule tests |
| 4. Viz spec v2 | `viz` gains encodings, style, labels, reference lines and bands, annotations and table rules; one renderer draws it for Apps, notebook cells and Ask answers | schema round-trip, renderer tests |
| 5. Canvas | Free grid with resize, snap, duplicate, keyboard; saved undo; only edited tiles rerun | Studio tests |
| 6. Reader trust | Trust and freshness on every tile, receipts, Trust Lens, tile descriptions | reader tests |
| 7. Driver tiles | “Why did it move?” runs the investigation engine and can be pinned as a `driver` tile that reruns on refresh | investigation and tile tests |
| 8. Story layout | Page `layout: "story"` with text whose `{{bind}}` numbers are checked against receipts | story checker tests |
| 9. Canvas pages | Page `kind: "canvas"`: sandboxed HTML plus named bindings, each a tile query; no naked numbers | binding and sandbox tests |
| 10. Distribution | Share links, PDF / PNG / signed HTML, rendered digests, monitors, visual PR diff | per feature |

## Progress

| Step | State | Notes |
| ---- | ----- | ----- |
| 0. Branch | Done | RFC 0007 series rebased onto `main`, DuckDB data-loss fix included; two calendar-dependent Ask trace tests fixed (they failed on `main` too) |
| 1. Brand tokens | Done | Teal in every theme, validated chart series and heatmap ramp, tabular digits, no purple or gradient mark left |
| 2. App type and colour system | Done | Scale, weights, radii and status tokens pinned by `app-type-system.test.ts` |
| 3a. Page AI | Done | Targets the open page; add mode by default; Keep/Skip per proposed tile; only proposed tiles can be removed |
| 3b. App copilot scope | Done | Server resolves the App's domain and states the reader's filters in the question |
| 3c. Schedules | Done | Full-page runs through the App runtime; webhook delivery; digest with values, trust and failures |
| 4. Viz spec v2 | Done | `viz.style` validated in core and drafts; ECharts 6.1 draws 10 chart types everywhere ChartOutput is used, SVG kept for the rest and as fallback; Studio style panel; planner may style components |
| 5. Canvas | Done | One grid engine in core (`apps/grid-layout`): a tile keeps the cell it was given, only overlaps move, empty rows close. Used by the draft reducer on save, the Studio canvas (drag by header, resize from edges, arrow keys, Shift+arrows, duplicate, Delete, undo) and the reader, which no longer re-ranks tiles. Editing, adding or removing a tile reruns only that tile; publishing still needs a full page run. Undo survives a reload (per draft, in the browser). Loading tiles show a skeleton of their shape. Tablet and phone layouts stay derived. |
| 6. Reader trust | Done | One reader vocabulary (certified, governed, needs review, blocked) worked out from run evidence (`reader-trust.ts`), with trust colour tokens in every theme. Every data tile shows its label and freshness; the label, or a KPI's number, opens a receipt (source, owner, filters, rows, time, result and SQL fingerprints, snapshot, run) that links to the query and SQL. Trust Lens outlines tiles by trust and the page says how many are certified. Tiles gain `description` and `owner`, edited in Studio. The reader asks for a full run when no tile is hidden, so the page story shows again on a normal open; author-only wording left the reader. Studio saves run one at a time, fixing a conflict when two fields saved together. |
| 7. Driver tiles | Done | "Why did it move?" with no AI: a driver definition (measure, time field, grain, period, comparison, dimensions or `*`) expands in the page run into ordinary governed Dataset comparison tiles — the whole measure plus one per dimension — so contract checks, filters, cache and evidence are the Dataset tile path. Their rows fold through the Research engine's exact-decimal contribution maths into a ranked split by member (additive shares, reconciliation, new and gone members, Other). Readers ask it from any trend tile (a bounded probe with the page's filters that never changes the App); authors add it as a tile from Studio and set its period, comparison and dimensions. A period with no data says so instead of guessing. Ratio mix/rate split is not in this step. |
| 8. Story layout | Done | A page can show as a story: `narrative` blocks of prose and embedded tiles. Every figure in the prose is a `{{binding}}` to a tile result (single values, members of grouped tiles, leaders, driver results), filled from the current run; a literal number is refused when the page is saved or parsed. Studio has a Dashboard/Story switch, a story editor with value insertion and live preview, and "Draft with AI": the configured model (tested with local Ollama `qwen3.8:27b`, about 50 s) writes around binding keys only, every draft is checked (known keys, no literal numbers, real tiles), one corrective retry, then a deterministic draft from the data. Result values reach the model only when it runs on this machine. Published story pages record an edition per change in their bound values (`.dql/local/story-editions`), and readers see what changed since the last edition. Also fixed: driver tiles now pass publish validation, reader filter coverage and the certified count. |
| 9. Governed HTML pages | Done | A page can show as a governed HTML page (`canvas`): an author or AI writes the layout and wording; data enters only through `<dql-value bind>` (story binding keys) and `<dql-tile tile>`. A strict checker in dql-core refuses (never repairs) anything outside an allowlist — scripts, event handlers, links, images, forms, iframes, SVG, CSS that loads files — and literal numbers, and stores canonical markup. The host fills values as escaped text and draws tiles itself (ECharts SVG, KPI, table, driver summary), then shows the page in a sandboxed frame with no scripts and a CSP that allows no network; the trust frame is drawn outside it. Studio has a Page mode with Design/Code tabs, a live check, a template, and "Design with AI" (tested with local `qwen3.8:27b`: a valid page on the second attempt, about five minutes). Pages live inline in the page file; a separate `pages/<id>.html` file is later work. |
| 10a. Export | Done | Readers export the page as it is now from the trust bar: **Signed HTML**, **PNG image**, or **Print / save as PDF**, all from one signed snapshot. The browser draws the page with the governed-page tile drawer (light theme, 12-column grid, story or HTML page as authored) and sends only its drawing, the run id and the tiles it showed; the server refuses active or external content, wraps it in a document with no scripts and a CSP that allows no network, and signs a manifest of the run, result fingerprint, page filters, trust count and every bound figure *as the server recorded them* with an Ed25519 project key kept in `.dql/local/private/signing` (never in git). `dql app verify <file>` checks offline that the bytes are unchanged, the signature matches, and (inside the project or with `--trust-key`) that the key is trusted; `dql app key` prints the public key to share. The reader's trust rules moved to dql-core so snapshots, digests and the reader use one vocabulary. The PNG is drawn in the browser from the same document; PDFs use the browser's print dialog. |
| 10b. Alerts and rendered digests | Done | A schedule can carry `monitors`: each watches one bound figure (the same keys stories bind to) with a threshold (`<`, `<=`, `>`, `>=`, in the unit readers see, so 45 means 45% for a percent figure) or a change since the last scheduled run (up, down or either, by a percent). Monitors read only the governed run's values and never run their own query; a figure that did not come back is reported as not checked, never as zero. Scheduled runs now send a rendered digest (email HTML with inline styles, plus markdown for Slack and webhooks): headline figures with ▲/▼ change since the last run, what moved most, driver tiles on the page, tiles that did not run, and the trust count; alerts go first with when they started firing. A driver tile is shown as related context under its own title, not as the cause of an alert. `digest: false` makes a schedule speak only when an alert fires. Each run's figures and alert state are kept per schedule in `.dql/local/digests` (values only), and the rendered digest is written to `.dql/runs/digests`. Readers add and remove alerts from an **Alerts** menu on the page; they are saved in the App's `dql.app.json` (a page without a schedule gets an alerts-only one, daily at 08:00), so they are shared through git. `dql schedule run <appId> [scheduleId]` runs one App schedule now. While `dql notebook` is open it runs the project's App schedules itself (re-reading `dql.app.json` every 30 s, so an alert added in the reader runs without a restart; `--no-schedules` turns this off) and announces itself in `.dql/local/notebook.json` (pid, port, a per-start instance id that `/api/health` echoes). `dql schedule run` and `dql schedule start` find that notebook and run App pages through it instead of opening the database again — DuckDB allows one process per file — and `dql schedule start` leaves App schedules to a notebook that runs them. A notebook bound beyond loopback is called with `DQL_SERVER_TOKEN`. `--runtime-url` still picks a runtime explicitly. A service's own runtime on a DuckDB project is closed after each run so a notebook started later can open the file. Block (.dql) schedules are unchanged. Charts are not drawn in email yet. |
| 10c. App review diff | Done | `dql app diff [base] [head]` (default `HEAD` against the working tree) compares every App page and `dql.app.json` between two git revisions without running anything, so it works in CI. For each page it lists tiles added, removed and changed (query, source, filters, driver, chart type and style, title, description, owner, text, position, size) and flags the changes that can move numbers; page-level changes (filters, interactions, story, HTML page, presentation) and schedule and alert changes are listed too. Every changed page is re-read with the parser publish uses, so a typed-in number in a story or an unsafe HTML page is reported as a problem, and `--check` fails the build on one. `--html` writes a self-contained review report with each page's layout drawn before and after (added, changed, numbers-can-change, removed); `--markdown` writes a PR comment. Private drafts are left out. It does not run the pages, so it says which tiles can change numbers rather than by how much. |
| 10d. Page links | Done | `?app=<id>&page=<id>` opens a page in the reader, and the address bar carries it while a published page is open, so a copied URL shares the page. A **Share** menu on the page gives the link for this computer and, when the notebook serves the network (`--host 0.0.0.0` with `DQL_SERVER_TOKEN` and `DQL_ALLOWED_ORIGINS`), a link per allowed origin with the access token in the fragment, as `dql notebook` prints. The server hands out those origins and the token only to a browser that already holds the token. A loopback server says the link works on this computer only and points to Export → Signed HTML for anyone else. Links open with the page's default filters. Hosted share links, embedding and per-reader access remain for the commercial server. |
| 3d. Retire legacy paths | Deferred | The in-place editor is still the only place a published App shows review-required AI pins; Studio must show them first. `app-planner.ts` exports a type live code uses. The chat builder backs the `build_dql_app` MCP tool. |

## File format

All additions are optional fields on `.dqld` version 3. Step 5 needed no
version change: `layout.items` already carried `x, y, w, h`; saves now keep
them instead of re-packing rows. The derived tablet and phone projections are
still written to the file; storing only the desktop layout is a later clean-up.

- **Tile `description`** (markdown, readers see it as plain text, at most 2000 characters) and `owner` (at most 120) — built in step 6.
- **`viz.style`** (built in step 4) — `labels` (`none | last | all`), `stack`,
  `format` (`number | compact | currency | percent`), `palette`, `legend`,
  `sort`, `referenceLines[]`, `bands[]`, `annotations[]` (`{at, text}`, kept
  in git). Encodings stay in `viz.options` (`x`, `y`, `color`). Table rules
  (colour scales, data bars) are still to come. No second y-axis: two
  measures are indexed to one axis.
- **App `theme`** in `dql.app.json` — `{ base: "paper" | "obsidian" |
  "editorial" | "brand", accent?, series? }`. Brand palettes are validated
  on save.
- **Driver tile** (built in step 7) — `driver: { version, measure, timeField, grain, anchor, comparison, dimensions, timezone? }` on a tile with the Dataset's `sourceId`; `viz.type: "waterfall"`.
- **Story page** (built in step 8) — `narrative: { version, presentation: "story"|"dashboard", blocks: [{kind:"text", markdown}|{kind:"tile", tileId}], generatedBy?, model? }`; figures only as `{{tileId.field}}`, `{{tileId.field[member]}}`, `{{tileId.leader}}` or driver keys (`.current`, `.prior`, `.change`, `.change_percent`, `.top_member`).
- **Schedule monitors** (built in step 10) — `schedules[].monitors: [{ id, binding, when: { kind: "threshold", op, value } | { kind: "change", direction, percent }, label? }]` and `schedules[].digest: false` for alerts-only schedules.
- **Canvas page** (built in step 9) — `canvas: { version, html, generatedBy?, model? }` with `narrative.presentation: "canvas"`; data only via `<dql-value bind>` and `<dql-tile tile>`.

## Colour and type

Deep teal is the brand in every theme and doubles as the certified colour.
Governed is ink blue, review is amber, blocked is red. Chart deltas use blue
for up and orange for down, always with an arrow. Series colours come from
fixed, validated palettes (colour-blind separation and contrast checked for
both light and dark), assigned in order and never cycled.

## Out of scope

Joining two Datasets in one tile (RFC 0007, D2), multi-user review, SSO, RBAC
and hosting; those belong to the commercial server.
