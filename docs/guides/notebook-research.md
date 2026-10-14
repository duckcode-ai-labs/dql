# Notebook research engine

> ~7 minutes - use notebooks as the research workspace before promoting SQL into DQL blocks

Notebook research is the investigation layer between raw SQL and governed DQL.
It is where analysts explore, run SQL, inspect evidence, document decisions,
and decide whether a query should reuse an existing block, extend one, replace
one, or become a new draft block.

The production model is:

```text
Notebook SQL / question
  -> metadata-grounded research run
  -> reviewed SQL + evidence + preview
  -> DQL draft block
  -> certification
  -> Apps and stakeholder views
```

Block Studio remains the fast review surface for DQL blocks. Apps remain the
presentation surface. Notebook research is where deeper analysis and DQL
conversion should happen.

## When to use it

Use notebook research when you have:

- SQL from an existing analysis, notebook, dashboard, or warehouse history
- a question that needs metadata-aware SQL before becoming a block
- several similar queries that might be duplicates
- parameterized business logic, such as year, date range, segment, player, team,
  customer, region, or limit values
- a deep investigation that needs notes, previews, lineage, and review context

For a quick dbt model or metric wrapper, Block Studio is still faster. For a
stakeholder page, use Apps after the block is reviewed.

## Enterprise workflow

1. Open the notebook and create or paste SQL cells.
2. Open **Research** from the notebook toolbar, or use the research action on a
   SQL/DQL cell.
3. Select **Seed cells** to create one research run per SQL/DQL source cell.
4. Work the **Research runs** queue by next action: source fixes, blockers,
   SQL review, context review, preview, DQL draft, certification, or complete.
5. Open **Preview context** to inspect the ranked metadata pack before trusting
   the generated or reviewed SQL.
6. Run or rerun the research preview.
7. Review the checklist: SQL, evidence, preview, source status, parameters, and
   DQL promotion decision.
8. Use **Check reuse** to compare the reviewed SQL against existing DQL blocks
   before creating another draft.
9. Create the DQL draft only after the SQL, context, preview, and reuse check
   are reviewed.
10. Open the generated draft in Block Studio for final metadata cleanup and
   certification.
11. Return to the notebook and use **Mark certified** only after the linked DQL
    draft has passed certification. Use **Complete** when the research should
    close without certifying a new block.
12. Insert a **Register** markdown cell when the notebook needs a durable
   handoff list for review.

If no SQL is attached and no AI provider is configured, **Run research** still
saves a metadata-grounded research plan with context evidence and warnings
instead of failing the run. The next action will stay on SQL review until the
user pastes reviewed SQL, links a source cell, or configures AI SQL generation.
Agent and tool callers that create research runs through the local API can link
notebook source cells with either flat fields (`sourceCellId`,
`sourceCellName`, `sourceCellFingerprint`) or a nested `sourceCell` object with
`id`, `name`, and `fingerprint` aliases. Flat fields remain authoritative when
both shapes are supplied.
After context is saved, the selected run shows a durable **Saved context**
review section with trust label, route, selected metadata summaries, allowed SQL
relations, and missing-context warnings. This lets reviewers reopen the notebook
later and inspect why the SQL or DQL draft was trusted.

## What the queue tracks

Each research run stores local review state in `.dql/local/notebook-research.sqlite`.
That database is local/private state and should not be committed.

The queue tracks:

- notebook path, source cell, source fingerprint, and source drift
- question, domain, research intent, and owner context
- generated SQL, reviewed SQL, preview result, warnings, and errors
- context pack evidence, selected relations, route decision, and missing context
- durable research plan: SQL state, grain, filters, parameters, evidence,
  preview state, and DQL promotion path
- DQL promotion decision and similar existing blocks
- parameter review, including dynamic parameters and static-scope warnings
- readiness for draft creation or certification review

For large repos, use the filters instead of scrolling:

- **Show** - open work by default, or all history for completed, certified, and
  rejected research
