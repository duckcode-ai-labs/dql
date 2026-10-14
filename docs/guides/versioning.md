# Version & diff notebooks

> ~4 minutes · ends with a clean PR-ready diff

Notebooks are plain text in git. ZLens's job is to keep the diffs **readable**
and the history **meaningful** — not line-noise from whitespace churn.

## Canonical format

Every `.dql` file starts with a version header:

```dql
// dql-format: 1

block "Revenue by segment" {
  domain = "finance"
  type = "custom"
  status = "draft"
  query = """SELECT 1 AS revenue"""
}
```

`zlens fmt` normalizes whitespace, key order, and SQL formatting into a
canonical form. Run it in a pre-commit hook (or enable notebook autosave —
the notebook writes canonical on save).

```bash
zlens fmt blocks/**/*.dql            # format in place
zlens fmt --check .                  # CI: non-zero exit if anything drifts
```

## Semantic diff

`git diff` works fine, but it's character-level. `zlens diff` is
**AST-level** — it tells you *what changed semantically*, not *which bytes*.
Works for both `.dql` blocks and `.dqlnb` notebooks.

```bash
zlens diff blocks/finance/revenue_by_segment.dql             # vs. HEAD (inside a git repo)
zlens diff notebooks/overview.dqlnb                          # notebook vs. HEAD
zlens diff before.dql after.dql                              # two files directly
```

Output:

```
~ block "Revenue by segment"
    tags: ["revenue"] -> ["revenue", "certified"]
    query:
      - group by segment
      + group by segment, region
    visualization: bar -> stacked-bar
```

Exits **1** on differences (scriptable like `git diff`).

## In-app git panel

Open the notebook sidebar → **Git** (⌘⇧G). You get three tabs:

- **Status** — porcelain view of the working tree, color-coded
- **Log** — last 30 commits on this branch, click to diff
- **Diff** — full or scoped to the active file

Read-only in v1.0 (the panel shipped in the v0.12 milestone). Stage / commit /
push are planned for the v0.13 milestone.

## Run snapshots

Executing cells writes a sibling `<notebook>.run.json` with the last
results. On re-open, ZLens rehydrates status/result/error without re-running
queries, and each rehydrated cell shows a subtle `cached` chip above its
output until you re-run it.

Snapshots are **git-ignored by default** — the first snapshot write appends
`*.run.json` to the project's `.gitignore`. Un-ignore deliberately if you
want to ship executed state in git.

## Upgrading existing projects

Files created before the canonical format can be upgraded in place:

```bash
zlens migrate format            # upgrade every .dql/.dqlnb in the project
zlens migrate format --check    # dry run; exits 1 if anything would change
```

Safe to re-run — files that are already canonical are skipped.

## Verify it worked

- `git diff` on a saved-but-unchanged notebook is empty (no whitespace churn)
- `zlens fmt --check .` passes in CI
- `zlens diff A B` produces a readable semantic report on two versions
