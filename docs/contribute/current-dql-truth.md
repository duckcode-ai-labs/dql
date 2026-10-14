# Current DQL truth

This document is the canonical starting point for planning changes in the DQL
OSS repository. It separates verified current facts from accepted design,
implemented-but-unverified work, and future scope.

It is a snapshot, not a substitute for checking the live repository. Before
using any version, commit, package, test result, or acceptance status below,
re-run the checks in [Refresh this snapshot](#refresh-this-snapshot). Live
repository and registry evidence always outranks this document, chat history,
agent memory, issues, old worktrees, and ignored planning files.

## Verified snapshot

Last checked: **2026-10-11** (repository rows from `main` at `9b1bdd53`; npm
and tag rows from the 2026-10-11 readiness review, not re-queried since)

| Fact                | Verified state                                                                                          | Evidence                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Primary branch      | `main` was at `9b1bdd53` when this snapshot was refreshed | `git rev-parse main origin/main`; `git rev-list --left-right --count main...origin/main` |
| Release target      | The release manifests and the starter CLI range read `0.1.0` (first release under the `@zlens/*` names); `apps/desktop` and `apps/dql-notebook` are private and not part of the release set | Release manifest audit; starter template manifest; `scripts/release-packages.mjs --dry-run --tag <tag> --expected-version <version>` |
| npm publication     | Versions `1.13.5` through `1.17.2` of the old `@duckcodeailabs/*` packages were published by hand, not by the release workflow. `0.1.0` is the version in the manifests; check the registry before calling it published | `npm view @zlens/cli dist-tags versions`; `npm view @duckcodeailabs/dql-cli dist-tags versions`; readiness review 2026-10-11 |
| Published CLI       | Not re-queried in this refresh. After any publish, run the exact-version clean local and global install smoke | `npm view @zlens/cli dist-tags`; `scripts/smoke-cli-install.mjs` |
| Release tag         | Newest git tag is `v1.14.3-rc.1`; no tag exists for later versions. The release workflow did not publish them | `git tag --sort=-creatordate` |

The missing `v1.11.3` through `v1.11.10` and `v1.12.4` through `v1.12.9` tags
are release-history debt. They do not invalidate the verified npm publication,
and they must not be created or rewritten without explicit maintainer
authorization.

## Shipped OSS facts

DQL OSS currently is:

- a local-first, single-user, dbt-first analytics-as-code workspace;
- Git-versioned through DQL source files for blocks, notebooks, Apps, domains,
  skills, contracts, tests, related project metadata, and governed Hint Graph
  traces/hints/evaluations/reviews; rebuildable SQLite indexes remain local;
- grounded in dbt artifacts and semantic metadata as the physical and semantic
  source of truth, with DQL adding a sparse governed answer layer;
- distributed as synchronized npm packages, including the CLI and
  `create-dql-app`;
- runnable locally with DuckDB/file data, Snowflake, Databricks SQL, and the
  documented semantic adapters, subject to connector-specific setup;
- explicit about local trust states: generated or exploratory work is
  review-required and cannot become certified merely because it executed.

The shipped governed-answer path is plan-first. After meaning is resolved, the
route order is:

1. a completely compatible certified block;
2. one compatible semantic adapter;
3. governed relational composition;
4. bounded, review-required exploration;
5. identifier-bound clarification or refusal.

Ask AI, Notebook AI, and Block AI use the durable run/artifact contracts in the
repository. Block AI generation remains ownerless, transient, and
review-required; only the explicit **Add to Block Studio** action writes a
draft. Ask is different: a review-required (Tier-2) Ask answer — UI, `zlens
agent ask`, MCP `answer_question` — leaves a de-duplicated draft under
`_drafts/` (`run.reviewDraft`), while its executed artifact stays transient.
Saving never certifies; only an explicit Certify action does, and it writes a
certification receipt into the companion YAML. Local agent memory is advisory. Certified assets, semantic/dbt facts,
policies, runtime evidence, and current Git state outrank memory.

App AI uses a separate stateful App orchestration loop over the same provider,
immutable snapshot, meaning, execution, repair, trust, and evidence
foundations. Manual and AI authoring share one paginated source catalog,
canonical source-to-tile composition, local preview/filter path, and Project
publication gate. Draft and review blocks remain discoverable and usable only
in local review-required Apps until they are explicitly certified, replaced,
or removed.

The OSS shared-design compatibility surface is limited to the documented
`data-theme` values, semantic color-token vocabulary, and `dql-theme`
storage-listener contract. Managed cloud embedding, navigation, identity, and
team workflow are not OSS implementation claims.

## Accepted design and implementation evidence

The normative DQL 2.0 domain-context pack is
[`docs/specs/dql-2-domain-context/`](../specs/dql-2-domain-context/README.md).
Its RFCs and specifications are accepted design. Its acceptance matrix records
implementation evidence, not automatic independent verification.

The requirement counts below were not independently re-audited by this
release-preparation change. Consult the acceptance matrix for requirement-level
status; this release candidate remains implementer-evidenced, not independently
verified.

At the prior acceptance-matrix snapshot:

- 87 acceptance requirements are `implemented`;
- 27 remain `specified`;
- 0 are `verified`;
- `E2E-015` remains `specified`;
- `PERF-001` remains an open release/performance gate.

Use the exact vocabulary:

- **shipped** — present on current `main` and, for release claims, present in
  the published package;
- **implemented** — code and implementer evidence exist;
- **verified** — a different verifier or integration owner completed the
  required independent evidence;
- **accepted design** — normative direction, not proof that behavior ships;
- **planned** — no current implementation claim.

DQL 2.0 must not be described as fully verified or generally available while
the tracked independent browser, enterprise-fixture, and performance gates
remain open.

## Strict OSS boundary

DQL OSS remains local-first, single-user, dbt-first, and Git-versioned. Local
certification, personas, policies, memory, and review flows are development and
governance tools inside one user-controlled project; they are not hosted
enterprise enforcement.

The following are future commercial scope and must not be added to this
repository as incidental OSS enhancement work:

- managed multi-tenancy or a hosted notebook service;
- SSO, OIDC, SCIM, organization RBAC, or permissions-aware team retrieval;
- centralized or organization-wide audit services;
- managed secret storage or hosted credential custody;
- managed approval workflows, policy distribution, or cross-repository
  federation;
- commercial billing, licensing, fleet management, or administrative control
  planes.

OSS may define portable interfaces and local evidence that a future commercial
product consumes. It must not weaken local correctness or withhold core
accuracy, trust, lineage, and review mechanisms to manufacture a commercial
dependency.

## Sources and precedence

For current-state decisions, use this order:

1. current checked-out code, manifests, Git relation, tests, and built runtime;
2. current npm registry evidence for publication claims;
3. Git-tracked normative specifications and acceptance evidence;
4. current contributor, architecture, and reference documentation;
5. issues, agent memory, historical reports, old release notes, and worktree
   observations as advisory context only.

`ROADMAP.md`, `CHANGELOG.md`, and `docs/oss-readiness-checklist.md` contain
release-candidate and historical release evidence. They do not establish npm
publication: live registry audit, install smoke, and the pushed release tag
remain authoritative.

## Refresh this snapshot

The current-state verifier performs at least:

```bash
git status --short --branch
git worktree list --porcelain
git fetch origin
git rev-parse main origin/main
git rev-list --left-right --count main...origin/main
git log -1 --oneline --decorate main
```

For a release claim, also:

1. compare every package in `scripts/release-packages.mjs` with its manifest;
2. query `version` and `dist-tags.latest` from npm for all release packages;
3. run `scripts/smoke-cli-install.mjs` against the claimed CLI version;
4. inspect the remote release tag and record any tag/package mismatch;
5. update this document in the same reviewed change that establishes a new
   verified release baseline.

For product behavior, inspect the implementation path and run the proportionate
package, integration, or built-CLI browser gates. Do not advance an acceptance
requirement from `implemented` to `verified` using the implementer's own
evidence.
