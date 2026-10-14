import {
  NodeKind,
  type ProgramNode,
  type DashboardNode,
  type BlockDeclNode,
  type ChartCallNode,
  type FilterCallNode,
  type DecoratorNode,
  type ExpressionNode,
  type NamedArgNode,
  type WorkbookNode,
  type PageNode,
  type ParamDeclNode,
  type LayoutBlockNode,
  type LayoutRowNode,
  type DashboardBodyItem,
  type DigestNode,
  type NarrativeNode,
  type SemanticLayer,
} from '@zlens/core';
import type {
  WorkbookIR,
  PageIR,
  ParamIR,
  DashboardIR,
  DigestIR,
  NarrativeIR,
  ChartIR,
  ChartConfig,
  InteractionConfig,
  FilterIR,
  FilterOptionConfig,
  ScheduleIR,
  NotificationIR,
  AlertIR,
  LayoutIR,
  LayoutItemIR,
  LayoutDiagnostic,
  SQLParam,
  DrillConfigIR,
} from './ir-nodes.js';

export interface LoweringOptions {
  semanticLayer?: SemanticLayer;
  /** Driver name for SQL dialect selection in semantic query composition. */
  driver?: string;
  diagnostics?: string[];
  /**
   * Registry of known block names to their materialized table/view names.
   * Used to resolve ref("block_name") calls in SQL queries.
   * Key = block name, Value = materialized table/view name (defaults to block name).
   */
  blockRegistry?: Map<string, string>;
}

/** Result of ref() resolution on a SQL string */
export interface RefResolutionResult {
  /** SQL with ref() calls replaced by actual table/view names */
  sql: string;
  /** Block names referenced via ref() */
  dependencies: string[];
}

/**
 * Resolve ref("block_name") calls in a SQL string using the block registry.
 *
 * If no registry is provided, ref() calls are left as-is (the block name is
 * used as the table name directly, assuming it will be materialized as a view).
 */
export function resolveRefs(sql: string, blockRegistry?: Map<string, string>): RefResolutionResult {
  const dependencies: string[] = [];
  const resolved = sql.replace(
    /\bref\s*\(\s*["']([^"']+)["']\s*\)/gi,
    (_match, blockName: string) => {
      dependencies.push(blockName);
      if (blockRegistry) {
        const tableName = blockRegistry.get(blockName);
        if (tableName) return `"${tableName}"`;
      }
      // Fallback: use block name as table name
      return `"${blockName}"`;
    },
  );
  return { sql: resolved, dependencies };
}

export function lowerProgram(program: ProgramNode, options: LoweringOptions = {}): DashboardIR[] {
  const dashboards: DashboardIR[] = [];

  for (const stmt of program.statements) {
    switch (stmt.kind) {
      case NodeKind.Dashboard:
        dashboards.push(lowerDashboard(stmt, options));
        break;
      case NodeKind.ChartCall:
        // Standalone chart -> wrap in a single-chart dashboard
        dashboards.push({
          title: 'Untitled',
          charts: [lowerChart(stmt, 0, options)],
          filters: [],
          params: [],
          notifications: extractNotifications(stmt.decorators),
          alerts: extractAlerts(stmt.decorators),
          schedule: extractSchedule(stmt.decorators),
          layout: buildLayout(1),
          variables: {},
        });
        break;
      case NodeKind.Workbook:
        // Flatten workbook pages into dashboards for backward compat
        for (const page of lowerWorkbook(stmt, options).pages) {
          dashboards.push({
            title: `${stmt.title} - ${page.title}`,
            charts: page.charts,
            filters: page.filters,
            params: page.params,
            schedule: extractSchedule(stmt.decorators),
            notifications: extractNotifications(stmt.decorators),
            alerts: extractAlerts(stmt.decorators),
            layout: page.layout,
            variables: page.variables,
            layoutDiagnostics: page.layoutDiagnostics,
          });
        }
        break;
      case NodeKind.BlockDecl: {
        const lowered = lowerBlockDecl(stmt, options);
        if (lowered) dashboards.push(lowered);
        break;
      }
      case NodeKind.Digest:
        dashboards.push(lowerDigest(stmt, options));
        break;
      case NodeKind.ImportDecl:
        // Import declarations are resolved at compile time, not at IR level
        break;
    }
  }

  return dashboards;
}

function lowerDigest(node: DigestNode, options: LoweringOptions): DigestIR {
  // Digest parses like a dashboard; reuse dashboard lowering for body/charts/layout.
  const dashboardShape = lowerDashboard(
    {
      kind: NodeKind.Dashboard,
      title: node.title,
      decorators: node.decorators,
      body: node.body,
      span: node.span,
    } as DashboardNode,
    options,
  );

  const narrative = node.narrative ? lowerNarrative(node.narrative) : undefined;
  return { ...dashboardShape, narrative };
}

