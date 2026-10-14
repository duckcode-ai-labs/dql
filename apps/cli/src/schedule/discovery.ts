import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { compile } from '@zlens/dql-compiler';
import { collectInputFiles } from '@zlens/core';
import type { ScheduledBlock } from './types.js';

export function discoverScheduledBlocks(projectRoot: string): ScheduledBlock[] {
  const files = collectInputFiles({ projectRoot }).filter((f) => f.endsWith('.dql'));
  const out: ScheduledBlock[] = [];

  for (const path of files) {
    let source: string;
    try {
      source = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }

    const result = compile(source, { file: path });
    for (const dashboard of result.dashboards) {
      const meta = dashboard.metadata;
      if (!meta.schedule?.cron) continue;
      out.push({
        path,
        name: deriveBlockName(projectRoot, path),
        schedule: meta.schedule,
        notifications: meta.notifications ?? [],
        alerts: meta.alerts ?? [],
      });
    }
  }

  return out;
}

export function deriveBlockName(projectRoot: string, absPath: string): string {
  const rel = relative(projectRoot, absPath);
  return rel.replace(/\.dql$/, '').replace(/\\/g, '/');
}
