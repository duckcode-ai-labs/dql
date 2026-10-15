import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { createDqlGenerationSessionForProject, saveBlockStudioDraftArtifacts, startLocalServer } from './local-runtime.js';
import { blockSourceStatus, describesReviewPending, withoutReviewPendingWording } from './certification-receipt.js';
import { saveProviderSettings } from './settings/provider-settings.js';

/**
 * ZLens 0.1.0 third e2e: an AI-imported block wrote "Review required" into its
 * human description, so every imported block failed Certify (#97's guard)
 * until someone rewrote it by hand; and certifying a draft left its companion
 * YAML behind under semantic-layer/blocks/_drafts/. Review state belongs in the
 * status and tags; the description says what the block returns; a draft
 * promoted by Certify takes its files with it.
 */

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function newProject(prefix: string): string {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'import_certifies_cleanly' }));
  return projectRoot;
}

function files(root: string, dir = root, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === '.dql' || entry === 'dql.config.json' || entry === 'dql-manifest.json') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(root, path, out);
    else out.push(relative(root, path).replaceAll('\\', '/'));
  }
  return out.sort();
}

const executor = {
  executeQuery: vi.fn(async () => ({
    columns: ['player_name', 'total_points'],
    rows: [{ player_name: 'James Harden', total_points: 5534 }],
    rowCount: 1,
    executionTime: 1,
  })),
} as unknown as QueryExecutor;

