# Import SQL

Turn SQL you already have into draft blocks. ZLens reads the SQL, drafts a
block for each query, runs a preview, and saves the drafts. You review each
one and certify the ones that are right.

{{ clip("import-certify") }}

## 1. Open Import SQL

1. In the left rail, click **Blocks**.
2. With no block open, Block Studio shows **Create DQL blocks**. On the
   **Import SQL** card, click **Start import**.

The page is titled **Import SQL to DQL** and shows three steps: **Source**,
**Draft** and **Review**.

## 2. Give it your SQL

Pick one:

- **Paste SQL**: paste one or more queries.
- **Upload files**: pick `.sql` files.
- **Local path**: a file or folder inside your project.

Optionally set **Domain** and **Owner**. Then click **Generate DQL drafts**.

ZLens works through **Reading SQL**, **Running previews** and **Saving
blocks**, then **Import complete**. The drafts are already saved as files.

## 3. Review each draft

The **Drafts** list shows one row per query. Click a draft to see:

- **Review details**: name, domain, owner, description, grain, outputs and
  other fields you can edit.
- **Preview Results**: the rows the query returned.
- **Original SQL** and **Draft DQL block**: before and after.
- **Grounding**: the tables and columns ZLens matched.

Edit the review details if something is wrong. **Edit full DQL** opens the
whole block. If ZLens finds a similar certified block, it suggests
**Reuse existing** instead of a new block.

## 4. Save the draft

Click **Save draft**. The message reads **Draft saved · needs review.
Certify it when it is ready.**

- A draft needs an **Owner**.
- If you changed the review details, ZLens saves the values you see.
- If the name is taken, rename the draft and save again.

## 5. Certify it

Click **Certify**. It is available once the draft is saved.

ZLens runs the block and its tests. When they pass, the block moves out of
`_drafts/` to its normal place and is **Certified**, with a receipt. When they
do not, you see **Not certified; the draft is unchanged.** and the reasons.
See [Save and certify](certify.md) for the rules.

## Where the drafts go

- `domains/<domain>/blocks/_drafts/` when your project has domain folders,
  otherwise `blocks/_drafts/<domain>/`.
- The import session is cached in `.dql/imports/<session>/`. **Import
  history** lists past sessions.

## From the terminal

```bash
zlens import sql ./legacy-sql --domain finance --owner you@example.com
```

It prints one line per query with the draft's path, and ends with:

```text
Drafts are autosaved under blocks/_drafts or domains/<domain>/blocks/_drafts. Review, preview, then certify selected candidates.
```

Then certify a draft with
`zlens certify --from-draft <path> --owner you@example.com`.
