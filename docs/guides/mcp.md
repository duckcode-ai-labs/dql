# Connect DQL to an AI agent (MCP)

DQL ships an [MCP](https://modelcontextprotocol.io) server that gives any
MCP-capable agent **governed** access to your analytics: it answers from
certified blocks when they exactly fit the question and clearly flags anything
it has to generate. Point
Claude Code, Claude Desktop, Cursor, Codex, or any other MCP client at it and
your agent answers data questions from trusted, git-versioned blocks — citing
them — instead of inventing SQL.

## What the agent gets

The server exposes governed workflow tools plus the lower-level building blocks
they use:

| Tier | Tools | Behavior |
|---|---|---|
| **front door** | `inspect_dql_project`, `ask_dql` | Verifies the project, refreshes local metadata/indexes, and returns the safe route: certified block, generated SQL preview, research, or clarify. |
| **governed generation** | `answer_question`, `build_block_from_prompt` | DQL generates for you. `answer_question` runs DQL's own governed cascade end-to-end and returns the executed answer + rows + canonical trust label + a reviewable draft — the same engine and trust guards as the DQL web UI. `build_block_from_prompt` drafts a reusable block from a natural-language prompt (never auto-certified). Both need the runtime (`dql serve`). |
| **1 — certified** | `query_via_block`, `search_blocks`, `get_block` | Serves only `status = "certified"` blocks when the block grain exactly answers the question. Safe to ship. |
| **2 — proposed (BYOSQL)** | `query_via_metadata`, `list_proposals`, `suggest_block`, `build_dql_block` | You author the read-only SQL; DQL grounds, validates, runs a bounded preview, returns `uncertified: true`, and saves a draft under `domains/<domain>/blocks/_drafts/` (domain-first layout) or `blocks/_drafts/` for human review. |
| **Apps** | `build_dql_app` | Creates or plans an app draft using certified tiles first and review-only placeholders for missing evidence. |
| **support** | `certify`, `lineage_impact`, `list_metrics`, `list_dimensions`, `kg_search`, `feedback_record` | Governance checks, lineage tracing, the semantic layer, and feedback. |

**Two ways to answer.** `answer_question` / `build_block_from_prompt` let DQL
generate for you with full UI parity (use these by default). The BYOSQL path
(`ask_dql` → inspect → `query_via_metadata` with your own `SELECT`) is for when
the agent wants to author the SQL itself. Either way, the server's instructions
tell the agent to search certified context first, flag generated/Tier‑2 answers
verbatim as review-required, and refuse when metadata is insufficient — so
generated SQL never silently becomes a "trusted" number.

For external agents, the preferred call order is:

1. `inspect_dql_project`
2. `answer_question` for "just answer it", **or** `ask_dql` to route a BYOSQL flow
3. `query_via_block` when `ask_dql.route = "certified"`
4. `query_via_metadata` (author the SQL) when `ask_dql.route = "generated_sql"`
5. `build_block_from_prompt` (governed) or `build_dql_block`/`build_dql_app` when the user asks to save a reusable asset

## App chat with SDK providers

The notebook and app chat runtime can also attach trusted remote MCP servers
when OpenAI or Anthropic is the active provider. DQL still exposes its own
governed tools first: certified block search/execution, DQL manifest search,
dbt/source metadata, semantic context, runtime schema inspection, bounded SQL
preview, draft block creation, and certification checks.

Create `.dql/mcp-servers.json` to let the active SDK provider use external
remote MCP servers or OpenAI connectors:

```json
{
  "servers": [
    {
      "name": "github",
      "url": "https://api.githubcopilot.com/mcp/",
      "trusted": true,
      "authorizationTokenEnv": "GITHUB_MCP_TOKEN",
      "allowedTools": ["search_issues"],
      "providers": ["openai", "anthropic"]
    }
  ],
  "connectors": [
    {
      "name": "gdrive",
      "connectorId": "connector_googledrive",
      "trusted": true,
      "authorizationTokenEnv": "GOOGLE_DRIVE_OAUTH_TOKEN",
      "providers": ["openai"]
    }
  ]
}
```

`trusted: true` is required before DQL attaches a remote MCP server. Use
provider filtering when a server should only be available to one SDK. OpenAI
uses the Responses API `mcp` tool for remote servers and connectors; Anthropic
uses the Messages API MCP connector for remote HTTP/SSE servers.

## Knowledge sources: answers that cite your team's documents

A server marked `"use": ["knowledge"]` is a **knowledge source**: a
read-only document store (Confluence, a wiki, a notes server) that Ask and
Research may read to explain a question's terms, and cite under the answer.
DQL reads it with its **own** MCP client — it does not hand the server to a
provider's hosted connector — so it works with every model: Anthropic,
OpenAI, Bedrock, Vertex, Ollama and the subscription CLIs.

```json
{
  "servers": [
    {
      "name": "confluence",
      "label": "Confluence",
      "url": "https://mcp.atlassian.com/v1/mcp",
      "use": ["knowledge"],
      "trusted": true,
      "authorizationTokenEnv": "CONFLUENCE_MCP_TOKEN",
      "knowledge": { "searchTool": "search", "searchArg": "query", "fetchTool": "fetch", "fetchArg": "id" }
    },
    {
      "name": "notes",
      "command": "node",
      "args": ["tools/notes-mcp.mjs"],
      "use": ["knowledge"],
      "trusted": true
    }
  ]
}
```

- **Transport.** Streamable HTTP (`url`, https; plain http only on this
  machine), or stdio (`command`, `args`) for a local server started in the
  project folder.
- **Tools.** DQL calls exactly two tools: the server's search (default
  `search` with `query`) and its page read (default `fetch` with `id`).
  `knowledge.searchArgs` / `fetchArgs` add fixed arguments (for example a
  site id). `allowedTools` narrows further. Nothing else on the server is
  ever called.
