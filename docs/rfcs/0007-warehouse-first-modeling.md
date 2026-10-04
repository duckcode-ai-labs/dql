# RFC 0007: Warehouse-first modeling (DQL without dbt)

| Field | Value |
|---|---|
| **Author(s)** | @KKranthi6881 |
| **Status** | Accepted — Phases 1–3 implemented |
| **Created** | 2026-09-18 |
| **Targets** | DQL 1.18.x |
| **Discussion** | — |
| **Implementation** | `packages/dql-core/src/manifest/warehouse-catalog.ts`, `apps/cli/src/warehouse-catalog-sync.ts`, `apps/cli/src/warehouse-model-discovery.ts` (see *As built*) |
| **Supersedes** | — |

## As built (Phases 1–3, 2026-09-18)

The implementation keeps the design's intent and reuses more of what exists.
Where it differs from the sections below, this list is authoritative:

1. **Schema selection reuses `metadataScopes`.** There is no
   `modeling.sources` key: the schemas a project models are the connection's
   existing `metadataScopes` entry, the same selection Settings → Sync schema
   already edits.
2. **One command: `dql sync warehouse`** (beside `dql sync dbt`), not
   `dql catalog sync` or `dql model sources add`.
   `dql sync warehouse --schemas a,b [--database X] [--connection name]`
   saves the selection and syncs; with no flags it re-syncs the saved one.
   Settings → Sync schema (`PUT /api/connections/:id/metadata-scope`,
   `POST …/metadata-sync`) does the same work through the same function.
3. **The catalog is one file, `.dql/warehouse-catalog.json`**
   (`WarehouseCatalogSnapshotV1`): sorted, fingerprinted without its capture
   time, metadata only. The manifest builder reads it as an input file, so a
   sync invalidates the project snapshot exactly as a new dbt
   `manifest.json` does.
4. **No separate `warehouseProvenance`.** Warehouse relations are provenance
   nodes in `dbtProvenance.nodes` with `resourceType: 'warehouse'` and ids
   `warehouse.<database>.<schema>.<name>`, and `dbtProvenance` gains
   `warehouseCatalogPath` / `warehouseCatalogFingerprint`. Every reader that
   resolves an entity's relation through `dbtProvenance.nodes` therefore
   works unchanged, and the knowledge graph records these nodes as
   `source_table` objects with `warehouse::` ids.
5. **`dql init` does not switch modes on its own.** A folder without dbt
   keeps today's configuration; `dql init --warehouse-first` writes
   `manifestVersion: 3` and `modeling.mode: "warehouse-first"`, and plain
   `dql init` mentions the option. Adding a dbt project to a warehouse-first
   project in Settings makes it `hybrid`, so relation-bound entities keep
   working.
6. **Drivers.** Catalog extractors exist for DuckDB, SQLite, PostgreSQL /
   Redshift and Snowflake, with an information_schema fallback for other
   drivers (tables, views and columns only). Schema discovery for the
   Settings picker now also lists DuckDB, PostgreSQL, Redshift, MySQL and
   SQL Server schemas, and SQLite databases, falling back to the connection's
   own database and schema as before. The SQLite connector is enabled in the
   default package. It uses the CLI's own `better-sqlite3` and opens a
   database file read-only.

7. **Drafting (Phase 2)** — `dql model discover` / `apply-discovery`, and
   Modeling → Draft from warehouse:
   - entities: grain from a declared primary key, or from a naming key such
     as `id` or `<table>_id` that `--validate` shows unique;
   - joins: from declared foreign keys, view SQL and naming conventions,
     with each piece of evidence cited;
   - `--validate`: checks each join with Validate's one statement
     (aggregates only) and proposes the cardinality it saw.

   In the UI the drafts open as an ordinary reviewable proposal, with origin
   `warehouse_discovery`. The runtime builds that proposal itself, so
   warehouse evidence never comes from the browser. The setup wizard's step 1
   and an unconfigured Modeling page offer "model my warehouse without dbt"
   (`POST /api/modeling/warehouse/enable`).
