# RFC 0010: Host hooks — who is asking, what they may see, and where state lives

| Field | Value |
|---|---|
| **Author(s)** | @KKranthi6881 (with Claude) |
| **Status** | Draft |
| **Created** | 2026-09-25 |
| **Targets** | DQL 1.18 → 1.20 (in slices) |
| **Discussion** | — |
| **Implementation** | — |
| **Supersedes** | — |

## Summary

`startLocalServer` gains one optional object, `hostHooks`. A program that
embeds DQL can use it to tell DQL:

- who is making each request;
- whether that person may do what they asked;
- which rows their queries may return;
- whose warehouse credentials to use;
- which model to call;
- where runs, memory, traces and audit events are kept;
- how tool calls are checked.

Each hook is bound once per request through `AsyncLocalStorage`, so none of
the more than 250 routes has to pass anything new along. With no hooks,
`dql notebook` behaves exactly as it does today: one local owner, one
connection, SQLite state in the project folder.

This RFC defines the interfaces and their local defaults. It does not add
sign-in, roles, multi-tenancy, central audit or managed secrets to the open
source. Those belong to whoever supplies the hooks.

## Motivation

DQL is a strong governed engine for one person on one machine. Teams run it
on a shared server, and commercial hosts run it inside a customer's cloud
account. Both need the same engine to answer as the person asking. Today it
can't, because the single-user assumption is spread through the code:

| Assumption | Where |
|---|---|
| One shared bearer token; no idea who is asking | `local-runtime.ts` request handler (`DQL_SERVER_TOKEN` check) |
| Actors taken from the request body (`reviewer`, `author`, `owner`) or from `git config` | `metadata/identity.ts` `resolveLocalOwner`; certify, review and owner routes |
| One active persona per process, which any caller can switch | `dql-project/src/persona.ts` `defaultPersonaRegistry`; `POST /api/persona` |
| Row rules only for blocks marked `@rls`; many query sites call `executeQuery` directly, and AI-written SQL is never narrowed | `dql-compiler` `applyRLSDecorators`; direct `executor.executeQuery` calls |
| One connection per process, with credentials from project config | `startLocalServer` `let connection`; `connection-pool.ts` |
| A closed list of model providers; the "values only to a local model" rule is hard-coded to Ollama on loopback | `providers/types.ts`; `selectAssistProvider`; story and canvas draft routes |
| Runs, threads, memory and traces created with `new` against SQLite files, with no person recorded | `SqliteAgentRunStore`, `MemoryStore`, `ConversationStore`, `AskTraceSqliteStoreV1` |
| Tool calls (MCP and native) with no single place to check them | `dql-mcp` `mcpToolHandlers`; `llm/tools.ts` `buildAgentTools` |

The fix is the same for all of them. Give each assumption one named seam with
a local default, then let a host replace the default.

## Detailed design

### The request context

```ts
export interface DqlPrincipal {
  /** Stable id; for the local default, the resolved local owner. */
  id: string;
  kind: 'person' | 'service';
  displayName?: string;
  email?: string;
  groups?: string[];
  /** Values row rules can read, e.g. region, cost_center. */
  attributes?: Record<string, string | number | boolean | string[]>;
  /** 'local' when DQL resolved it itself; 'host' when a hook supplied it. */
  source: 'local' | 'host';
}

export interface DqlRequestContext {
  principal: DqlPrincipal;
  requestId: string;
}
```

The request handler resolves the principal before dispatching a route. It
then runs the route inside `requestContext.run(ctx, …)`, using the same
`AsyncLocalStorage` pattern already used for provider evidence and Ask
traces.

Code reads the principal with `currentPrincipal()`. Background work (agent
runs, schedules) captures the context when it starts and restores it for
every step.

### The hooks

