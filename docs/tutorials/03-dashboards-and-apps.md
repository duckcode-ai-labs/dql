# 03 — Dashboards & Apps

!!! warning "Archived page"
    This page was written for an earlier version of ZLens and may not match the
    current product. See [About the archive](../archive.md) for the current page.

**Who this is for:** anyone packaging certified blocks into a consumption
surface for stakeholders.

**What you'll do:** create an App, compose a dashboard page from the three
certified blocks you built in tutorial 02, and open it in the Apps view.

**Time:** 15 minutes.

> Setup: continues from [02 — Authoring blocks](./02-authoring-blocks.md) —
> three certified blocks (`revenue_by_month`, `avg_order_value`,
> `daily_orders`).

---

## The mental model

- An **App** is a folder under `apps/` with a `dql.app.json` manifest:
  name, domain, owners, tags, plus dashboard pages, attached notebooks,
  AI pins, and drafts. It's the unit a stakeholder opens.
- A **dashboard page** (`.dqld`) is **layout-only**: a grid that references
  blocks by id and pins a viz type per tile. The blocks own the SQL,
  governance, and tests — dashboards never copy business logic.

Everything is a file, so the whole surface is reviewable in a PR.

---

## Step 1 — Create the App

```bash
zlens app new revenue-ops --domain revenue --owner you@your-company.com
```

> **You should see** `apps/revenue-ops/` created with a `dql.app.json`
> manifest and a scaffolded `dashboards/overview.dqld`.

---

## Step 2 — Lay out the dashboard

Replace `apps/revenue-ops/dashboards/overview.dqld` with:

```json
{
  "version": 1,
  "id": "overview",
  "metadata": {
    "title": "Revenue — Overview",
    "description": "Monthly revenue trend, order volume, and AOV.",
    "domain": "revenue",
    "tags": ["revenue", "overview"]
  },
  "layout": {
    "kind": "grid",
    "cols": 12,
    "rowHeight": 80,
    "items": [
      { "i": "kpi-aov", "x": 0, "y": 0, "w": 4, "h": 2,
        "title": "Avg Order Value",
        "block": { "blockId": "avg_order_value" },
        "viz":   { "type": "single_value", "options": { "format": "currency" } } },

      { "i": "trend-revenue", "x": 4, "y": 0, "w": 8, "h": 4,
        "title": "Revenue by month",
        "block": { "blockId": "revenue_by_month" },
        "viz":   { "type": "line", "options": { "x": "month", "y": "revenue" } } },

      { "i": "orders-bar", "x": 0, "y": 4, "w": 12, "h": 4,
        "title": "Orders per day",
        "block": { "blockId": "daily_orders" },
        "viz":   { "type": "bar", "options": { "x": "day", "y": "orders" } } }
    ]
  }
}
```

Save.

---

## Step 3 — Build and check block resolution

```bash
zlens app build
```

> **You should see**
> ```text
>   ✓ Built 1 app(s), 1 dashboard(s).
>     - revenue-ops: 1 dashboard(s)
> ```

Confirm every tile resolved to a real block:

```bash
node -e "
  const m = require('./dql-manifest.json');
  const d = m.dashboards['revenue-ops/overview'];
  console.log({ blockIds: d.blockIds, unresolved: d.unresolvedRefs });
"
```

> **You should see** `unresolved: []`. Anything listed there means a tile
> references a block id that doesn't exist — fix the typo or certify the
> missing block, then rebuild.

Dashboard IDs are local to their App; the manifest qualifies them as
`appId/dashboardId`, so different Apps can each have an `overview`.

---

## Step 4 — Open it in the Apps view

```bash
zlens notebook
```

1. Click **Apps** in the activity bar.
2. Open **Revenue — Ops**. The `overview` page is the App homepage.

> **You should see** the grid render the three certified tiles. Tiles can be
> dragged and resized in **Build** mode; stakeholders use **View** mode.

You can also attach the welcome notebook to the App (read-only preview) from
the App's **Build** panel — useful for analysis narratives that accompany
the dashboard.

---

## Step 5 — See the full lineage

```bash
zlens lineage revenue-ops
```

> **You should see** the complete chain:
> ```text
> app:revenue-ops
>   ↑ contains
> dashboard:revenue-ops/overview
>   ↑ contains
> block:revenue_by_month · block:avg_order_value · block:daily_orders
>   ↑ reads_from
> dbt model: orders → staging → seeds
> ```

This is the graph the agent, the impact-analysis tooling, and `zlens verify`
all share.

---

## What you now have

✓ An App folder (`apps/revenue-ops/`) tracked in git
✓ A dashboard page composed purely from certified blocks
✓ `unresolved: []` — every tile resolves against the manifest
✓ End-to-end lineage from dbt sources to the App

[Continue to tutorial 04 — Agentic analytics →](./04-agentic-analytics.md)
