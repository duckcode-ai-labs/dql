# Save and certify

ZLens keeps two steps apart:

- **Save** keeps your work. The block is a **draft**.
- **Certify** is a person saying "this is right". ZLens runs its checks, and
  only if they pass does the block become **Certified**, with a record of who
  certified it.

**Saving never certifies.** Not in Block Studio, not in Import SQL, not when
Ask keeps a draft, and not from the CLI.

## Save a draft

In Block Studio, click **Save draft**.

- A block needs a name and an **Owner** before it can be saved.
- The block is written with `status = "draft"`.
- If the block was already certified, your edit is saved as a separate draft
  beside it. Block Studio says **Saved as a draft beside the certified block.
  The certified version stays in use until this draft is certified.**

## Certify a block

1. Open the block in Block Studio.
2. Click **Certify** (**Re-certify** on a block that is already certified).

ZLens saves your latest edits, then checks the block. A panel shows each
check: **Metadata**, **Validation**, **Run**, **Tests**, **Chart · optional**
and **Lineage · optional**.

**When it passes**, the panel reads **Block certified**, the badge changes to
**Certified**, and a receipt line appears under the block name:

```text
Certified by you@example.com · 10/15/2026, 3:27:48 PM · via Block Studio · OSS rules
```

**When it does not pass**, the panel reads **Unable to certify** and lists
**Fixes before certification**. Each fix says how to fix it and has a button
for it, such as **Run block** or **Edit source**. Your draft stays saved and
nothing is half-certified.

## The rules

To be certified, a block must:

- have an **Owner**,
- compile and run successfully, and
- pass all of its tests.

A description that still says "review required" also blocks certification.
Block Studio offers to remove those words or let you edit the description.

Other checks are warnings: an AI-facing description (LLM context), tests,
grain, declared outputs, entities and a review cadence. They are recorded on
the receipt. With `zlens certify --enterprise`, they become requirements.

## Add tests

Tests are assertions that run every time the block runs. In the block's DQL:

```dql
tests {
  assert row_count > 0
}
```

In the visual builder, use the **Tests** box. If a test fails, Certify stops
with **A block test failed**.

## Where the receipt is kept

Each block has a companion YAML file under `semantic-layer/blocks/`. When you
certify, ZLens writes:

```yaml
reviewStatus: certified
certification:
  certifiedBy: you@example.com
  certifiedAt: '2026-10-15T20:27:48.466Z'
  via: block-studio
  rules: oss
  sourceSha256: b8e2…
```

`sourceSha256` is a fingerprint of the block source that was certified.
**Certified by** is your git identity (`git config user.email`).

## Certify from the terminal

Check a block without changing it:

```bash
zlens certify blocks/finance/revenue-by-segment.dql
```

It runs the block's tests on the project's connection and prints
`Status: ✓ CERTIFIABLE` or `Status: ✗ NOT CERTIFIABLE` with the reasons. It
exits with code 1 when the block does not pass, and writes nothing.

!!! note
    The terminal check needs test results, so give the block at least one
    test. A DuckDB file can be opened by one program at a time: stop
    `zlens notebook` before you run the check against the same file.

Certify a draft:

```bash
zlens certify --from-draft blocks/_drafts/top-customers.dql --owner you@example.com
```

When the checks pass, it moves the draft to its normal place, sets it to
certified, writes the receipt (with `via: cli`), and prints
`✓ Promoted <draft> -> <path>.` Then run `zlens compile` to refresh
`dql-manifest.json`. When the checks fail, the draft is unchanged.

## Retire a block

1. Open the block and the **Metadata** tab at the bottom.
2. Click **Deprecate**.

To send people to a newer block, set `replacedBy` in the block. Block Studio
then shows **Replaced by** with **Open the replacement →**.
