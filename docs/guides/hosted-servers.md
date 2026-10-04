# Hosted servers

`dql notebook` is a single-user server: whoever opens it is the person using it.
A **host** is a program that runs the same server for many people and tells it,
for every request, who is asking. DQL's [host hooks](../rfcs/0010-host-hooks.md)
(RFC 0010) are how a host does that. This page says what the server does when a
host is present. Without a host, nothing on this page applies, except where the
[changelog](https://github.com/duckcode-ai/dql/blob/main/CHANGELOG.md) says
otherwise.

## What the server does for each request

- **Records belong to people.** Runs, threads, traces, research runs, App
  memos and pins, drafts, imports, favourites and follows are kept for the
  person who made them. Someone else's id is "not found".
- **Project content only.** The file routes open project content (notebooks,
  blocks, Apps, domains, the semantic layer, docs), never the runtime's own
  folders, git's files, connection settings or data files.
- **The server chooses the connection.** A request may name one of the
  project's own connections; connection settings inside a request are ignored.
- **Statements are read-only and checked once.** SQL written by a person or a
  model passes through one checked path, is read with the rules of the engine
  it will run on, and is refused unless it only reads. A statement DQL cannot
  read the same way under every server setting is refused. The warehouse's own
  activity and settings views are not readable this way.
- **One figures decision.** Whether needs-review figures may be shown is
  decided in one place and applied to every route that can carry them: answers,
  streams, runs, exports, Slack and MCP-style tools.
- **Values reach a model only through the boundary check.** A host's
  `isInBoundary` hook, or the local-model check, decides whether values may
  appear in a prompt. A credential that may not see values gets column names and
  `rowsWithheld: true`, without row counts.
- **Hooks fail closed.** A hook that throws, answers late (every hook has a
  time limit) or answers with the wrong shape is treated as a refusal.

## What changes for a single-user `dql notebook`

Fonts and driver icons come from DQL itself, an export holds the whole result up
to 100,000 rows (a larger result is refused with `EXPORT_TOO_LARGE`; it used to
stop at the 500 rows on screen), a local Ollama model contacts only its
configured address, and research narration follows `providerResultRowEgress:
disabled`. The changelog lists the rest.

## For host authors

[RFC 0010](../rfcs/0010-host-hooks.md) lists every hook and field once, with its
default. The host package
(`@duckcodeailabs/dql-cli/host`) exports the statement check and the per-engine
reader that DQL applies, so a host that checks a statement before passing it on
uses the same rules.
