# Migrate from other tools

Moving to ZLens from Looker, Metabase, Tableau, Hex or a folder of SQL
scripts starts with the SQL behind your reports.

## Bring the SQL over

1. Export or copy the SQL of the reports you want to keep into `.sql` files,
   one query per file (or several queries in one file).
2. Import them:

    ```bash
    zlens import sql ./legacy-sql --domain finance --owner you@example.com
    ```

    `zlens migrate raw-sql --input ./legacy-sql` does the same thing.

3. Review the drafts and certify the ones that are right. You can also do the
   import in the workbench. See [Import SQL](../blocks/import-sql.md).

Each query becomes a draft block with a name, description, grain and outputs
drafted by AI, a preview of its rows, and a default test. Nothing is
certified until a person certifies it.

## What `zlens migrate <tool>` does today

`zlens migrate looker`, `metabase`, `tableau` and `dbt` do not read your
exports yet. They print the approach for that tool and an example of the block
it would produce. Use the import above for real content.

## Check the result

```bash
zlens validate .
```

`zlens validate` reports unresolved references in the imported blocks.

## Upgrade older ZLens or DQL files

These `migrate` commands work on your own project files:

| Command | Does |
|---|---|
| `zlens migrate format --check` | Lists `.dql` and `.dqlnb` files that are not in the canonical format. Run without `--check` to rewrite them. |
| `zlens migrate layout --to domain-first --dry-run` | Previews moving older folders into the `domains/` layout. |
| `zlens migrate parameters --check` | Audits older block parameters. |
| `zlens migrate modeling --to dbt-first --dry-run` | Previews adopting dbt-first modeling. Use `--apply` to write. |
| `zlens migrate datalex --input <manifest.json> --dry-run` | Converts DataLex business semantics into dbt-first overlays. |
