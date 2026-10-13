# OSS delivery orchestration

This playbook defines how maintainers, contributors, and coding agents deliver
ZLens OSS changes from request to verified evidence. It is a documentation and
handoff contract, not a new autonomous agent runtime.

Start every task with [Current DQL truth](./current-dql-truth.md). Live
repository state beats memory. The
[DQL 2.0 handoff template](../specs/dql-2-domain-context/agent-handoff-template.md)
adds stable acceptance IDs and workstream ownership when that program is in
scope.

## Operating rules

1. Verify the active checkout, branch, worktrees, remote relation, current
   package version, and relevant implementation before planning.
2. Treat memory, old worktrees, prior browser sessions, issue text, and roadmap
   snapshots as discovery aids, never as current proof.
3. Keep each implementation bounded by owned paths, acceptance criteria,
   prohibited changes, and the OSS boundary.
4. Separate implementation from independent verification. An implementer can
   report `implemented`; only a different verifier or integration owner can
   report `verified`.
5. Match evidence to the surface. Unit tests do not prove browser behavior,
   Vite does not prove the packaged CLI, and a package manifest does not prove
   npm publication.
6. Preserve epistemic state in every handoff: shipped, implemented, verified,
   accepted design, planned, blocked, and unknown are not interchangeable.
7. Do not add hosted/team/commercial behavior to close an OSS task.

## Delivery roles

Roles are bounded responsibilities. One person or task may hold multiple roles
for small changes, except that the implementer cannot independently verify its
own acceptance claim.

### Coordinator

- owns the user goal, OSS boundary, acceptance criteria, dependency order, and
  final status;
- chooses the minimum specialist roles required;
- prevents scope expansion, duplicate edits, and conflicting worktrees;
- resolves discrepancies between code, specifications, and requested behavior;
- does not convert partial evidence into a stronger completion claim.

### Current-state verifier

- begins read-only;
- checks Git/worktree state, current manifests, published release evidence when
  relevant, normative specs, and the actual implementation path;
- identifies stale documentation, old-worktree assumptions, unverified claims,
  and OSS/commercial boundary risks;
- produces a dated baseline the implementer may rely on.

### Bounded implementer

- changes only the assigned files and behavior;
- names applicable acceptance IDs and preserves shared contracts;
- adds or updates focused tests and documentation;
- records exact commands and evidence;
- reports its work as `implemented`, not independently `verified`;
- does not alter release, memory, certification, or commercial boundaries
  unless they are explicitly in scope.

### Verifier/reviewer

- is different from the implementer for a `verified` claim;
- reviews the diff against the task contract and current baseline;
- repeats risk-proportionate checks from a clean state;
- uses the built `zlens notebook` CLI and designated fixture for UI acceptance;
- reports pass, fail, or blocked with exact evidence and remaining risk;
- rejects hidden scope expansion and commercial leakage.

### Release/memory steward

- confirms synchronized package versions, starter ranges, release docs, clean
  build/test/pack evidence, npm visibility, install smoke, Git tag, and
  `main`/`origin/main` relation;
- never infers registry publication from a manifest or release commit;
- classifies durable task knowledge using the memory lifecycle below;
- promotes only independently verified merge/release facts into Active memory;
- archives stale version, worktree, port, process, and superseded plan details.

## Evidence gates

Use only the gates relevant to the change, but do not skip a gate whose claim
depends on it.

| Gate                          | Required evidence                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| G0 — Current state            | Clean/dirty status, active branch, worktree ownership, base/head SHAs, remote divergence, current version, relevant code/doc anchors |
| G1 — Contract                 | Goal, OSS boundary, owned/prohibited paths, acceptance IDs, dependencies, shared contracts, explicit non-goals                       |
| G2 — Focused implementation   | Diff review plus the smallest authoritative unit, type, format, schema, or documentation checks                                      |
| G3 — Integration/runtime      | Cross-package tests and real runtime evidence; built CLI plus designated fixture for UI behavior                                     |
| G4 — Independent verification | A different verifier repeats the acceptance path and records commit, command, fixture, and result                                    |
| G5 — Release                  | Synchronized manifests, clean build/test/pack, registry audit, disposable install smoke, remote commit/tag relation                  |
| G6 — Memory                   | Completion facts classified as Active, Reference, or Archive with source and date                                                    |

