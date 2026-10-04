import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppBuildDraft } from '@duckcodeailabs/dql-core';
import {
  ANSWER_FIGURES_DEPEND_ON_READER,
  STATIC_ANSWER_TILE_PLACEHOLDER,
  createAppPackage,
  createStoredAppBuildDraft,
  handleAppsApi,
  isStaticAnswerTile,
  loadStoredAppBuildDraft,
} from '../apps-api.js';
import { hostFiguresDependOnReader } from './request-context.js';

/**
 * With a host that protects a table an Ask answer read (a row rule, column policy or tag),
 * the answer's written text (the figures its author saw) is not saved into an App page as a static tile for
 * others to read: the save, the publish preflight and a page write refuse it, with the way forward (a live
 * tile, which runs the answer's SQL for each reader). The tile records what the answer read, so the check can
 * be made again later. Static tiles of this kind already published are listed for stewards, not deleted.
 * Without a host nothing changes.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const WEST_ANSWER = 'West has 149 open claims worth $1,204,330.';
const RUN_SQL = 'SELECT region, COUNT(*) AS open_claims FROM main.claims WHERE status = \'open\' GROUP BY region';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-static-answers-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), '{}\n');
  mkdirSync(join(root, 'blocks', 'claims'), { recursive: true });
  writeFileSync(join(root, 'blocks', 'claims', 'open-claims.dql'), `block "Open claims" {
  domain = "claims"
  status = "certified"
  type = "custom"
  description = "Open claims by region"
  owner = "analytics@local"
  tags = ["claims"]

  query = """
SELECT region, COUNT(*) AS n FROM main.claims GROUP BY region
"""

  visualization {
    chart = "bar"
  }
}
`);
  return root;
}

type Hooks = Partial<Pick<Parameters<typeof handleAppsApi>[0], 'figuresDependOnReader' | 'askRunReads' | 'mayKeepAnswerText'>>;

async function call(root: string, path: string, method: string, body: unknown, hooks: Hooks = {}): Promise<{ status: number; body: any; text: string }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}), 'utf-8')]) as IncomingMessage;
  req.method = method;
  let status = 0;
  let text = '';
  const res = {
    writeHead(next: number) { status = next; return this; },
    end(chunk?: string | Buffer) { if (chunk !== undefined) text += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk); return this; },
  } as unknown as ServerResponse;
  const url = new URL(`http://local.test${path}`);
  const handled = await handleAppsApi({ req, res, url, path: url.pathname, projectRoot: root, ...hooks });
  expect(handled).toBe(true);
  return { status, text, body: text ? JSON.parse(text) : undefined };
}

/** A host that protects main.claims (a row rule by region), and Priya's own Ask run that read it. */
const hosted = (seen: Array<string[] | undefined> = []): Hooks => ({
  figuresDependOnReader: async (relations) => {
    seen.push(relations);
    return relations === undefined || relations.some((relation) => relation.endsWith('claims'));
  },
  askRunReads: async (runId) => (runId === 'run-priya' ? { relations: ['main.claims'], sql: RUN_SQL, question: 'How many open claims are there by region?' } : null),
});

const draftFor = (root: string): AppBuildDraft => createStoredAppBuildDraft(root, {
  name: 'Claims review', goal: 'Review open claims', domain: 'claims', authoringMode: 'ai', sourcePolicy: 'include_review_required',
});

const askResult = (draft: AppBuildDraft, extra: Record<string, unknown> = {}) => ({
  expectedRevision: draft.revision,
  expectedProposalHash: draft.proposalHash,
  pageId: draft.pages[0]!.id,
  title: 'Open claims',
  question: 'How many open claims are there by region?',
  answer: WEST_ANSWER,
  runId: 'run-priya',
  ...extra,
});

/** The answer's figure as a whole number: ids and timestamps (a draft's `build_…149_…`, `…53.149Z`) may hold the same digits. */
const FIGURE = /(?<![\w.])149(?!\w)/;

