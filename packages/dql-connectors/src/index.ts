// @dql/connectors - DQL Database Connectors

export type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from './connector.js';
export {
  ConnectorQueryError,
  type QueryBatch,
  type QueryExecutionOptions,
  type QueryResult,
  type ColumnMeta,
  type ColumnType,
  type Row,
} from './result-types.js';
export { ConnectionPoolManager } from './connection-pool.js';
export { QueryExecutor } from './query-executor.js';
export { MissingConnectorDependencyError } from './optional-dependency.js';
export type { SQLParamSpec } from './sql-params.js';
export { buildParamValues, normalizeSQLPlaceholders } from './sql-params.js';
export { SnowflakeConnector } from './drivers/snowflake.js';
export { DuckDBConnector } from './drivers/duckdb.js';
export { FileConnector } from './drivers/file.js';
export { DatabricksConnector } from './drivers/databricks.js';
export { SQLiteConnector } from './drivers/sqlite.js';
export { PostgreSQLConnector } from './drivers/postgresql.js';
export { RedshiftConnector } from './drivers/redshift.js';
export { MySQLConnector } from './drivers/mysql.js';
export { MSSQLConnector } from './drivers/mssql.js';
export { FabricConnector } from './drivers/fabric.js';
export { TrinoConnector } from './drivers/trino.js';
export { ClickHouseConnector } from './drivers/clickhouse.js';
export { AthenaConnector } from './drivers/athena.js';
export { BigQueryConnector } from './drivers/bigquery.js';