```ts
export interface DqlHostHooks {
  /** Who is asking. null → 401. Replaces the shared-token check when present. */
  resolvePrincipal?(req: IncomingMessage): Promise<DqlPrincipal | null>;

  /** Certify with every enterprise gate required; with a host, the host decides, not the request. */
  enterpriseCertification?: boolean;

  /** May this principal do this? Called at route dispatch and before tool calls. */
  authorize?(principal: DqlPrincipal, action: DqlAction, resource: DqlResource): Promise<DqlDecision>;

  /** Narrow a query to what the principal may see. Called for every query. */
  rowPolicy?(query: DqlQueryContext): Promise<{ sql: string; params: unknown[] } | DqlRefusal>;

  /** Credentials for a connection, as this principal. */
  credentials?(input: { principal: DqlPrincipal; connection: string; driver: string }): Promise<DqlConnectionSecret | DqlRefusal>;

  /** A model provider for a task; undefined → DQL's own choice. */
  modelProvider?(input: { route: DqlModelRoute; principal: DqlPrincipal }): AgentProvider | undefined;

  /** Whether result values may reach this provider (the privacy boundary). */
  isInBoundary?(provider: DqlProviderDescriptor): boolean;

  /** Where state lives. Each store has a local SQLite/file default. */
  stores?: {
    runs?: AgentRunStore;
    memory?: MemoryStoreFactory;
    conversations?: ConversationStoreFactory;
    traces?: TraceSink;
    audit?: AuditSink;
  };

  /** Wraps every tool call, MCP and native: check, log, or refuse. */
  tools?: ToolGateway;

  schedules?: ScheduleTrigger;
  delivery?: DeliverySink;
  signing?: SigningKeyProvider;
  git?: GitHost;
}
```

`LocalServerOptions` gains `hostHooks?: DqlHostHooks`. The CLI package adds
an `exports` entry for `startLocalServer` and the hook types, so an embedding
program imports a supported API rather than a file path.

### Local defaults (no hooks)

