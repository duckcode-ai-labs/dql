# No dbt? Start from your database

ZLens does not need dbt. Point it at your database and choose the schemas to
model. ZLens reads their tables, columns, comments, declared keys and view
SQL. It reads metadata only, never rows. From that it drafts entities and
joins and checks them on the data. You then certify the ones Ask may rely on.
Answers carry the same trust labels as in a dbt project.

This page uses a DuckDB file as the example. The steps are the same for
PostgreSQL, Snowflake and the [other supported databases](#which-databases-work);
only the connection differs.

<!-- TODO(jaffle-shop-warehouse): link the sample repo once duckcode-ai/jaffle-shop-warehouse is public -->

!!! note "A database-only sample is on its way"
    A ready-made sample with the Jaffle Shop data and no dbt files is being
    published. Until then, use your own database, or the `jaffle_shop.duckdb`
    file from the [Quickstart](index.md) sample. The examples below use that
    file, whose tables are in the `dev` schema.

You end with:

- a ZLens project that models your database directly (`warehouse-first`)
- draft entities and joins, checked on the data
- a certified join that Ask uses automatically

## Before you start

You need:

- Node.js 20 or newer (`node -v`)
- a database ZLens can read, and a login that can see the schemas you want
  to model and `SELECT` from their tables

No dbt, Python or hosted account is needed.

## 1. Install ZLens

```bash
npm i -g @zlens/cli
zlens --version
```

To install the CLI into a project instead of globally, see
[Install](install.md).

## 2. Create a warehouse-first project

```bash
mkdir my-analytics
cd my-analytics
cp /path/to/jaffle_shop.duckdb .
zlens init --warehouse-first
```

The `cp` line is only for DuckDB: the database file sits in the project
folder. `zlens init --warehouse-first` prints what it found:

```text
  Detected:
    dbt project: no
    DuckDB file: jaffle_shop.duckdb
    Modeling: manifest v3, warehouse-first (entities bind to warehouse tables; no dbt needed)
```

It writes `dql.config.json` with:

```json
"manifestVersion": 3,
"modeling": { "mode": "warehouse-first" }
```

When it finds a DuckDB file in the folder, it also adds a `default` connection
to it. Otherwise the project has no connection yet; you add one in the next
step.

Plain `zlens init`, without the flag, does not switch modes on its own. If
you started that way, open **Modeling** in the workbench and click
**Model my warehouse without dbt**.

<!-- TODO(lead): confirm against feat/create-zlens-app-warehouse -->
You can also create the project with `create-zlens-app`, which adds npm
scripts and installs the CLI into the project:
`npx create-zlens-app my-app --warehouse duckdb` creates a database-only
project, and `npx create-zlens-app my-app --dbt <path>` one that reads the
dbt project at `<path>`.

## 3. Connect your database

For DuckDB, install the driver into the project:

```bash
npm install --prefix .dql/connectors duckdb
```

For any other database, open **Settings → Database** in the workbench, pick
it under **Warehouse**, fill in the fields and click **Save connection**.
ZLens tests the connection before saving it. See
[Connect a database](connect-database.md).

You can also write the connection in `dql.config.json`. A PostgreSQL
connection:

```json
"defaultConnectionName": "warehouse",
"connections": {
  "warehouse": {
    "driver": "postgresql",
    "host": "db.example.com",
    "port": 5432,
    "database": "analytics",
    "username": "zlens_reader",
    "password": "${PG_PASSWORD}"
  }
}
```

A Snowflake connection:

```json
"defaultConnectionName": "warehouse",
"connections": {
  "warehouse": {
    "driver": "snowflake",
    "account": "xy12345.us-east-1",
    "username": "${SNOWFLAKE_USER}",
    "authMethod": "password",
    "password": "${SNOWFLAKE_PASSWORD}",
    "warehouse": "ANALYTICS_WH",
    "database": "PROD",
    "role": "ANALYST"
  }
}
```

They need the `pg` and `snowflake-sdk` drivers. The
[Connectors reference](../reference/connectors.md) lists every driver's
fields, sign-in methods and install command.

## 4. Choose schemas and sync

```bash
zlens sync warehouse --schemas dev
```

```text
  Schemas: jaffle_shop: dev
  ✓ Schema metadata for Ask: 13 relation(s).
  ✓ Warehouse catalog: 13 relation(s) → .dql/warehouse-catalog.json
```

ZLens read the tables, views, columns, comments, declared keys and view SQL
of the `dev` schema. It wrote them to `.dql/warehouse-catalog.json`, which
Modeling works from, and to the local index Ask searches.

- `--schemas` saves your selection in `dql.config.json` under
  `metadataScopes`. Later, `zlens sync warehouse` with no flags syncs the
  saved selection again and lists what changed since the last sync.
- Name several schemas with commas: `--schemas sales,finance`.
- `--database <name>` reads another database or catalog than the
  connection's default. `--connection <name>` uses another connection.
- A DuckDB file's default schema is usually `main`. If the sync says it
  **returned no authorized relations**, the schema name is wrong or your
  login cannot see it.

In the workbench, the same step is **Settings → Database → Metadata scope**.
In a warehouse-first project it says **Choose the schemas to model**. Click
**Find available databases & schemas**, list them one line per database
(`DATABASE: SCHEMA, SCHEMA`) and click **Apply and synchronize**. The status
line then reads **Modeling catalog · 13 tables and views with their keys and
comments**.

## 5. Draft your models

```bash
zlens model discover --validate
```

ZLens drafts one entity per table and the joins between them. It uses
declared primary and foreign keys, view SQL and naming conventions such as
`customer_id`, and cites the evidence for each join. `--validate` checks each
join and each candidate key on the data, with aggregate-only queries, and
proposes the cardinality it saw:

```text
ZLens warehouse discovery (draft only, checked on the warehouse)
  catalog 681422b6800e · 13 relations · 13 new entities · 23 new relationships
Entities
  dev.order ← jaffle_shop.dev.orders · grain order_id (unique on the warehouse)
Relationships
  order_item → order on order_id = order_id · many_to_one · warehouse: passed
      because both models have order_id
```

Joins through a view that itself joins or aggregates are not checked
automatically; a person validates those.

Nothing is written yet. Add the drafts to the project:

```bash
zlens model apply-discovery --apply --validate
```

```text
ZLens warehouse discovery apply
  37 draft change(s) written:
    domains/dev/domain.dql
    domains/dev/modeling/model.dql.yaml
  Everything is a draft. Review and certify on the Modeling page.
```

- Drafts go into a domain named after the schema (`dev` here).
  `--domain <name>` puts every entity into one domain you name.
- `--query-history` also counts the joins in recent queries your login can
  see, on Snowflake, PostgreSQL (`pg_stat_statements`), Databricks and
  BigQuery. Query text is read in memory and dropped; only which columns were
  joined, and how often, is kept.

In the workbench, **Modeling → Draft from warehouse** runs the same
discovery and opens the drafts as a proposal you review before anything is
saved. Tick **Use query history** first to include query history.

## 6. Review and certify

```bash
zlens notebook
```

Open **Modeling**. The map shows the drafted entities and joins. Click a
join, then **Edit relationship**. Under **What Ask may do with it**, pick one:

| Level | Ask's behaviour |
|---|---|
| **Draft** | Ask sees it as a hint only. |
| **Validated** | Checked safe to join. Ask prefers it when it writes SQL. |
| **Certified** | Ask must join these models on exactly these keys. |

Choose **Certified**, click **Review change**, check the proposal and click
**Save**. From the terminal you can confirm it:

```bash
zlens model explain dev::relationship::order_item_to_order
```

```text
dev::relationship::order_item_to_order: dev::entity::order_item → dev::entity::order
  many_to_one; fanout=safe; status=certified
  automatic join allowed
```

The model lives in `domains/`, so commit it and review changes in git like
any other code.

## 7. Ask your first question

Ask needs an AI model: [set up an AI provider](ai-provider.md). Then open
**Ask** and type a question, such as *Which customers spent the most?*

Ask works from the synced schema and the joins you modeled. It labels the
answer with what it used, as it does in a dbt project. SQL that AI wrote is
labelled for review and saved as a draft block; certify that block, and Ask can
answer the question from it as **Certified**. Metrics you add with
**Modeling → New metric** give **Governed** answers. See
[Ask a question](../ask/index.md).

## Or use Guided Setup

<!-- TODO(lead): confirm against feat/setup-where-does-your-model-live once it merges -->

The first time you run `zlens notebook`, **Guided Setup** opens. Its first
step asks **Where does your data model live?**:

- **dbt project**: ZLens reads your dbt project. See
  [Add ZLens to your dbt project](your-dbt-project.md).
- **Database only**: the path on this page.
- **Both**: a dbt project plus schemas dbt does not cover (a `hybrid`
  project).
- **Open an existing ZLens project**: for a folder that already has a
  `dql.config.json`, such as a teammate's repository. Setup reads its
  modeling mode, asks only for credentials or environment variables and the
  connection test, runs the sync, and skips the modeling questions.

With **Database only**, Setup walks through the steps above:

1. Connect your database and test it.
2. Choose the schemas to model.
3. Click **Apply and synchronize**.
4. Click **Draft my models**. It runs the same discovery as
   `zlens model discover --validate`.
5. Review and certify the drafts in **Modeling**.
6. Ask a question.

## Which databases work

Every database in **Settings → Database** can be synced. How much the sync
reads depends on the database:

| Database | Sync reads |
|---|---|
| DuckDB, SQLite, PostgreSQL, Amazon Redshift, MySQL / MariaDB, SQL Server / Azure SQL, Microsoft Fabric, Snowflake, Databricks (Unity Catalog), BigQuery | tables, views, columns, comments and declared primary and foreign keys |
| Trino / Starburst, Amazon Athena | tables, views, columns and comments; they declare no keys, so joins come from naming, view SQL and `--validate` |
| ClickHouse | tables, columns and comments; no declared keys |
| Any other | tables, views and columns from `information_schema` |

Columns are always read. Comments, keys and view SQL are read when the
database and your login expose them. A sync that cannot read one still
finishes, and names what it skipped. Databricks and BigQuery extraction is
tested against their `information_schema` output but has not yet been run
against a live account.

## Add dbt later

A warehouse-first project can take on a dbt project at any time. Apply it in
**Settings → Project & dbt**, and the project becomes `hybrid`: dbt models
and the warehouse tables you modeled work side by side, and the entities you
bound to warehouse tables keep working. See
[Modeling and Domain Packages](../datalex-and-dql.md#hybrid-dbt-plus-schemas-dbt-does-not-cover).

## Next

- [Connect a database](connect-database.md): sign-in options and the metadata
  scope.
- [Modeling and Domain Packages](../datalex-and-dql.md): how the three
  modeling modes work.
- [Save a query as a block](../blocks/index.md) and certify it.
- [CLI reference](../reference/cli.md).
