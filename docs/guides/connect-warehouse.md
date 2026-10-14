# Connect a Warehouse

> ~3 minutes · ends with `zlens doctor` confirming the configured connection

ZLens keeps the CLI install small. Databricks SQL is built in. DuckDB,
local files, and Snowflake are enabled by installing the project-local driver
from the notebook connection panel.

Connections live in `dql.config.json` at the project root. Keep secrets in
environment variables and reference them with `${ENV_VAR}` interpolation.

## 1. Pick your connector

Databricks example:

```json
{
  "connections": {
    "default": {
      "driver": "databricks",
      "host": "${DATABRICKS_HOST}",
      "httpPath": "/sql/1.0/warehouses/${DATABRICKS_WAREHOUSE_ID}",
      "catalog": "main",
      "schema": "analytics",
      "token": "${DATABRICKS_TOKEN}"
    }
  }
}
```

Snowflake example:

```json
{
  "connections": {
    "default": {
      "driver": "snowflake",
      "account": "${SNOWFLAKE_ACCOUNT}",
      "username": "${SNOWFLAKE_USER}",
      "authMethod": "key_pair",
      "privateKeyPath": "${SNOWFLAKE_PRIVATE_KEY_PATH}",
      "warehouse": "ANALYTICS_WH",
      "database": "PROD",
      "schema": "MARTS",
      "role": "ANALYST"
    }
  }
}
```

Per-driver options live in the [Connector reference](../reference/connectors.md).

## 2. Install optional drivers

Open the notebook connection panel and click **Install** for DuckDB or
Snowflake. The driver is installed into the project under `.dql/connectors/`.
Databricks does not need an extra package.

CLI equivalents:

```bash
npm install --prefix .dql/connectors duckdb          # DuckDB and local files
npm install --prefix .dql/connectors snowflake-sdk   # Snowflake
```

## 3. Export credentials

```bash
export DATABRICKS_HOST=adb-123456789.0.azuredatabricks.net
export DATABRICKS_WAREHOUSE_ID=9196548d010cf14d
export DATABRICKS_TOKEN=...
```

or:

```bash
export SNOWFLAKE_ACCOUNT=xy12345.us-east-1
export SNOWFLAKE_USER=svc_dql
export SNOWFLAKE_PRIVATE_KEY_PATH="$HOME/.ssh/snowflake_key.p8"
```

## 4. Verify

```bash
zlens doctor
```

If that passes, the notebook and CLI resolve table references against this
connection.

## 5. Apply a metadata scope

In **Settings → Database**, test the connection, then use **Metadata scope**:

- **Use exact dbt project relations** is the recommended default when a current
  dbt manifest is configured.
- **dbt relations plus selected schemas** adds only the databases/catalogs and
  schemas you name.
- **Selected databases/catalogs and schemas** is the explicit non-dbt mode.

After the connection test passes, **Find available databases & schemas** can
perform a bounded, setup-only discovery of the database objects visible to the
configured warehouse credentials. The list clearly distinguishes:

- schemas already represented by the current dbt manifest, which are included
  automatically and should not be selected again; and
- additional schemas outside the dbt project, which remain optional until you
  explicitly select and apply them.

Discovery only shows the available scope. It does not save a selection, extract
table or column metadata, or widen Ask access. Select an additional schema only
when reporting needs relations outside the configured dbt project.

Use one line per database or catalog:

```text
ANALYTICS_PROD: SALES, FINANCE
REFERENCE_DATA: SHARED
```

**Apply and synchronize** validates the observed target and builds the local
`.dql/cache/metadata.sqlite` generation. A failed, empty, or truncated refresh
does not replace the previous valid generation. Normal warm Ask and schema UI
reads use this local generation; ZLens does not enumerate every database in the
account.

## Multiple connections

```json
{
  "connections": {
    "default": { "driver": "databricks", "host": "${DATABRICKS_HOST}", "token": "${DATABRICKS_TOKEN}" },
    "prod": { "driver": "snowflake", "account": "${SNOWFLAKE_ACCOUNT}" },
    "local": { "driver": "duckdb", "filepath": "./warehouse.duckdb" }
  }
}
```

Reference a non-default connection from a cell:

```sql
-- @connection: prod
select count(*) from analytics.orders
```

Ask AI shows the active database connection beside the Thinking control. Pick a
named connection there when reporting runs outside the default dbt target. One
Ask run uses that same connection for metadata grounding, semantic compilation,
certified/generated execution, and bounded validation; ZLens does not silently
switch connections during a run.

If a cached Snowflake or Databricks session is terminated while the Notebook is
open, ZLens evicts that session and reconnects once for a single read-only
`SELECT`/`WITH` statement. Mutating SQL and multi-statement scripts are never
replayed automatically. A second connection failure remains visible and can be
retried explicitly after the connection is checked.

## Troubleshooting

- **`driver package is not installed`** — open the notebook connection panel
  and install the project-local driver for DuckDB or Snowflake.
- **`connection refused`** — firewall, VPN, wrong host, or wrong port. Run
  `zlens doctor` after checking the resolved environment variables.
- **`terminated connection`** — ZLens retries one read-only query with a fresh
  session. If it still fails, test the selected Ask/Notebook connection and
  check the warehouse session, VPN, and authentication lifetime.
- **`role does not have USAGE on schema`** — warehouse permissions. ZLens needs
  `USAGE` on the schema and `SELECT` on queried objects.
- **Snowflake key-pair auth** — set `authMethod` to `key_pair` and provide
  `privateKeyPath` or `privateKey`. The public key belongs on the Snowflake
  user, not in ZLens config.
- **Databricks HTTP path** — paste the dbt/JDBC path
  `/sql/1.0/warehouses/<id>` or the raw warehouse ID.
