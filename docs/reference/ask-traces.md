# Local Ask trace reference

Ask traces are local diagnostic receipts for Ask, conversation, and Research.
They are not a hosted telemetry service and cannot affect query selection,
authorization, trust, provider retry, SQL safety, or an execution deadline.

## Storage and retention

The store is project-local at:

```text
.dql/local/ask-observability.sqlite
```

It is separate from AgentRun persistence and uses SQLite WAL. Default retention
keeps up to 500 detailed traces for 30 days and 2,000 summaries for 180 days,
within a 256 MiB database. A summary remains after detailed evidence expires.

Trace data contains qualified IDs, stable phase/reason codes, counts,
timestamps, source coverage, and one-way fingerprints. It does not contain a
question, answer, SQL, query literal, row, business value, provider body,
credential, URL, or local path.

## Local runtime API

All endpoints are served only by the local DQL runtime.

| Endpoint | Result |
| --- | --- |
| `GET /api/ask-traces/status` | Store availability and schema state |
| `GET /api/ask-traces?limit=100&cursor=...` | Bounded trace summaries (maximum 100) |
| `GET /api/ask-traces/by-run/:runId` | One detailed trace by Ask run ID |
| `GET /api/ask-traces/:traceId` | One detailed trace by trace ID |
| `GET /api/ask-traces/:traceId/export?profile=strict` | Strict redacted portable bundle |

Stable failures are:

| Code | Meaning |
| --- | --- |
| `TRACE_NOT_FOUND` | No local trace matches the ID |
| `TRACE_DETAIL_EXPIRED` | Detailed evidence expired; a summary may remain |
| `TRACE_STORE_UNAVAILABLE` | Local tracing was not available; Ask remains unaffected |
| `TRACE_SCHEMA_UNSUPPORTED` | The store was created by a newer DQL schema |
| `TRACE_EXPORT_REDACTION_FAILED` | Export cannot pass its redaction/canary check |

The full trace is intentionally absent from ordinary Ask run lists, conversation
threads, and server-sent progress events. Those surfaces receive only a compact
trace reference.

## CLI

The trace inspector opens the local store read-only:

```bash
dql agent trace list --format json
dql agent trace show <trace-id-or-run-id> --format json
dql agent trace export <trace-id-or-run-id> --out ./trace-bundle --profile strict
dql agent trace validate ./trace-bundle
dql agent trace replay ./trace-bundle --mode receipt
dql agent trace compare ./left-bundle ./right-bundle --mode compare
```

`export` requires an empty directory and will not overwrite an earlier bundle.
`replay` validates an already-exported receipt offline; it starts no provider,
tool, warehouse query, or network request. `compare` compares routing stages,
candidate roles/reasons, attempts, trust, and timing rather than prompt or
answer prose.

Use `--profile support --confirm-reviewed-identifiers` only when a reviewer has
approved the identifiers for sharing. Support-only reviewed question prose is
explicit CLI input; DQL does not recover a question from its local trace.

## Portable bundles

An export contains four checksum-bound JSON files:

```text
manifest.json
trace.json
run-receipt.json
redaction-receipt.json
```

`strict` pseudonymizes identifiers. Both profiles run a defensive canary for
secrets, SQL, URLs, and paths. DQL also offers an OpenTelemetry/OpenInference
JSON mapper for a reviewed local artifact; it does not ship a network exporter.

When traces are sent on (to a host's sink, or as OTLP when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set, also on a single-user install), the
question's fingerprint leaves keyed: HMAC-SHA256 under the host's `traceSalt`,
or under a key DQL makes once in `.dql/local/private/trace-salt`. The same
question keys the same way on one install, and the value cannot be checked
against a list of likely questions anywhere else. Fingerprints in the local
trace store are unchanged.

## UI

Open **Open full trace** from an Ask result, or navigate to
`/ask/traces/:runId`. The page hydrates by ID from the local runtime, then shows
a four-part answer incident summary (**What happened**, **Why**, **Impact on
answer**, **How to fix**) followed by a Trace Tree, Agent Graph, and Timeline
over the same selected detail pane. The summary uses only typed cause/coverage/
denial/safe-action evidence and links back to the responsible stage. The graph
uses dashed edges for continuation and Research run links in addition to
physical span-parent edges.
While recording it polls that local detail endpoint; terminal traces do not
poll. The page respects the existing `paper`, `white`, and `obsidian` themes.
