import { useCallback, useState, type ReactNode } from 'react';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import type { DashboardDocumentResponse, DashboardDriverDefinitionV1, DashboardRunResponse } from '../../api/client';
import type { ThemeMode } from '../../themes/notebook-theme';
import type { MarkPointer } from '../output/echarts/EChartsChart';
import { formatDisplayValue } from '../../utils/value-format';
import { MarkMenu } from './MarkMenu';
import { ExplorePanel, type ExplainState, type ExploreMode } from './ExplorePanel';
import {
  askAboutMarkQuestion,
  describeMark,
  explainDefinitionFor,
  explainablePeriod,
  markContextFor,
  markFilters,
  markMenuItems,
  type ExploreField,
  type ExploreStep,
  type MarkActionId,
  type MarkContext,
} from './mark-actions';

type LayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type RunTile = DashboardRunResponse['tiles'][number];
export type HierarchyCandidate = NonNullable<NonNullable<RunTile['dataset']>['hierarchy']>['candidates'][number];

/**
 * The click menu and Explore panel (RFC 0009 step 6a), shared by the reader
 * and Studio. The host supplies how to run a probe on its page (a published
 * App or a local draft) and what its existing actions do (keep only, drill a
 * hierarchy, open the details page, ask AI); this hook turns a clicked mark
 * into those actions, and draws the menu and the panel.
 */
