# MCP tools

The ZLens MCP server (`zlens mcp`) offers tools only: no resources and no
prompts. Every result is JSON. The server's instructions tell the agent to use
the trust labels it returns (Certified, Reviewed, AI-Generated,
Insufficient-Context, Conflict) as given, and never upgrade them.

## Default tools

These are on by default.

### Start here

| Tool | What it does |
|---|---|
| `inspect_dql_project` | Checks the project and refreshes its metadata and index. Call it first. |
| `answer_question` | Answers a question end to end, like Ask: certified block, then semantic metric, then AI-written SQL. Returns the rows, the trust label and, when the answer needs review, the draft block it saved. Needs the ZLens runtime. |
| `ask_dql` | Decides how a question should be answered (certified, generated SQL, conflict or missing context) and what to call next. For agents that write their own SQL. On a conflict, the agent must ask the user which source is authoritative. |

### Certified blocks

| Tool | What it does |
|---|---|
| `search_blocks` | Finds blocks by keyword, domain or status. |
| `get_block` | Returns a block's metadata and source. |
| `query_via_block` | Runs a certified block. Refuses blocks that are not certified, and blocks whose grain does not fit the question. |

### Writing SQL safely

| Tool | What it does |
|---|---|
| `inspect_metadata_context` | Builds the context the agent may use: tables, columns, joins. |
| `search_metadata` | Ranks dbt tables for a request. |
| `get_table_schema` | Columns, types and suggested join keys for a table. |
| `resolve_analytical_path` | The certified join plan for questions across entities or domains. |
| `explain_relationship_proof` | Why two tables may (or may not) be joined. |
| `validate_sql` | Checks that SQL only uses tables and columns that exist. |
| `expand_context` | Adds missing tables to the context so a failed query can be retried. |
| `query_via_metadata` | Runs one read-only `SELECT` or `WITH` query as a bounded preview. Marks the result `uncertified` and saves a draft block unless asked not to. |
| `query_semantic_model` | Compiles and previews a semantic-layer query, and saves it as a draft. |
| `kg_search` | Searches the project's knowledge graph. |

### Blocks, lineage and checks

| Tool | What it does |
|---|---|
| `build_block_from_prompt` | Drafts a reusable block from a description. Never certifies. Needs the ZLens runtime. |
| `suggest_block` | Saves a draft block under `_drafts/` with the rule check result. |
| `certify` | Checks a block against the certification rules and reports pass or fail. It writes nothing and changes no status. |
| `lineage_impact` | Upstream and downstream of a block, model or table. |

### App datasets

| Tool | What it does |
|---|---|
| `list_datasets`, `describe_dataset` | The App datasets and their fields. |
| `preview_tile_query`, `query_dataset` | Query a dataset by fields, without SQL. Creates no App or draft. |

## Extra tools

Set `ZLENS_MCP_TOOL_PROFILE=full` in the server's environment to add:

| Tool | What it does |
|---|---|
| `list_metrics`, `list_dimensions` | The semantic layer's metrics and dimensions. |
| `build_dql_block` | Older name for `suggest_block`. |
| `build_dql_app` | Drafts an App, certified tiles first. |
| `list_proposals` | Draft blocks, most asked first. |
| `feedback_record` | Records thumbs up or down on an answer. Never upgrades trust. |
| `record_correction`, `list_hints`, `approve_hint` | Capture an analyst's correction as a hint, and approve or reject it with an evidence note. |

## The ZLens runtime

`answer_question`, `build_block_from_prompt` and the query tools call the ZLens
runtime: the server that `zlens notebook` (`npm run notebook`) starts. Keep
it running. The tools look for it at `http://127.0.0.1:3474`, or at
`ZLENS_RUNTIME_URL`, or at a `serverUrl` argument. `zlens mcp test` checks it.