- **Scope** - current notebook or whole project
- **Notebook** - one notebook backlog inside project scope; type a path when it
  is not in the compact suggestion list
- **Domain** - domain-specific queue; type a domain when it is not in the
  compact suggestion list
- **Owner** - reviewer/team-specific queue; type an owner when it is not in
  the compact suggestion list
- **Intent** - ad hoc, change diagnosis, driver breakdown, segment compare,
  entity drilldown, anomaly investigation, or trust gap review
- **Source** - changed, missing, synced, or untracked source cells in the
  current notebook
- **Next** - the next review action to work
- **Order** - work queue priority or recent activity

Search is backed by a local full-text index in
`.dql/local/notebook-research.sqlite` when the bundled SQLite runtime supports
FTS5. The index covers research titles, questions, notebook paths, domains,
owners, source-cell ids and fingerprints, source-cell names, SQL text, evidence,
research plans, and duplicate/reuse metadata. Multi-word searches behave like
worklist search: terms can match across different fields, so `source123 scoring`
can match a source fingerprint plus a question or certified-block match. If FTS5
is not available, ZLens falls back to the same token-based local text scan, so the
workflow still works offline. The same search behavior applies to source
coverage, including source-cell names, ids, fingerprints, and SQL text. The
visible source list, counts, and next source-cell action all use the same
search-filtered coverage queue.

The panel keeps the default research queue compact: search and next-action
buttons stay visible, and the list defaults to **Open work** so completed,
certified, and rejected runs do not crowd active research. Scope, notebook,
domain, owner, show mode, source, intent, and order live behind the **Filters** row.
Switch **Show** to **All history** when auditing past decisions. When any
advanced filter is active, the row shows the active-filter summary so reviewers
can see why the list changed without keeping the whole filter grid open.
Active search and filter constraints also appear as removable chips, so a
reviewer can clear one domain, owner, notebook, source, coverage, or next-action
constraint without resetting the full queue.

The summary also includes a compact health line for large repositories. It
reports whether indexed search is active, open versus total research runs,
notebook, domain, and owner spread, source-linked coverage, and the paging limits used
by the review queue. Warnings appear there when local search falls back, the
index is stale, or the project has a large open backlog that should be handled
with domain, owner, notebook, source, and next-action filters.

The notebook workspace and Files panel also show compact research badges next
to notebooks with active research work. Completed, certified, and rejected
research stays available inside the Research panel's **All history** mode, but
does not keep the workspace queue or toolbar badge lit. Use those badges to find
notebooks with blocked, 30-day, stale, draft-ready, or certification-ready work
before opening the Research panel.
When a notebook has one visible research run, opening the Research panel opens
that dossier directly instead of landing on a blank new-research draft. Use
**New** when you intentionally want to start a separate investigation.
The **Priority worklist** also shows a short **Why** reason for each item so
reviewers can see the source change, blocker, stale state, or next gate behind
the queue order before opening the full dossier. It stays compact by default
and expands in small batches when reviewers need to work deeper into a large
queue.
When a project has saved research, the notebook workspace shows a **Project
research queue** summary with total research, draft-ready, certification-ready,
blocked, stale, and 30-day open counts. It also shows a compact **Owner focus**
row for the owners or teams with the highest-priority research backlog. Select
an owner chip to open the Research panel in project scope filtered to that
owner. Use **Open next** to open the
highest-priority notebook with the Research panel already visible and focused on
the next queue item.

Each row also shows compact trust chips for evidence, readiness, review gate,
parameter review, duplicate/reuse decision, preview, and DQL draft state. Rows
include a workflow progress line such as **4/6 Reuse + params review**, so
enterprise reviewers can scan long queues without opening every dossier. The
gate chip exposes the first blocker, warning, or pending checklist item, such as
**Blocked: Reviewed SQL** or **Review: Evidence**. Selected runs show a
**Selected next step** card before the dossier, with the recommended command and
blocker reason when the command is disabled. They also show a **Research
workflow** strip with the durable review stages:

