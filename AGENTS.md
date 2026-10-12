# Agent guide — DQL

Guidance for AI agents (and humans) making changes here. Most of DQL is yours to
evolve freely. The one thing to be careful about is the **shared design
contract** below.

## ⚠️ Shared design contract with host applications that embed DQL — do not break

DQL can be embedded inside a host application, which reskins the embedded
surface to its global theme. DQL already conforms to the shared contract — keep
it that way. The host keeps the canonical copy of the token names in its own
design-tokens package.
**Renaming or removing any of the following silently breaks the embed** —
and the host's sync runs a contract check that will **fail its build** if you do:

1. **Theme selector** — `data-theme` on `<html>`, values **`paper` | `white` |
   `obsidian`**. Keep these blocks in `packages/dql-ui/src/styles/tokens.css`.
2. **Token vocabulary** — the shared semantic vars every surface reads:
   `--bg-0..4`, `--bg-canvas`, `--text-primary/secondary/tertiary/muted`,
   `--accent`/`--accent-hover`/`--accent-dim`/`--accent-fg`,
   `--border-subtle/default/strong`. **No app-prefixed colour vars** (no
   `--dql-color-*`). Rename a token → rename it in the host's design tokens too.
3. **Theme persistence key** — `dql-theme` (the `NotebookStore` key). It is read
   on boot and the store listens for a cross-tab `storage` event on it; the host
   writes the key and dispatches that event to drive the embedded theme. Don't
   rename it or remove the `storage` listener.

Host-specific navigation, identity, and managed workflow are not OSS contracts
in this repository. The compatibility surface here is limited to the selector,
token, and storage-key names above; do not infer a hosted layout contract from
historical host branches.

If you must change any of the above, **coordinate with the host application's
maintainers**: update its design tokens and re-run its embed contract check.
Standalone DQL is unaffected by hosts — these are just stability guarantees on
the names embedding hosts depend on.

## General

- Notebook app: `apps/dql-notebook`. Build:
  `pnpm --filter @duckcodeailabs/dql-notebook-app build`.
- See `CONTRIBUTING.md` for setup, tests, and the OSS-readiness checklist.

## Current truth and delivery

- Start with `docs/contribute/current-dql-truth.md`; live repository and registry
  evidence always outranks memory, issues, old worktrees, and roadmap snapshots.
- Follow `docs/contribute/delivery-orchestration.md` for bounded roles, handoffs,
  evidence gates, memory lifecycle, and the OSS/commercial boundary.
- Do not add managed multi-tenancy, SSO/RBAC, centralized audit, managed
  secrets, or hosted approval workflows to close an OSS task.

## DQL 2.0 domain-context implementation

The normative implementation pack is
`docs/specs/dql-2-domain-context/README.md`, with decisions in RFC 0002 and RFC 0003. Git-tracked specs take precedence over chat history, Codex memory, issues,
or ignored planning files. Every implementation change in this program must
name its stable acceptance IDs and follow the workstream dependency/ownership
rules in that pack.

An implementer may report a requirement as `implemented`; only a different
verifier or the integration owner may mark it `verified`. UI verification must
run the built `dql notebook` CLI against the designated fixture—Vite-only proof
does not satisfy acceptance. Do not commit generated evidence, caches, local
connector/runtime state, or Playwright artifacts.
