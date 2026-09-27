import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listStoryEditions, MAX_STORY_EDITIONS, recordStoryEdition, storyEditionScope } from './story-editions.js';

const narrative = { version: 1 as const, presentation: 'story' as const, blocks: [{ id: 'b1', kind: 'text' as const, markdown: 'Revenue is {{kpi.revenue}}.' }] };
const catalog = (display: string) => ({
  'kpi.revenue': { key: 'kpi.revenue', tileId: 'kpi', label: 'Revenue', kind: 'number' as const, value: Number(display.replace(/[^\d.]/g, '')), display },
  'kpi.unused': { key: 'kpi.unused', tileId: 'kpi', label: 'Unused', kind: 'number' as const, value: 2, display: '2' },
});

describe('story edition store (RFC 0008 step 8)', () => {
  it('records bound values only, skips unchanged reruns, and keeps a bounded history', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-story-editions-'));
    try {
      const base = { projectRoot, appId: 'commerce', dashboardId: 'overview', narrative, filterFingerprint: 'f', scope: 'scope:all' };
      const first = recordStoryEdition({ ...base, catalog: catalog('$118'), runId: 'r1', resultFingerprint: 'a', now: new Date('2026-09-20T00:00:00Z') });
      expect(first?.values).toEqual({ 'kpi.revenue': { display: '$118', value: 118, label: 'Revenue' } });
      expect(recordStoryEdition({ ...base, catalog: catalog('$118'), runId: 'r2', resultFingerprint: 'a' })).toBeNull();
      // Only the formatting changed: same values, no new edition.
      const reformatted = catalog('118.00');
      expect(recordStoryEdition({ ...base, catalog: reformatted, runId: 'r2b', resultFingerprint: 'a2' })).toBeNull();
      expect(recordStoryEdition({ ...base, catalog: catalog('$130'), runId: 'r3', resultFingerprint: 'b' })?.runId).toBe('r3');
      expect(recordStoryEdition({ ...base, narrative: { ...narrative, presentation: 'dashboard' }, catalog: catalog('$1'), runId: 'r4', resultFingerprint: 'c' })).toBeNull();
      expect(listStoryEditions(projectRoot, 'commerce', 'overview').map((edition) => edition.runId)).toEqual(['r1', 'r3']);
      for (let index = 0; index < MAX_STORY_EDITIONS + 5; index += 1) {
        recordStoryEdition({ ...base, catalog: catalog(`$${index}`), runId: `n${index}`, resultFingerprint: `n${index}` });
      }
      expect(listStoryEditions(projectRoot, 'commerce', 'overview')).toHaveLength(MAX_STORY_EDITIONS);
      expect(listStoryEditions(projectRoot, 'other', 'overview')).toEqual([]);
      // With a host, each person's editions are their own: another person's run never shows here.
      recordStoryEdition({ ...base, catalog: catalog('$7'), runId: 'p1', resultFingerprint: 'p1', person: 'p-abc' });
      expect(listStoryEditions(projectRoot, 'commerce', 'overview', 'p-abc').map((edition) => edition.runId)).toEqual(['p1']);
      expect(listStoryEditions(projectRoot, 'commerce', 'overview').some((edition) => edition.runId === 'p1')).toBe(false);
      expect(listStoryEditions(projectRoot, 'commerce', 'overview', 'p-other')).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('compares editions within the same filters even when each run fingerprints differently (evaluation F3)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-story-editions-scope-'));
    try {
      const page = { filters: [{ id: 'region' }, { id: 'segment' }] };
      // Same effective filters, whatever order or request shape: one scope.
      const all = storyEditionScope(page, { region: ['US', 'CA'], segment: undefined });
      expect(storyEditionScope(page, { segment: '', region: ['CA', 'US'] })).toBe(all);
      expect(storyEditionScope(page, { region: ['US'] })).not.toBe(all);
      const base = { projectRoot, appId: 'commerce', dashboardId: 'overview', narrative, scope: all };
      recordStoryEdition({ ...base, catalog: catalog('$130'), runId: 'r1', resultFingerprint: 'a', filterFingerprint: 'f1' });
      // A different run fingerprint for the same filters used to start a new scope ("First edition" forever).
      expect(recordStoryEdition({ ...base, catalog: catalog('$130'), runId: 'r2', resultFingerprint: 'a', filterFingerprint: 'f2' })).toBeNull();
      expect(recordStoryEdition({ ...base, catalog: catalog('$140'), runId: 'r3', resultFingerprint: 'b', filterFingerprint: 'f3' })?.scope).toBe(all);
      expect(listStoryEditions(projectRoot, 'commerce', 'overview').map((edition) => edition.runId)).toEqual(['r1', 'r3']);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
