import { mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DuckDBConnector } from './duckdb.js';
import { readEnv } from '../env.js';

const configuredDuckDbConnectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
// /proc/self/fd exists only on Linux; the driver is only loadable where the root is configured.
const linuxIt = process.platform === 'linux' && configuredDuckDbConnectorRoot ? it : it.skip;

const openFiles = (needle: string) =>
  readdirSync('/proc/self/fd').flatMap((fd) => {
    try { return [readlinkSync(join('/proc/self/fd', fd))]; } catch { return []; }
  }).filter((target) => target.includes(needle));

describe('DuckDB file handle after disconnect', () => {
  linuxIt('does not list the database file in /proc/self/fd', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-fd-'));
    const filepath = join(directory, 'copy.duckdb');
    const connector = new DuckDBConnector();
    try {
      await connector.connect({ driver: 'duckdb', filepath, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      await connector.execute('CREATE TABLE t (v INTEGER)');
      expect(openFiles('copy.duckdb').length).toBeGreaterThan(0);
      await connector.disconnect();
      // duckdb-node 1.1 frees the file at garbage collection; hosts call this after stopping a runtime.
      setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc') as () => void;
      for (let pass = 0; pass < 3; pass += 1) {
        gc();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(openFiles('copy.duckdb')).toEqual([]);
    } finally {
      await connector.disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
