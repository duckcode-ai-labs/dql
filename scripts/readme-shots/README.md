# README screenshots

`capture.mjs` retakes the product screenshots in the root `README.md`
(`docs/assets/readme/*.png`) from the real product. Run it each release so the
README matches what users get.

It builds nothing fake: the CLI built from this checkout serves the
[Jaffle Shop DuckDB sample](https://github.com/duckcode-ai/jaffle-shop-duckdb)
(pinned commit) with `zlens notebook`, Playwright drives the workbench, and Ask
uses a real AI provider. Every label, number and answer in the images is what
the product showed during the run.

## Run it

```bash
pnpm install
pnpm exec turbo run build --filter=@zlens/cli...
node scripts/readme-shots/capture.mjs
```

Without `--sample`, the script clones the sample into the work directory and
builds it with dbt (needs Python 3.9 to 3.13 and network on the first run).
Pass `--sample <dir>` to reuse a clone you have already built with
`dbt seed` and `dbt build`.

| Option | Default | |
|---|---|---|
| `--sample <dir>` | clone and build | a dbt-built clone of the sample |
| `--work-dir <dir>` | `node_modules/.cache/zlens-readme-shots` | scratch space (the project copy, the DuckDB driver, the server log) |
| `--out <dir>` | `docs/assets/readme` | where the PNGs go |
| `--port <n>` | `3490` | notebook port |
| `--provider <id>` | `claude-code` | AI provider for Ask: `claude-code` (your Claude subscription through the Claude Code CLI), `codex`, or `ollama` |
| `--model <name>` | | model name (required for `ollama`) |
| `--only <a,b>` | all | retake some shots only |

Shots: `app`, `ask-certified`, `ask-review`, `notebook`, `block-certified`,
`app-ask`, `lineage`. Each is 1440×900 CSS pixels at device scale factor 2,
light theme, cropped to the part the README talks about. If `pngquant` (or
ImageMagick) and `oxipng` are on `PATH`, the files are optimised in place.

## What the script does to the sample

- Points the sample's `jaffle_shop_dev` connection (an absolute path on its
  author's machine) at the sample's own `jaffle_shop.duckdb`.
- Installs the DuckDB driver into `.dql/connectors`, as the Connections page
  does.
- Writes the AI provider to `.dql/provider-settings.json`, as
  **Settings → AI provider** does.
- Runs everything as the sample's analyst (`analytics@jaffle.shop`), so no
  personal git identity reaches a screenshot.
- At the pinned commit, the sample's certified `beverage_revenue_by_product`
  block orders by an ambiguous `product_name` and fails on DuckDB. The script
  fixes that one column reference in a draft and certifies it with
  `zlens certify --from-draft`, the documented CLI path, so the App's tile runs.