async function withServer(projectRoot: string, run: (base: string) => Promise<void>): Promise<void> {
  let server: Server | undefined;
  try {
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection: { driver: 'file' }, preferredPort: 0, captureServer: (created) => { server = created; } });
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  }
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Block Studio's Certify: start the operation and wait for its result. */
async function certifyInBlockStudio(base: string, source: string, path?: string): Promise<Record<string, any>> {
  const started = await call(base, 'POST', '/api/block-studio/certifications', { source, ...(path ? { path } : {}) });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  let operation: Record<string, any> = started.body.operation;
  for (let attempt = 0; attempt < 500 && ['queued', 'running'].includes(String(operation.status)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    operation = (await call(base, 'GET', `/api/operations/${encodeURIComponent(operation.id)}`)).body;
  }
  return operation.result;
}

const blockSource = (name: string, description: string, domain = 'nba') => `block "${name}" {
  status = "draft"
  domain = "${domain}"
  type = "custom"
  description = "${description}"
  owner = "e2e-test"
  tags = ["nba", "review-required"]
  outputs = ["player_name", "total_points"]
  grain = "player_name"
  query = """SELECT player_name, SUM(pts) AS total_points FROM int_player_stats GROUP BY player_name ORDER BY total_points DESC LIMIT 5"""
  tests {
    assert row_count > 0
  }
}
`;

describe('review wording in a description', () => {
  it('is taken out, keeping what the description says about the data', () => {
    expect(withoutReviewPendingWording('Ranks the top 5 NBA players by total points scored across games dated in 2016 or 2017, including distinct games played. Review required.'))
      .toBe('Ranks the top 5 NBA players by total points scored across games dated in 2016 or 2017, including distinct games played.');
    expect(withoutReviewPendingWording('Review required: ranks the top 5 NBA players by total rebounds for the 2017 season.'))
      .toBe('Ranks the top 5 NBA players by total rebounds for the 2017 season.');
    expect(withoutReviewPendingWording('Top scorers (review required) for 2017.')).toBe('Top scorers for 2017.');
    expect(withoutReviewPendingWording('Top scorers for 2017, review required.')).toBe('Top scorers for 2017.');
    expect(withoutReviewPendingWording('Review-required')).toBe('');
    expect(withoutReviewPendingWording('Review-required year-level comparison of top NBA scorers for 2016 and 2017.'))
      .toBe('Year-level comparison of top NBA scorers for 2016 and 2017.');
    expect(withoutReviewPendingWording('Draft review-required block comparing yearly top scorers.')).toBe('Draft block comparing yearly top scorers.');
    expect(withoutReviewPendingWording('Review required to confirm season boundaries. Top scorers by points.')).toBe('Top scorers by points.');
    expect(withoutReviewPendingWording('Top scorers by points.')).toBe('Top scorers by points.');
  });
});

describe('AI SQL import keeps review status out of the description', () => {
  it('a model that writes "Review required" into the description is corrected; status and tag carry it', async () => {
    const projectRoot = newProject('dql-import-review-wording-');
    saveProviderSettings(projectRoot, { id: 'openai', enabled: true, apiKey: 'sk-test-openai', model: 'gpt-test' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        name: 'Top Scorers 2016 2017',
        description: 'Review required: ranks the top 5 NBA players by total points from int_player_stats, with player_name.',
        llmContext: 'Top 5 players by summed points.',
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'upload',
      sourceKind: 'raw-sql',
      sources: [{ path: 'top.sql', content: 'SELECT player_name, SUM(pts) AS total_points FROM int_player_stats GROUP BY player_name ORDER BY total_points DESC LIMIT 5;' }],
      domain: 'nba',
      owner: 'e2e-test',
      provider: 'openai',
    });
    vi.unstubAllGlobals();

    const candidate = session.candidates[0]!;
    expect(candidate.generationMode).toBe('ai');
    expect(describesReviewPending(candidate.description)).toBe(false);
    expect(candidate.description).toMatch(/^Ranks the top 5 NBA players by total points/);
    expect(candidate.tags).toContain('review-required');
    expect(blockSourceStatus(candidate.dqlSource)).toBe('draft');
    const draftPath = candidate.savedPath!;
    expect(draftPath).toMatch(/_drafts\//);
    expect(readFileSync(join(projectRoot, draftPath), 'utf-8')).not.toMatch(/description = "[^"]*review[\s-]*required/i);

    // Certify straight away: no hand edit of the description is needed, and
    // the promoted draft leaves nothing behind in _drafts.
    await withServer(projectRoot, async (base) => {
      const certified = await call(base, 'POST', `/api/block-studio/ai-imports/${encodeURIComponent(session.id)}/candidates/${encodeURIComponent(candidate.id)}/certify`);
      expect(certified.status, JSON.stringify(certified.body?.blockers ?? certified.body)).toBe(200);
      const path: string = certified.body.candidate.savedPath;
      expect(blockSourceStatus(readFileSync(join(projectRoot, path), 'utf-8'))).toBe('certified');
      expect(files(projectRoot).filter((file) => file.includes('_drafts'))).toEqual([]);
    });
  }, 60_000);

  it('Certify refuses a description that says review required, explains why, and offers the corrected description', async () => {
    const projectRoot = newProject('dql-import-certify-fix-');
    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'upload',
      sourceKind: 'raw-sql',
      sources: [{ path: 'top.sql', content: 'SELECT player_name, SUM(pts) AS total_points FROM int_player_stats GROUP BY player_name ORDER BY total_points DESC LIMIT 5;' }],
      domain: 'nba',
      owner: 'e2e-test',
      provider: 'deterministic',
    });
    const candidate = session.candidates[0]!;
    await withServer(projectRoot, async (base) => {
      const base_ = `/api/block-studio/ai-imports/${encodeURIComponent(session.id)}/candidates/${encodeURIComponent(candidate.id)}`;
      // A person typed the status into the description.
      const edited = await call(base, 'PATCH', base_, { description: 'Top 5 scorers by total points. Review required.' });
      expect(edited.status).toBe(200);

      const refused = await call(base, 'POST', `${base_}/certify`);
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('The description says it needs review');
      const issue = refused.body.details.issues.find((item: any) => item.code === 'description_review_required');
      expect(issue).toMatchObject({ action: 'fix_description', suggestedDescription: 'Top 5 scorers by total points.' });
      expect(issue.message).toMatch(/Certifying is the review/);
      expect(blockSourceStatus(readFileSync(join(projectRoot, refused.body.candidate.savedPath), 'utf-8'))).toBe('draft');

      // The one-click fix: write the suggested description, then certify.
      expect((await call(base, 'PATCH', base_, { description: issue.suggestedDescription })).status).toBe(200);
      const certified = await call(base, 'POST', `${base_}/certify`);
      expect(certified.status, JSON.stringify(certified.body?.blockers)).toBe(200);
      expect(readFileSync(join(projectRoot, certified.body.candidate.savedPath), 'utf-8')).toContain('description = "Top 5 scorers by total points."');
    });
  }, 60_000);
});

describe('Block Studio Certify of a description that says review required', () => {
  it('is still refused, with the corrected description to certify in one click', async () => {
    const projectRoot = newProject('dql-studio-certify-fix-');
    await withServer(projectRoot, async (base) => {
      const refused = await certifyInBlockStudio(base, blockSource('Top Scorers', 'Ranks the top 5 players by points. Review required.'));
      expect(refused.outcome).toBe('draft_saved_with_blockers');
      const issue = refused.checklist.issues.find((item: any) => item.code === 'description_review_required');
      expect(issue).toMatchObject({ action: 'fix_description', suggestedDescription: 'Ranks the top 5 players by points.' });
      expect(blockSourceStatus(readFileSync(join(projectRoot, refused.draftPath), 'utf-8'))).toBe('draft');

      // Nothing about the data left to keep: the suggestion comes from the outputs and grain.
      const bare = await certifyInBlockStudio(base, blockSource('Bare', 'Review required.'));
      expect(bare.checklist.issues.find((item: any) => item.code === 'description_review_required')?.suggestedDescription)
        .toBe('Returns player_name, total_points per player_name.');

      const fixed = blockSource('Top Scorers', issue.suggestedDescription);
      const certified = await certifyInBlockStudio(base, fixed, refused.draftPath);
      expect(certified.outcome).toBe('certified');
      const onDisk = readFileSync(join(projectRoot, certified.newPath), 'utf-8');
      expect(blockSourceStatus(onDisk)).toBe('certified');
      expect(onDisk).not.toContain('review-required');
    });
  }, 60_000);
});

