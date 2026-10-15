import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_CONNECTION_FOR_SCHEDULE_RUN, runSchedule } from './schedule.js';

describe('zlens schedule run without a connection (N2)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('names the missing connection instead of falling back to an in-memory DuckDB', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-schedule-noconn-'));
    dirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'newproj' }));
    mkdirSync(join(projectRoot, 'blocks'));
    const block = join(projectRoot, 'blocks', 'probe.dql');
    writeFileSync(block, 'block "Probe" {\n  domain = "general"\n  type = "custom"\n  query = """SELECT 1 AS ok"""\n}\n');
    vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runSchedule('run', [block], {} as never)).rejects.toThrow(NO_CONNECTION_FOR_SCHEDULE_RUN);
    expect(NO_CONNECTION_FOR_SCHEDULE_RUN).toContain('No database connection is configured yet');
    expect(NO_CONNECTION_FOR_SCHEDULE_RUN).toContain('CONNECTION_NOT_CONFIGURED');
    // Nothing ran, so nothing reports "ok" or a missing DuckDB driver.
    expect(log).not.toHaveBeenCalled();
  });
});
