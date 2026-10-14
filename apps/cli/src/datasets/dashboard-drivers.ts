/**
 * Driver tiles in the App page run (RFC 0008 step 7).
 *
 * A driver tile never runs SQL of its own. The page run expands it into
 * ordinary governed Dataset comparison tiles (the whole measure, then one
 * per dimension), runs those like any other Dataset tile, and folds their
 * results back into one driver tile. Contract checks, filters, caching and
 * execution evidence are therefore exactly the Dataset tile path.
 */
import {
  normalizeTileQuery,
  readDriverDefinition,
  type DashboardDocument,
  type DashboardGridItem,
  type DatasetDescriptor,
  type TileQuery,
} from '@zlens/core';
import {
  driverDimensionTileId,
  driverTotalTileId,
  foldDriverAnalysis,
  planDriverQueries,
  type DriverQueryPlan,
} from '@zlens/agent';

export class DriverProbeError extends Error {}

export interface DashboardDriverRun {
  item: DashboardGridItem;
  plan?: DriverQueryPlan;
  error?: string;
}

/** The transient driver tile a reader's "Why did it move?" adds to one run. */
export function dashboardDriverProbeItem(dashboard: DashboardDocument, raw: unknown): DashboardGridItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DriverProbeError('driverProbe must name a tile and a driver definition.');
  const probe = raw as Record<string, unknown>;
  const fromTileId = typeof probe.fromTileId === 'string' ? probe.fromTileId.trim() : '';
  const source = dashboard.layout.items.find((item) => item.i === fromTileId);
  if (!source || !source.sourceId || !source.query) throw new DriverProbeError('A driver probe must start from a Dataset tile on this page.');
  const errors: string[] = [];
  const driver = readDriverDefinition(probe.driver, 'driverProbe.driver', (message) => errors.push(message));
  if (!driver) throw new DriverProbeError(errors.join(' ') || 'driverProbe.driver is not a valid driver definition.');
  return {
    i: `${source.i}::why`,
    x: 0,
    y: 0,
    w: 12,
    h: 6,
    sourceId: source.sourceId,
    ...(source.sourceRevision ? { sourceRevision: source.sourceRevision } : {}),
    ...(source.filterBindings ? { filterBindings: source.filterBindings } : {}),
    ...(source.parameterBindings ? { parameterBindings: source.parameterBindings } : {}),
    ...(source.sourceClass ? { sourceClass: source.sourceClass } : {}),
    ...(source.trustState ? { trustState: source.trustState } : {}),
    ...(source.reviewStatus ? { reviewStatus: source.reviewStatus } : {}),
    driver,
    viz: { type: 'waterfall' },
    title: `Why ${source.title ?? 'this'} moved`,
  };
}

/**
 * The transient tile a reader's Explore panel adds to one run (RFC 0009 step
 * 6a): a drill view of one Dataset tile, as a field query on the same
 * Dataset. Like the driver probe it joins the page run, so it gets the
 * page's filters (scoped to the source tile too), access checks and contract
 * validation, and it never changes the App.
 */
export function dashboardExploreProbeItem(dashboard: DashboardDocument, raw: unknown): DashboardGridItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DriverProbeError('exploreProbe must name a tile and a field query.');
  const probe = raw as Record<string, unknown>;
  const fromTileId = typeof probe.fromTileId === 'string' ? probe.fromTileId.trim() : '';
  const source = dashboard.layout.items.find((item) => item.i === fromTileId);
  if (!source || !source.sourceId || !source.query) throw new DriverProbeError('An Explore view must start from a Dataset tile on this page.');
  const query = normalizeTileQuery(probe.query);
  if (!query) throw new DriverProbeError('exploreProbe.query is not a valid field query.');
  return {
    i: `${source.i}::explore`,
    x: 0,
    y: 0,
    w: 12,
    h: 6,
    sourceId: source.sourceId,
    ...(source.sourceRevision ? { sourceRevision: source.sourceRevision } : {}),
    ...(source.filterBindings ? { filterBindings: source.filterBindings } : {}),
    ...(source.parameterBindings ? { parameterBindings: source.parameterBindings } : {}),
    ...(source.sourceClass ? { sourceClass: source.sourceClass } : {}),
    ...(source.trustState ? { trustState: source.trustState } : {}),
    ...(source.reviewStatus ? { reviewStatus: source.reviewStatus } : {}),
    query,
    viz: { type: query.detail ? 'table' : 'bar' },
    title: `Explore ${source.title ?? 'this tile'}`,
  };
}