function lowerNarrative(node: NarrativeNode): NarrativeIR {
  let prompt = '';
  const sources: string[] = [];
  for (const prop of node.properties) {
    if (prop.name === 'prompt') {
      const v = evaluateExpression(prop.value);
      if (typeof v === 'string') prompt = v;
    } else if (prop.name === 'sources') {
      // Accept either an array of ref("…") function calls, or an array of strings.
      if (prop.value.kind === NodeKind.ArrayLiteral) {
        for (const el of prop.value.elements) {
          if (el.kind === NodeKind.FunctionCall && el.callee === 'ref' && el.arguments.length > 0) {
            const arg = el.arguments[0];
            if (arg.kind === NodeKind.StringLiteral) sources.push(arg.value);
          } else if (el.kind === NodeKind.StringLiteral) {
            sources.push(el.value);
          }
        }
      }
    }
  }
  return { prompt, sources };
}

export function lowerWorkbookProgram(program: ProgramNode, options: LoweringOptions = {}): WorkbookIR | null {
  for (const stmt of program.statements) {
    if (stmt.kind === NodeKind.Workbook) {
      return lowerWorkbook(stmt, options);
    }
  }
  return null;
}

function lowerWorkbook(node: WorkbookNode, options: LoweringOptions): WorkbookIR {
  return {
    title: node.title,
    pages: node.pages.map((page) => lowerPage(page, options)),
    schedule: extractSchedule(node.decorators),
    notifications: extractNotifications(node.decorators),
    alerts: extractAlerts(node.decorators),
  };
}

function lowerPage(node: PageNode, options: LoweringOptions): PageIR {
  const { charts, filters, params, variables, layout, layoutDiagnostics } = lowerBodyItems(node.body, options);
  return {
    title: node.title,
    charts,
    filters,
    params,
    layout,
    variables,
    layoutDiagnostics: layoutDiagnostics.length > 0 ? layoutDiagnostics : undefined,
  };
}

function lowerBodyItems(body: DashboardBodyItem[], options: LoweringOptions): {
  charts: ChartIR[];
  filters: FilterIR[];
  params: ParamIR[];
  variables: Record<string, unknown>;
  layout: LayoutIR;
  layoutDiagnostics: LayoutDiagnostic[];
} {
  const charts: ChartIR[] = [];
  const filters: FilterIR[] = [];
  const params: ParamIR[] = [];
  const variables: Record<string, unknown> = {};
  const layoutDiagnostics: LayoutDiagnostic[] = [];
  let chartIndex = 0;
  let filterIndex = 0;
  let explicitLayout: LayoutIR | null = null;

  for (const item of body) {
    switch (item.kind) {
      case NodeKind.VariableDecl:
        variables[item.name] = evaluateExpression(item.initializer);
        break;
      case NodeKind.ParamDecl:
        params.push(lowerParamDecl(item));
        // Also register as variable with default value
        if (item.defaultValue) {
          variables[item.name] = evaluateExpression(item.defaultValue);
        }
        break;
      case NodeKind.ChartCall:
        charts.push(lowerChart(item, chartIndex++, options));
        break;
      case NodeKind.FilterCall:
        filters.push(lowerFilter(item, filterIndex++));
        break;
      case NodeKind.UseDecl:
        // Use declarations are resolved at compile time
        break;
      case NodeKind.LayoutBlock:
        {
          const loweredLayout = lowerLayoutBlock(item, chartIndex);
          explicitLayout = loweredLayout.layout;
          layoutDiagnostics.push(...loweredLayout.diagnostics);
        }
        // Process charts inside layout rows
        for (const row of item.rows) {
          for (const rowItem of row.items) {
            if (rowItem.node.kind === NodeKind.ChartCall) {
              charts.push(lowerChart(rowItem.node, chartIndex++, options));
            } else if (rowItem.node.kind === NodeKind.FilterCall) {
              filters.push(lowerFilter(rowItem.node, filterIndex++));
            }
          }
        }
        break;
    }
  }

  const baseLayout = explicitLayout ?? buildLayout(charts.length);
  const validated = validateAndNormalizeLayout(baseLayout, charts);
  layoutDiagnostics.push(...validated.diagnostics);

  return {
    charts,
    filters,
    params,
    variables,
    layout: validated.layout,
    layoutDiagnostics,
  };
}

function lowerDashboard(node: DashboardNode, options: LoweringOptions): DashboardIR {
  const { charts, filters, params, variables, layout, layoutDiagnostics } = lowerBodyItems(node.body, options);

  // Extract @refresh(seconds) decorator for auto-refresh interval
  const refreshDecorator = node.decorators.find((d) => d.name === 'refresh');
  let refreshInterval: number | undefined;
  if (refreshDecorator && refreshDecorator.arguments.length > 0) {
    const val = evaluateExpression(refreshDecorator.arguments[0]);
    refreshInterval = typeof val === 'number' ? val : Number(val);
    if (isNaN(refreshInterval) || refreshInterval <= 0) refreshInterval = undefined;
  }

  return {
    title: node.title,
    charts,
    filters,
    params,
    schedule: extractSchedule(node.decorators),
    notifications: extractNotifications(node.decorators),
    alerts: extractAlerts(node.decorators),
    layout,
    variables,
    refreshInterval,
    layoutDiagnostics: layoutDiagnostics.length > 0 ? layoutDiagnostics : undefined,
  };
}

