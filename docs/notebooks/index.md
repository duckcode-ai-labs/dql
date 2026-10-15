# Work in a notebook

A notebook is where you explore: SQL and DQL cells, their results, and notes,
in one file. When a query is worth keeping, you save it as a block.

{{ clip("notebook") }}

## Create a notebook

1. In the left rail, click **Notebooks**.
2. Click **New Notebook** (or the **Create notebook** icon next to
   **Search notebooks…**).
3. Fill in the **Create notebook** dialog:
    - **Notebook name**, such as `Customer retention analysis`.
    - **Domain context** (optional).
    - **Who is this for**: **Shared with the team** saves it in `notebooks/`,
      tracked by git. **Private to me** keeps it outside git until you publish it.
    - **Starting point**: **Start empty**, or a template such as
      **Explore a question** or **Investigate a metric**. Templates only add
      starter cells.
4. Click **Create notebook**.

An empty notebook asks **What are you researching?** and offers
**Use existing block**, **Ask Notebook AI**, **Create DQL query** and
**Import local data**.

## Add cells

Hover between cells and click **Add cell**. Pick a type:

| Type | Use it for |
|---|---|
| **SQL** | Plain SQL against your database. |
| **DQL** | A block, or a semantic query with `@metric(...)` and `@dim(...)`. |
| **Block** | An existing block, by name: `@block("Top customers by lifetime spend")`. |
| **Ask AI** | A question for Notebook AI. |
| **Import** | Local CSV, Parquet or JSON data. |
| **Note** | Markdown text. |
| **Input** | A parameter, such as a date or a dropdown, that other cells use. |

Each cell shows its type in its header, and which connection it **runs on**.

A DQL cell holds a block. To start one, click **Insert DQL example** in an
empty DQL cell:

```dql
block "Top customers by revenue" {
  domain = "sales"
  type = "custom"
  query = """
SELECT customer_name, SUM(amount) AS revenue
FROM orders
GROUP BY 1
"""
}
```

To switch an empty DQL cell to plain SQL, click **Switch to SQL cell**.

## Run cells

- Run one cell: **Shift+Enter**, **Cmd+Enter** (**Ctrl+Enter**), or the run
  button in the cell header.
- Run every cell: **Run all** at the top, or **Cmd+Shift+Enter**.

The result appears under the cell, with **Success**, the row count and the
time it took. From the result you can **Filter**, **Pivot**, make a **Chart** or
a **KPI**, and download **CSV** or **JSON**.

## Saving

Notebooks save themselves a moment after you stop typing. **Save** at the top
(or **Cmd+S**) saves at once. A dot next to the title means there are unsaved
changes.

The notebook is a `.dqlnb` file. Results go in a `.run.json` file next to it,
which git ignores, so data never ends up in a commit.

## Save a cell as a block

When a query is worth reusing:

1. Hover over the cell and click **Save Block** ("Save this cell as a reusable
   block").
2. In **Save as Block**, fill in **Block Name** and **Owner**, and ideally a
   **Domain**, **Tags** and **Description**. **Governance checks** shows what is
   still missing.
3. Click **Save draft block**.

ZLens saves a draft block and opens it in Block Studio. As the dialog says,
saving never certifies: click **Certify** in Block Studio when it is ready.
See [Save and certify](../blocks/certify.md).

## See where a cell's data comes from

Under a SQL or DQL cell, open **Cell SQL lineage** (SQL) or **Project block
lineage** (DQL) to see the tables, joins, filters and outputs. **View in DAG**
opens the full [lineage](../lineage/index.md).

## Notebook AI and history

- **Notebook AI** (top right) opens a side panel that answers questions using
  the whole notebook, dbt and semantic metadata, and certified blocks. It needs
  an [AI provider](../get-started/ai-provider.md).
- **History** shows this notebook's earlier Notebook AI conversations.

## Share a notebook

A shared notebook is a file in `notebooks/`. Commit it from
**Source control**. To remove local run state before sharing, run:

```bash
zlens promote notebook notebooks/customer_orders.dqlnb --to shared
```

See [Version and diff your work](version-and-diff.md).