/** Replace each driver tile with the governed comparison tiles that feed it. */
export function expandDashboardDriverItems(input: {
  items: DashboardGridItem[];
  descriptorFor: (item: DashboardGridItem) => DatasetDescriptor | undefined;
  sourceErrorFor: (item: DashboardGridItem) => string | undefined;
}): { executionItems: DashboardGridItem[]; runs: Map<string, DashboardDriverRun>; executionOwners: Map<string, string> } {
  const executionItems: DashboardGridItem[] = [];
  const runs = new Map<string, DashboardDriverRun>();
  const executionOwners = new Map<string, string>();
  for (const item of input.items) {
    if (!item.driver) {
      executionItems.push(item);
      continue;
    }
    const sourceError = input.sourceErrorFor(item);
    const descriptor = input.descriptorFor(item);
    if (sourceError || !descriptor) {
      runs.set(item.i, { item, error: sourceError ?? 'This driver tile has no current governed Dataset.' });
      continue;
    }
    const planned = planDriverQueries(item.driver, descriptor);
    if (planned.status !== 'ready') {
      runs.set(item.i, { item, error: planned.reason });
      continue;
    }
    // The reader's selections, drills and clicked mark narrow both periods
    // alike. A field held to one value explains nothing, so it is not a
    // breakdown.
    const narrow = item.driver.filters ?? [];
    if (narrow.length) {
      const held = new Set(narrow.filter((filter) => (filter.op === 'eq' || filter.op === 'in') && filter.values.length === 1).map((filter) => filter.field.toLowerCase()));
      const withFilters = (query: TileQuery): TileQuery => ({ ...query, filters: [...(query.filters ?? []), ...narrow.map((filter) => ({ field: filter.field, op: filter.op, values: [...filter.values] }))] });
      planned.plan = {
        ...planned.plan,
        total: withFilters(planned.plan.total),
        dimensions: planned.plan.dimensions.filter((dimension) => !held.has(dimension.field.toLowerCase())).map((dimension) => ({ ...dimension, query: withFilters(dimension.query) })),
      };
    }
    runs.set(item.i, { item, plan: planned.plan });
    const base: Omit<DashboardGridItem, 'i' | 'query'> = {
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      sourceId: item.sourceId,
      ...(item.sourceRevision ? { sourceRevision: item.sourceRevision } : {}),
      ...(item.filterBindings ? { filterBindings: item.filterBindings } : {}),
      ...(item.parameterBindings ? { parameterBindings: item.parameterBindings } : {}),
      ...(item.sourceClass ? { sourceClass: item.sourceClass } : {}),
      ...(item.trustState ? { trustState: item.trustState } : {}),
      ...(item.reviewStatus ? { reviewStatus: item.reviewStatus } : {}),
      viz: { type: 'table' },
    };
    const total = driverTotalTileId(item.i);
    executionItems.push({ ...base, i: total, query: planned.plan.total, title: `${item.title ?? 'Driver'} · total` });
    executionOwners.set(total, item.i);
    for (const dimension of planned.plan.dimensions) {
      const id = driverDimensionTileId(item.i, dimension.field);
      executionItems.push({ ...base, i: id, query: dimension.query, title: `${item.title ?? 'Driver'} · ${dimension.label}` });
      executionOwners.set(id, item.i);
    }
  }
  return { executionItems, runs, executionOwners };
}

/** Page filters scoped to a driver tile also apply to its comparison tiles. */
/**
 * A driver runs as generated comparison queries (`<driver>::driver::…`), so
 * a filter that lists the tiles it applies to must list those queries too,
 * both in `scope.tileIds` and in each Dataset binding's `tileIds`. A query
 * gets a filter when its driver is listed, or when the tile the driver
 * explains is listed: a reader's probe `<tile>::why` always explains `tile`,
 * and a Studio driver tile is named `<tile>-why` (Studio also adds new driver
 * tiles to the source tile's filters).
 */
