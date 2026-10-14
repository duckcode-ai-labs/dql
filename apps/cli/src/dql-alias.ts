#!/usr/bin/env node
// `dql` is the old name of the `zlens` command. It stays as an alias until a future
// release removes it: one line on stderr (never stdout, so `--json` output and pipes
// stay clean), then exactly what `zlens` does.

export const DQL_ALIAS_NOTICE = 'dql is now called zlens; the dql command will be removed in a future release.';

process.stderr.write(`${DQL_ALIAS_NOTICE}\n`);
await import('./index.js');