Open research older than seven days is marked **stale**, and open research older
than thirty days is marked **30d+**. In **Work queue** order, stale work is
promoted within the same next-action lane so reviewers can revalidate old SQL,
evidence, and promotion decisions before creating or certifying blocks.
Within each next-action lane, blocked and warning gates sort ahead of pending or
clear runs.

```text
Source -> SQL -> Context -> Preview -> Reuse + params -> DQL + certify
```

This gives reviewers a compact status map before the detailed dossier. The
stage strip uses the same source drift, SQL review, evidence, preview,
parameter, duplicate/reuse, and DQL draft signals that drive the next-action
buttons, so the visible process matches the certification gates. The
**Research plan** card remains the deeper checklist for grain, filters,
parameters, evidence counts, preview state, and promotion path.
The dossier repeats the same review gate next to source, SQL, evidence, preview,
DQL, and route state so the list view and detail view agree. Warning-only runs
that do not yet have a DQL draft can still use the selected next-step command to
add a review note. The **Check reuse** action runs the same duplicate and
parameter-shape matcher
used by SQL import, then saves the decision back to the research run. If reuse
is recommended, draft creation is blocked until the reviewer reuses the matched
block or documents a replacement path.
After a DQL draft is created, **Open draft** sends the reviewer to Block Studio
for the actual certification gate. The notebook **Mark certified** action closes
the research run as certified only when the checklist is certification-ready;
it records a recommendation note that points back to the reviewed DQL draft.
This keeps the notebook backlog clean without turning notebook research into a
separate certification authority.
The summary count cards are quick filters, so reviewers can jump directly to
blocked, draft-ready, certification-ready, draft-created, or failed research
runs. The **Priority worklist** stays visible as the day-to-day enterprise
queue: source fixes, blockers, SQL review, context review, previews, reuse
decisions, draft creation, and new unresearched source cells. Use it instead of
manually scanning the full run list; expand it only when the first queue page is
not enough for the review session.
The run list, notebook badges, project queue, and portfolio map use the same
next-action priority order, so **Open next** points at the same class of work
that appears first in the visible lists.
Research diagnostics also track aging open work: runs older than 7 days are
shown as stale, and runs older than 30 days are called out as expired open
research that should be revalidated or closed before DQL promotion. Use the
**Stale** and **30d+** summary cards, or the **Show** filter's stale-open modes,
to focus the queue on aging investigations. These cards use the active queue
scope, search, notebook, domain, and owner filters; the Project Health line remains a
project-wide diagnostic.
Zero-count summary cards, source-coverage lanes, and next-action lanes are
disabled, so reviewers do not click into empty filters when triaging large
notebooks.

