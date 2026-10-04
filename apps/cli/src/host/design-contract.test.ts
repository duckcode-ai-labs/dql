import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The shared design contract in AGENTS.md ("do not break") holds in the OSS app: the `data-theme` selector on
 * <html> with paper | white | obsidian, the shared token vocabulary in every theme, no app-prefixed colour
 * variables, and the `dql-theme` persistence key read on boot, written on change and followed across tabs by a
 * `storage` listener.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const tokens = readFileSync(join(repo, 'packages/dql-ui/src/styles/tokens.css'), 'utf8');
const store = readFileSync(join(repo, 'apps/dql-notebook/src/store/NotebookStore.tsx'), 'utf8');

const VOCABULARY = [
  '--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-4', '--bg-canvas',
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-muted',
  '--accent', '--accent-hover', '--accent-dim', '--accent-fg',
  '--border-subtle', '--border-default', '--border-strong',
];

/** The custom properties a CSS rule block declares. */
function block(selector: string): Set<string> {
  const start = tokens.indexOf(`${selector} {`);
  if (start < 0) return new Set();
  const body = tokens.slice(start, tokens.indexOf('\n}', start));
  return new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]!));
}

function files(at: string, out: string[] = []): string[] {
  for (const name of readdirSync(at)) {
    const path = join(at, name);
    if (statSync(path).isDirectory()) { if (name !== 'node_modules' && name !== 'dist') files(path, out); }
    else if (/\.(css|ts|tsx|html)$/.test(name)) out.push(path);
  }
  return out;
}

describe('AGENTS.md design contract (shared with the hosted embed)', () => {
  it('keeps the three data-theme blocks: obsidian (also the :root default), paper and white', () => {
    expect(tokens).toMatch(/\[data-theme="obsidian"\]\s*\{/);
    expect(tokens).toMatch(/\[data-theme="paper"\]\s*\{/);
    expect(tokens).toMatch(/\[data-theme="white"\]\s*\{/);
  });

  it('declares the whole shared token vocabulary in :root and in each light theme', () => {
    for (const selector of [':root', '[data-theme="paper"]', '[data-theme="white"]']) {
      const declared = block(selector);
      expect(VOCABULARY.filter((name) => !declared.has(name)), selector).toEqual([]);
    }
  });

  it('has no app-prefixed colour variables in the app or its UI package', () => {
    const offenders = [...files(join(repo, 'packages/dql-ui/src')), ...files(join(repo, 'apps/dql-notebook/src'))]
      .filter((file) => /--dql-color-/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps the dql-theme key: read on boot, written on change, followed across tabs by a storage listener', () => {
    expect(store).toMatch(/localStorage\?\.getItem\('dql-theme'\)/);
    expect(store).toMatch(/localStorage\?\.setItem\('dql-theme'/);
    expect(store).toMatch(/addEventListener\('storage'/);
    expect(store).toMatch(/e\.key !== 'dql-theme'/);
    for (const theme of ['obsidian', 'paper', 'white']) expect(store).toContain(`mode === '${theme}'`);
    expect(store).toMatch(/setAttribute\('data-theme'/);
  });
});
