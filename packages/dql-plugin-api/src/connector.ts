/**
 * Warehouse connector contract.
 *
 * FROZEN at v1.0 — any breaking change requires a major version bump and a
 * 6-month deprecation window. See docs/architecture/plugin-api.md.
 */

export interface ColumnSchema {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface TableSchema {
  schema: string;
  name: string;
  columns: ColumnSchema[];
}

export interface QueryRow {
  [column: string]: unknown;
}

export interface QueryResult {
  columns: ColumnSchema[];
  rows: QueryRow[];
  rowCount: number;
  executionTimeMs?: number;
}

export interface QueryCursor extends AsyncIterable<QueryRow> {
  readonly columns: ColumnSchema[];
  close(): Promise<void>;
}

/** Per-driver configuration — opaque to the core. */
export type ConnectorConfig = Record<string, unknown>;

export interface ConnectorMetadata {
  id: string;              // unique driver id, e.g. "postgres"
  displayName: string;     // human name, e.g. "PostgreSQL"
  supports: {
    streaming: boolean;
    introspection: boolean;
    transactions: boolean;
  };
}

/**
 * Implement this interface and register the module in cdql.yaml under
 * `plugins.connectors`. ZLens will instantiate, connect, and close the
 * connector; plugin authors do not need to manage lifecycle.
 */
export interface Connector {
  readonly metadata: ConnectorMetadata;

  /** Open a connection. Called once per session. */
  connect(config: ConnectorConfig): Promise<void>;

  /** Close the connection. Must be idempotent. */
  close(): Promise<void>;

  /** Execute a query to completion and return the full result. */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;

  /**
   * Optional: execute a query as a streaming cursor. Required when
   * `metadata.supports.streaming` is true.
   */
  stream?(sql: string, params?: unknown[]): Promise<QueryCursor>;

  /**
   * Optional: list tables with columns. Required when
   * `metadata.supports.introspection` is true.
   */
  introspect?(): Promise<TableSchema[]>;

  /** Optional: sanity-check the connection is live. */
  ping?(): Promise<void>;
}