describe('certifying a draft removes the draft and its companion files', () => {
  it('for an Ask draft saved in blocks/_drafts/ with no domain folder', async () => {
    const projectRoot = newProject('dql-certify-ask-draft-');
    mkdirSync(join(projectRoot, 'blocks/_drafts'), { recursive: true });
    writeFileSync(join(projectRoot, 'blocks/_drafts/top_scorers.dql'), blockSource('Top Scorers', 'Top scorers by points.'));
    await withServer(projectRoot, async (base) => {
      const certified = await certifyInBlockStudio(base, blockSource('Top Scorers', 'Top scorers by points.'), 'blocks/_drafts/top_scorers.dql');
      expect(certified.outcome).toBe('certified');
      expect(files(projectRoot)).toEqual(['blocks/nba/top-scorers.dql', 'semantic-layer/blocks/nba/top-scorers.yaml']);
    });
  }, 60_000);

  it('for a draft whose domain was changed before certifying', async () => {
    const projectRoot = newProject('dql-certify-moved-domain-');
    const draftPath = saveBlockStudioDraftArtifacts(projectRoot, { source: blockSource('Top Scorers', 'Top scorers by points.'), name: 'Top Scorers', domain: 'nba', owner: 'e2e-test', description: 'Top scorers by points.', stableSuffix: 'abc123' });
    await withServer(projectRoot, async (base) => {
      const certified = await certifyInBlockStudio(base, blockSource('Top Scorers', 'Top scorers by points.', 'sales'), draftPath);
      expect(certified.outcome).toBe('certified');
      expect(files(projectRoot)).toEqual(['blocks/sales/top-scorers.dql', 'semantic-layer/blocks/sales/top-scorers.yaml']);
    });
  }, 60_000);

  it('including a companion an older release stranded, and nothing else', async () => {
    const projectRoot = newProject('dql-certify-stranded-companion-');
    mkdirSync(join(projectRoot, 'blocks/_drafts'), { recursive: true });
    writeFileSync(join(projectRoot, 'blocks/_drafts/top_scorers.dql'), blockSource('Top Scorers', 'Top scorers by points.'));
    // Written by an older release under the block's domain instead of beside the draft's path.
    mkdirSync(join(projectRoot, 'semantic-layer/blocks/_drafts/nba'), { recursive: true });
    writeFileSync(join(projectRoot, 'semantic-layer/blocks/_drafts/nba/top_scorers.yaml'), 'name: top_scorers\nblock: top_scorers\ndomain: _drafts/nba\nreviewStatus: draft\n');
    // Another draft with the same file name in another domain keeps its companion.
    const otherDraft = saveBlockStudioDraftArtifacts(projectRoot, { currentPath: 'blocks/_drafts/sales/top_scorers.dql', source: blockSource('Sales Top Scorers', 'Sales scorers.', 'sales'), name: 'Sales Top Scorers', domain: 'sales', owner: 'e2e-test' });
    // A hand-written file with the same name that ZLens did not write stays.
    mkdirSync(join(projectRoot, 'semantic-layer/blocks/_drafts/notes'), { recursive: true });
    writeFileSync(join(projectRoot, 'semantic-layer/blocks/_drafts/notes/top_scorers.yaml'), 'notes: kept by hand\n');
    await withServer(projectRoot, async (base) => {
      const certified = await certifyInBlockStudio(base, blockSource('Top Scorers', 'Top scorers by points.'), 'blocks/_drafts/top_scorers.dql');
      expect(certified.outcome).toBe('certified');
    });
    expect(files(projectRoot)).toEqual([
      'blocks/_drafts/sales/top_scorers.dql',
      'blocks/nba/top-scorers.dql',
      'semantic-layer/blocks/_drafts/notes/top_scorers.yaml',
      'semantic-layer/blocks/_drafts/sales/top_scorers.yaml',
      'semantic-layer/blocks/nba/top-scorers.yaml',
    ]);
    expect(otherDraft).toBe('blocks/_drafts/sales/top_scorers.dql');
  }, 60_000);
});
