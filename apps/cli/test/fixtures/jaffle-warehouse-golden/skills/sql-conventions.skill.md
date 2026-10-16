---
id: sql-conventions
description: "House SQL conventions for grounded, certified-first analytics."
starter: true
---
# SQL conventions

Apply these conventions to all generated SQL:

- **Reference relations correctly.** In governed BLOCK SQL, reference tables via `{{ ref('<model>') }}`.
  In ad-hoc CELL SQL, use the fully-qualified relation `database.schema.table`. Never a bare model name.
- **Prefer certified blocks.** When a certified block answers the question at the right grain, reuse it
  instead of regenerating SQL.
- **Prove the answer contract before reusing a block.** Decompose the question into metric, grain,
  dimensions, filters, ranking direction, top-N, and required output columns. A certified block is
  trusted only when those pieces match; otherwise use it as context and generate review-required SQL.
- **Preserve follow-up context.** Resolve phrases like "these categories" or "those products" against
  the prior result values, and carry forward the prior measure unless the user asks for a new one.
- **Exclude test / internal accounts *only when a flag column exists in the grounded schema*.**
  If a test/internal flag is present (e.g. an `is_test`, `is_internal`, or `is_test_account` column),
  filter it out unless the question asks for those records. NEVER add a filter on a column that is not
  in the inspected/grounded schema — an invented filter column fails SQL validation.
- **One row per grain.** Make the grain explicit and ensure the query returns exactly one row per grain
  (no accidental fan-out from un-deduplicated joins).
- **Preserve amount semantics and precision.** Aggregate raw DECIMAL/NUMERIC values at their native
  grain; never round, format, or cast to FLOAT/DOUBLE/REAL before SUM/AVG. Apply COALESCE to the
  aggregate and ROUND only the outer final result. Never sum balances, snapshots, rates, ratios,
  lifetime/cumulative values, or already-aggregated metrics across a lower-grain join.
- **Read-only only.** Generate a single `SELECT` / `WITH` query; never DML or DDL.
