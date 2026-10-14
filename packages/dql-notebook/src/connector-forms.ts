import type { ConnectionConfig } from '@zlens/connectors';

export interface ConnectorFieldSchema {
  key: keyof ConnectionConfig | 'name';
  label: string;
  type: 'text' | 'number' | 'password' | 'checkbox' | 'select' | 'textarea';
  placeholder?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  helpText?: string;
}

export interface ConnectorFormSchema {
  driver: ConnectionConfig['driver'];
  label: string;
  category: 'local' | 'warehouse' | 'lakehouse';
  description: string;
  fields: ConnectorFieldSchema[];
}

const schemas: ConnectorFormSchema[] = [
  {
    driver: 'duckdb',
    label: 'DuckDB',
    category: 'local',
    description: 'Connect directly to a local DuckDB database file.',
    fields: [
      { key: 'filepath', label: 'DuckDB file path', type: 'text', placeholder: './local/dev.duckdb', required: true },
    ],
  },
  {
    driver: 'snowflake',
    label: 'Snowflake',
    category: 'warehouse',
    description: 'Snowflake account, warehouse, database, and role.',
    fields: [
      { key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'warehouse', label: 'Warehouse', type: 'text', required: true },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'schema', label: 'Schema', type: 'text', required: true },
      { key: 'username', label: 'Username', type: 'text', required: true },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'password', label: 'Password' },
          { value: 'mfa', label: 'Password + MFA' },
          { value: 'key_pair', label: 'Key pair / private key' },
          { value: 'external_browser', label: 'SSO / external browser' },
          { value: 'oauth', label: 'OAuth token' },
          { value: 'oauth_authorization_code', label: 'OAuth authorization code' },
          { value: 'oauth_client_credentials', label: 'OAuth client credentials' },
          { value: 'programmatic_access_token', label: 'Programmatic access token' },
          { value: 'workload_identity', label: 'Workload identity' },
        ],
      },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'token', label: 'Token', type: 'password', helpText: 'OAuth, programmatic access token, or OIDC workload identity token.' },
      { key: 'privateKeyPath', label: 'Private key file path', type: 'text', placeholder: '~/.ssh/snowflake_key.p8' },
      { key: 'privateKey', label: 'Private key PEM', type: 'textarea', helpText: 'Paste PEM only when a key file cannot be referenced.' },
      { key: 'privateKeyPassphrase', label: 'Private key passphrase', type: 'password' },
      { key: 'authenticator', label: 'Authenticator override', type: 'text', placeholder: 'EXTERNALBROWSER, OAUTH, WORKLOAD_IDENTITY, or Okta URL' },
      { key: 'role', label: 'Role', type: 'text' },
      { key: 'accessUrl', label: 'Access URL', type: 'text' },
      { key: 'application', label: 'Application name', type: 'text', placeholder: 'DQL' },
      { key: 'queryTag', label: 'Query tag', type: 'text', placeholder: 'team=analytics;app=dql' },
      { key: 'passcode', label: 'MFA passcode', type: 'password' },
      { key: 'passcodeInPassword', label: 'MFA passcode is appended to password', type: 'checkbox' },
      { key: 'clientRequestMFAToken', label: 'Reuse cached MFA token', type: 'checkbox' },
      { key: 'clientStoreTemporaryCredential', label: 'Cache SSO token locally', type: 'checkbox' },
      { key: 'clientSessionKeepAlive', label: 'Keep session alive', type: 'checkbox' },
      { key: 'clientSessionKeepAliveHeartbeatFrequency', label: 'Keep-alive heartbeat seconds', type: 'number', placeholder: '3600' },
      { key: 'credentialCacheDir', label: 'Credential cache directory', type: 'text' },
      { key: 'browserActionTimeout', label: 'Browser SSO timeout ms', type: 'number', placeholder: '120000' },
      { key: 'keepAlive', label: 'Socket keep-alive', type: 'checkbox' },
      { key: 'timeout', label: 'Connection timeout ms', type: 'number', placeholder: '60000' },
      { key: 'proxyHost', label: 'Proxy host', type: 'text' },
      { key: 'proxyPort', label: 'Proxy port', type: 'number' },
      { key: 'proxyProtocol', label: 'Proxy protocol', type: 'text', placeholder: 'https' },
      { key: 'proxyUser', label: 'Proxy user', type: 'text' },
      { key: 'proxyPassword', label: 'Proxy password', type: 'password' },
      { key: 'noProxy', label: 'No proxy hosts', type: 'text', placeholder: '*.amazonaws.com|*.internal' },
      { key: 'oauthClientId', label: 'OAuth client ID', type: 'text' },
      { key: 'oauthClientSecret', label: 'OAuth client secret', type: 'password' },
      { key: 'oauthAuthorizationUrl', label: 'OAuth authorization URL', type: 'text' },
      { key: 'oauthTokenRequestUrl', label: 'OAuth token request URL', type: 'text' },
      { key: 'oauthScope', label: 'OAuth scope', type: 'text' },
      { key: 'oauthRedirectUri', label: 'OAuth redirect URI', type: 'text' },
      { key: 'workloadIdentityProvider', label: 'Workload identity provider', type: 'text', placeholder: 'AWS, AZURE, GCP, or OIDC' },
      { key: 'workloadIdentityAzureClientId', label: 'Azure client ID', type: 'text' },
    ],
  },
  {
    driver: 'databricks',
    label: 'Databricks SQL',
    category: 'lakehouse',
    description: 'Databricks workspace, SQL warehouse, and bearer token.',
    fields: [
      { key: 'host', label: 'Workspace URL', type: 'text', required: true, placeholder: 'https://adb-123.cloud.databricks.com' },
      { key: 'database', label: 'Catalog / database', type: 'text' },
      { key: 'schema', label: 'Schema', type: 'text' },
      { key: 'warehouse', label: 'Warehouse ID', type: 'text', helpText: 'Use the SQL warehouse ID when you have it.' },
      { key: 'httpPath', label: 'SQL warehouse ID or path', type: 'text', placeholder: '/sql/1.0/warehouses/abc123', helpText: 'Paste the warehouse ID or its JDBC/HTTP path.' },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'token', label: 'Access token' },
          { value: 'oauth', label: 'OAuth bearer token' },
        ],
      },
      { key: 'token', label: 'Bearer token', type: 'password', required: true, helpText: 'Use an OAuth token for automation when possible, or a service-principal PAT.' },
      { key: 'waitTimeout', label: 'Statement wait timeout', type: 'text', placeholder: '50s' },
      { key: 'byteLimit', label: 'Inline byte limit', type: 'number', placeholder: '25000000' },
    ],
  },
];

export function getConnectorFormSchemas(): ConnectorFormSchema[] {
  return schemas;
}
