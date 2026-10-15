# Diagnose a local Ask AI failure with a trace

Use this workflow when an office project reports a bad routing decision,
clarification loop, provider error, generated SQL failure, or incomplete
Research answer. It is safe for local investigation; it does not upload data.

## 1. Capture the compact run context

Before re-running the question, record the ZLens binary path/version/commit and
the selected project/connection. From the Ask result, open **How it was
answered** and then **Open full trace**. Save the run ID, trace ID, status,
selected tier, trust state, and provider phase/cause if present.

Do not copy the office question, SQL, result rows, database names, local paths,
provider request/response bodies, or credentials into an issue.

## 2. Read the trace from top to bottom

The detail page starts with an answer-first incident summary. Read **What
happened**, **Why**, **Impact on answer**, and **How to fix** before opening a
detail pane. Those fields are derived from typed provider cause/safe action,
coverage, cascade, SQL, and tool receipts; they do not expose provider bodies,
SQL, or rows. Use **View related stage** to jump to the responsible evidence.

In **Trace Tree** expand only the failed/terminal path first:

1. **Snapshot and retrieval** — inspect source coverage and candidate lifecycle.
   An excluded or pruned candidate is evidence of package narrowing, not proof
   that the model or field is unmodeled.
2. **Meaning and cascade** — check the selected qualified IDs, cascade attempts,
   and whether the plan froze. Pre-freeze unavailable/ineligible tiers may move
   to a safe later tier; policy denial and post-freeze failure remain terminal.
3. **Provider, tool, and SQL** — inspect phase, stable cause, safe action,
   fingerprints, and reason codes. No payload includes the raw request, SQL, or
   values.
4. **Result/narration/persistence** — distinguish an execution failure from a
   narration fallback or a local trace-store failure.
5. **Research** — inspect each linked branch, validator, verdict, and synthesis
   limitation. `inconclusive` is not a positive finding.

Use **Agent Graph** to understand physical dependencies plus dashed
continuation/Research relationships and **Timeline** to locate a slow boundary.
Search temporarily expands matching tree paths; clearing search restores the
normal progressively disclosed view.

## 3. Export a safe reproduction bundle

From a terminal in the project directory:

```bash
zlens agent trace show <run-id> --format json
zlens agent trace export <run-id> --out ./ask-trace-strict --profile strict
zlens agent trace validate ./ask-trace-strict
zlens agent trace replay ./ask-trace-strict --mode receipt
```

The strict bundle pseudonymizes identifiers and refuses raw SQL, URLs, paths,
secrets, and similar dangerous content. Validation/replay are offline-only.
Do not use a support profile unless an authorized reviewer explicitly confirms
that the qualified identifiers and any separately supplied reviewed question
are safe to share.

## 4. Share an actionable gap

For a ZLens maintainer, share the strict bundle plus this redacted checklist:

- ZLens version, binary path, package/commit SHA
- provider/model/base-origin **fingerprints** and readiness status, not values
- manifest/catalog/SQLite/vector/runtime-schema fingerprints and timestamps
- trace/run IDs, selected tier, trust state, stop reason, and stable failure code
- admitted/excluded candidate IDs and reason codes
- cascade attempts, plan/SQL/result fingerprints, and redacted logs
- a sanitized reproduction using the office-shaped fixture pattern

If the trace store says unavailable or unsupported, that explains only missing
diagnostic evidence. It does not explain a failed Ask answer by itself: trace
recording is intentionally fail-open.

## 5. Compare before and after a fix

Export a strict receipt from each run, then compare structurally:

```bash
zlens agent trace compare ./before ./after --mode compare
```

Look for a change in source coverage, candidate role/reason counts, cascade
attempts, provider/tool/SQL attempts, route/tier, trust, and timing. Do not use
the text of an answer as the only proof of a routing fix.