Failure at a gate does not erase useful implementation evidence. Report the
strongest supported state and the precise remaining gate.

## Task handoff contract

Every non-trivial handoff must contain:

```text
Goal:
User-visible outcome:
OSS boundary and non-goals:
Current baseline: branch, base SHA, version, source links
Authoritative specs and acceptance IDs:
Owned paths:
Prohibited paths/actions:
Dependencies and assumed verified interfaces:
Required evidence gates and commands:
Fixture/runtime requirements:
Risks, known gaps, and rollback:
Expected completion report:
```

If the handoff cannot name the current base, evidence gate, or boundary, the
current-state verifier must resolve it before implementation begins.

## Completion contract

A completion report must state:

1. outcome and user-visible behavior;
2. exact files and intentional scope;
3. final Git state and commit, if one exists;
4. checks run with pass/fail results;
5. built-runtime or registry evidence when those claims are made;
6. acceptance IDs and their supported status;
7. unresolved gaps, exceptions, or decisions;
8. OSS/commercial boundary verdict;
9. memory lifecycle changes proposed by the steward;
10. whether work is complete, continuing, blocked, or awaiting authorization.

Do not say “done,” “verified,” “released,” or “current” without the matching
gate evidence.

## Memory lifecycle

Delivery memory is advisory and must preserve provenance, scope, date, and
epistemic status.

### Active

Small, current facts that future delivery should apply by default.

Admission requires:

- the fact is grounded in a merged current-main change or a verified published
  release;
- the required independent verification or release evidence exists;
- the fact names its version/commit and scope;
- no newer repository evidence supersedes it.

Examples: current published version after registry/install verification; a
verified shared contract; a merged and independently verified acceptance
behavior.

### Reference

Useful context that must be rechecked before use.

Store here:

- accepted designs and RFC decisions;
- implemented-but-not-independently-verified behavior;
- durable commands, test methods, failure patterns, and review checklists;
- commercial architecture ideas and vendor research clearly labeled as
  non-OSS or time-sensitive.

Reference memory cannot authorize a current product claim or bypass a live
state check.

### Archive

Historical evidence retained only for traceability.

Archive:

- superseded release snapshots and demo pins;
- old branch/worktree SHAs, ports, browser sessions, locks, processes, and
  fixture state;
- rejected or superseded plans;
- static audits after the behavior changed;
- unverified success claims, inaccessible-provider browser attempts, and stale
  vendor capability notes;
- roadmap/checklist snapshots whose named release is no longer current.

### Promotion and demotion

- `Reference -> Active` requires verified merge/release evidence.
- `Active -> Reference` occurs when the fact remains useful but current proof
  has drifted or a verification gate reopens.
- `Active/Reference -> Archive` occurs when a newer release, implementation, or
  decision supersedes it.
- Chat summaries and agent assertions alone never promote memory.
- A task may propose memory changes, but the steward records only evidence the
  repository and verification support.

## OSS boundary gate

Before implementation and review, answer:

1. Does this improve a local, single-user, dbt-first, Git-versioned workflow?
2. Does it keep core accuracy, trust, lineage, and review mechanisms in OSS?
3. Does it avoid managed multi-tenancy, SSO/RBAC, centralized audit, managed
   secrets, hosted approvals, billing, licensing, and administrative control
   planes?
4. Does any shared cloud compatibility change remain a narrow interface
   contract rather than hosted product behavior?

If any answer is unclear, stop at design review. Do not silently implement a
commercial control plane in the OSS repository.
