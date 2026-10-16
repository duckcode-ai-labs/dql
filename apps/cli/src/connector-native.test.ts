import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectorBindingError, repairConnectorBinding, seedConnectorAllowScripts } from './connector-native.js';

const temp: string[] = [];
afterEach(() => {
  while (temp.length) rmSync(temp.pop()!, { recursive: true, force: true });
});

function connectorsDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zlens-connectors-')));
  temp.push(dir);
  return join(dir, '.dql', 'connectors');
}

const BLOCKED = "throw new Error(\"Cannot find module '/x/node_modules/duckdb/lib/binding/duckdb.node'\");";

function writeDuckdb(root: string, body: string): void {
  const dir = join(root, 'node_modules', 'duckdb');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'duckdb', version: '1.4.4', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), body);
}

function readPkg(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as Record<string, unknown>;
}

describe('seedConnectorAllowScripts', () => {
  it('creates .dql/connectors/package.json allowing duckdb, name only', () => {
    const root = connectorsDir();
    expect(seedConnectorAllowScripts(root, ['duckdb'])).toBe(true);
    expect(readPkg(root)).toEqual({ private: true, description: 'Project-local ZLens connector packages', allowScripts: { duckdb: true } });
  });

  it('merges into an existing file and leaves non-native packages out', () => {
    const root = connectorsDir();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { pg: '^8.13.0' } }));
    expect(seedConnectorAllowScripts(root, ['pg', 'ssh2', 'duckdb'])).toBe(true);
    expect(readPkg(root)).toEqual({ dependencies: { pg: '^8.13.0' }, allowScripts: { duckdb: true } });
    expect(seedConnectorAllowScripts(root, ['duckdb'])).toBe(false);
  });

  it('keeps an explicit denial or a pinned approval someone wrote', () => {
    const root = connectorsDir();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ allowScripts: { duckdb: false } }));
    expect(seedConnectorAllowScripts(root, ['duckdb'])).toBe(false);
    expect(readPkg(root).allowScripts).toEqual({ duckdb: false });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ allowScripts: { 'duckdb@1.4.4': true } }));
    expect(seedConnectorAllowScripts(root, ['duckdb'])).toBe(false);
  });
});

describe('repairConnectorBinding', () => {
  it('allows the script and rebuilds a duckdb npm 12 installed without its binary', () => {
    const root = connectorsDir();
    writeDuckdb(root, BLOCKED);
    expect(connectorBindingError([root], 'duckdb')?.packageDir).toBe(join(root, 'node_modules', 'duckdb'));

    const runNpm = vi.fn((args: string[]) => {
      // What `npm rebuild` does once the script may run: the binary appears.
      expect(readPkg(root).allowScripts).toEqual({ duckdb: true });
      expect(args).toEqual(['rebuild', '--prefix', root, 'duckdb']);
      writeDuckdb(root, 'module.exports = { Database: function Database() {} };');
    });
    expect(repairConnectorBinding(root, 'duckdb', runNpm)).toBe(true);
    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(connectorBindingError([root], 'duckdb')).toBeNull();
  });

  it('does nothing for a driver that loads, or one without a native binary', () => {
    const root = connectorsDir();
    writeDuckdb(root, 'module.exports = {};');
    const runNpm = vi.fn();
    expect(repairConnectorBinding(root, 'duckdb', runNpm)).toBe(true);
    expect(repairConnectorBinding(root, 'pg', runNpm)).toBe(false);
    expect(runNpm).not.toHaveBeenCalled();
  });
});