8. **Key types.** Relationship validation reads the key columns' types from
   the warehouse catalog, the same source the compiler uses. Without this, a
   certified warehouse join could never become automatic for Ask.
9. **Depth (Phase 3):**
   - *Extractors:* Databricks (Unity Catalog `information_schema`,
     informational keys) and BigQuery (per-dataset `INFORMATION_SCHEMA`,
     descriptions from `TABLE_OPTIONS` and `COLUMN_FIELD_PATHS`,
     single-column foreign keys). Both are unit-tested against rows shaped
     like their `information_schema` output, but not yet run against a live
     account. BigQuery's connector is still outside the default connector
     package, so its extractor takes effect when that connector ships.
   - *Query-history evidence* is opt-in: `--query-history`, or "Use query
     history" in Modeling (not with a host: a hosted statement does not read
     other sessions' queries, RFC 0010). It reads Snowflake `QUERY_HISTORY`, PostgreSQL
     `pg_stat_statements`, Databricks `system.query.history` and BigQuery
     `JOBS_BY_PROJECT`. Query text is parsed in memory and dropped; only
     join pairs and counts are kept, and a join seen fewer than twice is
     ignored.
   - *Drift:* each re-sync compares the new catalog with the previous one.
     It reports added and removed tables and columns and type changes, and
     names the entities and joins they touch (CLI, Settings). The compiler
     already stops a changed certified join from being automatic.
   - *Native metrics:* Modeling → New metric writes a DQL semantic-layer
     metric: an aggregation of one catalog column. The endpoint now writes
     YAML with a serializer and refuses to replace an existing metric when
     asked.

Compatibility was checked the way *Backward compatibility* requires, after
each phase:
- every CLI fixture's compiled manifest and compile output are byte-identical
  to the build before this work;
- the golden Ask replays pass without re-recording;
- a dbt project's Modeling page and APIs show no warehouse controls or
  fields (checked in the browser).

## Summary

DQL's Modeling, certified relationships, certified joins and governed Ask
answers need a dbt project today. This RFC lets a team that has **only a
database** get the same product. The warehouse itself becomes a model source
beside dbt:
- its tables, views, columns, comments, declared keys and view definitions go
  into the metadata catalog;
- Modeling entities may bind to a warehouse relation instead of a dbt model;
- relationships are drafted automatically from keys, names and view SQL,
  checked against the data, and certified by a person.

**Nothing changes for dbt projects.** Every existing file, config key, command,
manifest field and recorded test keeps its meaning. The new behaviour is
reached only through a new, explicit mode.

## Motivation

- **Market.** Most teams that would buy DQL keep their data in Snowflake,
  Databricks, BigQuery or Postgres without a dbt project. Today they get only
  the lowest tier. On the insurance benchmark, that tier (dbt project only, no
  Modeling) scored 26%, against 70–72% with Modeling, the semantic layer and
  skills, on the same model.
- **Benchmarks.** Every raw-database benchmark (Spider 2.0-Lite/Snow, BIRD,
  LiveSQLBench) needs this. Wrapping each table in a generated dbt model adds
  no knowledge and hides what DQL does on a real warehouse.
- **Where the gap is today:**
  - `packages/dql-core/src/manifest/dbt-first-modeling.ts` rejects an entity
    without `dbt_model` ("each entity requires `id` and `dbt_model`");
  - `ManifestModelEntity.dbtUniqueId` is required;
  - `modelingRelationshipEdges` (`apps/cli/src/ask-pipeline-host/join-relationships.ts`)
    finds an entity's table only through `dbtProvenance.nodes`;
  - so without dbt there are no entities, no relationships and no governed
    joins.

## What already exists and is reused