function lowerParamDecl(node: ParamDeclNode): ParamIR {
  return {
    name: node.name,
    paramType: node.paramType,
    defaultValue: node.defaultValue ? evaluateExpression(node.defaultValue) : undefined,
  };
}

function lowerLayoutBlock(
  node: LayoutBlockNode,
  startChartIndex: number,
): { layout: LayoutIR; diagnostics: LayoutDiagnostic[] } {
  const items: LayoutItemIR[] = [];
  const diagnostics: LayoutDiagnostic[] = [];
  const columns = node.columns;
  let chartIdx = startChartIndex;
  let currentRow = 1;

  for (const row of node.rows) {
    let currentCol = 1;
    for (const rowItem of row.items) {
      const derivedSpan = rowItem.span ?? Math.floor(columns / row.items.length);
      const colSpan = derivedSpan > 0 ? derivedSpan : 1;
      if (derivedSpan <= 0) {
        diagnostics.push({
          level: 'warning',
          row: currentRow,
          message: `Invalid span ${derivedSpan} in layout row ${currentRow}; defaulted to 1.`,
        });
      }
      if ((currentCol + colSpan - 1) > columns) {
        diagnostics.push({
          level: 'warning',
          row: currentRow,
          message: `Layout row ${currentRow} exceeds ${columns} columns.`,
        });
      }
      if (rowItem.node.kind === NodeKind.ChartCall) {
        items.push({
          chartId: `chart-${chartIdx}`,
          gridColumn: `${currentCol} / span ${colSpan}`,
          gridRow: `${currentRow}`,
        });
        chartIdx++;
      }
      currentCol += colSpan;
    }
    currentRow++;
  }

  return { layout: { type: 'grid', columns, items }, diagnostics };
}

function lowerChart(node: ChartCallNode, index: number, options: LoweringOptions): ChartIR {
  const normalizedChartType = normalizeChartTypeAlias(node.chartType) as typeof node.chartType;
  const config = extractChartConfig(node.args);
  const interaction = extractInteractionConfig(node.args);
  let { sql, params } = processSQL(node.query.rawSQL, node.query.interpolations);

  // Extract @if condition from decorators
  const ifDecorator = node.decorators.find((d) => d.name === 'if');
  let condition: string | undefined;
  if (ifDecorator && ifDecorator.arguments.length > 0) {
    condition = evaluateExpression(ifDecorator.arguments[0]) as string;
  }

  // Extract @rls decorator — inject WHERE clause for row-level security
  const rlsApplied = applyRLSDecorators(node.decorators, sql, params);
  sql = rlsApplied.sql;
  params = rlsApplied.params;

  // Extract @cache(ttl) decorator for query caching
  const cacheDecorator = node.decorators.find((d) => d.name === 'cache');
  let cacheTTL: number | undefined;
  if (cacheDecorator && cacheDecorator.arguments.length > 0) {
    const ttlVal = evaluateExpression(cacheDecorator.arguments[0]);
    cacheTTL = typeof ttlVal === 'number' ? ttlVal : Number(ttlVal);
    if (isNaN(cacheTTL)) cacheTTL = undefined;
  }

  // Extract @annotate(x_value, label [, color]) decorators for chart annotations
  const annotateDecorators = node.decorators.filter((d) => d.name === 'annotate');
  const annotations = annotateDecorators.length > 0
    ? annotateDecorators.map((d) => {
        const args = d.arguments.map(evaluateExpression);
        return {
          x: args[0] != null ? String(args[0]) : undefined,
          label: args[1] != null ? String(args[1]) : '',
          color: args[2] != null ? String(args[2]) : undefined,
        };
      })
    : undefined;

  // Extract @materialize(refresh = "hourly") decorator
  const materializeDec = node.decorators.find((d) => d.name === 'materialize');
  const materializeRefresh = materializeDec && materializeDec.arguments.length > 0
    ? String(evaluateExpression(materializeDec.arguments[0]))
    : undefined;
  const drillConfig = buildDrillConfig(node.args, options);

  return {
    id: `chart-${index}`,
    chartType: normalizedChartType,
    sql,
    sqlParams: params,
    config,
    interaction: hasInteraction(interaction) ? interaction : undefined,
    title: getStringArg(node.args, 'title'),
    theme: getStringArg(node.args, 'theme'),
    condition,
    cacheTTL,
    connection: getStringArg(node.args, 'connection'),
    annotations,
    materializeRefresh,
    drillConfig,
  };
}

const SAFE_RLS_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const RLS_TEMPLATE_VARIABLE = /^\{([A-Za-z_][A-Za-z0-9_.]*)\}$/;

type RLSValueBinding =
  | { type: 'variable'; variableName: string }
  | { type: 'literal'; literalValue: unknown };

