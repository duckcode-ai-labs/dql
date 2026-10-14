# Getting help with ZLens

Pick whichever channel matches what you need:

| What you need | Where to go |
|---|---|
| **Design questions, broader proposals** | [Open an issue](https://github.com/duckcode-ai-labs/zlens/issues/new/choose) or write an RFC (below). GitHub Discussions are not enabled. |
| **File a reproducible bug** | [Open a bug report](https://github.com/duckcode-ai-labs/zlens/issues/new?template=bug_report.yml) |
| **Request a feature** | [Open a feature request](https://github.com/duckcode-ai-labs/zlens/issues/new?template=feature_request.yml) |
| **Propose a language or schema change** | RFC under [`docs/rfcs/`](docs/rfcs/) — see the [template](docs/rfcs/0000-template.md) |
| **Report a security issue** | Follow [SECURITY.md](SECURITY.md) (do **not** open a public issue) |
| **DataLex-side governance questions** | [duckcode-ai/DataLex](https://github.com/duckcode-ai/DataLex) |

## Triage SLA

We aim to acknowledge new issues within **3 business days** and apply a triage label (`bug`, `enhancement`, `question`, `needs-info`, `wontfix`) within **7 business days**. The schedule below sets expectations — it is not a hard guarantee for a small OSS team.

| Severity | First response | Status update | Resolution target |
|---|---|---|---|
| `severity:critical` (broken release, MCP serves wrong data, certified output corrupt) | <24h | every 48h | within 1 week |
| `severity:high` (regression in compile / runtime / lineage) | <72h | weekly | next minor release |
| `severity:normal` | <7 days | as needed | best-effort |
| `severity:low` / `enhancement` | <14 days | quarterly | community PRs welcome |

## What we'll **not** do here

- Discuss closed-source / commercial product details — that's a separate venue.
- Triage issues filed against archived repos (`duckcode-observability`, `duck-code`) — those are unmaintained.
- Provide tax, legal, financial, or compliance advice based on your data — ZLens is a tool; you own the call.