| Piece | Where | Used for |
|---|---|---|
| Driver introspection (`listTables`, `listColumns`) | `packages/dql-connectors/src/drivers/*` | tables and columns, every driver |
| Warehouse metadata sync, with scope modes `dbt_relations`, `selected_scopes` and `dbt_plus_selected` | `apps/cli/src/warehouse-metadata.ts` | `selected_scopes` is already the no-dbt scope |
| Metadata catalog, snapshots, fingerprints, vector index | `packages/dql-agent/src/metadata/catalog.ts` | unchanged storage for the new nodes |
| Relationship key suggestions (`same_name`, `named_for_table`, `dbt_test`) | `packages/dql-agent/src/relationship-suggestions.ts` | extended with new evidence sources |
| Relationship validation (cardinality, null keys, unmatched rows) | `packages/dql-agent/src/relationship-validation.ts` | checks every drafted relationship |
| Modeling-authoring AI, "AI drafts, humans certify" | `packages/dql-core/src/manifest/dbt-first-authoring.ts` | drafts names, descriptions, domains |
| Native semantic engine; Snowflake semantic views; LookML import | `apps/cli/src/semantic-import.ts` and others | metrics without MetricFlow |

## Detailed design

### 1. Modes and detection

A new value for the existing `modeling.mode` key in `dql.config.json`:

| Mode | Meaning | When `dql init` writes it |
|---|---|---|
| `dbt-first` (unchanged) | Entities bind to dbt models | `dbt_project.yml` found (as today) |
| **`warehouse-first`** (new) | Entities bind to warehouse relations | no dbt project, a connection configured |
| **`hybrid`** (new) | Both, per entity | dbt found **and** the user adds warehouse schemas dbt does not cover |

Rules:
- **A missing `modeling.mode` keeps today's behaviour exactly.** Nothing is
  re-detected, and nothing is inferred for an existing project.
- `dql init` never rewrites an existing `modeling` block. Switching an
  existing project to `hybrid` is an explicit action (Settings or
  `dql model sources add`).
- Detection prints what it found and the mode it chose; `--mode` overrides.

New keys, all optional:

```jsonc
{
  "modeling": {
    "mode": "warehouse-first",
    "sources": [
      { "kind": "warehouse", "connection": "default",
        "scopes": [{ "database": "ACME", "schema": "SALES" }] }
    ]
  }
}
```

`sources[].scopes` reuses the `RuntimeSchemaScope` shape already stored by
`ConnectionMetadataScopeV1`.

### 2. The warehouse catalog layer

A per-driver **catalog extractor** returns one normalized `WarehouseCatalogSnapshotV1`:

```ts
interface WarehouseRelationV1 {
  id: string;                 // "warehouse.<database>.<schema>.<name>" — stable, driver-neutral
  binding: PhysicalRelationBindingV1;   // existing type: database, schema, table, driver
  kind: 'table' | 'view' | 'materialized_view';
  comment?: string;
  columns: Array<{ name: string; type?: string; comment?: string; nullable?: boolean }>;
  primaryKey?: string[];                              // declared, informational or enforced
  foreignKeys?: Array<{ columns: string[]; references: { relation: string; columns: string[] } }>;
  viewSql?: string;                                   // definition, for lineage and join evidence
  rowCountEstimate?: number;                          // from system tables, never COUNT(*)
}
```

Per-driver extraction, all metadata only:

| Driver | Comments | Declared keys | View SQL | Phase |
|---|---|---|---|---|
| DuckDB | `duckdb_tables/columns().comment` | `duckdb_constraints()` | `duckdb_views()` | 1 |
| Snowflake | `COMMENT` in `INFORMATION_SCHEMA` | `SHOW PRIMARY KEYS` / `SHOW IMPORTED KEYS` | `GET_DDL` / `VIEWS.VIEW_DEFINITION` | 1 |
| Postgres | `pg_description` | `information_schema.table_constraints` + `key_column_usage` | `pg_views` | 1 |
| SQLite | — | `pragma foreign_key_list`, `pragma table_info(pk)` | `sqlite_master.sql` | 1 |
| BigQuery | `description` | `INFORMATION_SCHEMA.TABLE_CONSTRAINTS` | `VIEWS.view_definition` | 3 |
| Databricks | `COMMENT` | Unity Catalog constraints | `SHOW CREATE TABLE` | 3 |

