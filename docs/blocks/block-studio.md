# Block Studio dbt-first workflow

> ~8 minutes · ends with one draft SQL block and one draft semantic block ready for certification

Block Studio is the main workspace for turning dbt models, dbt semantic
metrics, or legacy SQL into trusted DQL blocks.

The intended flow is:

```text
Connect dbt -> Pick model or metric -> Build block -> Validate -> Save draft -> Certify -> Use in Apps
```

The editor toolbar keeps the two trust transitions separate: **Save draft**
persists review-required work, while **Certify** runs the validation, execution,
test, chart, and lineage gates before changing the status. A draft may be used
inside Block Studio for authoring and review, but normal Ask retrieval does not
offer it as answer evidence; Ask can route through a block only after that block
is certified.

ZLens does not replace dbt. dbt owns models, transformations, tests, and semantic
definitions. ZLens owns reusable answer blocks, chart configuration, notebooks,
Apps, AI pins, certification labels, and answer-level lineage.

## 1. Open Block Studio

Start the notebook UI:

```bash
npx zlens notebook ./dql
```

Click **Blocks**. If no block is selected, Block Studio shows four starting
paths:

- **Create SQL Block from dbt Model**
- **Create Semantic Block from dbt Metric**
- **Import SQL**
- **Ask AI to Generate Block**

The start page also shows dbt status: project path, `manifest.json`,
`catalog.json`, `semantic_manifest.json`, and setup hints.

## 2. SQL block from a dbt model

Use this when you need explicit SQL.

1. Click **Create SQL Block from dbt Model**.
2. Pick or type a block name.
3. Use the schema/dbt explorer to insert tables and columns.
4. Write normal SQL against warehouse tables or dbt-built models.
5. Run, inspect results, then save as draft.

Example:

```dql
block "Daily Transaction Volume" {
  domain = "cards"
  type = "custom"
  status = "draft"
  description = "Daily card transaction volume."
  owner = "analytics"
  tags = ["cards", "daily"]

  query = """
SELECT
  transaction_date,
  SUM(amount) AS transaction_volume
FROM analytics.fct_card_transactions
GROUP BY transaction_date
ORDER BY transaction_date
"""

  visualization {
    chart = "line"
    x = transaction_date
    y = transaction_volume
  }
}
```

If you click a semantic metric while editing a SQL block, ZLens does not silently
mix it into the query. The UI asks whether to create a Semantic Block or insert
an advanced semantic reference explicitly.

## 3. Semantic block from a metric

Use this when dbt Semantic Layer or DQL semantic metadata already defines the
business metric.

1. Click **Create Semantic Block from dbt Metric**.
2. Pick the metric.
3. Add dimensions, optional time dimension, grain, and chart intent.
4. Validate the generated DQL.
5. Save as draft.

Example:

```dql
block "Approval Rate by Region" {
  domain = "cards"
  type = "semantic"
  status = "draft"
  description = "Approval rate by region from the dbt semantic layer."
  owner = "analytics"
  tags = ["cards", "approval"]

  metric = "approval_rate"

  visualization {
    chart = "single_value"
    y = approval_rate
  }
}
```

Semantic blocks hide raw `SELECT` editing by default. If you need custom SQL,
create a SQL Block instead.

## 4. AI Import legacy SQL

Use **AI Import** when pasting SQL, uploading `.sql` files, migrating folders,
or turning an agent-generated SQL answer into a reusable block draft.

The wizard is:

```text
Source -> Analyze -> Reuse/parameterize -> Preview -> Certify
```

Supported first-pass sources:

- paste SQL
- upload one `.sql` file
- upload multiple `.sql` files
- project-relative folder path

The importer splits semicolon-delimited statements, common `GO` batches, and
repeated `-- name:` / `-- title:` query headers. For each statement it detects
tables, joins, parameters, literals, grain, outputs, and source metadata.

Before saving a new draft, ZLens runs a reuse-first check:

- exact SQL match -> reuse the existing block
- same SQL shape with different values -> reuse with new parameter values
- same business intent -> prefer the certified block
- close variant -> propose extending the existing block
- genuinely new logic -> save a draft block

Runtime-scope literals such as years, dates, `LIMIT`, IDs, segments, teams,
players, regions, products, and comparison windows become DQL params when safe.
Contiguous year lists become range parameters, non-contiguous year lists stay
selected-set parameters, and filters such as `team IN ('LAL', 'BOS')` become
array-backed params such as `team_set = ["LAL", "BOS"]`.
Business constants stay static or review-required. Generated drafts include
`parameterPolicy` and `filterBindings` so Apps can apply shared filters only to
compatible blocks.

For batch migration from the CLI:

```bash
zlens import sql ./legacy-sql --domain finance --owner analytics
```

The import command autosaves valid candidates as `_drafts` blocks, reports
similar certified blocks, and keeps `--save` only as a compatibility alias. Run
the preview/tests and then certify the reviewed block.

In the **Import SQL to DQL** screen, **Save draft** writes the candidate as a
draft (the `.dql` status and its YAML both say `draft`) and never certifies it,
even when every check would pass. **Certify** is a separate button: it runs the
certification rules against the saved draft and, only when they pass, moves it
to the canonical blocks folder as certified and records who certified it.

## 5. Certify

Certification is a trust label in OSS. It is not RBAC.

Before clicking **Certify**, confirm:

- metadata is present
- validation has no errors
- the block runs successfully
- tests pass
- chart config is valid
- lineage is captured
- AI-generated changes were reviewed

Certification changes useful blocks from `draft` or `review` to `certified`.
Certified blocks appear in the block library and can be added to App dashboard
pages.

Certify is the only way a block becomes certified: saving (here, from a notebook
cell, from an Ask answer, or from an import) always writes a draft. A passing
certification writes a receipt into the block's companion YAML — who certified
it, when, from which surface, under which rules, and the hash of the exact
source — and the block overview shows it as *Certified by … · when · via …*.
From the CLI, `zlens certify --from-draft <path>` runs the same rules and
leaves the same receipt.

## 6. Lineage

SQL blocks track detected tables and dbt model/source matches.

Semantic blocks track:

```text
dbt source -> dbt model -> semantic metric -> DQL block -> dashboard page -> App
```

Run these commands after dbt artifacts change:

```bash
dbt build
npx zlens compile ./dql
npx zlens sync dbt ./dql
cd dql && npx zlens agent reindex
```

## Verify it worked

- Block Studio dbt status shows `manifest.json` present.
- A SQL block validates and runs against a dbt model or warehouse table.
- A semantic block validates from a metric without raw SQL editing.
- Imported SQL saves as draft blocks instead of replacing current work.
- The Lineage tab shows source/model/metric/block/App context after compile.