function applyRLSDecorators(
  decorators: DecoratorNode[],
  sql: string,
  params: SQLParam[],
): { sql: string; params: SQLParam[] } {
  const rlsDecorators = decorators.filter((d) => d.name === 'rls');
  if (rlsDecorators.length === 0) return { sql, params };

  const rlsClauses: string[] = [];
  const nextParams = [...params];
  let nextPosition = nextParams.reduce((max, p) => Math.max(max, p.position), 0);
  let literalParamCounter = 0;

  for (const rls of rlsDecorators) {
    if (rls.arguments.length < 2) continue;

    const column = normalizeRLSColumn(rls.arguments[0]);
    if (!column) continue;

    const valueBinding = resolveRLSValueBinding(rls.arguments[1]);
    if (!valueBinding) continue;

    nextPosition += 1;
    if (valueBinding.type === 'variable') {
      nextParams.push({ name: valueBinding.variableName, position: nextPosition });
    } else {
      literalParamCounter += 1;
      nextParams.push({
        name: `__rls_literal_${literalParamCounter}`,
        position: nextPosition,
        literalValue: valueBinding.literalValue,
      });
    }

    rlsClauses.push(`${column} = COALESCE($${nextPosition}, ${column})`);
  }

  if (rlsClauses.length === 0) return { sql, params: nextParams };

  // Wrap the original SQL in a subquery and apply RLS WHERE clause
  const rlsWhere = rlsClauses.join(' AND ');
  return {
    sql: `SELECT * FROM (${sql}) _dql_rls WHERE ${rlsWhere}`,
    params: nextParams,
  };
}

function normalizeRLSColumn(arg: ExpressionNode): string | null {
  let raw: string | null = null;
  if (arg.kind === NodeKind.StringLiteral) {
    raw = arg.value;
  } else if (arg.kind === NodeKind.Identifier) {
    raw = arg.name;
  } else {
    const evaluated = evaluateExpression(arg);
    if (typeof evaluated === 'string') raw = evaluated;
  }

  if (!raw) return null;
  const trimmed = raw.trim();
  if (!SAFE_RLS_COLUMN.test(trimmed)) return null;
  return trimmed;
}

function resolveRLSValueBinding(arg: ExpressionNode): RLSValueBinding | null {
  if (arg.kind === NodeKind.StringLiteral) {
    const raw = String(arg.value ?? '');
    const match = raw.trim().match(RLS_TEMPLATE_VARIABLE);
    if (match) {
      return { type: 'variable', variableName: match[1] };
    }
    return { type: 'literal', literalValue: raw };
  }

  if (arg.kind === NodeKind.Identifier) {
    return { type: 'variable', variableName: arg.name };
  }

  if (arg.kind === NodeKind.NumberLiteral || arg.kind === NodeKind.BooleanLiteral) {
    return { type: 'literal', literalValue: arg.value };
  }

  const evaluated = evaluateExpression(arg);
  if (typeof evaluated === 'string') {
    const match = evaluated.trim().match(RLS_TEMPLATE_VARIABLE);
    if (match) {
      return { type: 'variable', variableName: match[1] };
    }
    return { type: 'literal', literalValue: evaluated };
  }

  if (typeof evaluated === 'number' || typeof evaluated === 'boolean') {
    return { type: 'literal', literalValue: evaluated };
  }

  return null;
}

function lowerFilter(node: FilterCallNode, index: number): FilterIR {
  const label = getStringArg(node.args, 'label') ?? `Filter ${index + 1}`;
  const param = getStringArg(node.args, 'param') ?? `filter_${index}`;

  let sql: string | undefined;
  let sqlParams: SQLParam[] = [];

  if (node.query) {
    const processed = processSQL(node.query.rawSQL, node.query.interpolations);
    sql = processed.sql;
    sqlParams = processed.params;
  }

  const defaultValue = getStringArg(node.args, 'default_value');
  const placeholder = getStringArg(node.args, 'placeholder');

  const options: FilterOptionConfig = {};
  const format = getStringArg(node.args, 'format');
  const debounce = getNumberArg(node.args, 'debounce');
  const min = getNumberArg(node.args, 'min');
  const max = getNumberArg(node.args, 'max');
  const step = getNumberArg(node.args, 'step');
  const width = getNumberArg(node.args, 'width');

  if (format != null) options.format = format;
  if (debounce != null) options.debounce = debounce;
  if (min != null) options.min = min;
  if (max != null) options.max = max;
  if (step != null) options.step = step;
  if (width != null) options.width = width;

  return {
    id: `filter-${index}`,
    filterType: node.filterType,
    sql,
    sqlParams,
    label,
    param,
    defaultValue: defaultValue ?? undefined,
    placeholder,
    options: Object.keys(options).length > 0 ? options : undefined,
  };
}

function extractInteractionConfig(args: NamedArgNode[]): InteractionConfig {
  const config: InteractionConfig = {};

  for (const arg of args) {
    const value = evaluateExpression(arg.value);
    switch (arg.name) {
      case 'on_click':
        config.onClick = String(value);
        break;
      case 'drill_down':
        config.drillDown = String(value);
        break;
      case 'link_to':
        config.linkTo = String(value);
        break;
      case 'filter_by':
        config.filterBy = Array.isArray(value) ? value.map(String) : String(value);
        break;
    }
  }

  return config;
}

