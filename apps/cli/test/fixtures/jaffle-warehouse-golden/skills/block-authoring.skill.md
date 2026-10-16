---
id: block-authoring
description: "How the agent should draft meaningful, certified-ready DQL blocks from your data."
starter: true
---
# Block authoring

Guidance the agent follows when drafting DQL blocks from dbt + the semantic
layer. Edit it to match how your team models analytics — the agent will adapt.

- **Lead with semantic metrics.** When a model backs a semantic measure, build a real
  aggregation block (group by the declared grain/dimensions, aggregate the measure) — not `SELECT *`.
- **One business concept per block.** A block answers one clear thing (e.g. "Monthly Revenue",
  "Active Customers"), not "everything in this table".
- **Name by the business term, not the model.** Prefer "Revenue by Month" over `fct_orders`.
- **Make the grain explicit.** State one row per <grain> and keep the SQL at that grain.
- **Declare outputs.** Name the measures/dimensions the block exposes; avoid blind passthroughs.
- **Pick the vital few.** Favor the handful of high-value blocks stakeholders actually ask for
  over one wrapper per dbt model.
- **Write real example questions.** Each block should list 3 concrete business questions it answers.
- **Stay grounded and review-required.** Use only real columns/metrics from the project; every draft
  is reviewed and certified by a human before reuse.