- **Read-only.** A server that marks its search or fetch tool as one that
  writes (`readOnlyHint: false` or `destructiveHint: true`) is refused.
- **Tool gate.** Every search and page read runs through the same tool gate
  as DQL's other agent tools (a host's `tools` hook sees each call with the
  person asking). A page can be read only if a search in the same answer
  returned it.
- `trusted: true` is required, as for chat servers. `use` defaults to
  `["chat"]`; a server may list both. A knowledge-only server is never
  attached to the chat cell.

**What an answer does with documents.** The governed answer is made first,
exactly as without knowledge. The model then looks up what the documents say
about the question's terms and writes a short note, shown under the answer
as **From team documents** with each page's title and link.

- **Figures come only from governed queries.** Any sentence in the note that
  states a figure is removed, and a sentence in the answer that states a
  figure only a document holds is removed too.
- **Documents never change trust.** A certified answer is certified because
  of its block; an answer that needs review still needs review. Citations
  are kept apart from the trust decision.
- **What leaves the machine.** Pages go only to a model on this machine
  (Ollama on a loopback address) unless you allow a server's pages to reach
  a hosted model: add `"hostedModels": true` to its `knowledge` settings.
  `.dql/mcp-servers.json` is private (git-ignored), so this is your own
  choice, per server. When pages are held back, the answer's steps say
  **Team documents not read** and name the servers. Result values never go
  to the knowledge step.

```json
{ "name": "confluence", "url": "https://mcp.atlassian.com/v1/mcp", "use": ["knowledge"], "trusted": true,
  "authorizationTokenEnv": "CONFLUENCE_MCP_TOKEN", "knowledge": { "hostedModels": true } }
```

Research reads the same sources after framing the question and lists what
it read as context; context is never used in a verdict.

**Who reads what.** Without a host, the project file's servers and tokens
are used, with the model rule above. When DQL runs inside a host that signs people in (RFC 0010), the
host's `knowledgeSources` hook decides, per person, with that person's own
token; without that hook such a host gets no knowledge sources.

## Run the server

From a DQL project folder:

```bash
dql mcp                 # stdio (default) — for clients that spawn a child process
dql mcp --http          # loopback HTTP on 127.0.0.1 with a bearer token
dql mcp test            # verify manifest, metadata, agent index, and MCP readiness
```

Most desktop clients use **stdio** and launch the command for you — you just
add the config below. Use `--http` only for clients that connect to a URL
instead of spawning a process (it prints `http://127.0.0.1:<port>/mcp` and an
`Authorization: Bearer <token>` to stderr; loopback-only).

> **Governed generation needs the runtime.** Routing and BYOSQL planning work
> from the MCP server alone, but `answer_question`, `build_block_from_prompt`,
> and any bounded query execution proxy to the local DQL runtime. Run it
> alongside the MCP server:
>
> ```bash
> dql serve               # in your project folder (defaults to http://127.0.0.1:3474)
> ```
>
> `dql mcp test` reports whether the runtime is reachable (an advisory check —
> stdio routing still works without it). If a governed tool can't reach the
> runtime it returns a clear "start `dql serve`" error instead of failing
> silently. Point tools at a non-default runtime with the `serverUrl` argument
> or the `DQL_RUNTIME_URL` env var.