function hasInteraction(config: InteractionConfig): boolean {
  return !!(config.onClick || config.drillDown || config.linkTo || config.filterBy);
}

function extractChartConfig(args: NamedArgNode[]): ChartConfig {
  const config: ChartConfig = {};

  for (const arg of args) {
    const value = evaluateExpression(arg.value);
    switch (arg.name) {
      case 'x':
        config.x = String(value);
        break;
      case 'y':
        config.y = String(value);
        break;
      case 'color':
        config.color = String(value);
        break;
      case 'size':
        config.size = String(value);
        break;
      case 'facet':
        config.facet = String(value);
        break;
      case 'color_field':
        config.colorField = String(value);
        break;
      case 'line_width':
        config.lineWidth = Number(value);
        break;
      case 'fill_opacity':
        config.fillOpacity = Number(value);
        break;
      case 'bar_width':
        config.barWidth = Number(value);
        break;
      case 'inner_radius':
        config.innerRadius = Number(value);
        break;
      case 'orientation':
        config.orientation = String(value);
        break;
      case 'x_axis_label':
        config.xAxisLabel = String(value);
        break;
      case 'y_axis_label':
        config.yAxisLabel = String(value);
        break;
      case 'title_font_size':
        config.titleFontSize = Number(value);
        break;
      case 'show_grid':
        config.showGrid = Boolean(value);
        break;
      case 'show_legend':
        config.showLegend = Boolean(value);
        break;
      case 'width':
        config.width = Number(value);
        break;
      case 'height':
        config.height = Number(value);
        break;
      case 'stroke_dash':
        config.strokeDash = String(value);
        break;
      case 'metrics':
        config.metrics = value as string[];
        break;
      case 'compare_to_previous':
        config.compareToPrevious = Boolean(value);
        break;
      case 'formatting':
        config.formatting = String(value);
        break;
      case 'columns':
        config.columns = value as string[];
        break;
      case 'sortable':
        config.sortable = Boolean(value);
        break;
      case 'page_size':
        config.pageSize = Number(value);
        break;
      case 'y2':
        config.y2 = String(value);
        break;
      case 'tooltip':
        config.tooltip = Array.isArray(value) ? value.map(String) : [String(value)];
        break;
      case 'format_x':
        config.formatX = String(value);
        break;
      case 'format_y':
        config.formatY = String(value);
        break;
      case 'color_rule':
        config.colorRule = String(value);
        break;
      case 'pin_columns':
        config.pinColumns = Array.isArray(value) ? value.map(String) : [String(value)];
        break;
      case 'row_color':
        config.rowColor = String(value);
        break;
      case 'drill_hierarchy':
        config.drillHierarchy = String(value);
        break;
      case 'drill_path':
        config.drillPath = String(value);
        break;
      case 'drill_mode':
        config.drillMode = String(value) as ChartConfig['drillMode'];
        break;
      case 'topology_url':
        config.topologyUrl = String(value);
        break;
    }
  }

  return config;
}

function buildDrillConfig(args: NamedArgNode[], options: LoweringOptions): DrillConfigIR | undefined {
  const hierarchy = getStringArg(args, 'drill_hierarchy');
  const path = getStringArg(args, 'drill_path');
  const modeRaw = getStringArg(args, 'drill_mode');

  if (!hierarchy) {
    if ((path || modeRaw) && options.diagnostics) {
      options.diagnostics.push('drill_path/drill_mode provided without drill_hierarchy; falling back to legacy drill_down behavior.');
    }
    return undefined;
  }

  const mode = modeRaw && (modeRaw === 'modal' || modeRaw === 'replace' || modeRaw === 'expand')
    ? modeRaw
    : 'modal';
  if (modeRaw && modeRaw !== mode && options.diagnostics) {
    options.diagnostics.push(`Invalid drill_mode '${modeRaw}' for hierarchy '${hierarchy}'. Falling back to 'modal'.`);
  }

  const drillConfig: DrillConfigIR = {
    hierarchy,
    path: path ?? undefined,
    mode,
  };

  const semanticLayer = options.semanticLayer;
  if (!semanticLayer) return drillConfig;

  const hierarchyDef = semanticLayer.getHierarchy(hierarchy);
  if (!hierarchyDef) {
    options.diagnostics?.push(`Unknown drill hierarchy '${hierarchy}'.`);
    return drillConfig;
  }

  const resolvedLevels = semanticLayer.resolveDrillPath(hierarchy, path ?? undefined);
  if (path && resolvedLevels.length === 0) {
    options.diagnostics?.push(`Unknown drill path '${path}' for hierarchy '${hierarchy}'.`);
    return {
      ...drillConfig,
      rollup: hierarchyDef.defaultRollup,
    };
  }

  return {
    ...drillConfig,
    rollup: hierarchyDef.defaultRollup,
    levels: resolvedLevels.map((level) => ({
      name: level.name,
      dimension: level.dimension,
    })),
  };
}