The **Portfolio map** groups the same queue by notebook, business domain,
owner, and research pattern, with blocked, stale, 30-day, certification-ready, and
draft-ready counts on each row. It is collapsed by default so the run list stays prominent, and opens
automatically when a notebook, domain, owner, or pattern filter is active. Use it to
scan large project research backlogs before drilling into a specific notebook,
domain, owner, or pattern filter. Each portfolio row also shows the highest-priority
next action and count, such as **Review context · 12** or **Create draft · 4**,
so enterprise reviewers can choose the next domain, owner, or research pattern without
opening every run. The map deliberately shows only the top notebooks, domains,
owners, and patterns by next-action priority; the header keeps the full project counts
visible and each group shows how many additional groups are hidden. Use the
search box plus notebook, domain, owner, and pattern filters for complete drilldown
instead of expanding the panel into a full catalog. The backend chooses those
bounded group lists by highest-priority next action before total volume, so a
small blocked domain, owner, or notebook remains visible ahead of larger historical
groups.
Project-scoped queues can show research from notebooks other than the one
currently open. Selecting one of those runs or using **Open next** opens the
source notebook before source sync, preview, reuse checking, or DQL draft
creation. Until that notebook is open, the run is treated as cross-notebook
work rather than a missing source cell, so enterprise queues do not create false
source-fix noise. The selected research dossier is preserved during that file
handoff, so reviewers land in the owning notebook with the same question, SQL,
review gate, and next action still active.
Source-state filters are scoped to the currently open notebook because ZLens can
only compare source-cell fingerprints against cells loaded in that notebook.
Switching to project scope or selecting a different notebook clears source
filters; use notebook, domain, pattern, and next-action filters for project-wide
triage.
Project notebook lists and recent notebook rows use the same priority rules, so
the most urgent research notebooks appear first and their badges show the next
action to take, such as **Review context**, **Create draft**, or **Certify**,
with visible counts and exact details in the hover text. Badge tone follows the
next action: blockers are error-colored, SQL/context/preview/reuse review is
warning-colored, certification is success-colored, and draft creation is the
primary action color. Source-filtered run lists use the same blocker-first
priority after source changes and missing-source fixes, so local notebook triage
does not reorder certification ahead of unresolved blockers.
The project research queue also shows a second line with the next-action count
and readiness state, so reviewers can choose a notebook without opening hover
details first. The queue starts compact and can expand to a bounded review list,
which keeps large enterprise workspaces scannable without rendering every
research notebook on the welcome screen. Openable notebooks sort ahead of
stale research entries whose notebook file is no longer in the workspace; those
rows are marked **Missing file** and counted in a queue-level **Missing** metric.
The other queue metrics count openable notebook work, so reviewers can clean up
or restore stale entries without confusing them for immediately actionable work.
The Recent notebooks header reports open research and missing entries separately
for the same reason.
Source coverage uses a bounded source-cell lookup, so larger notebooks can show
which SQL/DQL cells are unresearched, changed, missing, or synced without
loading unrelated research history. Runs linked by `sourceCellId` are matched
first. Older or agent-created runs that have no source cell id can still appear
as covered when their stored source fingerprint matches the current notebook
cell fingerprint; this fallback is read-only and does not rewrite the saved
research record. **Seed cells** uses the same source id and fingerprint signals
to avoid creating duplicate research runs for already-covered SQL. The panel
also filters the coverage list by new, changed, missing, synced, or unknown
source state so reviewers can work one class of source cells at a time. The
visible source list stays compact and expands in batches, so very large
notebooks do not render every matching source cell at once. In
notebook scope, source-state counters come
from that coverage lookup instead of the current visible run page. Research
runs whose original source cell was deleted are included in the Missing source
filter and coverage list so they can be closed or kept as standalone reviewed
SQL. The Covered cells summary counts current notebook source cells that already
have matching research by source id or fingerprint; deleted source research is
reported separately as Missing. Missing-source limits are applied after all
current source cells are excluded, which prevents large notebooks from
mislabeling current cells as deleted. Selecting Changed, Missing, Synced, or Unknown in
Source coverage also filters the research run list to the same source state;
selecting New stays focused on creating research drafts for unresearched cells.
If every current SQL/DQL cell is removed, the coverage panel
still shows historical missing-source research so it can be closed or preserved
as standalone reviewed SQL, and Source state counters still come from coverage
rather than the visible run page. Source-filtered run lists page over the
coverage result itself, so the pager count and **Next** state match the changed,
missing, synced, or unknown rows the reviewer is actually seeing. Source
coverage is collapsed when every source is already synced, and expands
automatically when there are new, changed, missing, or actively filtered source
cells. Source-filtered run lists and generated register snapshots still honor
the selected Order value. When New is selected, the detail pane is primed with
the first unresearched source cell, and Open next starts the next unresearched
source cell instead of jumping to an existing research run. When filters hide
the selected research run, the detail pane keeps that dossier active and shows
**Show selected** and **Open first** controls. Show selected clears queue
filters and switches notebook/project scope as needed so the selected research
run appears in the list again.
SQL and DQL cell headers also show the same source-coverage state as a compact
research badge, such as **Research: New**, **Research: Changed**,
**Research: Draft ready**, or **Research: Certify**. Clicking the badge opens
the Research panel for that source cell. The badges use the same source id and
fingerprint coverage as the side panel, so historical or agent-created research
does not look new when the SQL still matches. This keeps long notebooks
scannable: reviewers can work directly from the cell list without hunting for
the matching row in the side panel first. Research actions refresh these badges and the
notebook-list badges immediately after saves, previews, reuse checks, draft
creation, or review-status changes; periodic refresh remains as a fallback.