| Hook | Default |
|---|---|
| `resolvePrincipal` | The local owner from `resolveLocalOwner`. The shared-token check keeps working for non-loopback binds |
| `authorize` | Today's persona and App-policy checks, unchanged |
| `rowPolicy` | Today's `@rls` lowering for blocks. Every other query passes through unchanged |
| `credentials` | Project config plus the local credential vault (`.dql/local/private`) |
| `modelProvider` | Today's provider selection |
| `isInBoundary` | Ollama on a loopback URL (today's rule) |
| `stores.*` | Today's SQLite files. `traces` also writes OTLP when the standard `OTEL_EXPORTER_OTLP_ENDPOINT` is set |
| `tools` | Pass-through |
| `schedules`, `delivery`, `signing`, `git` | Today's in-process cron, notifiers, local signing key and `gh` |

### Rules every hook follows

1. **Fail closed:**
   - a hook that throws is treated as a refusal;
   - `resolvePrincipal` returning null gives a 401;
   - a `DqlRefusal` from `rowPolicy` or `credentials` is shown to the person, never retried with broader rights.
2. **Never fall back to a service credential.** If `credentials` refuses (for example, the person's warehouse token has expired), the answer is "reconnect", not a quiet retry as the service account.
3. **With a host, the request body no longer names actors.** Reviews, correction authors and the default owner of new content are stamped from the host's principal, and request fields such as `reviewer` and `author` are ignored. A content `owner` the author types (for example a team) stays content metadata; only its default comes from the person. The rule set a certification uses (`enterprise`) comes from the host, not the request. With no hooks, today's behaviour is kept exactly: the local owner, and names from the body. Recording who certified what is part of the audit sink (HH-6).
4. **One query path.** Every warehouse query goes through `ExecutionService.execute` or `executePreparedAgenticSqlBoundary`, including AI-written SQL. That path calls `rowPolicy` exactly once. A test enumerates direct `executeQuery` call sites and fails when a new one appears outside the allowlist.
5. **Caches are keyed by access.** The Dataset result cache already includes the persona policy fingerprint. It adds the principal's policy fingerprint, the hash of what `rowPolicy` returned, and the credential id.
6. **Records carry the person.** Runs, threads, memory items and trace spans record `principal.id`. With no hooks this is the local owner, so existing SQLite files gain a column with a default.

### Action vocabulary (for `authorize`)

`project.read`, `project.write`, `connection.manage`, `settings.manage`,
`dataset.author`, `dataset.certify`, `hint.review`, `app.view`,
`app.author`, `app.publish`, `ask`, `research`, `query.run` (SQL the
person writes), `export`, `schedule.manage`, `git.review`, `tool.<name>`.

Each request maps to one action and one resource (`project`, `app`,
`app-build`, `hint`, `connection`, each with an id where the path names
one) through `routeAction(method, path)` in `apps/cli/src/host/route-actions.ts`.
Specific rules come first. Anything else is `project.read` for GET and
`project.write` otherwise, so a new route is never more open than the
project itself.

### Privacy boundary

The OSS rule stays: result values reach a model only when the model runs on
this machine. `isInBoundary` generalises the check, which today is
hard-coded to Ollama on loopback, so a host can declare its own boundary.
The commercial host's wording, approved on 2026-09-25, is:

> Result values reach a model only when the model runs in the customer's own
> cloud account, in a region their admin approved, with data retention off —
> or on the person's own machine.

`resolveProviderResultRowEgressPolicy` consults `isInBoundary`. Ask still
sends zero result rows by default, whatever the boundary.

### Slices

Each slice ships on its own, with tests, and keeps the no-hooks behaviour
identical.

| Slice | Contents | Check |
|---|---|---|
| HH-1 | Request context, `resolvePrincipal`, `currentPrincipal()`; actors stamped from the principal; certification mode from the host; `startLocalServer` exported as `@duckcodeailabs/dql-cli/host` | A test server with a fake `resolvePrincipal` refuses unplaced requests (401, health open), answers overlapping requests as their own people, and records the principal as correction author and hint reviewer despite other names in the body; with no hooks, `/api/identity` and body-supplied names are unchanged |
| HH-2 | `authorize` at route dispatch; the persona registry reads the request context | Two concurrent requests with different principals see different App access; switching the persona in one request does not affect the other |
| HH-3 | One query path plus `rowPolicy`; cache keys by access | Call-site allowlist test; two principals, same question, different rows, from both a certified Dataset and AI-written SQL; a `rowPolicy` refusal stops the query |
| HH-4 | `credentials` and a connector factory registry (the documented plugin seam) | Pool keyed by credential id; a refusal gives "reconnect", never a service-account retry |
| HH-5 | `modelProvider`, `isInBoundary`; Bedrock and Vertex providers (OSS features in their own right) | Values egress follows `isInBoundary`; a Bedrock provider passes the provider contract tests |
| HH-6 | Store interfaces and injection (runs, memory, conversations, traces, audit); OTLP trace export | Stores swapped for in-memory fakes in tests; a principal id on every record |
| HH-7 | `tools` gateway around MCP and native tool calls; MCP HTTP transport with a host authenticator | A gateway that refuses `tool.run_sql` blocks it in both paths |
| HH-8 | `schedules`, `delivery`, `signing`, `git` | A schedule runs as its owner's principal; a delivery sink receives the digest |

## Progress

All slices below are on `claude/oss-security-fixes`, implemented 2026-09-25 and awaiting independent verification. Items marked **needs a live check** were built from the vendors' public documentation and tested on recorded replies, not against the live service.

### HH-1 — who is asking
`apps/cli/src/host/`. With `resolvePrincipal`, every API request except health runs as the person the host names. Unplaced requests get 401. Reviews, correction authors and the default owner of new content come from the person, never the request body. The certification rule set comes from the host. `@duckcodeailabs/dql-cli/host` exports the supported API. Tests: `host-hooks.test.ts`.

### HH-2 — what each person may do
- **Permission checks:** every placed request maps to an action and resource (`route-actions.ts`) and goes to `authorize`. A refusal answers 403 `PERMISSION_DENIED` with the action.
- **View as:** personas are kept per person (`PersonaRegistry.useSlots`).
- **People without a persona:** App policies check their own groups, never the owner default. Row rules read their attributes as `{user.<name>}`.
- **Caches:** cache and proof keys include the person, only when a host is present.

Tests: `route-actions.test.ts`, `host-hooks.test.ts`, `governance-runtime.test.ts`, dql-project `persona.test.ts`.

### HH-2 — read-only page links
`viewer-links.ts`.
- **What the link is:** on a network-shared server without a host, the Share menu's network link carries a signed viewer token for one App. It lasts 14 days, and changing the server token ends every link.
- **What it can do:** view, run and export that App's pages, and nothing else. It sees the App as the owner publishes it.
- **Apps it can't open:** Apps with per-member row rules cannot be shared by link. This is checked both when the link is made and on every request.
- **What the viewer sees:** the UI shows only that App's reader.

Checked in the built CLI. Tests: `viewer-links.test.ts`, notebook `server-auth.test.ts`.

### HH-3 — one query path
`row-policy.ts`.
- **Single entry point:** with `rowPolicy`, the server wraps its one executor. Every statement passes the policy once first: executor calls, connectors, streams, and DuckDB read scopes.
- **What the policy is told:** the person, SQL, values, tables (parser-based), connection and purpose. Schema reads are tagged `metadata`.
- **Refusals:** a refusal answers `ROW_POLICY_REFUSED` and runs nothing.
- **Guard test:** a source scan fails if server code creates another executor or connector.

Checked on real DuckDB: an admin, a CA user and a US user get all rows, CA only and US only; a user with no region is refused.

### HH-4 — the person's own warehouse sign-in
`credentials` in `withHostQueryHooks`.
- **Order:** before any statement, the host lays the person's settings (token, user, role or target) over the connection. The row policy then sees the final connection.
- **Pooling:** connections are pooled by their full settings.
- **Refusals:** a refusal answers `CREDENTIALS_REQUIRED` ("reconnect"), and there is never a service-credential retry.

Checked on real DuckDB with per-person warehouses. Not built: a connector registry, and idle eviction of per-person connections.

### HH-5 — Claude on Bedrock and Vertex, and the privacy boundary (**needs a live check**)
`packages/dql-agent/src/providers/claude-cloud.ts`, with no cloud SDKs.
- **Bedrock:** InvokeModel with the `bedrock-2023-05-31` body, signed with AWS SigV4. The signing matches AWS's published "get-vanilla" test vector. Credentials come from the environment, the ECS/EKS container endpoint, or the host. Answers come back whole.
- **Vertex:** `rawPredict` and `streamRawPredict` with the `vertex-2023-10-16` body and a Google token from the environment, the metadata server, or the host.
- **Server hooks:** `modelProvider` is consulted first in provider selection. `isInBoundary` decides whether result values may reach a model, replacing the Ollama-on-loopback rule; an error means no.
- **Guardrails:** `guardrail: { id, version }` applies an Amazon Bedrock Guardrail to every call (signed request headers).

Not built: choosing Bedrock or Vertex in the Settings page. Tests: `claude-cloud.test.ts`, `host-hooks.test.ts`.

### HH-6 — audit, traces and stores
`observability.ts`.
- **Audit:** `audit` receives one event per request that changed something or was refused (who, action, resource, status, outcome). It also receives one per finished answer: trust label, SQL fingerprints and sources, with no question, SQL or values.
- **Traces:** each finished Ask trace, as the strict redacted bundle, goes to `traces` and/or as OTLP/JSON to `OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT` (**needs a live check** with a collector). Export never slows or fails an answer.
- **Stores:** `stores.runs|memory|conversations` replace the project's SQLite files.

Not built: a person column on stored runs, threads and memory, and a hint-store factory. Tests: `observability.test.ts`.

### HH-7 — one place every tool runs
`packages/dql-agent/src/agentic/tool-gate.ts`.
- **What passes the gate:** every tool an agent runs in the server, with the person asking. That covers the providers' native loops, the agent loops including `finish_answer`, and the CLI chat runners.
- **What the host can do:** check, log, reshape or refuse (throw) each call.
- **Guard test:** a source scan fails if a tool runs outside the gate.

Not built: an MCP HTTP transport with a host authenticator. Tests: `tool-gate.test.ts`, `host-hooks.test.ts`.

### HH-8 — schedules, delivery, signing and git
- **Schedules:** `POST /api/apps/:app/schedules/:schedule/run` (action `schedule.manage`) lets an outside scheduler run one App schedule as its owner. The page runs through the reader's full-page run route under a pass (`schedule-runs.ts`). The pass is random, accepted only from this machine and only for that App's page runs, lasts two minutes, and is revoked when the run ends. Permission checks and row policy therefore apply as the owner.
- **Delivery:** `delivery` replaces DQL's email, Slack and webhook senders for digests and alerts.
- **Signing:** `signing` is a key service (for example a KMS or HSM Ed25519 key) that signs exported snapshots without handing out the private key. Exports record `signedBy`, and the existing verifier accepts them.
- **Git:** commits are authored as the signed-in person when they have an email. `git.openPullRequest` replaces the GitHub CLI for review requests.

Not built: moving the `dql notebook` block scheduler onto this route. Tests: `delivery-signing-git.test.ts`, `route-actions.test.ts`.

### Fixes from the first host's review
- **Certifying is a certification:** `/api/block-studio/certifications` (the route the UI uses), `/api/blocks/save-from-cell` (which certifies what it saves) and `approve-semantic` now map to `dataset.certify`; they had fallen through to `dataset.author`, so a person allowed only to author could certify. Creating a Dataset from a table and saving a cell apply the host's enterprise gates.
- **Chart questions respect the privacy boundary:** asking about an App chart sends its displayed rows to a model only when `isInBoundary` (or, without a host, a model on this machine) allows it; otherwise the answer is the deterministic summary, written without a model.
- **Who and for whom:** a certification request records the signed-in person, not a name in the body; Apps published or created with a host are owned by the signed-in person; the new `audience` hook decides whether answers are written for a stakeholder or an analyst (the body's `audience` is ignored); Research requested through Ask needs the `research` action.
- **Conversations belong to a person:** with a host, threads record their owner and each person lists, searches, opens and continues only their own; someone else's thread answers 404. The local notebook is unchanged.

Tests: `route-actions.test.ts`, `privacy-boundary.test.ts`, `per-person.test.ts`.

### HH-9 — the host around DQL's own screens
A host serves every role with DQL's app. It does not rebuild Ask, Apps or notebooks; it adds to them.
- **`ui(principal)`** returns what the host adds for this person: `signOutUrl`, an `environment` label, `links` (placed in the account `menu` or the side `nav`), and `answerActions` (buttons on an answer that needs review, such as "Ask an analyst to check this"). Only same-origin paths are kept, at most 12 links and 4 actions.
- **`GET /api/host/ui`** answers `{ host: false }` without a host. With one, it answers the person, those additions and `capabilities`, which say whether each action is allowed (Ask, authoring, certifying, publishing, git review, settings and others). The same `authorize` hook still guards every route, so `capabilities` only decides what the app shows.
- **In the app:**
  - Navigation hides screens the person may not use.
  - The header shows the person, the environment and sign-out.
  - A host `nav` link opens the host's page inside DQL's main area, with `embed=1` added so the page leaves out its own frame.
  - An answer that needs review offers the host's answer actions, which POST `{ runId, question, trustState }` to the host's path.
- **Sign-in:** a host's 401 may carry `X-DQL-Sign-In: <same-origin path>`. The app then goes there once, with `returnTo` set to the current page, instead of asking for an access link.
- **Readers read:** without `app.author`, the App library hides Build new App, Edit and Delete, and the App opens without the View/Edit switch, personas or the local handoff.
- **No first-run review:** the host sets up the project, so `/api/onboarding/launch` never opens the installer's setup review for the people it signs in (`hostManaged: true`).

Without a host nothing changes. Tests: `per-person.test.ts` (route), `host-ui.test.tsx` (app).

### HH-10 — answers belong to who asked, and the host can follow them
- **Ownership:** with a host, every run records the signed-in person as `ownerId`. Someone else's run reads as not found wherever DQL reads runs (the run routes, traces, repair, follow-ups, Research), and the run list and count are that person's own. Runs from before the host have no owner and are hidden from host people. The SQLite store filters by owner in SQL.
- **`GET /api/host/answers/:runId`** gives the host one of the caller's own answers as it may keep it: question, status, trust, the SQL and where it came from, its fingerprint, the tables it read, the trace id and the object the person had open. Never the written answer, rows or result values (`answerFactsFromRun`).
- **`answerStatus(principal, runIds)`** tells the app where the host's review of each answer stands (`requested`, `in_progress`, `checked`, `certified`, `declined`, with a label, detail and a same-origin page). `POST /api/host/answer-status` asks only about the caller's own runs. The answer shows the status in place of the host's answer actions, with Open for the page.
- **Rail links** may carry a `badge` count and one of DQL's icons (`inbox`, `requests`, `review`, `work`, `health`, `admin`, `people`, `git`, `link`).
- **Which answers get an action:** each answer action says where it applies with `on`: `review` (an AI answer no certified source backs; the default) and/or `unanswered` (DQL could not answer). Both Ask views (the Ask screen and the side panel) show them.
- **"This looks wrong" on trusted answers:** `on` also takes `answered` (a completed certified or governed answer); those actions show as a quiet link. A host's answer facts carry `sqlSha256` and `sources`, computed exactly as the answer's audit event does, so a host can find others who got the same answer.
- **Authoring stays with authors:** without `app.author` an answer has no Add to app; without `dataset.author`, no Save as block.
- **Counts stay current:** the app reloads the host's links when a same-origin host page inside it posts `{ type: 'dql-host:changed' }`, when the tab regains focus, and once a minute.

Tests: `per-person.test.ts`, `answer-facts.test.ts`, `host-ui.test.tsx`.

### HH-11 — a host's grant opens one App
A host may add `appGrants` to the principal it resolves: App id → `read` (open it) or `execute` (also run its tiles). `assertAppAccess` honours a grant before the App's own policies, so a person the host gave one App (for example after an approved access request) can use it without joining its groups. Only host principals carry grants; absent, the App's policies decide alone, as before.

Tests: `governance-runtime.test.ts`, `host-hooks.test.ts`.

### HH-12 — a refusal can say where to go
`authorize` may return `next: { label, href }` with a refusal. DQL passes it on in the 403 body only when `href` is a same-origin path (`/…`, not `//…`); the App reader shows the reason with that link, opened as a host page inside DQL, instead of "Dashboard could not be loaded". Without `next`, a refusal reads as before.

Tests: `host-hooks.test.ts`, `app-workspace-loader.test.ts`.

### Schema refresh for hosts
`startProjectRuntime` returns `syncSchema()`: it refreshes DQL's schema snapshot (table and column names, no values) through the runtime's own connection, so a DuckDB file is never opened twice. A host that applies column policies in `rowPolicy` uses it to know every protected table's columns. No project files change.

### Host follow-ups (Enterprise's first full build)
- **Background requests:** the app marks any API request made more than 30 seconds after the person last touched the page `x-dql-background: 1` (polls, refreshes, recovery loops), so a host's idle sign-out isn't kept alive by an unattended tab.
- **App page links:** `/?app=<id>&page=<id>` opens that App page (the App's home page without `page`); the parameters are removed once read. App schedule deliveries carry `appPage { appId, pageId, title, href }` with that same-origin link, so a host can send a link-only message that opens the page.
- **Model usage:** with an audit sink, every model call's provider, model, operation and token counts (including a streamed Claude reply's) is a `model_usage` audit event for the person whose request made it — never prompt or reply text. `setProviderUsageListener` in `@duckcodeailabs/dql-agent` is the underlying listener.
- **The Apps list follows `app.view`:** with a host that authorizes, `GET /api/apps` lists only the Apps the person may open.
- **Reading a published page is `read`:** an App's `read` policy (the scaffolded `viewer` role) runs a published page's tiles; ad-hoc SQL, investigations and notebooks still need `execute`.
- **`dql app check <id> [--format json]`:** each tile's source and whether it passes the checks publication runs (a certified block, an approved semantic result with its preflight receipt, a matching Dataset binding, preflighted filters), with what would stop it publishing; exits 1 when not ready.

Tests: `server-auth.test.ts`, `ask-trace-navigation.test.ts`, `app-page-run.test.ts`, `usage-ledger.test.ts`, `observability.test.ts`, `host-hooks.test.ts`, `app.test.ts`.

### HH-13 — which certified sources a person may use
`sourceAccess(principal, sources)` gets App Datasets (`app:block:…`, `app:semantic:…`), certified blocks (their `app:block:` id when the block has a file) and metrics (`metric:<name>`), and returns the ids the person may use; an error allows none. Ask builds its vocabulary only from the admitted ones, before anything reaches the model (the cached view is keyed by the person's access), and an App page refuses just the tiles on a refused Dataset ("You don't have access to the Dataset …"), which also covers `/api/app-datasets/run` and field values. Tables themselves stay governed by row rules and warehouse permissions: a restricted Dataset is not a restricted table.

### HH-14 — figures of an answer that needs review
`answerFigures(principal)` returns `show` or `withhold_review`. For a person it withholds from, an Ask answer that needs review is stored and sent without any value: its answer text, result rows, step summaries, events, evaluations and receipts are left out, and the run keeps its trust, SQL, sources, tables and each result's column names and row count (`figuresWithheld: true`). Nothing that could quote a figure streams to that person while the run is going (answer deltas and progress wording). Certified and governed answers are unchanged; the host's answer actions (ask an analyst, make it certified) stay on the answer. An error withholds.

### Answers, links and connections for hosts
- **An answer's values for its owner:** `GET /api/host/answers/:runId?values=1` adds the answer's written text and first table (at most 500 rows) to its facts — only for the answer's owner, and nothing when HH-14 withheld its figures. Without `values=1`, facts carry no value, as before.
- **A link to one answer:** `/ask?run=<runId>` opens the conversation the answer was given in (`GET /api/agent-runs/:id/thread`, only for someone who may see it); otherwise plain Ask.
- **Metadata through the runtime's own connection:** `startProjectRuntime` also returns `metadataQuery(sql)` — one read-only statement (SELECT, WITH, SHOW, DESCRIBE) as metadata, e.g. a host reading warehouse tags without opening a second connection.
- **Idle connectors close:** the connection pool disconnects network connectors unused for 30 minutes and keeps at most 64 (least recently used first), since per-person sign-in makes one per person per token; local embedded databases are never evicted.
- **Governed answers are headed "Governed answer"**, not "AI-generated answer".
- **Run evidence belongs to who ran it:** the page and chart runs DQL keeps for snapshots, story drafts, chart questions and App Autopilot are found only by the person and App persona who ran them (`activePersonaPolicyFingerprint`); a run id alone reads as not current.

### One process, several servers
Each request carries its own server's hooks in its request context, so a host that runs Production and pull request previews in one process never has one server's git, delivery, model, tool-gate or usage hooks replaced by another's; the process-wide values are only a fallback for work outside a request. A runtime's `close()` also ends open event streams (a browser tab with DQL open used to hold it forever), a host's own model id (`bedrock`, `vertex`) no longer fails the local provider settings, and `dql app ls` / `GET /api/apps` (without a host) name App files that don't load and why.

Tests: `host-hooks.test.ts`, `host-scope.test.ts`, `scoped-hooks.test.ts`, `notebook.test.ts`, `provider-settings.test.ts`, `app.test.ts`.

### Entry point
`@duckcodeailabs/dql-cli/host` also exports `startProjectRuntime`: the full server with its UI for one project, as `dql notebook` runs it, taking `hostHooks`, `allowedOrigins` and a host-managed `connection`. The first host (DQL Enterprise) starts every workspace this way; its end-to-end test drives this branch's server through sign-in, roles, row rules and DuckDB for five people.

### Needs a live check before release
1. Claude on Amazon Bedrock (in-region and Geo profile model ids, long answers, tool use) with real AWS credentials, and from an ECS task role.
2. Claude on Google Vertex AI (regional, `us`/`eu` multi-region and global endpoints; streaming) with a real service account and from the metadata server.
3. OTLP trace export to a real collector (for example the AWS Distro for OpenTelemetry or the Google Cloud telemetry endpoint).
4. `credentials` against a real per-user warehouse sign-in (Snowflake External OAuth or Databricks OAuth).
5. A snapshot signed by a real KMS/HSM Ed25519 key.
6. `git.openPullRequest` through a GitHub App, and delivery through a real Slack app and mail service.

## Backward compatibility

Nothing changes for projects or for `dql notebook` with no hooks.

- The new principal columns are added with a default of the local owner.
- `dql.config.json`, `.dql` files and the manifest are unchanged.
- The one visible change is that the certify and review routes stop trusting
  actor fields in the request body when a principal exists. With no hooks, the
  principal is the local owner, which is what the UI already sends.

## Security considerations

- **Why the request body stops naming actors.** Today, anyone who can reach the server can certify in someone else's name. After HH-1, only the server can say who acted.
- **The one query path protects against more than row rules.** It is also where read-only checking, deadlines and cost guards are enforced for every query, not only those that remember to call it.
- **Hooks run in-process with full trust.** A host that loads untrusted hooks has already lost. The contract gives no sandbox.

## Alternatives considered

- **Fork DQL for commercial hosting.** Every OSS release would become merge work. The existing governed-analytics-cloud embed drifted three months behind for this reason.
- **Put a proxy in front of the server.** It can check who is asking, but it can't narrow AI-written SQL, stamp certification actors or key caches by access. Those decisions live inside the engine.
- **Pass the principal as a parameter through every call.** That touches hundreds of call sites. `AsyncLocalStorage` is already used for the same purpose in this file.
- **Build sign-in and roles into OSS.** Out of scope by the OSS boundary (AGENTS.md, `delivery-orchestration.md`).

## Unresolved questions

1. **Scope of `routeAction` for HH-2.** Should the first cut cover only routes that change state and routes that read data, with everything else treated as `project.read`?
2. **Store migration.** When a host supplies Postgres stores, do we provide a one-time import from existing SQLite files, or start empty?
3. ~~**Viewer links.**~~ Resolved in HH-2: network links are signed, read-only, one-App viewer links (see Progress).

## Adoption signal

- A commercial host runs DQL unchanged with its own sign-in, row rules and
  stores.
- Teams on a shared server can see who certified what.
- The `executeQuery` allowlist test stays green release after release.

## Process

Implement slice by slice on short branches. Each slice goes through
independent verification before it lands on main. OSS releases follow the
normal quiet-release path. Nothing in this RFC is pushed or published
without the owner's go-ahead.
