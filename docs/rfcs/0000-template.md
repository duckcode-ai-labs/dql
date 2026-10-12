# RFC 0000: <title>

| Field | Value |
|---|---|
| **Author(s)** | <@github-handle> |
| **Status** | Draft / In review / Accepted / Implemented / Rejected / Superseded |
| **Created** | YYYY-MM-DD |
| **Targets** | DQL `<version range>` |
| **Discussion** | <link to GitHub Discussion thread> |
| **Implementation** | <link to PR(s)> |
| **Supersedes** | RFC NNNN (if any) |

## Summary

One paragraph. What is being proposed?

## Motivation

What problem does this solve? Who feels the pain? Why now? Cite real
examples — issues, support threads, customer conversations, prior incidents.

## Detailed design

The technical proposal. Explicit enough that a competent engineer outside the
core team could implement it from this document. Include:

- Grammar / lexer / parser / AST changes (for language proposals)
- Manifest schema changes (and the corresponding `manifest-spec` PR if any)
- MCP tool surface changes (input zod, output shape)
- Examples of `.dql` source before-and-after
- Edge cases the design must handle
- How the proposal interacts with: dbt manifest interop, certification,
  semantic provider chain, lineage emitter, governance gates

## Backward compatibility

What breaks for existing `.dql` projects? What's the deprecation path? What
window of two consecutive DQL majors will support both old and new behavior?

If the change touches `manifest-spec`, link the corresponding spec RFC and
state the spec version this lands in.

## Alternatives considered

What other approaches were evaluated and why were they rejected? Be honest
about tradeoffs.

## Unresolved questions

What is still open? What input from the community would change the design?

## Adoption signal

How will we know this RFC was a good call after it ships? Concrete metrics:
new issues filed, error rate, npm install count of an extension, MCP call
counts in real projects, etc.

---

## Process

1. Copy this template to `docs/rfcs/<NNNN>-<short-slug>.md` and PR it as
   **status: Draft**. The PR is for the doc only — implementation follows
   in a separate PR.
2. Open a [GitHub Discussion](https://github.com/duckcode-ai-labs/dql/discussions/categories/rfcs)
   for community input. Link it in the table at the top.
3. Discussion stays open ≥ 14 days for non-trivial proposals.
4. Maintainers move status to **Accepted** or **Rejected** with a brief
   rationale comment in the PR.
5. Once accepted, implementation PRs reference the RFC number.