- A driver that cannot report a field leaves it undefined; nothing is guessed.
- Extraction obeys the selected scopes and has a row/table cap, the same
  bounded-query pattern as `buildWarehouseMetadataQueries`.
- **No row values are read** by the extractor. Sample values stay behind the
  existing value-probe policy and personal-data guards.

### 3. Storage, manifest and freshness

- **Manifest:**
  - `DQLManifest` gains an optional `warehouseProvenance`
    (`{ snapshotFingerprint, capturedAt, relations: Record<id, WarehouseRelationV1> }`),
    beside the existing `dbtProvenance`;
  - `dbtProvenance` is untouched;
  - both may be present (`hybrid`).
- **Catalog:**
  - warehouse relations are written into the existing metadata catalog as
    relation and column objects, with `source: 'warehouse'`, through the same
    snapshot/fingerprint path (`buildMetadataSnapshot`,
    `ensureMetadataCatalogFresh`);
  - retrieval, vocabulary building and the vector index read them unchanged,
    as they already read runtime-probed relations.
- **Freshness:**
  - the snapshot fingerprint is a hash of the extracted schema;
  - `dql sync warehouse` (CLI), "Sync schema" (Settings), or a scheduled refresh
    re-extracts;
  - a dropped column or table marks the entities and relationships that use
    it **stale**, exactly as dbt freshness does today (`dbt-freshness.ts`);
  - Ask treats stale certified relationships as it already does: not
    certified.

### 4. Modeling entities bound to relations

A modeling entity names exactly one of `dbt_model` or `relation`:

```yaml
entities:
  - id: policy
    relation: ACME.SALES.POLICY        # new; warehouse-first / hybrid only
    grain: POLICY_ID
    keys: [POLICY_ID]
  - id: customer
    dbt_model: model.acme.dim_customer # unchanged
```

- **Parser** (`dbt-first-modeling.ts`):
  - in `dbt-first` mode, behaviour and diagnostics are byte-for-byte unchanged:
    `relation:` is rejected with a clear message;
  - in `warehouse-first` and `hybrid` modes, an entity needs `id` and exactly
    one of `dbt_model` or `relation`;
  - keys and grain are validated against `warehouseProvenance` columns, as
    they are validated against dbt node columns today.
- **Types:**
  - `ManifestModelEntity` gains an optional `relationRef?: string` (the
    warehouse relation id);
  - `dbtUniqueId` stays required **in the type for dbt-first manifests**.
    For warehouse entities it holds the warehouse id under a reserved prefix
    (`warehouse.`), so every existing reader that keys by `dbtUniqueId` keeps
    working without edits.
- **Relation lookup:**
  - one helper, `entityRelation(entity, manifest)`, resolves the physical
    relation from `dbtProvenance` **or** `warehouseProvenance`;
  - `modelingRelationshipEdges` and the other readers that walk
    `dbtProvenance.nodes[entity.dbtUniqueId]` are switched to it;
  - for a dbt entity it returns exactly what the current code returns.
- **Certification rules are unchanged:** grain + keys + data validation, and
  a person certifies. The AI never certifies.

### 5. Automatic drafting: `dql model discover`

This drafts entities and relationships for review; it never certifies.

1. **Entities.**
   - One draft per selected table, with its grain and keys taken from the
     declared primary key when there is one.
   - Otherwise a single-column key candidate, checked for uniqueness with one
     bounded `COUNT(DISTINCT)` query.
   - Business name and description are drafted by the existing authoring AI
     from the table name, comments and columns.
