import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalize, canonicalizeNotebook } from '@zlens/core';
import type { CLIFlags } from '../args.js';

/**
 * Detect the deprecated top-level `workbook { }` construct without invoking
 * the parser — a fast regex probe is enough because `workbook` at column 0
 * (optionally decorated) is unambiguous. Track F flags but does not rewrite.
 */
function detectWorkbook(source: string): boolean {
  return /^\s*(?:@[\w_]+\s*(?:\([^)]*\))?\s*)*workbook\s+"/m.test(source);
}

const WORKBOOK_DEPRECATION =
  'workbook { } is deprecated and will be removed in v1.3. See docs/migrations/workbook-to-dashboard.md.';

export async function runFmt(filePath: string, flags: CLIFlags): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');
  const isNotebook = filePath.endsWith('.dqlnb');
  const formatted = isNotebook ? canonicalizeNotebook(source) : canonicalize(source);
  const changed = source !== formatted;
  const usesWorkbook = !isNotebook && detectWorkbook(source);

  if (flags.check) {
    if (flags.format === 'json') {
      console.log(
        JSON.stringify(
          {
            file: filePath,
            changed,
            mode: 'check',
            deprecations: usesWorkbook ? ['workbook'] : [],
          },
          null,
          2,
        ),
      );
    } else {
      if (changed) console.log(`\n  ✗ Needs formatting: ${filePath}`);
      else console.log(`\n  ✓ Already formatted: ${filePath}`);
      if (usesWorkbook) console.log(`    ⚠ ${WORKBOOK_DEPRECATION}`);
      console.log('');
    }
    if (changed || usesWorkbook) process.exit(1);
    return;
  }

  if (changed) {
    writeFileSync(filePath, formatted, 'utf-8');
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({ file: filePath, changed, mode: 'write' }, null, 2));
  } else if (changed) {
    console.log(`\n  ✓ Formatted: ${filePath}\n`);
  } else {
    console.log(`\n  ✓ No changes: ${filePath}\n`);
  }
}