describe('an Ask answer\'s text, where its figures depend on who is looking', () => {
  it('is refused when it is saved into an App, with the way forward: a live tile', async () => {
    const root = project();
    const draft = draftFor(root);
    const seen: Array<string[] | undefined> = [];
    const refused = await call(root, `/api/app-builds/${draft.id}/ask-results`, 'POST', askResult(draft), hosted(seen));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ ok: false, code: 'ANSWER_FIGURES_DEPEND_ON_READER', error: ANSWER_FIGURES_DEPEND_ON_READER, ways: [{ id: 'live', label: 'Add as a live tile' }] });
    // The host heard what the answer read, from the person's own run (not from the browser).
    expect(seen).toEqual([['main.claims']]);
    // Nothing was added.
    expect(loadStoredAppBuildDraft(root, draft.id)?.pages[0]?.layout.items ?? []).toHaveLength(draft.pages[0]!.layout.items.length);

    // A live tile runs the answer's SQL for each reader; its source says what it answers, not the author's figures.
    const live = await call(root, `/api/app-builds/${draft.id}/ask-results`, 'POST', askResult(draft, { mode: 'live' }), hosted());
    expect(live.status, live.text).toBe(201);
    const tile = live.body.draft.pages[0].layout.items.find((item: { i: string }) => item.i === live.body.tileId);
    expect(tile.draftAnalysis).toBeTruthy();
    expect(tile.text).toBeUndefined();
    expect(JSON.stringify(live.body.draft)).not.toMatch(FIGURE);
    const source = live.body.draft.sources.find((candidate: { kind: string }) => candidate.kind === 'review_dql');
    const artifact = readFileSync(join(root, '.dql', 'local', 'app-builds', draft.id, source.sourceRef), 'utf-8');
    expect(artifact).toContain(RUN_SQL);
    expect(artifact).not.toMatch(FIGURE);
    expect(artifact).toContain('How many open claims are there by region?');
  });

  it('is saved, with what it read, where the figures do not depend on the reader; and without a host, as before', async () => {
    const root = project();
    const open = draftFor(root);
    const unprotected: Hooks = { figuresDependOnReader: async () => false, askRunReads: hosted().askRunReads };
    const saved = await call(root, `/api/app-builds/${open.id}/ask-results`, 'POST', askResult(open), unprotected);
    expect(saved.status, saved.text).toBe(201);
    const tile = saved.body.draft.pages[0].layout.items.find((item: { i: string }) => item.i === saved.body.tileId);
    expect(isStaticAnswerTile(tile)).toBe(true);
    expect(tile.text.markdown).toBe(WEST_ANSWER);
    expect(tile.sourceEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'main.claims', kind: 'answer_relation' })]));

    const single = draftFor(root);
    const local = await call(root, `/api/app-builds/${single.id}/ask-results`, 'POST', askResult(single));
    expect(local.status, local.text).toBe(201);
    expect(local.body.draft.pages[0].layout.items.find((item: { i: string }) => item.i === local.body.tileId).text.markdown).toBe(WEST_ANSWER);
  });

  it('is refused when a draft edit adds one, as when it is added from Ask', async () => {
    const root = project();
    const draft = draftFor(root);
    const page = draft.pages[0]!;
    const forged = {
      i: 'ask-forged', x: 0, y: 10, w: 12, h: 2, title: 'Open claims', text: { markdown: WEST_ANSWER }, viz: { type: 'text' }, sourceClass: 'narrative',
      sourceEvidence: [{ source: 'ask:forged', reason: 'Saved from Ask.', kind: 'text' }],
    };
    const edit = await call(root, `/api/app-builds/${draft.id}`, 'PATCH', { expectedRevision: draft.revision, operations: [{ type: 'add_tile', pageId: page.id, tile: forged }] }, hosted());
    expect(edit.status, edit.text).toBe(409);
    expect(edit.body).toMatchObject({ code: 'ANSWER_FIGURES_DEPEND_ON_READER', tiles: ['ask-forged'] });
    // An author's own text tile (no Ask answer behind it) is the author's to write.
    const own = await call(root, `/api/app-builds/${draft.id}`, 'PATCH', { expectedRevision: draft.revision, operations: [{ type: 'add_tile', pageId: page.id, tile: { ...forged, i: 'note', sourceEvidence: undefined } }] }, hosted());
    expect(own.status, own.text).toBe(200);
  });

  it('is refused at the publish preflight, whichever way it reached the draft', async () => {
    const root = project();
    const draft = draftFor(root);
    // Added where nothing depended on the reader (or before the rule), then the host protects the table.
    const added = await call(root, `/api/app-builds/${draft.id}/ask-results`, 'POST', askResult(draft), { figuresDependOnReader: async () => false, askRunReads: hosted().askRunReads });
    expect(added.status).toBe(201);
    const current = loadStoredAppBuildDraft(root, added.body.draft.id)!;
    const preflight = await call(root, `/api/app-builds/${draft.id}/preflight`, 'POST', { expectedRevision: current.revision, proposalHash: current.proposalHash }, hosted());
    expect(preflight.status).toBe(400);
    expect(preflight.body.errors).toEqual(expect.arrayContaining([expect.stringContaining(ANSWER_FIGURES_DEPEND_ON_READER)]));
    const publish = await call(root, `/api/app-builds/${draft.id}/publish-to-project`, 'POST', { expectedRevision: current.revision, proposalHash: current.proposalHash }, hosted());
    expect(publish.status).toBe(400);
    expect(publish.body.errors).toEqual(expect.arrayContaining([expect.stringContaining(ANSWER_FIGURES_DEPEND_ON_READER)]));
  });

  it('is refused when a page write adds one; a page that already had one can still be edited; stewards get the list', async () => {
    const root = project();
    const created = createAppPackage(root, { name: 'Claims weekly', domain: 'claims', owners: ['owner@local'], selectedBlockIds: ['Open claims'] });
    expect(created.ok).toBe(true);
    const appId = 'claims-weekly';
    const pagePath = join(root, 'apps', appId, 'dashboards', 'overview.dqld');
    const page = JSON.parse(readFileSync(pagePath, 'utf-8'));
    const answerTile = (id: string, relations?: string[]) => ({
      i: id, x: 0, y: 20, w: 12, h: 2, title: 'Open claims (Ask)', text: { markdown: WEST_ANSWER }, viz: { type: 'text' }, sourceClass: 'narrative',
      sourceEvidence: [
        { source: `ask:${id}`, reason: 'Saved from Ask as an editable review-required narrative.', kind: 'text', trustState: 'review_required' },
        ...(relations ?? []).map((relation) => ({ source: relation, reason: 'A table the answer read.', kind: 'answer_relation' })),
      ],
    });
    const withTile = { ...page, layout: { ...page.layout, items: [...page.layout.items, answerTile('ask-new', ['main.claims'])] } };
    const put = await call(root, `/api/apps/${appId}/dashboards/overview`, 'PUT', withTile, hosted());
    expect(put.status).toBe(409);
    expect(put.body).toMatchObject({ code: 'ANSWER_FIGURES_DEPEND_ON_READER', tiles: ['ask-new'] });
    const patch = await call(root, `/api/apps/${appId}/dashboards/overview/layout`, 'PATCH', { items: withTile.layout.items }, hosted());
    expect(patch.status).toBe(409);
    expect(readFileSync(pagePath, 'utf-8')).not.toMatch(FIGURE);

    // One published before the rule (no record of what it read): it stays, edits around it go through, and
    // stewards find it listed, without its text.
    writeFileSync(pagePath, `${JSON.stringify({ ...page, layout: { ...page.layout, items: [...page.layout.items, answerTile('ask-old')] } }, null, 2)}\n`);
    const moved = JSON.parse(readFileSync(pagePath, 'utf-8'));
    moved.layout.items = moved.layout.items.map((item: { i: string; y: number }) => (item.i === 'ask-old' ? { ...item, y: 30 } : item));
    const edit = await call(root, `/api/apps/${appId}/dashboards/overview/layout`, 'PATCH', { items: moved.layout.items }, hosted());
    expect(edit.status, edit.text).toBe(200);
    const listed = await call(root, '/api/app-answer-tiles', 'GET', undefined, hosted());
    expect(listed.status).toBe(200);
    expect(listed.body.tiles).toEqual([expect.objectContaining({ appId, pageId: 'overview', tileId: 'ask-old', title: 'Open claims (Ask)', notice: expect.stringContaining('live tile') })]);
    expect(listed.text).not.toMatch(FIGURE);
    // Meanwhile, a reader who may not replace it reads a placeholder, never its text; its
    // authors and stewards still read the text (to replace it); without a host the page is as before.
    const asReader = await call(root, `/api/apps/${appId}/dashboards/overview`, 'GET', undefined, { ...hosted(), mayKeepAnswerText: async () => false });
    const readerTile = asReader.body.dashboard.layout.items.find((item: { i: string }) => item.i === 'ask-old');
    expect(readerTile).toMatchObject({ text: { markdown: STATIC_ANSWER_TILE_PLACEHOLDER }, figuresWithheld: 'depends_on_reader', title: 'Open claims (Ask)' });
    expect(asReader.text).not.toMatch(FIGURE);
    expect(asReader.text).not.toContain('1,204,330');
    const noDecision = await call(root, `/api/apps/${appId}/dashboards/overview`, 'GET', undefined, hosted());
    expect(noDecision.text).not.toMatch(FIGURE);
    const asSteward = await call(root, `/api/apps/${appId}/dashboards/overview`, 'GET', undefined, { ...hosted(), mayKeepAnswerText: async (app) => app === appId });
    expect(asSteward.text).toContain(WEST_ANSWER);
    const otherTables = await call(root, `/api/apps/${appId}/dashboards/overview`, 'GET', undefined, { figuresDependOnReader: async () => false, mayKeepAnswerText: async () => false });
    expect(otherTables.text).toContain(WEST_ANSWER);
    expect((await call(root, `/api/apps/${appId}/dashboards/overview`, 'GET', undefined)).text).toContain(WEST_ANSWER);
    // Without a host there is nothing to list, and a page write is as before.
    expect((await call(root, '/api/app-answer-tiles', 'GET', undefined)).body).toEqual({ tiles: [] });
    expect((await call(root, `/api/apps/${appId}/dashboards/overview`, 'PUT', withTile)).status).toBe(200);
  });

  it('the host decides; a host that errs, or one with row rules but no answer, means the figures depend on the reader', async () => {
    expect(await hostFiguresDependOnReader(undefined, ['main.claims'])).toBe(false);
    expect(await hostFiguresDependOnReader({}, ['main.claims'])).toBe(false);
    expect(await hostFiguresDependOnReader({ rowPolicy: (query) => ({ sql: query.sql }) }, ['main.claims'])).toBe(true);
    expect(await hostFiguresDependOnReader({ figuresDependOnReader: () => false, rowPolicy: (query) => ({ sql: query.sql }) }, ['main.claims'])).toBe(false);
    expect(await hostFiguresDependOnReader({ figuresDependOnReader: () => { throw new Error('down'); } }, ['main.claims'])).toBe(true);
  });
});
