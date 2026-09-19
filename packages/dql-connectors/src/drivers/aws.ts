import type { ConnectionConfig } from '../connector.js';
import { loadDependency } from './shared.js';

export type AwsAuth = 'aws_default' | 'aws_profile' | 'aws_access_key';

export function isAwsAuth(method: ConnectionConfig['authMethod']): method is AwsAuth {
  return method === 'aws_default' || method === 'aws_profile' || method === 'aws_access_key';
}

/**
 * AWS SDK client settings for a connection: the default credential chain
 * (environment, SSO, instance or task role), a named profile from
 * `~/.aws/config`, or an access key pair.
 */
export function awsClientConfig(config: ConnectionConfig, method: AwsAuth): Record<string, unknown> {
  const out: Record<string, unknown> = { region: config.region ?? regionFromHost(config.host) ?? 'us-east-1' };
  if (method === 'aws_access_key') {
    if (!config.accessKeyId || !config.secretAccessKey) throw new Error('AWS access-key sign-in needs an access key id and a secret access key.');
    out.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    };
  } else if (method === 'aws_profile') {
    if (!config.profile) throw new Error('AWS profile sign-in needs a profile name from ~/.aws/config.');
    out.profile = config.profile;
  }
  return out;
}

/** `x.abc.us-east-2.redshift.amazonaws.com` → `us-east-2`. */
export function regionFromHost(host: string | undefined): string | undefined {
  return host?.match(/\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.(?:redshift|redshift-serverless|rds)\.amazonaws\.com/)?.[1];
}

export interface IamSignIn {
  user: string;
  /** A fresh short-lived password for each new connection. */
  password: () => Promise<string>;
}

/**
 * Temporary database credentials from AWS IAM, fetched per connection so an
 * expired token is never reused:
 * - Redshift provisioned (`clusterId`): GetClusterCredentials for `username`.
 * - Redshift Serverless (`workgroup`): GetCredentials for the caller's identity.
 * - RDS / Aurora PostgreSQL: an RDS auth token for `username`.
 */
export async function iamSignIn(config: ConnectionConfig, engine: 'postgresql' | 'redshift'): Promise<IamSignIn> {
  const method = config.authMethod as AwsAuth;
  const client = awsClientConfig(config, method);
  if (engine === 'redshift' && config.workgroup) {
    const sdk = await loadDependency<any>('@aws-sdk/client-redshift-serverless', config);
    const redshift = new sdk.RedshiftServerlessClient(client);
    const fetch = async () => redshift.send(new sdk.GetCredentialsCommand({ workgroupName: config.workgroup, dbName: config.database }));
    const first = await fetch();
    let pending: { dbUser?: string; dbPassword?: string } | undefined = first;
    return {
      user: String(first.dbUser ?? ''),
      password: async () => {
        const credentials = pending ?? await fetch();
        pending = undefined;
        return String(credentials.dbPassword ?? '');
      },
    };
  }
  if (engine === 'redshift') {
    if (!config.clusterId) throw new Error('Redshift IAM sign-in needs the cluster identifier (or a Serverless workgroup).');
    if (!config.username) throw new Error('Redshift IAM sign-in needs the database user name.');
    const sdk = await loadDependency<any>('@aws-sdk/client-redshift', config);
    const redshift = new sdk.RedshiftClient(client);
    const fetch = async () => redshift.send(new sdk.GetClusterCredentialsCommand({
      ClusterIdentifier: config.clusterId,
      DbUser: config.username,
      DbName: config.database,
      AutoCreate: false,
      DurationSeconds: 900,
    }));
    const first = await fetch();
    let pending: { DbUser?: string; DbPassword?: string } | undefined = first;
    return {
      user: String(first.DbUser ?? `IAM:${config.username}`),
      password: async () => {
        const credentials = pending ?? await fetch();
        pending = undefined;
        return String(credentials.DbPassword ?? '');
      },
    };
  }
  if (!config.username) throw new Error('RDS IAM sign-in needs the database user name.');
  const signer = await loadDependency<any>('@aws-sdk/rds-signer', config);
  const Signer = signer.Signer ?? signer;
  const rds = new Signer({ ...client, hostname: config.host, port: config.port ?? 5432, username: config.username });
  return { user: config.username, password: async () => rds.getAuthToken() };
}