## Dynamic parameters

Most reusable business logic should not bake in one hard-coded value. Notebook
research reviews literals and filters before draft creation.

Example source SQL:

```sql
select
  player_name,
  sum(pts) as total_points
from transformed.int_player_stats
where extract(year from game_date_est) = 2017
group by 1
order by total_points desc
limit 5
```

The research checklist should flag reusable parameters such as:

- `season_year`
- `top_n`

If no reusable runtime parameters are detected, the checklist warns that the
block should be certified as static only if the business question is
intentionally fixed.

## Duplicate and reuse review

Before creating a new draft block, notebook research compares the candidate
against existing DQL context. The promotion decision can be:

- **Reuse existing** - the business logic already exists, usually with a
  parameterized difference.
- **Extend existing** - a close block exists but needs an additional output,
  filter, or grain.
- **Create replacement** - the new logic should replace old logic for the same
  business question.
- **Create new** - no suitable reusable block was found.
- **Review required** - evidence is too weak or conflicting.

Do not create another block just because a SQL query is slightly different.
Review the similar-block evidence and parameter policy first.
A **Review required** promotion decision is not certification-ready; resolve
the duplicate, replacement, or evidence question before certifying a block.
When **Reuse existing** is the accepted decision, use **Complete reuse** to
remove the item from the active review queue without creating another block.

## Register cell

Use **Register** when the notebook needs a clean review artifact. The inserted
markdown summarizes:

- run counts and covered-cell coverage
- project health: indexed search, open/closed backlog, notebook/domain/owner
  spread, source-linked runs, queue limits, and warnings
- active filter scope, show mode, and included run count
- portfolio map groups for top notebooks, domains, owners, and research
  patterns, with hidden-group counts plus stale and 30-day open-work counts for large
  repositories
- priority worklist ordered by next action, with workflow progress and gate
  status
- DQL promotion decisions for duplicate control: reuse, extend, replacement,
  create-new, review-required, and pending runs
- research plan summary for each listed run
- draft-ready and certification-ready work
- blockers and errors
- every source cell and its coverage state
- the research queue with domain, owner, intent, workflow progress, readiness,
  review gate, age, parameter review, next action, and source cell

This gives reviewers a compact backlog inside the notebook without committing
local preview data or run snapshots.
Register is refreshable: if the notebook already has a generated Notebook
Research Register cell, or an older register with the same heading, the action
updates that cell instead of adding another copy. This keeps curated research
notebooks from filling up with duplicate handoff snapshots.
For enterprise-sized notebooks, the register fetches a larger filtered
snapshot so it is not limited to the currently visible page, and its Project
Health section includes the same stale and 30-day open-work counts as the
Research panel diagnostics.

## Git policy

Commit:

```text
notebooks/*.dqlnb when curated/shared
domains/**/blocks/**/*.dql
blocks/**/*.dql
apps/*/dql.app.json
apps/*/dashboards/*.dqld
```

Do not commit:

```text
.dql/local/notebook-research.sqlite
.dql/cache/**
*.run.json
personal layout overrides
private AI pins
temporary generated artifacts
```

Use `zlens promote notebook <path> --to shared` when a private notebook becomes a
team artifact. Promotion strips local-only run state before the file becomes
shared source.

## Verify it worked

- The research panel shows source coverage for SQL/DQL cells.
- **Seed cells** creates research runs without duplicating already covered cells.
- A hard-coded filter query shows dynamic parameters in the review checklist.
- A static query shows a static-scope warning.
- **Register** inserts a markdown backlog with **Project Health**, **Gate**,
  **Age**, and **Parameters** columns.
- **Create draft** writes a review-required DQL draft, not a certified block.
