# Migrate from Metabase / Looker / Hex

> ~varies by source · scaffold first, refine by hand

ZLens's migration tooling doesn't promise a one-click swap — it scaffolds a
starting point that you refine. Expect ~80% of simple queries to compile
cleanly; the remaining 20% surface as `// TODO` comments in the generated
`.dql` files.

## From Looker (LookML)

```bash
zlens migrate looker --input path/to/lookml/
```

Maps views → DQL tables, measures → metrics, dimensions → dimensions. Liquid
templating becomes `// TODO` comments with the original inline.

## From Metabase

```bash
zlens migrate metabase --input export.json
```

Reads a Metabase collection export. Questions become notebooks; saved SQL
becomes blocks.

## From Hex

```bash
zlens migrate hex --input workspace.zip
```

Cells map 1:1. Python cells are preserved as markdown with the original source
for manual port.

## From raw SQL

```bash
zlens migrate raw-sql --input queries/
```

Each `.sql` file becomes a block scaffold with a generated chart spec
inferred from column types.

## Verify

After any migration:

```bash
zlens validate .
zlens fmt .
```

`validate` flags unresolved references; `fmt` canonicalizes the scaffolded
output so the initial commit is clean.
