# Connectors

DQL uses a flat install. The CLI installs quickly and does not bundle
every database driver. Configure connections in `dql.config.json` or through
the notebook connection panel.

## Active connectors

| Connector | Driver | Install model | Sign-in |
| --- | --- | --- | --- |
| Amazon Athena | `athena` | Project-local (`@aws-sdk/client-athena`) | AWS default credentials (SSO, environment, role), named profile, or access key |
| Amazon Redshift | `redshift` | Project-local (`pg`) | Password, or IAM (provisioned cluster or Serverless) |
| BigQuery | `bigquery` | Project-local (`@google-cloud/bigquery`) | Google sign-in (Application Default Credentials), service account key file or key JSON |
| ClickHouse | `clickhouse` | Built in (HTTP) | User and password; HTTPS for ClickHouse Cloud |
| Databricks SQL | `databricks` | Built in | Access token or OAuth bearer token |
| DuckDB | `duckdb` | Project-local (`duckdb`) | — |
| Local files | `file` | Project-local DuckDB | — |
| Microsoft Fabric | `fabric` | Project-local (`mssql`) | Microsoft Entra ID |
| MySQL / MariaDB | `mysql` | Project-local (`mysql2`) | User and password |
| PostgreSQL | `postgresql` | Project-local (`pg`) | Password, or RDS / Aurora IAM |
| Snowflake | `snowflake` | Project-local (`snowflake-sdk`) | Password, key pair, SSO, OAuth, PAT, MFA, workload identity |
| SQL Server / Azure SQL | `mssql` | Project-local (`mssql`) | SQL login, or Microsoft Entra ID (user, service principal, az login / managed identity) |
| SQLite | `sqlite` | Built in (read-only) | — |
| Trino / Starburst | `trino` | Built in (HTTP) | Password (HTTPS only) or JWT / OAuth token |

Every connector honours the same execution contract:

- the caller's deadline and cancel stop the statement on the server, not only in DQL;
- results are capped at the requested row and byte limits, and a cut is reported as `truncated`;
- calendar dates come back as the `YYYY-MM-DD` the warehouse holds, never shifted by the machine's time zone;
- exact integers and decimals come back as numbers;
- a failed sign-in never repeats the password.

## Project-local driver install

Open the notebook connection panel and use **Install connector**; saving a
connection also installs what it needs. DQL installs driver packages into:

```text
.dql/connectors/
```

CLI equivalents:

```bash
npm install --prefix .dql/connectors duckdb                  # DuckDB and local files
npm install --prefix .dql/connectors snowflake-sdk           # Snowflake
npm install --prefix .dql/connectors pg                      # PostgreSQL, Redshift
npm install --prefix .dql/connectors mysql2                  # MySQL, MariaDB
npm install --prefix .dql/connectors mssql                   # SQL Server, Azure SQL, Fabric
npm install --prefix .dql/connectors @google-cloud/bigquery  # BigQuery
npm install --prefix .dql/connectors @aws-sdk/client-athena  # Athena
```

The SSH client (`ssh2`) and the AWS IAM token packages
(`@aws-sdk/client-redshift`, `@aws-sdk/client-redshift-serverless`,
`@aws-sdk/rds-signer`) are installed the same way, only for a connection
that uses a tunnel or IAM sign-in.

This keeps the global CLI install small while still letting each project opt
into the database packages it actually uses.

## Credentials

Secrets typed on the Connections page never go into `dql.config.json`. They
are written to `.dql/local/private/connection-secrets.json` (git-ignored,
readable only by your user, mode 0600), and the config keeps a reference in
their place:

```json
{ "driver": "postgresql", "host": "db.example.com", "username": "reader", "password": "${secret:warehouse.password}" }
```

The Connections page never receives a saved secret back: it shows a mask, and
saving the mask keeps the stored value. A password already written literally
in an older config keeps working and moves to the private file the next time
the connection is saved from the page. `${ENV_VAR}` references keep working as
before and are the right choice for CI and servers.