> **Project path matters.** `dql mcp` resolves the project from its working
> directory. Clients that don't launch from your project folder (Claude
> Desktop, Cursor, Codex) need the project path passed as the last argument —
> shown below as `/abs/path/to/your/dql`.

---

## Claude Code

Run from your DQL project folder:

```bash
dql connect claude-code
```

This writes project-local `.mcp.json` and adds DQL guidance to `CLAUDE.md`.
Open Claude Code in the same project and run `/mcp` to confirm the `dql` server
is loaded. Then ask a data question — Claude routes through `ask_dql`, answers
from certified blocks when the grain fits, and flags generated SQL as
uncertified.

Starter projects ignore `.mcp.json` because it can contain local machine paths.
Commit `CLAUDE.md` only when you want to share the DQL agent guidance with the
team.

## Claude Desktop

Settings → Developer → **Edit Config** opens `claude_desktop_config.json`. Add:

```json
{
  "mcpServers": {
    "dql": {
      "command": "npx",
      "args": ["-y", "@duckcodeailabs/dql-cli", "mcp", "/abs/path/to/your/dql"]
    }
  }
}
```

Restart Claude Desktop; "dql" appears in the tools menu.

Or let DQL write/update that config:

```bash
dql connect claude-desktop /abs/path/to/your/dql
```

## Cursor

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all
projects):

```json
{
  "mcpServers": {
    "dql": {
      "command": "npx",
      "args": ["-y", "@duckcodeailabs/dql-cli", "mcp", "/abs/path/to/your/dql"]
    }
  }
}
```

Enable it under Cursor → Settings → MCP.

Or generate the project config:

```bash
dql connect cursor
```

## Codex (OpenAI Codex CLI)

Add to the trusted project's `.codex/config.toml`:

```toml
[mcp_servers.dql]
command = "npx"
args = ["-y", "@duckcodeailabs/dql-cli", "mcp", "/abs/path/to/your/dql"]
```

Or let DQL add the block and DQL guidance in `AGENTS.md`:

```bash
dql connect codex
```

Open the DQL project in Codex after connecting. If Codex asks whether to trust
the project, trust it so the project-local MCP config is loaded.

Starter projects ignore `.codex/` because it can contain local machine paths.
Commit `AGENTS.md` only when you want to share the DQL agent guidance with the
team.

## Configure all local clients

From the DQL project folder:

```bash
dql connect all
```

This writes project config for Claude Code, Codex, and Cursor, and updates
Claude Desktop's user config. Use the individual commands above when you only
want one client configured.

After connecting any client, run:

```bash
dql mcp test /abs/path/to/your/dql
```

## Any other MCP client

The pattern is identical — a stdio server you launch with:

```
command: npx
args:    -y @duckcodeailabs/dql-cli mcp /abs/path/to/your/dql
```

If your DQL CLI is installed locally in the project, you can also use
`node ./node_modules/@duckcodeailabs/dql-cli/dist/index.js mcp`.

---

## Try it

Build the knowledge graph and start the runtime first (governed generation +
execution proxy to it):

```bash
dql agent reindex       # once, to build .dql/cache indexes
dql serve               # leave running; governed tools call it
```

Then, after wiring any client:

**Ask a governed question** — *"What was our revenue last month?"* A certified
block match → the agent answers from it and cites it (trust label
**Certified**). No exact match, or a deeper/custom-grain question → DQL's
governed cascade generates and executes SQL, returns the rows flagged
**Review-required**, and files a reviewable draft. With `answer_question` DQL
does this for you end-to-end; with the BYOSQL path the agent authors the SQL and
runs it through `query_via_metadata`.

**Build a reusable block from a description** — *"Make a reusable block for
weekly revenue by region."* `build_block_from_prompt` drafts it (grain,
outputs, SQL) as a **review-required** draft under `blocks/_drafts/` — never
auto-certified — and returns the Certifier verdict. Review it, then:

```bash
dql certify --from-draft blocks/_drafts/<slug>.dql
```

Same governed engine, same trust labels as the DQL web UI — the answer you get
from an agent is the answer you'd get from the app.

See [tutorial 04 — Agentic analytics](../tutorials/04-agentic-analytics.md) for
the full loop, and [the agentic architecture](../architecture/graduated-trust.md)
for how graduated trust works.