function processSQL(
  rawSQL: string,
  interpolations: Array<{ variableName: string; offsetInSQL: number }>,
): { sql: string; params: SQLParam[] } {
  if (interpolations.length === 0) {
    return { sql: rawSQL, params: [] };
  }

  let sql = rawSQL;
  const params: SQLParam[] = [];

  // Replace ${varName}/{varName} with $N placeholders (process right-to-left to preserve offsets)
  const sorted = [...interpolations].sort((a, b) => b.offsetInSQL - a.offsetInSQL);
  let paramIndex = interpolations.length;

  for (const interp of sorted) {
    const placeholder = `$${paramIndex}`;
    const from = interp.offsetInSQL;
    const rest = sql.slice(from);
    const paramPattern = new RegExp(`^\\$\\{${interp.variableName}\\}|^\\{${interp.variableName}\\}`);
    const match = rest.match(paramPattern);
    if (!match) {
      paramIndex--;
      continue;
    }
    sql = sql.slice(0, from) + placeholder + sql.slice(from + match[0].length);
    params.unshift({ name: interp.variableName, position: paramIndex });
    paramIndex--;
  }

  return { sql, params };
}

function lowerBlockDecl(node: BlockDeclNode, _options: LoweringOptions): DashboardIR | null {
  // Semantic blocks: compose SQL from the semantic layer
  const metricRefs = node.metricsRef?.length ? node.metricsRef : (node.metricRef ? [node.metricRef] : []);
  if (!node.query && node.blockType === 'semantic' && metricRefs.length > 0) {
    if (!_options.semanticLayer) return null;
    const composed = _options.semanticLayer.composeQuery({
      metrics: metricRefs,
      dimensions: node.dimensionsRef ?? [],
      driver: _options.driver,
    });
    if (!composed) return null;

    const vizChartType = getBlockVisualizationChartType(node);
    const chartType = vizChartType ? vizChartType : 'bar';
    const normalizedChartType = normalizeChartTypeAlias(chartType);
    const config = lowerBlockVisualizationConfig(node);
    const paramIRs: ParamIR[] = (node.params?.params ?? []).map((p) => ({
      name: p.name,
      paramType: p.paramType?.replace('[]', '') as ParamIR['paramType'] ?? (p.initializer ? inferParamType(p.initializer) : 'string'),
      defaultValue: p.initializer ? evaluateExpression(p.initializer) : undefined,
    }));
    const variables: Record<string, unknown> = {};
    for (const p of node.params?.params ?? []) {
      if (p.initializer) variables[p.name] = evaluateExpression(p.initializer);
    }

    const rlsApplied = applyRLSDecorators(node.decorators, composed.sql, []);

    return {
      title: node.name,
      charts: [{
        id: 'chart-0',
        chartType: normalizedChartType as ChartIR['chartType'],
        sql: rlsApplied.sql,
        sqlParams: rlsApplied.params,
        config,
        title: node.description || node.name,
        blockType: node.blockType,
      }],
      filters: [],
      params: paramIRs,
      schedule: extractSchedule(node.decorators),
      notifications: extractNotifications(node.decorators),
      alerts: extractAlerts(node.decorators),
      layout: buildLayout(1),
      variables,
      layoutDiagnostics: undefined,
    };
  }

  if (!node.query) return null;

  const vizChartType = getBlockVisualizationChartType(node);
  const chartType = vizChartType ? vizChartType : 'bar';

  const normalizedChartType = normalizeChartTypeAlias(chartType);
  const config = lowerBlockVisualizationConfig(node);
  // Resolve ref() calls before processing interpolations
  const refResult = resolveRefs(node.query.rawSQL, _options.blockRegistry);
  let { sql, params } = processSQL(refResult.sql, node.query.interpolations);
  const rlsApplied = applyRLSDecorators(node.decorators, sql, params);
  sql = rlsApplied.sql;
  params = rlsApplied.params;

  const paramIRs: ParamIR[] = (node.params?.params ?? []).map((p) => ({
    name: p.name,
    paramType: p.paramType?.replace('[]', '') as ParamIR['paramType'] ?? (p.initializer ? inferParamType(p.initializer) : 'string'),
    defaultValue: p.initializer ? evaluateExpression(p.initializer) : undefined,
  }));

  const variables: Record<string, unknown> = {};
  for (const p of node.params?.params ?? []) {
    if (p.initializer) variables[p.name] = evaluateExpression(p.initializer);
  }

  return {
    title: node.name,
    dependencies: refResult.dependencies,
    charts: [{
      id: 'chart-0',
      chartType: normalizedChartType as ChartIR['chartType'],
      sql,
      sqlParams: params,
      config,
      title: node.description || node.name,
      blockType: node.blockType,
    }],
    filters: [],
    params: paramIRs,
    schedule: extractSchedule(node.decorators),
    notifications: extractNotifications(node.decorators),
    alerts: extractAlerts(node.decorators),
    layout: buildLayout(1),
    variables,
    layoutDiagnostics: undefined,
  };
}

