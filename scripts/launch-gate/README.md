# Launch gate

`node scripts/launch-gate.mjs` checks a release the way a new user meets it.
On a clean folder it installs the packed release, follows the README and
docs quickstart exactly for both samples, and prints a pass/fail table. Push
a release tag only after a run on the tagged commit has zero failures.

```bash
pnpm install --frozen-lockfile
node scripts/launch-gate.mjs --out ../gate-runs/gate-$(date +%Y%m%d-%H%M%S)
```

It takes 20 to 40 minutes: the dbt build, two `npm install`s, and Ask
answered by a live model.

## What it does

1. **Packs the release.** `scripts/release-packages.mjs --dry-run` builds the
   workspace and packs the 18 release packages at the version in
   `apps/cli/package.json`. These are the tarballs `npm publish` would upload.
   Pass `--tarballs <dir>` to reuse tarballs packed earlier.
2. **Serves them from a local registry** on `127.0.0.1` (first free port from
   `--port`, default 3620). The release packages resolve to the packed
   tarballs, at their version, under `latest`. Every other package passes
   through to registry.npmjs.org. Nothing is published.
3. **Uses a clean shell:**
   - npm points at that registry, with a fresh npm cache and an empty user
     config;
   - no npm/pnpm/`ZLENS_*` variables from the harness;
   - no `dbt`, `mf` or `zlens` from your `PATH`; the quickstart uses the
     sample's own `.venv/bin/dbt`;
   - `ZLENS_EMBEDDINGS_AUTODETECT=off`, so a local Ollama does not change
     Ask.

   `open`/`xdg-open` are stubbed, so `npm run notebook` does not open your
   browser. Playwright is the browser.
4. **dbt sample** (`duckcode-ai/jaffle-shop-duckdb`), as the README says:
   - `git clone`; the Python venv; `pip install`; `dbt deps`, `dbt seed` and
     `dbt build`;
   - `npm install`, the DuckDB driver, `npm run sync`, `npm run validate`;
   - `npm run notebook`;
   - then, in the browser (`apps/dql-notebook/browser/gate/dbt-sample.gate.ts`):
     - Guided Setup with the dbt project (Preview, Apply project, DuckDB
       configured and tested, Finish setup);
     - the quickstart's notebook query;
     - the **Jaffle Growth Review** App and its trust labels;
     - lineage of `monthly_revenue` (dbt source → dbt model → block → App);
     - the `claude-code` AI provider (Settings → AI provider → Anthropic
       Claude → Subscription → Test, save & activate);
     - Ask: a certified answer;
     - two App Ask questions, each of which must carry exactly one kind of
       trust label;
   - then `zlens connect claude-code`, `zlens mcp test` with the workbench up
     (must pass), `zlens doctor` while it runs (no DuckDB lock error), and
     `zlens mcp test` with it stopped (must fail and say Not ready).
5. **Warehouse sample** (`duckcode-ai/jaffle-shop-warehouse`, no dbt): the same
   steps without dbt. In the browser (`warehouse-sample.gate.ts`):
   - Guided Setup with Database only;
   - the starter notebook's **Run all**;
   - a certified join in Modeling;
   - the provider;
   - Ask: an AI-drafted answer labelled for review that joins store names and
     saves a draft block;
   - lineage of that draft block back to the warehouse tables, without
     "Compiled from the dbt manifest".
6. **`create-zlens-app`** in an empty folder:
   - `npx create-zlens-app@<version> my-analytics --warehouse duckdb`;
   - checks the generated config;
   - `npm install`, then `npx zlens --version`.

The sample's own `@zlens/cli` range is a check of its own. If the range would
not install the packed version (`^0.1.0` never installs 0.2.0), that row
fails, and the gate sets the range to `^<version>` so it can test the rest.

## Where the README is not followed to the letter

- `npm run notebook -- --port <free port>` instead of 3474, so the gate never
  collides with a workbench you are running. `zlens mcp test` then needs
  `ZLENS_RUNTIME_URL`, as `docs/agents` says for a workbench on another
  address.
- Guided Setup's optional AI step is skipped. The provider is set in
  **Settings → AI provider** instead, as `docs/get-started/ai-provider.md`
  does it, so it is its own row.

## Requirements

- Node 20+, git, Python 3.9 to 3.14 (the README's `python3`, or `--python`).
- The `claude` CLI, signed in. The `claude-code` provider runs it. No API keys.
- Playwright's Chromium (`pnpm --filter @zlens/notebook-app exec playwright install chromium`).
- Network access to GitHub, PyPI and registry.npmjs.org.

## Output

Under `--out`:

| Path | What |
|---|---|
| `summary.md`, `summary.json` | The pass/fail table, with commit, version and the PATH entries hidden. |
| `logs/` | Every command, its output and exit code, one file per step. |
| `evidence/` | A screenshot (and notes) per browser check, passed or failed. |
| `playwright/` | Traces and failure screenshots from Playwright. |
| `dbt/`, `warehouse/`, `create/` | The folders the quickstart ran in. |

The exit code is 0 only when every row passed.

`--only dbt,warehouse,create` runs a subset.
