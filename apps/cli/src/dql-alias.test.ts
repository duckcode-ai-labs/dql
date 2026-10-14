import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The `dql` bin is the old name of `zlens`: the same command, plus one notice
// on stderr. Runs the built entry points, as npm links them.
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function run(entry: string, args: string[]) {
  const path = join(dist, entry);
  if (!existsSync(path)) throw new Error(`${path} is missing: build the CLI first (pnpm build).`);
  return spawnSync(process.execPath, [path, ...args], { encoding: 'utf-8', env: { ...process.env, ZLENS_DISABLE_VERSION_CHECK: '1' } });
}

describe('dql alias', () => {
  it('prints the rename notice on stderr only and otherwise behaves like zlens', () => {
    const zlens = run('index.js', ['--version']);
    const dql = run('dql-alias.js', ['--version']);
    expect(zlens.status).toBe(0);
    expect(dql.status).toBe(0);
    expect(zlens.stdout).toMatch(/^zlens \d+\.\d+\.\d+/);
    expect(dql.stdout).toBe(zlens.stdout);
    expect(zlens.stderr).toBe('');
    expect(dql.stderr).toBe('dql is now called zlens; the dql command will be removed in a future release.\n');
  });

  it('keeps help text and exit codes identical', () => {
    const zlens = run('index.js', ['--help']);
    const dql = run('dql-alias.js', ['--help']);
    expect(dql.stdout).toBe(zlens.stdout);
    expect(zlens.stdout).toContain('zlens — ZLens CLI');

    const unknownZlens = run('index.js', ['no-such-command']);
    const unknownDql = run('dql-alias.js', ['no-such-command']);
    expect(unknownZlens.status).toBe(1);
    expect(unknownDql.status).toBe(1);
    expect(unknownDql.stdout).toBe(unknownZlens.stdout);
  });
});