function getBlockVisualizationChartType(node: BlockDeclNode): string | null {
  const chartProp = node.visualization?.properties.find((p) => p.name === 'chart');
  if (!chartProp) return null;
  const value = evaluateExpression(chartProp.value);
  if (typeof value !== 'string') return null;
  return value;
}

function lowerBlockVisualizationConfig(node: BlockDeclNode): ChartConfig {
  const config: ChartConfig = {};
  for (const prop of node.visualization?.properties ?? []) {
    const value = evaluateExpression(prop.value);
    switch (prop.name) {
      case 'x':
        config.x = String(value);
        break;
      case 'y':
        config.y = String(value);
        break;
      case 'y2':
        config.y2 = String(value);
        break;
      case 'color':
        config.color = String(value);
        break;
      case 'size':
        config.size = String(value);
        break;
      case 'facet':
        config.facet = String(value);
        break;
      case 'metrics':
        config.metrics = Array.isArray(value) ? value.map(String) : [String(value)];
        break;
      case 'columns':
        config.columns = Array.isArray(value) ? value.map(String) : [String(value)];
        break;
      case 'tooltip':
        config.tooltip = Array.isArray(value) ? value.map(String) : [String(value)];
        break;
      case 'width':
        config.width = Number(value);
        break;
      case 'height':
        config.height = Number(value);
        break;
      case 'theme':
        // theme handled at dashboard compile options today.
        break;
    }
  }
  return config;
}

function inferParamType(expr: ExpressionNode): ParamIR['paramType'] {
  switch (expr.kind) {
    case NodeKind.NumberLiteral:
      return 'number';
    case NodeKind.BooleanLiteral:
      return 'boolean';
    default:
      return 'string';
  }
}

function normalizeChartTypeAlias(chartType: string): string {
  switch (chartType) {
    case 'single_value':
    case 'single-value':
      return 'kpi';
    case 'grouped-bar':
      return 'grouped_bar';
    case 'stacked-bar':
      return 'stacked_bar';
    case 'stacked-area':
    case 'stacked_area':
      return 'area';
    case 'donut':
      return 'pie';
    case 'forecast':
      return 'line';
    case 'tree-map':
      return 'treemap';
    case 'flow':
      return 'sankey';
    case 'spark-line':
    case 'spark':
      return 'sparkline';
    case 'small-multiples':
    case 'small_multiple':
    case 'small-multiple':
      return 'small_multiples';
    default:
      return chartType;
  }
}

function extractSchedule(decorators: DecoratorNode[]): ScheduleIR | undefined {
  const scheduleDec = decorators.find((d) => d.name === 'schedule');
  if (!scheduleDec) return undefined;

  const args = scheduleDec.arguments.map(evaluateExpression);
  return normalizeSchedule(args);
}

function normalizeSchedule(args: unknown[]): ScheduleIR {
  if (args.length === 0) {
    return { cron: '0 0 * * *' }; // default: daily midnight
  }

  const first = String(args[0]);

  switch (first) {
    case 'daily': {
      const time = args[1] ? parseTime(String(args[1])) : { hour: 0, minute: 0 };
      return { cron: `${time.minute} ${time.hour} * * *` };
    }
    case 'hourly':
      return { cron: '0 * * * *' };
    case 'weekly': {
      const day = args[1] ? parseDayOfWeek(String(args[1])) : 1;
      return { cron: `0 0 * * ${day}` };
    }
    case 'cron':
      return { cron: String(args[1] ?? '0 0 * * *') };
    default:
      // Try as raw cron expression
      return { cron: first };
  }
}

function parseTime(time: string): { hour: number; minute: number } {
  // Parse "9:00 AM", "14:30", etc.
  const match = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return { hour: 0, minute: 0 };

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const ampm = match[3]?.toUpperCase();

  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  return { hour, minute };
}

function parseDayOfWeek(day: string): number {
  const days: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  return days[day.toLowerCase()] ?? 1;
}

function extractNotifications(decorators: DecoratorNode[]): NotificationIR[] {
  const notifications: NotificationIR[] = [];

  for (const dec of decorators) {
    if (dec.name === 'email_to') {
      notifications.push({
        type: 'email',
        recipients: dec.arguments.map((a) => String(evaluateExpression(a))),
      });
    } else if (dec.name === 'slack_channel') {
      notifications.push({
        type: 'slack',
        recipients: dec.arguments.map((a) => String(evaluateExpression(a))),
      });
    }
  }

  return notifications;
}

function extractAlerts(decorators: DecoratorNode[]): AlertIR[] {
  const alerts: AlertIR[] = [];
  for (const dec of decorators) {
    if (dec.name !== 'alert') continue;
    const args = dec.arguments.map((a) => evaluateExpression(a));
    if (args.length < 1) continue;

    const conditionSQL = String(args[0] ?? '').trim();
    if (!conditionSQL) continue;

    let operator: AlertIR['operator'] = '>';
    let threshold = 0;
    let message: string | undefined = undefined;

    if (args.length >= 2) {
      const second = String(args[1]);
      const match = second.match(/^([><=!]+)\s*(\d+(?:\.\d+)?)$/);
      if (match) {
        operator = match[1] as AlertIR['operator'];
        threshold = parseFloat(match[2]);
      } else {
        const n = Number(args[1]);
        threshold = Number.isFinite(n) ? n : 0;
      }
    }
    if (args.length >= 3) {
      message = String(args[2]);
    }

    alerts.push({ conditionSQL, operator, threshold, message });
  }
  return alerts;
}

