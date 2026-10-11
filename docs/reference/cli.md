# CLI reference

> **Source of truth:** the installed CLI. Run `dql --help` (or the project-local
> equivalent below) for the exact command list shipped by your version. This
> page is maintained against
> [`apps/cli/src/index.ts`](https://github.com/duckcode-ai-labs/dql/blob/main/apps/cli/src/index.ts),
> and CI checks that every dispatched top-level command appears here.

```bash
dql --help
dql --version
```

## Running the CLI

The command prefix depends on how DQL was installed:

| Installation | Command form | When to use it |
| --- | --- | --- |
| Project-local (recommended) | `npm exec -- dql <command>` | Any CLI command using the version in this repository |
| Project-local starter script | `npm run doctor`, `npm run notebook`, and similar | Common commands already declared in `package.json` |
| Project-local shorthand | `npx dql <command>` | Convenient when the local dependency is already installed |
| Global | `dql <command>` | A global installation available everywhere on `PATH` |

For example:

```bash
npm install
npm run doctor
npm exec -- dql model list
npm exec -- dql --help
```

`npm run` adds `node_modules/.bin` to `PATH` for that script. A normal shell
does not, so a bare `dql` command requires
`npm install -g @duckcodeailabs/dql-cli`. The command tables below use the
short global form for readability; prepend `npm exec --` for a project-local
installation.

## Commands

### Project

| Command | What it does |
| --- | --- |
| `dql init [dir]` | Initialize DQL in a project (auto-detects dbt) |
| `dql doctor [path]` | Run local setup checks |
| `dql doctor scale` | Report enterprise-scale manifest/cache/index health |
| `dql doctor git-hygiene` | Flag tracked local/generated files before commit |
| `dql validate [path]` | Validate all `.dql` files and semantic references |
| `dql compile [path]` | Generate project manifest (`dql-manifest.json`) |
| `dql verify [path]` | Verify that `dql-manifest.json` is reproducible from tracked source |

`dql doctor scale --format json` includes counts, cache freshness,
metadata/KG index state, context-pack timing, source fingerprints, domain
shards, and top rejected evidence candidates that were relevant but excluded by
retrieval caps.

`dql doctor git-hygiene --format json` checks tracked files against the OSS Git
policy and flags `.dql/cache`, `.dql/local`, `*.run.json`, `dql-manifest.json`,
local databases, data files, AI pins, saved views, and layout overrides.

### Authoring

| Command | What it does |
| --- | --- |
| `dql new <type> <name>` | Create a domain, block, semantic block, term, business view, dashboard, workbook, or notebook |
| `dql new domain <name>` | Create `domains/<domain>/domain.dql` plus domain-local `terms/`, `blocks/`, `views/`, and `apps/` folders |
| `dql new block --domain <domain> --pattern <pattern> <name>` | Create a draft block scaffold with enterprise contract metadata |
| `dql new view --domain <domain> <name>` | Create a domain-local business view scaffold |
| `dql import sql <path>` | Generate AI-first DQL draft blocks from SQL files or folders |
| `dql import sql <path> --save` | Compatibility alias; generated drafts autosave before certification |
| `dql propose [path]` | Rank dbt models and write review-only DQL block proposals |
| `dql propose [path] --dry-run` | Preview ranked proposals without writing files |
| `dql parse <file.dql>` | Parse and analyze a DQL file |
| `dql info <file.dql>` | Show block metadata |
| `dql certify <file.dql>` | Evaluate certification rules |
| `dql certify <file.dql> --enterprise` | Enforce grain, outputs, source-system lineage, pattern-specific reusable contracts, review cadence, and test assertions |
| `dql certify --from-draft <path>` | Promote a reviewed Tier-2 draft and surface its DataLex contract patch |
| `dql test <file.dql>` | Deprecated compatibility command; use `dql certify --connection` |
| `dql fmt <file.dql\|.dqlnb>` | Format a file in place (canonical form) |
| `dql fmt --check <path>` | CI check; exits 1 if anything needs formatting |

### Diff & versioning

| Command | What it does |
| --- | --- |
| `dql diff <path>` | Semantic diff of a `.dql` or `.dqlnb` against git HEAD |
| `dql diff <before> <after>` | Semantic diff between two files on disk |
| `dql diff <path> --impact --write-recertification` | Mark impacted semantic metric/dimension YAML as `pending_recertification` |

Exits **1** on changes — scriptable like `git diff`.

### Build & preview

| Command | What it does |
| --- | --- |
| `dql build <file.dql>` | Compile to a static HTML bundle |
| `dql preview <file.dql>` | Local browser preview |
| `dql serve [dir]` | Serve a built bundle |
| `dql notebook [path]` | Launch the browser-first notebook |

### Data & semantic

| Command | What it does |
| --- | --- |
| `dql semantic list\|validate\|query\|pull` | Semantic layer operations |
| `dql sync dbt [path]` | Diff, compile, and reindex dbt-backed DQL state |
| `dql sync dbt --check [path]` | Report dbt/DQL drift without writing |
| `dql model list [path]` | List dbt-first Domain Packages |
| `dql model validate [path]` | Validate Domain Packages and relationship proofs |
| `dql model discover [path]` | Preview deterministic dbt domain proposals |
| `dql model apply-discovery [path] --apply` | Write reviewed sparse Domain Package proposals |
| `dql model explain <id> [path]` | Explain whether a relationship has automatic-join proof |
| `dql lineage [block] [path]` | Answer-layer lineage analysis |

Useful lineage flags:

```bash
dql lineage --term "Customer"          # business term to blocks/views/consumption
dql lineage --business-360 "Customer"  # business definition, reusable block contracts, sources, consumers, and gaps
dql lineage cross-domain --domain customer
                                      # domain boundary flows touching customer
dql lineage --business                 # business lineage summary
dql lineage --business "Customer 360"  # focused business composition and backing sources
dql lineage --table fct_orders         # technical source lineage
dql lineage --dashboard daily_ops      # consumption lineage
```

### Apps, agent, and MCP

| Command | What it does |
| --- | --- |
| `dql app new <name>` | Create a local App package |
| `dql app generate "<prompt>"` | Generate a governed App draft from certified blocks plus review placeholders |
| `dql app generate "<prompt>" --ai-layout` | Store richer GenUI layout metadata for dynamic visualization/layout decisions |
| `dql app ls\|show\|build\|reindex` | List, inspect, compile, or reindex local Apps |
| `dql promote notebook <path> --to shared` | Strip local run/UI state and mark a notebook as shared source |
| `dql promote app <app-id> --to shared` | Mark an App manifest as shared/reviewed source |
| `dql promote dashboard <app-id>/<dashboard-id> --to shared` | Strip AI pins/local state and mark a dashboard as shared source |
| `dql agent ask "<question>"` | Ask through the certified-first local agent loop |
| `dql agent threads` | List persisted conversations that can be resumed with `--thread` |
| `dql agent reindex` | Rebuild `.dql/cache/agent-kg.sqlite` and metadata cache |
| `dql agent feedback up\|down` | Record answer feedback |
| `dql agent eval <file.yml>` | Run answer-loop eval checks with metrics and JSON traces; cases can assert `expected.minToolCalls` for tool-observed deep/research flows |
| `dql agent trace list\|show\|export\|validate\|replay\|compare` | Inspect and export local redacted Ask trace receipts without starting a provider, tool, SQL, or network path |
| `dql mcp [path]` | Run the DQL MCP server over stdio |
| `dql mcp --http [path]` | Run loopback HTTP MCP with a bearer token |
| `dql mcp test [path]` | Verify manifest, metadata catalog, agent index, and MCP tool readiness |
| `dql connect codex [path]` | Write project `.codex/config.toml` plus `AGENTS.md` |
| `dql connect claude-code [path]` | Write project `.mcp.json` plus `CLAUDE.md` |
| `dql connect claude-desktop [path]` | Update Claude Desktop MCP config |
| `dql connect cursor [path]` | Write project `.cursor/mcp.json` |
| `dql connect all [path]` | Configure all supported local MCP clients |

### Automation, integrations, and evaluation

| Command | What it does |
| --- | --- |
| `dql schedule list [path]` | List local schedules declared by DQL blocks |
| `dql schedule run [path]` | Run due local schedules once; `dql schedule run <appId> [scheduleId]` runs one App schedule (through a running `dql notebook` when there is one) |
| `dql schedule start [path]` | Start the local scheduler (App schedules are left to a running `dql notebook`, which runs them itself) |
| `dql schedule status [path]` | Show local scheduler status |
| `dql schedule stop [path]` | Stop the local scheduler |
| `dql slack serve [path]` | Run the Slack slash-command bot through the governed answer loop |
| `dql eval [path]` | Replay block examples and `eval/*.yaml` through the router |
| `dql agent eval <file.yml>` | Evaluate certified/follow-up/refusal behavior, optional tools, SQL execution, and judging |

### Migration

| Command | What it does |
| --- | --- |
| `dql import sql <path>` | Generate autosaved AI import drafts from SQL files/folders |
| `dql migrate <source>` | Scaffold from looker, tableau, dbt, metabase, or raw-sql |
| `dql migrate layout --to domain-first --dry-run` | Preview moves from legacy folders into `domains/<domain>/...` |
| `dql migrate layout --to domain-first --force` | Apply the previewed domain-first file moves |
| `dql migrate format` | Rewrite every `.dql` and `.dqlnb` in the project in canonical form |
| `dql migrate format --check` | Dry run; exits 1 if anything would change |
| `dql migrate parameters --check` | Audit legacy block parameters before AI adaptation |
| `dql migrate datalex --input <manifest.json> --dry-run` | Preview DataLex-only semantics as dbt-first Domain Package overlays |
| `dql migrate datalex --input <manifest.json> --apply` | Apply the reviewed DataLex migration plan |
| `dql migrate modeling --to dbt-first --dry-run` | Preview manifest-v3/dbt-first modeling adoption |
| `dql migrate modeling --to dbt-first --apply` | Apply the reviewed dbt-first modeling migration |

## Shared and command-specific flags

| Flag | Meaning |
| --- | --- |
| `--format json\|text` | Output format (default: text) |
| `--verbose` | Detailed output |
| `--open` / `--no-open` | Auto-open the browser on `preview`/`serve` |
| `--no-schedules` | `dql notebook` does not run the project's App schedules |
| `--check` | For `fmt`: non-zero exit if changes needed |
| `--input <path>` | Source for scaffold-style migrations |
| `--out-dir <path>` | Output directory for `build` |
| `--host <host>` | Bind host for local HTTP commands; defaults to loopback |
| `--to domain-first` | Target for `dql migrate layout` |
| `--dry-run` | Preview layout moves without writing |
| `--apply` | Apply an otherwise preview-only migration or discovery plan |
| `--plan` | Print a deterministic proposal plan without writing |
| `--force` / `-f` | Apply supported overwrites or file moves |
| `--to shared` | Target for `dql promote` |
| `--port <n>` | Preferred local port for `preview`/`serve` |
| `--chart <type>` | Primary chart type for `new` scaffolds |
| `--domain <name>` | Domain for new block scaffolds |
| `--owner <name>` | Owner for new block scaffolds |
| `--purpose <text>` | Governed purpose for an authorized cross-domain import |
| `--pattern <name>` | Block scaffold pattern, such as `metric_wrapper`, `entity_profile`, `entity_rollup`, `ranking`, `trend`, `bridge`, `drilldown`, or `replacement` |
| `--template <name>` | Alias for `--pattern` on scaffold commands |
| `--enterprise` | For `certify`: require enterprise-ready reusable block metadata plus pattern-specific parameter/filter contracts |
| `--query-only` | Create a query-only block (no visualization) |
| `--connection <driver\|path>` | Connection for `certify`/`test` (e.g. `duckdb`, `./db.duckdb`) |
| `--skip-tests` | Skip executable certification tests when the command supports it |
| `--save` | Compatibility flag for SQL import; drafts already autosave |
| `--from-draft <path>` | Draft source for `dql certify --from-draft` |
| `--contract <id@version>` | DataLex contract bound during draft certification |
| `--datalex-manifest <path>` | DataLex manifest used for contract validation or compilation |
| `--open-pr` | Push the certification branch and open a GitHub pull request |
| `--http` | Run MCP over loopback HTTP instead of stdio |
| `--ai` | Include AI provider, MCP, and metadata checks in `dql doctor` |
| `--ai-layout` | Store dynamic GenUI layout metadata for `dql app generate` |
| `--provider <name>` | Select agent provider where supported |
| `--user <id>` | Attribute agent memory or feedback to a local user id |
| `--runtime-url <url>` / `--runtime <url>` | Select the local agent runtime endpoint |
| `--thread <id>` | Continue a persisted `dql agent ask` conversation |
| `--reasoning-effort low\|medium\|high` | Select supported provider reasoning effort |
| `--analysis-depth quick\|deep` | Control the agent context budget |
| `--block <id>` / `--question <text>` / `--comment <text>` | Supply agent feedback context |
| `--execute` | Execute bounded generated SQL previews during agent eval and score expected rows |
| `--min-route-accuracy <0..1>` | For `dql eval`: minimum expected-route accuracy |
| `--min-refusal <0..1>` | For `dql eval`: minimum refusal recall |
| `--min-answer-rate <0..1>` | For `dql eval`: fail when answerable cases route to missing context below this non-refusal rate |
| `--min-tool-requirement <0..1>` | For `dql agent eval`: fail when cases with `expected.minToolCalls` fall below this pass rate |
| `--min-execution-match <0..1>` | For `dql agent eval`: minimum expected-row execution match |
| `--min-judge-pass <0..1>` | For `dql agent eval`: minimum LLM-judge pass rate |
| `--max-wrong-certified <n>` | For `dql agent eval`: maximum wrongly certified answers |
| `--no-examples` | For `dql eval`: score YAML cases without manifest examples |
| `--impact` | Include downstream impact in `dql diff` |
| `--write-recertification` | Mark impacted semantic YAML pending recertification |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic failure *or* `dql diff`/`dql fmt --check` found differences |
| `2` | Usage / argument error |
