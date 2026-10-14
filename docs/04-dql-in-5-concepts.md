# ZLens in 5 Concepts

ZLens OSS is analytics as code for a single local user. These five concepts are
enough to understand the product before reading the references.

## 1. Block

A block is a reusable analytics artifact in a `.dql` file. It carries SQL or
semantic intent, owner, domain, description, tags, chart config, tests, and
agent context.

Blocks are the unit you save, review, reuse, and cite.

## 2. Certified Block

A certified block is a block with `status = "certified"`. In OSS this is a
local trust label, not an enterprise approval workflow.

Certified blocks are preferred by Apps, notebooks, MCP tools, and local agent
answers. If the agent cannot find a certified block, generated SQL must stay
clearly labeled as uncertified.

## 3. App

An App is a local folder under `apps/<app-id>/` that packages dashboard pages,
attached notebooks, text, AI pins, draft blocks, and metadata for a domain or
decision workflow.

Apps are git-backed consumption artifacts. In OSS, App visibility, lifecycle,
persona, and policy fields are local preview metadata, not hosted RBAC.

## 4. Manifest

`dql-manifest.json` is the dbt-like compiled artifact for a ZLens project.

It records blocks, notebooks, Apps, dashboard pages, metrics, dimensions,
sources, dbt imports when present, diagnostics, and lineage. Run:

```bash
zlens compile
```

after editing source artifacts.

## 5. Lineage

Lineage shows how data flows from source tables and dbt models through semantic
metrics, DQL blocks, dashboard pages, and Apps.

Use it to answer:

- Where did this answer come from?
- What breaks if this source changes?
- Which certified blocks depend on this model?
- Which Apps consume this block?
