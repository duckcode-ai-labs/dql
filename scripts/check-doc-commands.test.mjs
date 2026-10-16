import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function check(markdown) {
  const dir = mkdtempSync(join(tmpdir(), 'zlens-doc-commands-'));
  try {
    writeFileSync(join(dir, 'page.md'), markdown);
    const run = spawnSync(process.execPath, ['scripts/check-doc-commands.mjs', dir], { encoding: 'utf-8' });
    return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real commands, subcommands and flags pass', () => {
  const result = check([
    '```bash',
    'npx create-zlens-app@latest dql --template starter',
    'npm run notebook',
    'npm exec -- zlens connect claude-code --format json',
    'zlens certify --from-draft blocks/_drafts/a.dql --owner me@example.com',
    'zlens agent trace export <trace-id> --out ./b --profile strict',
    'which -a zlens   # prose, not a zlens command',
    '```',
    'Inline: `zlens lineage cross-domain` and `zlens sync dbt --watch`.',
  ].join('\n'));
  assert.equal(result.ok, true, result.output);
});

test('flags a command that does not exist', () => {
  const result = check('```bash\nzlens promote-to-block notebooks/a.dqlnb\n```\n');
  assert.equal(result.ok, false);
  assert.match(result.output, /"zlens promote-to-block" is not a CLI command/);
});

test('flags a flag the command does not read', () => {
  const result = check('```bash\nzlens connect claude-code --dry-run\n```\n');
  assert.equal(result.ok, false);
  assert.match(result.output, /"zlens connect" does not read --dry-run/);
});

test('flags an unknown subcommand', () => {
  const result = check('Run `zlens connect vscode`.\n');
  assert.equal(result.ok, false);
  assert.match(result.output, /"zlens connect vscode" is not a known subcommand/);
});

test('flags an unknown starter script and scaffolder flag', () => {
  const result = check('```bash\nnpm run deploy\nnpx create-zlens-app my-app --typescript\n```\n');
  assert.equal(result.ok, false);
  assert.match(result.output, /no "npm run deploy" script/);
  assert.match(result.output, /create-zlens-app has no --typescript flag/);
});

test('ignores non-shell code blocks', () => {
  const result = check('```text\nzlens 0.1.0\n```\n');
  assert.equal(result.ok, true, result.output);
});