Use a read-only database role for DQL. Ask only runs single read-only
statements, but the database is the place that enforces it.

## Encryption in transit

Network databases take `sslMode`, named as in libpq:

| `sslMode` | Meaning |
| --- | --- |
| `disable` | No TLS |
| `require` | Encrypted; the certificate is not checked |
| `verify-ca` | Encrypted; the certificate must chain to a trusted CA |
| `verify-full` | Encrypted; the CA and the host name are both checked |

`sslRootCert` names a PEM bundle (a file path, or the PEM text) for private
CAs such as the RDS, Azure or Cloud SQL bundles. Defaults: Redshift `require`;
SQL Server and Fabric `verify-full` (set `trustServerCertificate` only for a
self-signed server on a network you trust); PostgreSQL and MySQL follow the
driver's default unless you choose. Trino and ClickHouse use `"ssl": true`
for HTTPS; Trino only accepts a password over HTTPS.

## SSH tunnels

PostgreSQL, Redshift, MySQL and SQL Server can be reached through an SSH
bastion. DQL opens the tunnel when it connects and closes it when the
connection closes; TLS still checks the database's real host name.

```json
{
  "driver": "postgresql",
  "host": "10.0.3.17",
  "database": "analytics",
  "username": "reader",
  "password": "${secret:warehouse.password}",
  "sslMode": "verify-full",
  "sshTunnel": { "host": "bastion.example.com", "username": "ec2-user", "privateKeyPath": "~/.ssh/id_ed25519" }
}
```

## Common shape

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

Environment variables and `${secret:...}` references are resolved at
runtime, so secrets stay out of git.

## Databricks SQL

Use either a warehouse ID or the dbt/JDBC HTTP path. DQL extracts the warehouse
ID from paths like `/sql/1.0/warehouses/<id>`.

```json
{
  "driver": "databricks",
  "host": "adb-123456789.0.azuredatabricks.net",
  "httpPath": "/sql/1.0/warehouses/9196548d010cf14d",
  "catalog": "main",
  "schema": "marts",
  "authMethod": "oauth",
  "token": "${DATABRICKS_TOKEN}",
  "waitTimeout": "50s",
  "byteLimit": 25000000
}
```

For automation, prefer an enterprise-approved OAuth token or service principal
token rather than a personal token.

## DuckDB and local files

```json
{
  "driver": "duckdb",
  "filepath": "./warehouse.duckdb"
}
```

For CSV/Parquet/JSON exploration, use the `file` driver with DuckDB installed:

```json
{
  "driver": "file",
  "filepath": ":memory:"
}
```

Then query files from SQL:

```sql
select * from read_csv_auto('./data/orders.csv')
```

## SQLite

```json
{ "driver": "sqlite", "filepath": "./data/app.sqlite" }
```

The file is opened read-only; DQL never changes it.

## Snowflake

Password auth:

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "password",
  "password": "${SNOWFLAKE_PASSWORD}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "schema": "MARTS",
  "role": "ANALYST"
}
```

Key-pair auth:

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "key_pair",
  "privateKeyPath": "${SNOWFLAKE_PRIVATE_KEY_PATH}",
  "privateKeyPassphrase": "${SNOWFLAKE_PRIVATE_KEY_PASSPHRASE}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "schema": "MARTS",
  "role": "ANALYST"
}
```

Use either `privateKeyPath` or `privateKey`. The public key is configured on
the Snowflake user; DQL only needs the private key material or file path.

