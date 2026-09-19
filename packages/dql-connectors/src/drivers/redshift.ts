import { PostgreSQLConnector } from './postgresql.js';
import type { DriverName } from '../connector.js';
import type { TlsMode } from './shared.js';

/**
 * Amazon Redshift speaks the PostgreSQL wire protocol: the same client, with
 * Redshift's port, TLS on by default, and its plain cursor syntax.
 */
export class RedshiftConnector extends PostgreSQLConnector {
  readonly driverName: DriverName = 'redshift';
  protected engine = 'Redshift';

  protected defaultPort(): number {
    return 5439;
  }

  protected defaultTls(): TlsMode | undefined {
    return 'require';
  }

  protected cursorKind(): string {
    return 'CURSOR';
  }
}