2. **Relationship candidates, each tagged with its evidence.** The existing
   `RelationshipKeySuggestionSource` is extended with two new sources:
   - `declared_fk`: declared foreign keys (strongest);
   - `view_join`: equi-joins parsed from view definitions (the
     `joinKeyPairs` parser already used for AI-written SQL);
   - plus the existing `same_name` and `named_for_table` naming conventions.
   - *Phase 3:* `query_history`, joins observed in the warehouse's query
     history (Snowflake `ACCESS_HISTORY`, BigQuery `JOBS`), opt-in.
3. **Validation.**
   - Every candidate runs through `relationship-validation.ts` (cardinality,
     null keys, unmatched rows).
   - One that passes becomes `validated`; one that fails stays `draft`, with
     the evidence and the failure shown.
4. **Domains.** Tables are grouped into draft domains by schema and by
   connected components of validated relationships, and named by the
   authoring AI.

The output is ordinary modeling YAML in the project's Git repo, marked
`status: draft` / `validated`, reviewed on the Modeling page. Running
`discover` again is idempotent: it never overwrites a human edit or a
certification, and it only adds or updates drafts.

### 6. Semantic layer without MetricFlow

- Metrics can be defined in DQL's native semantic engine over warehouse-bound
  entities (the native composer already compiles over relations).
- Snowflake semantic views and LookML import keep working as semantic sources.
- MetricFlow remains the engine for dbt projects; nothing about its selection
  changes.

### 7. Ask and retrieval

No change to the Ask pipeline's logic. Ask reads the vocabulary, which now
also contains:
- warehouse relations, with their comments;
- entities bound to them;
- validated and certified relationships, as join hints and certified-join
  bindings, through `modelingRelationshipEdges`.

The certified → semantic → AI-written SQL order, the trust labels and every
check are unchanged.

### 8. User interface

- **Setup wizard (Home → "Set up your data")**:
  1. "Where does your data model live?" Three cards: *dbt project* ·
     **Database only** · *Both*.
  2. Connect: the existing connector cards.
  3. Choose schemas: a scope picker with table counts, built on
     `discoverWarehouseMetadataScopes`. Ask works from this step, at the
     lowest tier.
  4. Build the map: a progress bar while `discover` runs, then a summary
     ("142 tables · 38 declared relationships · 61 suggested, 55 validated").
  5. Review on the Modeling page: suggested entities and relationships with
     their evidence; certify, edit or dismiss.
- **Settings → Data sources:**
  - every source (dbt project, warehouse scopes, semantic views);
  - its last sync and drift warnings;
  - "Sync schema" and "Add schemas".
- **Existing dbt users see no change.** The wizard's dbt card leads to
  today's flow, and Settings shows the dbt source as it does now.
- **CLI:**
  - `dql init` (detects and prints the mode);
  - `dql sync warehouse`;
  - `dql model discover [--schema …]`;
  - `dql model sources add|list`.

## Backward compatibility

The design is additive. These guarantees are acceptance criteria, each
backed by a test:

1. **Existing projects are untouched.**
   - A project with no `modeling.mode`, or with `dbt-first`, parses, builds and
     answers exactly as before.
   - The manifest it produces is byte-identical, apart from
     `warehouseProvenance`, which is absent.
   - `dql init` never rewrites an existing `modeling` block.
2. **dbt-first parsing is unchanged.** Every existing test in
   `dbt-first-modeling.test.ts` and `dbt-first-authoring*.test.ts` passes
   unedited. `relation:` in a dbt-first project is a new diagnostic only.
3. **Readers of `dbtUniqueId` keep working.**
   - Warehouse entities fill it with a `warehouse.`-prefixed id.
   - Every existing reader either goes through `entityRelation()` or keeps its
     current dbt-only behaviour.
   - A test enumerates the readers (20 call sites read
     `dbtProvenance.nodes[...]` on 2026-09-18), so none is missed.
