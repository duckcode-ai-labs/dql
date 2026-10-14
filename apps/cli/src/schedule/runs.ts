import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord } from './types.js';

const RUNS_DIR = '.dql/runs';

export function ensureRunsDir(projectRoot: string): string {
  const dir = join(projectRoot, RUNS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function writeRunRecord(projectRoot: string, record: RunRecord): string {
  const dir = ensureRunsDir(projectRoot);
  const stamp = record.startedAt.replace(/[:.]/g, '-');
  const safeName = record.block.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const file = join(dir, `${stamp}-${safeName}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  return file;
}

export function listRunRecords(projectRoot: string, limit = 20): RunRecord[] {
  const dir = join(projectRoot, RUNS_DIR);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);

  const records: RunRecord[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf-8');
      records.push(JSON.parse(raw) as RunRecord);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[zlens schedule] skipping malformed run record ${f}: ${msg}`);
    }
  }
  return records;
}

/** A rendered digest as a standalone HTML file under `.dql/runs/digests`; returns its project-relative path. */
export function writeDigestHtml(projectRoot: string, startedAt: string, block: string, title: string, body: string): string {
  const dir = join(ensureRunsDir(projectRoot), 'digests');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const name = `${startedAt.replace(/[:.]/g, '-')}-${block.replace(/[^a-zA-Z0-9_-]+/g, '_')}.html`;
  const escaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  writeFileSync(
    join(dir, name),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escaped}</title></head><body style="margin:0;background:#fbfaf7">${body}</body></html>\n`,
    'utf-8',
  );
  return `${RUNS_DIR}/digests/${name}`;
}