export function withDriverFilterScopes(dashboard: DashboardDocument, owners: Map<string, string>): DashboardDocument {
  const filters = dashboard.filters ?? [];
  if (!filters.some((filter) => filter.scope?.tileIds?.length || Object.values(filter.datasetBindings ?? {}).some((binding) => binding.tileIds))) return dashboard;
  const tileIds = new Set(dashboard.layout.items.map((item) => item.i));
  const explains = (owner: string): string[] => {
    const probe = /^(.*)::(?:why|explore)$/.exec(owner)?.[1];
    if (probe) return [owner, probe];
    const authored = /^(.*)-why(?:-\d+)?$/.exec(owner)?.[1];
    return authored && tileIds.has(authored) ? [owner, authored] : [owner];
  };
  const byOwner = new Map<string, string[]>();
  for (const [id, owner] of owners) byOwner.set(owner, [...(byOwner.get(owner) ?? []), id]);
  const widen = (listed: string[]): string[] => {
    const extra = [...byOwner].flatMap(([owner, ids]) => (explains(owner).some((id) => listed.includes(id)) ? ids : []));
    return extra.length ? [...new Set([...listed, ...extra])] : listed;
  };
  return {
    ...dashboard,
    filters: filters.map((filter) => {
      const scopeIds = filter.scope?.tileIds;
      const bindings = filter.datasetBindings
        ? Object.fromEntries(Object.entries(filter.datasetBindings).map(([datasetId, binding]) => [
          datasetId,
          binding.tileIds ? { ...binding, tileIds: widen(binding.tileIds) } : binding,
        ]))
        : undefined;
      return {
        ...filter,
        ...(scopeIds?.length ? { scope: { ...filter.scope, tileIds: widen(scopeIds) } } : {}),
        ...(bindings ? { datasetBindings: bindings } : {}),
      };
    }),
  };
}

type RunTile = { tileId: string; status: string; [key: string]: any };

/** Fold the comparison tile results back into one result per driver tile. */
export function foldDashboardDriverTiles(tiles: RunTile[], runs: Map<string, DashboardDriverRun>): void {
  for (const [tileId, run] of runs) {
    const { item } = run;
    const header = { tileId, tileType: 'driver', title: item.title, viz: item.viz };
    if (!run.plan || run.error) {
      tiles.push({ ...header, status: 'error', error: run.error ?? 'This driver tile could not be planned.' });
      continue;
    }
    const taken = (id: string) => {
      const index = tiles.findIndex((tile) => tile.tileId === id);
      return index >= 0 ? tiles.splice(index, 1)[0] : undefined;
    };
    const total = taken(driverTotalTileId(tileId));
    const dimensionTiles = run.plan.dimensions.map((dimension) => ({ dimension, tile: taken(driverDimensionTileId(tileId, dimension.field)) }));
    if (!total || total.status !== 'ok' || !total.result) {
      tiles.push({
        ...header,
        status: total?.status && total.status !== 'ok' ? total.status : 'error',
        error: total?.error ?? 'The comparison for the whole measure did not run.',
      });
      continue;
    }
    const analysis = foldDriverAnalysis({
      definition: item.driver!,
      plan: run.plan,
      totalRows: total.result.rows ?? [],
      dimensionResults: dimensionTiles.map(({ dimension, tile }) => (tile?.status === 'ok' && tile.result
        ? { field: dimension.field, rows: tile.result.rows ?? [] }
        : { field: dimension.field, error: tile?.error ?? 'This breakdown did not run.' })),
    });
    const rows = analysis.dimensions.flatMap((dimension) => dimension.members.map((member) => ({
      dimension: dimension.label,
      member: member.label,
      current: member.current ?? null,
      prior: member.prior ?? null,
      change: member.delta ?? null,
      share_of_change: member.share ?? null,
    })));
    tiles.push({
      ...header,
      status: 'ok',
      driver: analysis,
      // The whole-measure comparison carries the governed evidence: its
      // Dataset trust, contract validation, SQL and result fingerprints.
      ...(total.dataset ? { dataset: total.dataset } : {}),
      ...(total.artifact ? { artifact: { ...total.artifact, name: item.title ?? total.artifact.name } } : {}),
      ...(total.certificationStatus ? { certificationStatus: total.certificationStatus } : {}),
      ...(total.filters ? { filters: total.filters } : {}),
      driverEvidence: dimensionTiles.map(({ dimension, tile }) => ({
        field: dimension.field,
        status: tile?.status ?? 'missing',
        resultFingerprint: tile?.result?.resultFingerprint ?? tile?.dataset?.executionProvenance?.resultFingerprint,
        executedSqlFingerprint: tile?.dataset?.executionProvenance?.executedSqlFingerprint,
      })),
      result: {
        columns: ['dimension', 'member', 'current', 'prior', 'change', 'share_of_change'],
        // The measure's display unit, from the governed comparison's metadata.
        ...(() => {
          const meta = (total.result.columnsMeta ?? []).find((entry: { name?: string }) => typeof entry?.name === 'string' && entry.name.endsWith('__current_period'));
          return meta ? { columnsMeta: ['current', 'prior', 'change'].map((name) => ({ ...meta, name })) } : {};
        })(),
        rows,
        rowCount: rows.length,
        executionTime: [total, ...dimensionTiles.map(({ tile }) => tile)].reduce((sum, tile) => sum + (Number(tile?.result?.executionTime) || 0), 0),
        ...(total.result.resultFingerprint ? { resultFingerprint: total.result.resultFingerprint } : {}),
      },
    });
  }
}