function buildLayout(chartCount: number): LayoutIR {
  const items: LayoutItemIR[] = [];
  const columns = 12;

  // Auto-layout: KPIs get full width row, charts get 6-col (2 per row)
  let currentRow = 1;
  let currentCol = 1;

  for (let i = 0; i < chartCount; i++) {
    const colSpan = chartCount === 1 ? 12 : 6;
    items.push({
      chartId: `chart-${i}`,
      gridColumn: `${currentCol} / span ${colSpan}`,
      gridRow: `${currentRow}`,
    });

    currentCol += colSpan;
    if (currentCol > columns) {
      currentCol = 1;
      currentRow++;
    }
  }

  return { type: 'grid', columns, items };
}

function validateAndNormalizeLayout(
  layout: LayoutIR,
  charts: ChartIR[],
): { layout: LayoutIR; diagnostics: LayoutDiagnostic[] } {
  const diagnostics: LayoutDiagnostic[] = [];
  const chartIds = new Set(charts.map((chart) => chart.id));
  const seen = new Set<string>();
  const normalizedItems: LayoutItemIR[] = [];

  for (const item of layout.items) {
    if (!chartIds.has(item.chartId)) {
      diagnostics.push({
        level: 'error',
        chartId: item.chartId,
        message: `Layout references unknown chart "${item.chartId}".`,
      });
      continue;
    }

    if (seen.has(item.chartId)) {
      diagnostics.push({
        level: 'warning',
        chartId: item.chartId,
        message: `Layout contains duplicate entry for "${item.chartId}". Keeping first occurrence.`,
      });
      continue;
    }

    const span = parseGridSpan(item.gridColumn);
    if (span > layout.columns) {
      diagnostics.push({
        level: 'warning',
        chartId: item.chartId,
        message: `Layout span ${span} exceeds grid columns ${layout.columns} for "${item.chartId}".`,
      });
    }

    seen.add(item.chartId);
    normalizedItems.push(item);
  }

  const missingCharts = charts.filter((chart) => !seen.has(chart.id));
  if (missingCharts.length > 0) {
    const fallbackLayout = buildLayout(missingCharts.length);
    const existingRows = normalizedItems
      .map((item) => Number.parseInt(item.gridRow, 10))
      .filter((row) => Number.isFinite(row));
    const rowOffset = existingRows.length > 0 ? Math.max(...existingRows) : 0;

    missingCharts.forEach((chart, index) => {
      const fallback = fallbackLayout.items[index];
      const fallbackRow = Number.parseInt(fallback.gridRow, 10);
      normalizedItems.push({
        chartId: chart.id,
        gridColumn: fallback.gridColumn,
        gridRow: Number.isFinite(fallbackRow) ? String(rowOffset + fallbackRow) : String(rowOffset + 1),
      });
      diagnostics.push({
        level: 'warning',
        chartId: chart.id,
        message: `Chart "${chart.id}" was missing from explicit layout and was auto-placed.`,
      });
    });
  }

  return {
    layout: { ...layout, items: normalizedItems },
    diagnostics,
  };
}

function parseGridSpan(gridColumn: string): number {
  const match = gridColumn.match(/span\s+(\d+)/i);
  if (!match) return 1;
  const span = Number.parseInt(match[1], 10);
  return Number.isFinite(span) && span > 0 ? span : 1;
}

function evaluateExpression(node: ExpressionNode): unknown {
  switch (node.kind) {
    case NodeKind.StringLiteral:
      return node.value;
    case NodeKind.NumberLiteral:
      return node.value;
    case NodeKind.BooleanLiteral:
      return node.value;
    case NodeKind.Identifier:
      return node.name;
    case NodeKind.ArrayLiteral:
      return node.elements.map(evaluateExpression);
    case NodeKind.IntervalExpr:
      return node.value;
    case NodeKind.BinaryExpr:
      // Simplified: return string representation
      return `${evaluateExpression(node.left)} ${node.operator} ${evaluateExpression(node.right)}`;
    case NodeKind.FunctionCall:
      return node.callee;
    case NodeKind.TemplateString:
      return node.parts.map((p) => (typeof p === 'string' ? p : String(evaluateExpression(p)))).join('');
  }
}

function getStringArg(args: NamedArgNode[], name: string): string | undefined {
  const arg = args.find((a) => a.name === name);
  if (!arg) return undefined;
  return String(evaluateExpression(arg.value));
}

function getNumberArg(args: NamedArgNode[], name: string): number | undefined {
  const arg = args.find((a) => a.name === name);
  if (!arg) return undefined;
  const val = evaluateExpression(arg.value);
  return typeof val === 'number' ? val : Number(val);
}
