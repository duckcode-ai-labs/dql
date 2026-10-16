import { describe, expect, it } from 'vitest';
import { connectionEnvironmentReferences } from './connection-env.js';

describe('connectionEnvironmentReferences', () => {
  it('lists the ${NAME} references a connection reads and whether each is set', () => {
    const connection = {
      driver: 'postgres',
      host: '${PG_HOST}',
      user: 'analyst',
      password: '${PG_PASSWORD}',
      sshTunnel: { privateKeyPath: '${HOME_KEY}/id_rsa' },
    };
    expect(connectionEnvironmentReferences(connection, { PG_HOST: 'db.internal', HOME_KEY: '' })).toEqual([
      { name: 'HOME_KEY', set: false },
      { name: 'PG_HOST', set: true },
      { name: 'PG_PASSWORD', set: false },
    ]);
  });

  it('skips secret-store references and literal values', () => {
    expect(connectionEnvironmentReferences({ driver: 'snowflake', password: '${secret:default.password}', account: 'acme' }, {})).toEqual([]);
    expect(connectionEnvironmentReferences(undefined, {})).toEqual([]);
  });
});
