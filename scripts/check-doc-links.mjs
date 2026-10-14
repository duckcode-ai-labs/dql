#!/usr/bin/env node
// Verify every relative markdown link under docs/ and the root README.md
// points at a file that actually exists. External (http/https/mailto) and
// anchor-only links are skipped. Fragments after `#` are stripped.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...walk(full));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = [...walk(join(ROOT, 'docs')), join(ROOT, 'README.md')];
const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;

const problems = [];
for (const file of files) {
  const src = readFileSync(file, 'utf-8');
  const baseDir = dirname(file);
  for (const match of src.matchAll(linkRe)) {
    let href = match[1].trim();
    if (!href || href.startsWith('#')) continue;
    if (/^(https?|mailto|tel):/i.test(href)) continue;
    href = href.split('#')[0].split('?')[0];
    if (!href) continue;
    const target = resolve(baseDir, href);
    try {
      statSync(target);
    } catch {
      problems.push(`${file}: broken link → ${match[1]}`);
    }
  }
}

if (problems.length) {
  console.error(`Found ${problems.length} broken link(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

const cliSource = readFileSync(join(ROOT, 'apps/cli/src/index.ts'), 'utf-8');
const cliReference = readFileSync(join(ROOT, 'docs/reference/cli.md'), 'utf-8');
const dispatchedCommands = [...cliSource.matchAll(/^\s+case "([a-z-]+)":$/gm)]
  .map((match) => match[1]);
const undocumentedCommands = dispatchedCommands.filter((command) =>
  !cliReference.includes(`zlens ${command}`));

if (undocumentedCommands.length) {
  console.error('CLI reference is missing dispatched top-level command(s):');
  for (const command of undocumentedCommands) console.error(`  zlens ${command}`);
  process.exit(1);
}

console.log(`Checked ${files.length} markdown files — all relative links resolve.`);
console.log(`CLI reference covers ${dispatchedCommands.length} dispatched top-level commands.`);
