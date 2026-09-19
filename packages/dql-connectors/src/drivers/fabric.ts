import { MSSQLConnector } from './mssql.js';
import type { ConnectionConfig, DriverName } from '../connector.js';

/**
 * A Microsoft Fabric warehouse or SQL endpoint: SQL Server's protocol, always
 * encrypted, signed in with Microsoft Entra ID unless told otherwise.
 */
export class FabricConnector extends MSSQLConnector {
  readonly driverName: DriverName = 'fabric';
  protected engine = 'Fabric';

  protected poolConfig(config: ConnectionConfig): Record<string, unknown> {
    return super.poolConfig({
      ...config,
      ssl: true,
      sslMode: config.sslMode === 'disable' ? 'require' : config.sslMode,
      authMethod: config.authMethod ?? 'azure_default',
    });
  }
}
