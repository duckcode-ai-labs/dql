# 05 — CI and `zlens verify`

**Who this is for:** platform engineers wiring ZLens into CI and audits.

**What you'll do:** add a GitHub Actions workflow that runs `zlens verify`
on every PR, demonstrate that drift is caught, and walk through what the
check covers.

**Time:** 15 minutes.

> Setup: continues from the previous tutorials — a `dql/` workspace with
> certified blocks and an App, tracked in git.

---

## Why `zlens verify`?

The DQL manifest (`dql-manifest.json`) is the single source of truth for
downstream tooling: lineage, the MCP server, the knowledge graph, the UI's
lineage drawer, and external systems via the OpenLineage exporter. If the
manifest drifts from the source tree, every downstream consumer is reading
a lie.

`zlens verify`:

1. Reads `dql-manifest.json` from disk.
2. Recompiles the manifest in-memory from source.
3. Diffs the two — block contents, dashboard refs, App definitions,
   lineage inputs, everything.
4. Returns a non-zero exit code on drift, prints a structured diff, and
   tells you exactly which files to recompile.

It's the "did you forget to commit `zlens compile`?" guard.

---

## Step 1 — Run it locally

From a clean tree:

```bash
zlens compile          # ensure dql-manifest.json is fresh
zlens verify
```

> **You should see**
> ```text
>   ✓ Manifest verified — no drift between source tree and dql-manifest.json.
> ```

Now intentionally introduce drift:

```bash
# rename a block in the file but DON'T recompile
sed -i.bak 's/revenue_by_month/revenue_by_month_v2/' \
  blocks/revenue_by_month.dql
zlens verify
```

> **You should see**
> ```text
>   ✗ Manifest drift detected:
>     - blocks: removed "revenue_by_month"
>     - blocks: added "revenue_by_month_v2"
>
>   Run `zlens compile` to regenerate, then commit.
> ```

Exit code is **1** — perfect for CI gates.

Restore:

```bash
mv blocks/revenue_by_month.dql.bak blocks/revenue_by_month.dql
zlens compile
zlens verify        # green again
```

---

## Step 2 — Add the GitHub Actions workflow

The ZLens workspace lives inside your dbt repo and installs the CLI as a dev
dependency, so CI is plain npm. Create `.github/workflows/dql-ci.yml`:

```yaml
# .github/workflows/dql-ci.yml
name: ZLens CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: dql      # the ZLens workspace inside the repo
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: dql/package-lock.json

      - name: Install
        run: npm ci

      - name: Validate DQL sources
        run: npx zlens validate

      - name: Compile manifest
        run: npx zlens compile

      - name: Verify manifest is reproducible
        run: npx zlens verify

      - name: Golden answer-routing eval
        run: npx zlens eval . --min-route-accuracy 0.9 --min-refusal 0.8 --min-answer-rate 0.9
```

Commit the workflow. The first PR you open runs all the steps and
fails fast on the first red light.

Seed `eval/*.yaml` with certified, generated, and safe-refusal questions. `zlens
eval` is deterministic and CI-safe; it reports route accuracy, refusal recall,
and answer rate for answerable cases. Use `zlens agent eval --execute` in a
credentialed environment when you also want generated SQL previews compared
against expected rows.

> **Certify in CI too?** If your default connection is reachable from CI
> (local DuckDB always is), add a step that re-certifies changed blocks:
> ```yaml
> - name: Certify changed blocks
>   run: |
>     for blk in $(git diff --name-only origin/main... | grep '^dql/blocks/.*\.dql$'); do
>       npx zlens certify "${blk#dql/}"
>     done
> ```

---

## Step 3 — Block merges on drift

In GitHub repository settings → **Branches** → **Branch protection rules**
for `main`:

1. **Require status checks to pass before merging** ✓
2. Add the `ZLens CI / verify` check to the required checks.
3. **Require branches to be up to date before merging** ✓ — so a stale
   PR can't sneak past `zlens verify`.

Now any PR that edits a block but forgets to recompile, or renames a
dashboard without rebuilding the App, cannot merge. The fix is always:
`zlens compile && git add dql-manifest.json && git commit`.

---

## Step 4 — Audit the certifier output (regulator-friendly)

For audited industries, archive certifier output as part of the PR:

```yaml
- name: Certify and upload report
  run: |
    mkdir -p /tmp/dql-reports
    for blk in $(git diff --name-only origin/main... | grep '^dql/blocks/.*\.dql$'); do
      name=$(basename "$blk" .dql)
      npx zlens certify "${blk#dql/}" --format json > /tmp/dql-reports/$name.json
    done

- uses: actions/upload-artifact@v4
  with:
    name: dql-certifier-report
    path: /tmp/dql-reports/
```

The JSON report has every rule, severity, pass/fail, and timestamp —
auditors get a per-PR snapshot of governance evidence.

---

## What `zlens verify` actually checks

From [`apps/cli/src/commands/verify.ts`](https://github.com/duckcode-ai-labs/zlens/blob/main/apps/cli/src/commands/verify.ts):

| Check | Drift signal |
|---|---|
| Block keys | Added / removed block names |
| Notebook keys | Added / removed `.dqlnb` |
| App keys | Added / removed `dql.app.json` |
| Dashboard keys | Added / removed `.dqld` |
| Metric keys | Added / removed semantic-layer metrics |
| Dimension keys | Added / removed semantic-layer dimensions |
| Source keys | Added / removed source tables |
| Per-block SQL | Block SQL changed without recompile |
| Per-block status | Certification status changed |
| Per-block domain | Domain reassigned |

Lineage edges aren't diffed yet — they're derived from the above, so a
clean check on those generally implies clean lineage. Future work will
add explicit edge-set diffing.

---

## What you now have

✓ A CI workflow that validates, compiles, and verifies on every PR
✓ Branch protection that blocks drift from reaching `main`
✓ Per-PR audit artefacts for regulator response
✓ A clear, reproducible source-of-truth pipeline

That's the full loop: dbt models → certified blocks → dashboards & Apps →
governed agent answers → CI. Stuck anywhere? See the
[troubleshooting guide](../guides/troubleshooting.md).