Enterprise auth fields are passed through to the Snowflake Node driver:

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "programmatic_access_token",
  "token": "${SNOWFLAKE_PAT}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "schema": "MARTS",
  "queryTag": "team=analytics;app=dql",
  "proxyHost": "${HTTPS_PROXY_HOST}",
  "proxyPort": 8080
}
```

Supported `authMethod` values include `password`, `mfa`, `key_pair`,
`external_browser`, `oauth`, `oauth_authorization_code`,
`oauth_client_credentials`, `programmatic_access_token`, and
`workload_identity`.

For dbt `profiles.yml`, DQL imports Snowflake `private_key_path`,
`private_key`, `private_key_passphrase`, `authenticator`, `token`, proxy
fields, OAuth fields, workload identity fields, and query tags where present.

## PostgreSQL

```json
{
  "driver": "postgresql",
  "host": "db.example.com",
  "port": 5432,
  "database": "analytics",
  "username": "dql_reader",
  "password": "${PG_PASSWORD}",
  "sslMode": "verify-full",
  "sslRootCert": "~/certs/rds-global-bundle.pem"
}
```

RDS and Aurora IAM sign-in: set `"authMethod": "aws_default"` (or
`aws_profile` with `profile`, or `aws_access_key`) and `region`; DQL mints a
fresh token for each new connection. Row caps are applied with a cursor
inside a read-only transaction, so the server stops after the rows the
caller can take.

## Amazon Redshift

```json
{
  "driver": "redshift",
  "host": "analytics.abc123.us-east-1.redshift.amazonaws.com",
  "database": "dev",
  "authMethod": "aws_profile",
  "profile": "analytics",
  "clusterId": "analytics",
  "username": "dql_reader"
}
```

IAM sign-in uses GetClusterCredentials for a provisioned cluster
(`clusterId` and `username`) or GetCredentials for Serverless (`workgroup`).
Password sign-in takes `username` and `password`. TLS is on by default.

## MySQL / MariaDB

```json
{ "driver": "mysql", "host": "db.example.com", "database": "shop", "username": "dql_reader", "password": "${MYSQL_PASSWORD}", "sslMode": "verify-full" }
```

In MySQL a database is the schema: tables are named `shop.orders`.

## SQL Server, Azure SQL and Microsoft Fabric

```json
{ "driver": "mssql", "host": "myserver.database.windows.net", "database": "sales", "authMethod": "azure_default" }
```

`authMethod`: `password` (SQL login with `username`/`password`),
`azure_password`, `azure_service_principal` (`oauthClientId`,
`oauthClientSecret`, `tenantId`), or `azure_default` (az login, managed
identity, environment variables). Fabric (`"driver": "fabric"`) always
encrypts and defaults to `azure_default`. Descriptions set as
`MS_Description` extended properties are read into the modeling catalog.

## BigQuery

```json
{ "driver": "bigquery", "projectId": "acme-analytics", "location": "US", "schema": "marts", "authMethod": "application_default", "byteLimit": 10000000000 }
```

`authMethod`: `application_default` (run `gcloud auth application-default
login`, or a workload identity), `service_account_key_file` (`keyFilename`),
or `service_account_json` (`serviceAccountJson`). `byteLimit` becomes the
job's maximum bytes billed: BigQuery refuses a query that would scan more
instead of billing it.

## Trino / Starburst

```json
{ "driver": "trino", "host": "trino.example.com", "port": 443, "ssl": true, "catalog": "hive", "schema": "analytics", "username": "dql", "password": "${TRINO_PASSWORD}" }
```

Use `"authMethod": "token"` with `token` for JWT or OAuth access tokens.
Tables are named with their catalog: `hive.analytics.orders`.

## ClickHouse

```json
{ "driver": "clickhouse", "host": "abc123.us-east-1.aws.clickhouse.cloud", "ssl": true, "database": "analytics", "username": "dql_reader", "password": "${CLICKHOUSE_PASSWORD}" }
```

Row caps and deadlines are ClickHouse server settings (`max_result_rows`,
`max_execution_time`); a cancelled query is killed by its query id.

## Amazon Athena

```json
{ "driver": "athena", "region": "us-east-1", "workgroup": "analytics", "database": "sales", "outputLocation": "s3://acme-athena-results/dql/", "authMethod": "aws_default" }
```

`outputLocation` is needed unless the workgroup enforces one. A cancelled or
timed-out query is stopped with StopQueryExecution, so it stops scanning (and
billing).