export function useMarkInteractions(host: {
  themeMode: ThemeMode;
  /** Runs one probe inside this page's run, with its filters and selections. */
  runProbe: (options: { exploreProbe: { fromTileId: string; query: TileQuery } } | { driverProbe: { fromTileId: string; driver: DashboardDriverDefinitionV1 } }) => Promise<DashboardRunResponse>;
  drillsFor: (tileId: string) => Array<{ hierarchyId: string; fromField: string; values: unknown[] }> | undefined;
  keepOrExclude: (item: LayoutItem, field: string, value: unknown, exclude: boolean) => void;
  drillDown: (item: LayoutItem, candidate: HierarchyCandidate, row: Record<string, unknown>) => void;
  hasDetailsPage: (tileId: string) => boolean;
  openDetailsPage: (tileId: string) => void;
  ask?: (item: LayoutItem, question: string) => void;
  authoredColumns?: string[];
  label: (field: string) => string;
  /** Studio: keep an Explore view as a tile on the page. */
  saveAsTile?: (item: LayoutItem, query: TileQuery, title: string) => void;
}): { openMarkMenu: (item: LayoutItem, tile: RunTile | undefined, row: Record<string, unknown>, at: MarkPointer | undefined, hierarchyCandidates: HierarchyCandidate[]) => void; overlays: ReactNode } {
  const [menu, setMenu] = useState<{ item: LayoutItem; tile: RunTile | undefined; mark: MarkContext; at: MarkPointer; drillCandidate?: HierarchyCandidate } | null>(null);
  const [explore, setExplore] = useState<{ item: LayoutItem; tile: RunTile | undefined; mark?: MarkContext; path: ExploreStep[]; mode: ExploreMode } | null>(null);

  const openMarkMenu = useCallback((item: LayoutItem, tile: RunTile | undefined, row: Record<string, unknown>, at: MarkPointer | undefined, hierarchyCandidates: HierarchyCandidate[]) => {
    const mark = markContextFor(item, row);
    if (!mark) return;
    const drillCandidate = hierarchyCandidates.find((candidate) => row[candidate.fromAlias] !== undefined && row[candidate.fromAlias] !== null);
    setMenu({ item, tile, mark, at: at ?? { x: window.innerWidth / 2, y: window.innerHeight / 3 }, ...(drillCandidate ? { drillCandidate } : {}) });
  }, []);

  const runExplore = async (item: LayoutItem, query: TileQuery): Promise<{ tile?: RunTile; error?: string }> => {
    try {
      const result = await host.runProbe({ exploreProbe: { fromTileId: item.i, query } });
      return { tile: result.tiles.find((candidate) => candidate.tileId === `${item.i}::explore`) };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  };

  const explainPath = async (item: LayoutItem, tile: RunTile | undefined, mark: MarkContext | undefined, path: ExploreStep[], comparison: DashboardDriverDefinitionV1['comparison']): Promise<ExplainState> => {
    const fields = (tile?.dataset?.explore?.fields ?? []) as ExploreField[];
    const drills = host.drillsFor(item.i);
    // The clicked mark sets the period and the measure; which categories are
    // in view is the breadcrumb's job, so going back to "All" widens it again.
    const periodOnly = mark ? { ...mark, values: mark.values.filter((entry) => entry.timeGrain) } : undefined;
    const base = { item, ...(periodOnly ? { mark: periodOnly } : {}), tile, path, ...(drills ? { drills } : {}), fields, comparison };
    let planned = explainDefinitionFor(base);
    // A tile without a time grain: find the latest period of this slice first.
    if ('needsPeriod' in planned) {
      const measure = mark?.measure?.name ?? (item.query as TileQuery | undefined)?.measures[0]?.measure;
      if (!measure) return { status: 'error', message: 'This tile has no measure to explain.' };
      const slice = path.flatMap((step) => step.filters).filter((filter) => filter.op === 'eq' || filter.op === 'in');
      const periods = await runExplore(item, { dimensions: [{ field: planned.needsPeriod.timeField, timeGrain: planned.needsPeriod.grain }], measures: [{ measure }], filters: slice });
      const rows = periods.tile?.status === 'ok' ? periods.tile.result?.rows ?? [] : [];
      const alias = `${planned.needsPeriod.timeField}_${planned.needsPeriod.grain}`;
      const anchor = explainablePeriod(rows.map((row) => row[alias]), planned.needsPeriod.grain);
      if (!anchor) return { status: 'error', message: periods.tile?.error ?? periods.error ?? 'There is no period with data to explain.' };
      planned = explainDefinitionFor({ ...base, anchor });
    }
    if ('unavailable' in planned) return { status: 'error', message: planned.unavailable };
    if (!('definition' in planned)) return { status: 'error', message: 'There is no period with data to explain.' };
    try {
      const result = await host.runProbe({ driverProbe: { fromTileId: item.i, driver: planned.definition } });
      const driverTile = result.tiles.find((candidate) => candidate.tileType === 'driver');
      return driverTile?.status === 'ok' && driverTile.driver
        ? { status: 'ready', analysis: driverTile.driver, definition: planned.definition }
        : { status: 'error', message: driverTile?.error ?? 'The comparison did not run.' };
    } catch (cause) {
      return { status: 'error', message: cause instanceof Error ? cause.message : String(cause) };
    }
  };

  const formattedMeasure = (mark: MarkContext, tile: RunTile | undefined) => (mark.measure
    ? formatDisplayValue(mark.measure.alias, mark.measure.value, [], { meta: tile?.result?.columnsMeta?.find((meta) => meta.name === mark.measure!.alias) as never })
    : undefined);

  const pick = (id: MarkActionId) => {
    const current = menu;
    setMenu(null);
    if (!current) return;
    const { item, tile, mark } = current;
    const category = mark.values.find((entry) => !entry.timeGrain);
    const step: ExploreStep = { label: describeMark(mark, host.label), filters: markFilters(mark) };
    if ((id === 'keep' || id === 'exclude') && category) host.keepOrExclude(item, category.alias, category.value, id === 'exclude');
    else if (id === 'drill-down' && current.drillCandidate) host.drillDown(item, current.drillCandidate, mark.row);
    else if (id === 'details') host.openDetailsPage(item.i);
    else if (id === 'drill-by') setExplore({ item, tile, mark, path: [step], mode: 'breakdown' });
    else if (id === 'rows') setExplore({ item, tile, mark, path: [step], mode: 'rows' });
    // A period is explained at its own date, not filtered to it.
    else if (id === 'explain') setExplore({ item, tile, mark, path: [{ ...step, filters: step.filters.filter((filter) => filter.op === 'eq') }], mode: 'explain' });
    else if (id === 'ask') host.ask?.(item, askAboutMarkQuestion(mark, item.title ?? 'this chart'));
  };

  const overlays = (
    <>
      {menu ? (() => {
        const { item, tile, mark } = menu;
        const fields = (tile?.dataset?.explore?.fields ?? []) as ExploreField[];
        const category = mark.values.find((entry) => !entry.timeGrain);
        const formatted = formattedMeasure(mark, tile);
        return (
          <MarkMenu
            heading={describeMark(mark, host.label)}
            {...(formatted && mark.measure ? { value: `${host.label(mark.measure.name)}: ${formatted}` } : {})}
            at={menu.at}
            items={markMenuItems({
              mark,
              ...(category ? { keepField: category.alias } : {}),
              ...(menu.drillCandidate ? { drillDown: { toField: menu.drillCandidate.toField } } : {}),
              canDrillBy: fields.length > 0,
              hasDetailsPage: host.hasDetailsPage(item.i),
              canExplain: fields.some((field) => field.role === 'time') || Boolean((item.query as TileQuery | undefined)?.dimensions.some((dimension) => dimension.timeGrain)),
              canAsk: Boolean(host.ask && tile?.dataset),
              label: host.label,
            })}
            onPick={pick}
            onClose={() => setMenu(null)}
          />
        );
      })() : null}
      {explore && explore.item.query ? (
        <ExplorePanel
          title={explore.item.title ?? 'This tile'}
          base={explore.item.query as TileQuery}
          fields={(explore.tile?.dataset?.explore?.fields ?? []) as ExploreField[]}
          initialPath={explore.path}
          initialMode={explore.mode}
          {...(host.authoredColumns?.length ? { authoredColumns: host.authoredColumns } : {})}
          themeMode={host.themeMode}
          run={(query) => runExplore(explore.item, query)}
          explain={(path, comparison) => explainPath(explore.item, explore.tile, explore.mark, path, comparison)}
          {...(host.ask ? { onAsk: (question: string) => { const item = explore.item; setExplore(null); host.ask!(item, question); } } : {})}
          {...(host.saveAsTile ? { onSaveAsTile: (query: TileQuery, title: string) => { const item = explore.item; setExplore(null); host.saveAsTile!(item, query, title); } } : {})}
          onClose={() => setExplore(null)}
        />
      ) : null}
    </>
  );
  return { openMarkMenu, overlays };
}
