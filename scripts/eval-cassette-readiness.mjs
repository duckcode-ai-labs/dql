#!/usr/bin/env node
/**
 * Decide whether a provider-cassette directory can back a runtime-driven eval.
 *
 * The answerability gate replays recorded provider responses and never calls a
 * live model. Until somebody records the suite against a real provider (which
 * needs provider credentials), the committed directory holds only legacy and
 * synthetic orchestration fixtures. Every current prompt then misses, and the
 * gate fails on every pull request for a reason that says nothing about the
 * change under review.
 *
 * "Ready" therefore means: at least one entry was recorded from a real provider
 * (`provenance.kind === 'recorded_provider'`, written in record mode). Entries are
 * loaded the way `CassetteStore` loads them (`apps/cli/src/commands/agent-eval-
 * cassette.ts`): `*.json` files with a `key`, unreadable files skipped, one
 * entry per key. The classification matches `cassetteEvidenceSummary`.
 *
 * Usage: node scripts/eval-cassette-readiness.mjs <cassette-dir>
 * Prints a JSON summary and exits 0 whether or not the directory is ready; the
 * workflow decides what to do with the answer.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function cassetteReadiness(dir) {
  const entries = new Map();
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
        if (entry?.key) entries.set(entry.key, entry);
      } catch {
        // Same as CassetteStore: a corrupt cassette is skipped, not fatal.
      }
    }
  }
  const all = [...entries.values()];
  const recordedProviderEntries = all.filter((entry) => entry.provenance?.kind === 'recorded_provider').length;
  const ready = recordedProviderEntries > 0;
  const reason = ready
    ? `${recordedProviderEntries} of ${all.length} cassette entries were recorded from a real provider`
    : all.length === 0
      ? 'no provider cassettes are committed'
      : `none of the ${all.length} committed cassette entries was recorded from a real provider`;
  return { dir, totalEntries: all.length, recordedProviderEntries, ready, reason };
}

function main(argv) {
  const dir = argv[0];
  if (!dir) {
    console.error('Usage: node scripts/eval-cassette-readiness.mjs <cassette-dir>');
    return 2;
  }
  const result = cassetteReadiness(resolve(dir));
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
