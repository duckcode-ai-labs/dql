# Concepts

> ~4 minutes · the mental model behind every feature

ZLens has six primitives. Once these click, the rest of the docs read like
reference material.

## 1. Notebook

A `.dqlnb` file containing an ordered list of cells. Cells can be:

- **SQL** — free-form queries against any connected warehouse
- **DQL** — reference blocks or semantic objects via `@block(name)`,
  `@metric(name)`, and `@dim(name)`
- **Markdown** — commentary, docs, dashboards-as-code
- **Param** — text/select/date/number inputs wired into downstream cells

Notebooks live in git. Results never do (they go in a sibling
`.run.json` that's git-ignored by default — see [Run Snapshots](./reference/file-formats.md#run-snapshots)).

Notebooks are also the research workspace for deeper SQL-to-DQL conversion.
The Research panel turns source SQL cells into reviewable runs with metadata
evidence, preview results, duplicate/reuse checks, parameter review, and a
DQL-draft promotion path. See the [Notebook research engine](./guides/notebook-research.md)
guide for the enterprise workflow.

## 2. Block

A **named, versioned, governed** analytics artifact. Think of a block as a
trusted answer unit that ships with SQL or semantic intent, a chart spec, tests,
lineage, and governance metadata.

```dql
block "Revenue by Segment" {
  domain = "finance"
  type = "custom"
  status = "draft"
  owner = "analytics@company.com"
  tags = ["revenue", "certified"]

  query = """
SELECT segment, SUM(amount) AS revenue
FROM analytics.orders
GROUP BY 1
"""

  visualization {
    chart = "bar"
    x = segment
    y = revenue
  }
}
```

Blocks are authored in **Block Studio**. Use a **SQL Block** when you want raw
SQL against dbt models or database tables. Use a **Semantic Block** when you
want a dbt/DQL metric plus dimensions, filters, grain, and chart intent. Both
compile to executable SQL + a chart spec and are embeddable in notebooks,
dashboard pages, Apps, or other blocks.

## 3. Semantic layer

The shared vocabulary of the business — **metrics** (measures),
**dimensions** (attributes), **hierarchies** (drill paths), **cubes**
(pre-joined fact/dim sets). ZLens imports from dbt's semantic layer by default
and lets you author the rest locally.

In a DQL cell, `@metric("revenue")` and `@dim("customer.segment")` resolve
against the semantic layer — no hand-written joins.

## 4. Lineage

A graph of every **dbt/source/table -> semantic metric -> block -> notebook ->
dashboard page -> App** edge in the project, built from AST-level SQL parsing
and dbt artifacts. The lineage panel renders it with React Flow; the CLI
exposes it via `zlens lineage impact <name>` and friends.

Lineage answers three questions:

- *What depends on this table?* (impact analysis)
- *Where did this number come from?* (trust chain)
- *What's shared across teams?* (cross-domain detection)

## 5. App

An App is the decision-facing package. In OSS it is a local file-backed folder
under `apps/<app-id>/` with dashboard pages, attached notebooks, AI pins, and
draft blocks. App metadata such as domain, subdomain, group, audience,
visibility, and lifecycle is for organization and future upgrade paths; it is
not enforced RBAC in OSS.

The UI has two modes:

- **View** — clean consumer surface for dashboard pages, notebook previews, AI
  conversations, and pinned summaries.
- **Build** — creation surface for adding pages, blocks, notebooks, text tiles,
  drafts, and settings.

## 6. Dashboard Page

A dashboard page is a curated grid inside an App, backed by `.dqld`. It composes
block tiles, text tiles, KPI cards, charts, and table outputs. Older standalone
notebook dashboards can still compile to static HTML, but Apps are the primary
OSS consumption surface.

---

## How they fit

```
dbt sources/models ──┐
                     ├─▶ semantic layer ──▶ DQL blocks ──▶ notebooks
warehouse tables ────┘                         │             │
                                               ▼             ▼
                                         dashboard pages ──▶ Apps
                                               │
                                               ▼
                                          lineage DAG
```

With that mental model loaded, [the guides](guides/README.md) all make sense.