4. **Ask behaviour is unchanged for dbt projects.**
   - All golden suites (jaffle, NBA, office) replay with **no re-recording**.
   - This is the same gate that caught the effort-default regression on
     2026-09-18: prompt bytes, and therefore cassette keys, must not move.
   - The dql-agent lane gate (`scripts/test-lanes.mjs`) and the CLI suite pass.
5. **The existing warehouse-metadata scopes are unchanged.**
   - `dbt_relations`, `selected_scopes` and `dbt_plus_selected` keep their
     meaning.
   - The catalog extractor adds fields to what `syncWarehouseMetadata` stores;
     it does not change the existing ones.
6. **Connectors:**
   - new extraction queries are separate functions;
   - `listTables` and `listColumns` keep their signatures and results;
   - a driver without an extractor falls back to today's tables-and-columns
     behaviour.
7. **Config compatibility:**
   - the new keys are optional;
   - an older DQL reading a `warehouse-first` config fails at startup with a
     clear "requires DQL ≥ 1.18" message, never by silently ignoring the mode.
8. **Git:** discovery writes ordinary modeling YAML in the documented shape.
   Nothing under the dbt project is ever written.

## Test plan

- **Fixture:** a no-dbt insurance project, the same 29 tables with no dbt
  files, loaded into DuckDB with declared keys and comments added.
  - One lane checks parsing, `discover` output and validation.
  - One golden lane (recorded) checks Ask.
- **Compatibility lane:** every existing fixture (jaffle, jaffle-semantic, NBA,
  office, bigrepo, manifest-only) builds a manifest identical to the
  pre-change manifest (snapshot compare), and every golden replay passes
  unchanged.
- **Per driver:** extractor unit tests against captured
  `information_schema`/`pragma` results for DuckDB, Snowflake, Postgres and
  SQLite; a live DuckDB and SQLite test.
- **Benchmark (the product claim):** insurance **without dbt**, on the Claude
  subscription, under three conditions:

  | Condition | What it is | Answers |
  |---|---|---|
  | L0 | raw tables | the baseline |
  | L1-auto | `discover` output, no human edits | what DQL gives on day one |
  | L1 | human-reviewed | what review adds |

  Compared with the dbt version, then Spider 2.0-Lite (SQLite subset) on L0
  and L1-auto.

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| 1. Foundation | Modes and detection; `WarehouseCatalogSnapshotV1` and extractors for DuckDB, Snowflake, Postgres, SQLite; `warehouseProvenance`; `relation:` entities; `entityRelation()` in all readers; `dql sync warehouse`; fixture, compatibility lane and golden lane | ~1 week |
| 2. Drafting and UI | `dql model discover` (declared keys, naming, view joins, validation, draft domains); setup wizard; Modeling review of drafts; Settings → Data sources | ~1 week |
| 3. Depth | BigQuery and Databricks extractors; query-history evidence (opt-in); native metric authoring UI; drift notifications | ~1 week |

Each phase ships behind the new mode only, so it can merge without affecting
dbt users.

## Alternatives considered

- **Generate a dbt project from the warehouse** (one `select *` model per
  table). Rejected:
  - it adds a dbt installation and generated files to maintain;
  - it gives DQL no knowledge the catalog does not already have;
  - it hides that DQL works on a raw warehouse.
- **Warehouse relations only as Ask context, with no Modeling.** Rejected:
  it keeps non-dbt users at the lowest tier, which is the gap this RFC exists
  to close.

## Open questions

1. Should `hybrid` let a warehouse entity and a dbt entity bind to the same
   relation? The proposal is no: one binding per relation, and the dbt binding
   wins.
2. Snowflake informational constraints are often absent or stale. Should
   `declared_fk` from Snowflake be treated as a suggestion (validated like any
   other), rather than as strong evidence? The proposal is to always validate.
3. Query history is powerful but sensitive. Opt-in per connection, reading
   only which tables were joined on which columns, never query text? The
   proposal is yes.
