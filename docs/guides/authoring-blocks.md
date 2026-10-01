# Author a certified block

> ~6 minutes · ends with a certified block linked from a notebook

A **block** is a named, versioned analytics artifact with SQL or semantic
intent, a chart spec, tests, lineage, and governance metadata. Blocks are the
unit of reuse in DQL and the thing reviewers actually review.

## 1. Open Block Studio

From the notebook UI, click **Blocks** in the left rail. Block Studio starts
with four paths:

- **Create SQL Block from dbt Model**
- **Create Semantic Block from dbt Metric**
- **AI Import SQL**
- **Ask AI to Generate Block**

Use the CLI when you want a file scaffold:

```bash
dql new block revenue_by_segment --domain finance
dql new business-view customer_360 --domain customer
```

Block Studio keeps SQL blocks and semantic blocks separate so metric references
do not get mixed into raw SQL unless you explicitly choose the advanced path.

## 2. Pick the right block type

| Block type | Use when | Primary inputs |
| --- | --- | --- |
| SQL Block | You need explicit SQL against dbt models or warehouse tables | SQL, detected tables, parameters, filter bindings |
| Semantic Block | You want a dbt/DQL metric plus dimensions and grain | metric, dimensions, time dimension, filters |

## 3. Write the SQL

```sql
select
  segment,
  sum(amount) as revenue,
  count(distinct customer_id) as customers
from @table("orders")
group by 1
order by revenue desc
```

`@table("orders")` resolves via the semantic layer (dbt or DQL-local). The
editor shows lint warnings from `dql-governance` as you type.

For a semantic block, pick a metric and dimensions instead of editing a raw
`SELECT` statement.

To extend one trusted block with another, reference the upstream block from the
new block's SQL instead of copying its query:

```sql
select
  c.customer_id,
  c.customer_name,
  o.total_orders,
  o.lifetime_revenue
from @block("Customer Identity") c
left join @block("Customer Orders Rollup") o
  on c.customer_id = o.customer_id
```

DQL records this as block-to-block lineage.

## 4. Fill in governance

| Field | Example | Why it matters |
| --- | --- | --- |
| `domain` | `finance` | Lineage cross-domain detection |
| `owner` | `analytics@company.com` | Who answers questions |
| `tags` | `revenue`, `certified` | Discovery & filtering |
| `description` | "Revenue by customer segment…" | Shows in hover cards |
| `tests` | `row_count > 0` | Blocks the certify step if failing |

## 5. Preview

**⌘↵** runs the query. Results render inline; the chart spec auto-picks bar
for categorical-x/numeric-y. Override in the visualization panel.

## 6. Certify

Click **Run Certification** and then **Certify** after the checklist passes.
DQL:

- runs tests (`tests:` block)
- validates required metadata
- verifies the block can run
- validates chart config and lineage
- keeps AI-generated changes in review until approved

The certified tag appears in the block library; downstream notebooks see
the new version on next open.

### Retiring a block

When a new block takes over from a certified one, set the old block's
`status = "deprecated"` and name the replacement:

```dql
status = "deprecated"
replacedBy = "Claims Dataset"
deprecatedOn = "2026-09-30"
```

The old block's badge then reads **Replaced by Claims Dataset**, opening it
offers **Open the replacement**, Ask answers its questions from the
replacement, and `dql validate` lists every block and App page still using
it. See [Retired Block](../reference/language.md#retired-block).

## 7. Use it in a notebook

```dql
-- Notebook cell
@block("revenue_by_segment")
```

DQL inlines the compiled SQL, runs it, and renders the block's chart spec.

## 8. Add business terms

Define business vocabulary once, then reference it from blocks and business
views. This creates the business lineage layer that sits above SQL and dbt
lineage.

```dql
term "Customer" {
  domain = "Customer"
  type = "entity"
  status = "draft"
  description = "A person or account that can place orders or receive service."
  owner = "customer-analytics"
  identifiers = ["customer_id"]
  synonyms = ["Account"]
}

block "Customer Orders Rollup" {
  domain = "Customer"
  type = "custom"
  terms = ["Customer"]

  query = """
    SELECT customer_id, COUNT(*) AS total_orders
    FROM fct_orders
    GROUP BY 1
  """
}
```

## 9. Compose a business view

Use `business_view` when the value is no longer one SQL result, but a business
capability made from multiple reusable blocks.

```dql
business_view "Customer 360" {
  domain = "Customer"
  status = "draft"
  description = "Complete customer view for retention and account review."
  owner = "customer-analytics"
  terms = ["Customer"]
  businessOutcome = "Understand customer value, activity, and service risk."
  decisionUse = "Account planning, churn review, and expansion targeting."
  reviewCadence = "weekly"

  includes {
    block "Customer Identity"
    block "Customer Orders Rollup"
    block "Customer Service Summary"
  }
}
```

`dql compile` adds the view to `businessViews` in the manifest and creates
lineage edges from each term, included block, or nested business view into this
view.

## Verify it worked

- Block appears in the **Block Library** sidebar with a green "certified" badge
- `git log -- blocks/finance/revenue_by_segment.dql` shows a clean commit
- Notebook cell referencing the block renders a bar chart with your data
