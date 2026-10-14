import type { ChartType, FilterType, ParamType } from '@zlens/core';

// ---- Workbook / Page ----

export interface WorkbookIR {
  title: string;
  pages: PageIR[];
  schedule?: ScheduleIR;
  notifications: NotificationIR[];
  alerts: AlertIR[];
}

export interface PageIR {
  title: string;
  charts: ChartIR[];
  filters: FilterIR[];
  params: ParamIR[];
  layout: LayoutIR;
  variables: Record<string, unknown>;
  layoutDiagnostics?: LayoutDiagnostic[];
}

// ---- Param ----

export interface ParamIR {
  name: string;
  paramType: ParamType;
  defaultValue?: unknown;
}

// ---- Dashboard ----

export interface DashboardIR {
  title: string;
  charts: ChartIR[];
  filters: FilterIR[];
  params: ParamIR[];
  schedule?: ScheduleIR;
  notifications: NotificationIR[];
  alerts: AlertIR[];
  layout: LayoutIR;
  variables: Record<string, unknown>;
  refreshInterval?: number;
  layoutDiagnostics?: LayoutDiagnostic[];
  /** Block names this dashboard/block depends on via ref() calls */
  dependencies?: string[];
}

export interface ChartIR {
  id: string;
  chartType: ChartType;
  sql: string;
  sqlParams: SQLParam[];
  config: ChartConfig;
  interaction?: InteractionConfig;
  title?: string;
  theme?: string;
  condition?: string;
  cacheTTL?: number;
  connection?: string;
  annotations?: AnnotationIR[];
  materializeRefresh?: string;
  blockType?: 'semantic' | 'custom';
  drillConfig?: DrillConfigIR;
}

export interface AnnotationIR {
  x?: string;
  y?: number;
  label: string;
  color?: string;
}

export interface InteractionConfig {
  onClick?: string;
  drillDown?: string;
  linkTo?: string;
  filterBy?: string | string[];
}

export interface ChartConfig {
  x?: string;
  y?: string;
  y2?: string;
  color?: string;
  facet?: string;
  size?: string;
  colorField?: string;
  lineWidth?: number;
  fillOpacity?: number;
  barWidth?: number;
  innerRadius?: number;
  orientation?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  titleFontSize?: number;
  showGrid?: boolean;
  showLegend?: boolean;
  width?: number;
  height?: number;
  strokeDash?: string;
  metrics?: string[];
  compareToPrevious?: boolean;
  formatting?: string;
  columns?: string[];
  sortable?: boolean;
  pageSize?: number;
  tooltip?: string[];
  formatX?: string;
  formatY?: string;
  colorRule?: string;
  pinColumns?: string[];
  rowColor?: string;
  drillHierarchy?: string;
  drillPath?: string;
  drillMode?: 'modal' | 'replace' | 'expand';
  topologyUrl?: string;
}

export interface DrillConfigLevelIR {
  name: string;
  dimension: string;
}

export interface DrillConfigIR {
  hierarchy: string;
  path?: string;
  mode: 'modal' | 'replace' | 'expand';
  currentLevel?: string;
  rollup?: 'sum' | 'count' | 'count_distinct' | 'avg' | 'min' | 'max' | 'none';
  levels?: DrillConfigLevelIR[];
}

export interface SQLParam {
  name: string;
  position: number;
  literalValue?: unknown;
}

export interface ScheduleIR {
  cron: string;
  timezone?: string;
}

export interface NotificationIR {
  type: 'email' | 'slack';
  recipients: string[];
}

export interface NarrativeIR {
  /** User-supplied prompt describing what the narrative should cover. */
  prompt: string;
  /** Block names referenced via `sources = [ref("…")]`. Supplies the allow-list of citable sources. */
  sources: string[];
}

export interface DigestIR extends DashboardIR {
  narrative?: NarrativeIR;
}

export interface AlertIR {
  conditionSQL: string;
  threshold?: number;
  operator?: '>' | '<' | '>=' | '<=' | '==' | '!=';
  message?: string;
}

export interface FilterIR {
  id: string;
  filterType: FilterType;
  sql?: string;
  sqlParams: SQLParam[];
  label: string;
  param: string;
  defaultValue?: string | string[];
  placeholder?: string;
  options?: FilterOptionConfig;
}

export interface FilterOptionConfig {
  format?: string;
  debounce?: number;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
}

export interface LayoutIR {
  type: 'grid';
  columns: number;
  items: LayoutItemIR[];
}

export interface LayoutItemIR {
  chartId: string;
  gridColumn: string;
  gridRow: string;
}

export interface LayoutDiagnostic {
  level: 'warning' | 'error';
  message: string;
  row?: number;
  chartId?: string;
}
