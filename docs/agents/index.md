# Connect your AI agent (MCP)

ZLens includes an [MCP](https://modelcontextprotocol.io) server. Connect it
to Claude Code, Codex, Cursor or Claude Desktop, and your agent answers data
questions the way Ask does: from certified blocks first, with the same trust
labels, and with AI-written SQL clearly marked for review.

{{ clip("mcp-connect") }}

## 1. Check the project

From your ZLens project folder:

```bash
npm exec -- zlens mcp test
```

It checks the project, the manifest, the metadata catalog, the search index,
the MCP tools and the ZLens runtime, which is the workbench that
`npm run notebook` starts (see [step 4](#4-keep-the-workbench-running)).
Every check must pass:

- When they all pass, the last line is
  `Ready: point Claude Code, Codex, Cursor, or Claude Desktop at this project with zlens connect.`
  and the command exits 0.
- When any check fails, it is marked `✗` and followed by a `Fix:` line that
  says what to do. The last line is
  `Not ready: 2 checks failed (…). Fix them as shown above, then rerun zlens mcp test.`
  and the command exits 1, so a script can gate on it.

If the index is missing, run `npm run sync` first. If the runtime checks fail,
start the workbench in another terminal with `npm run notebook` (or
`zlens notebook <project>` outside a create-zlens-app project), leave it
running, and run `zlens mcp test` again.

## 2. Connect your agent

From the project folder, run the command for your agent:

| Agent | Command | Writes |
|---|---|---|
| Claude Code | `npm exec -- zlens connect claude-code` | `.mcp.json` and a ZLens section in `CLAUDE.md` |
| Codex | `npm exec -- zlens connect codex` | `.codex/config.toml` and a ZLens section in `AGENTS.md` |
| Cursor | `npm exec -- zlens connect cursor` | `.cursor/mcp.json` |
| Claude Desktop | `npm exec -- zlens connect claude-desktop` | Claude Desktop's own config file, for your user |
| All four | `npm exec -- zlens connect all` | all of the above |

For Claude Code, the output looks like this:

```text
  ZLens agent connection setup
    Project: /path/to/jaffle-shop-duckdb

  ✓ Claude Code
    Project .mcp.json and CLAUDE.md now point Claude Code at ZLens.
    Next: Open Claude Code from this project and run /mcp to confirm the dql server is loaded.

  Verify before asking an agent: zlens mcp test
```

The server is registered under the name `dql`. Each config starts it with:

```json
{
  "command": "npx",
  "args": ["-y", "--package=@zlens/cli", "zlens", "mcp", "/path/to/your/project"]
}
```

Running `zlens connect` again is safe: it keeps your other MCP servers and
only rewrites the ZLens entry. `zlens connect` has one option,
`--format json`.

!!! note "What to commit"
    The starter project's `.gitignore` keeps `.mcp.json`, `.codex/` and
    `.cursor/` out of git, because they hold paths on your machine. Commit
    `CLAUDE.md` or `AGENTS.md` if you want to share the ZLens guidance with your
    team.

!!! warning "Claude Desktop on Windows and Linux"
    `zlens connect claude-desktop` writes to the macOS location of Claude
    Desktop's config. On other systems, add the `dql` entry above to Claude
    Desktop's config yourself (Settings → Developer → Edit Config).

## 3. Open your agent

- **Claude Code**: start it in the project folder and run `/mcp`. The `dql`
  server is listed.
- **Codex**: open the project and trust it, so Codex loads the project's MCP
  config.
- **Cursor**: enable MCP in Cursor's settings and reload the project.
- **Claude Desktop**: restart it and enable the `dql` tool.

## 4. Keep the workbench running

Answering questions and running queries go through the ZLens runtime, which
is the server `npm run notebook` starts. Keep it running while your agent
works. `zlens mcp test` reports whether it is reachable at
`http://127.0.0.1:3474`. If it runs on another address, set `ZLENS_RUNTIME_URL`.

## 5. Ask

Ask your agent a data question, for example *"Who are our top customers by
lifetime spend?"*

- If a certified block answers it, the agent answers from it and the label is
  **Certified**.
- If not, ZLens writes SQL, runs it, labels the answer as needing review, and
  saves a draft block for review, exactly as [Ask](../ask/needs-review.md) does.
- If the project cannot answer safely, the agent is told to refuse rather than
  guess.

The server tells the agent to report trust labels exactly as given and never
upgrade them. The agent cannot certify anything: the `certify` tool only
checks the rules. A person certifies in Block Studio or with
`zlens certify --from-draft`.

See [MCP tools](tools.md) for what the agent can call.

## Other MCP clients

Any client that can start a stdio server works:

```text
command: npx
args:    -y --package=@zlens/cli zlens mcp /abs/path/to/your/project
```

For clients that connect to a URL, run `zlens mcp --http`. It listens on
`127.0.0.1` only and prints the URL (`http://127.0.0.1:<port>/mcp`) and a
bearer token to use in the `Authorization` header. Pick the port with
`--port <n>`.
