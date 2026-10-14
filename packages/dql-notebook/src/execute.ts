import {
  NodeKind,
  blockSemanticRuntimeBindings,
  parse,
  type BlockDeclNode,
  type DecoratorNode,
  type ExpressionNode,
  type NamedArgNode,
  type SemanticLayer,
} from '@zlens/core';
import type { SQLParamSpec } from '@zlens/connectors';
import type { NotebookCell, NotebookChartConfig } from './document.js';
import { resolveSemanticRefs, hasSemanticRefs } from './semantic-refs.js';

export interface NotebookExecutionPlan {
  title: string;
  sql: string;
  sqlParams: SQLParamSpec[];
  variables: Record<string, unknown>;
  chartConfig?: NotebookChartConfig;
  tests: Array<{ field: string; operator: string; expected: unknown }>;
}

export interface BuildExecutionPlanOptions {
  semanticLayer?: SemanticLayer;
  /**
   * SQL compiled by the already-selected semantic adapter. When present it is
   * authoritative; notebook planning only adds chart, parameter, variable, and
   * test metadata and must not try a second native semantic compilation.
   */
  semanticSql?: string;
  /** Driver name for SQL dialect selection (e.g. 'snowflake', 'bigquery'). */
  driver?: string;
  /** Maps semantic table names to actual database table names, e.g. order_items -> dev.order_items. */
  tableMapping?: Record<string, string>;
  /** Resolved typed values from the shared block invocation contract. */
  parameters?: Record<string, unknown>;
}

export function buildExecutionPlan(
  cell: NotebookCell,
  options?: BuildExecutionPlanOptions,
): NotebookExecutionPlan | null {
  if (cell.type === 'markdown' || cell.type === 'chart') {
    return null;
  }

  if (cell.type === 'sql') {
    // Resolve @metric(name) and @dim(name) references in SQL cells
    let resolvedSql = cell.source;
    if (options?.semanticLayer && hasSemanticRefs(cell.source)) {
      const resolution = resolveSemanticRefs(cell.source, options.semanticLayer, {
        tableMapping: options.tableMapping,
      });
      if (resolution.unresolvedRefs.length > 0) {
        throw new Error(
          `Unresolved semantic references in SQL cell: ${resolution.unresolvedRefs.join(', ')}. ` +
          'Check that these metrics/dimensions exist in your semantic layer.',
        );
      }
      resolvedSql = resolution.resolvedSql;
    }
    return {
      title: cell.title || 'SQL cell',
      sql: resolvedSql,
      sqlParams: [],
      variables: {},
      chartConfig: cell.config,
      tests: [],
    };
  }

  const program = parse(cell.source);
  const block = program.statements.find((statement) => statement.kind === NodeKind.BlockDecl) as BlockDeclNode | undefined;

  if (!block) {
    throw new Error('ZLens notebook cells must contain a block declaration.');
  }

  // Semantic blocks: compose SQL from the semantic layer
  if (block.blockType === 'semantic') {
    return buildSemanticPlan(
      block,
      options?.semanticLayer,
      options?.driver,
      options?.tableMapping,
      options?.parameters,
      options?.semanticSql,
    );
  }

  if (block.blockType !== 'custom') {
    throw new Error(`Unsupported block type "${block.blockType}". Only "custom" and "semantic" blocks can run in the notebook.`);
  }
  if (!block.query) {
    throw new Error('ZLens notebook block is missing a query field.');
  }

  const processed = applyRLSDecorators(
    block.decorators,
    processSQL(block.query.rawSQL, block.query.interpolations),
  );
  const chartConfig = block.visualization ? lowerChartConfig(block.visualization.properties) : undefined;
  const variables = Object.fromEntries(
    (block.params?.params ?? [])
      .filter((param) => param.initializer)
      .map((param) => [param.name, evaluateExpression(param.initializer!)]),
  );

  return {
    title: block.name,
    sql: processed.sql,
    sqlParams: processed.params,
    variables,
    chartConfig,
    tests: (block.tests ?? []).map((test) => ({
      field: test.field,
      operator: test.operator,
      expected: evaluateExpression(test.expected),
    })),
  };
}

function lowerChartConfig(properties: NamedArgNode[]): NotebookChartConfig {
  const config: NotebookChartConfig = {};

  for (const property of properties) {
    const value = evaluateExpression(property.value);
    switch (property.name) {
      case 'chart':
        config.chart = String(value);
        break;
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
    }
  }

  return config;
}

function processSQL(
  rawSQL: string,
  interpolations: Array<{ variableName: string; offsetInSQL: number }>,
): { sql: string; params: SQLParamSpec[] } {
  if (interpolations.length === 0) {
    return { sql: rawSQL, params: [] };
  }

  let sql = rawSQL;
  const params: SQLParamSpec[] = [];
  const sorted = [...interpolations].sort((a, b) => b.offsetInSQL - a.offsetInSQL);
  let position = interpolations.length;

  for (const interpolation of sorted) {
    const placeholder = `$${position}`;
    const from = interpolation.offsetInSQL;
    const rest = sql.slice(from);
    const pattern = new RegExp(`^\\$\\{${interpolation.variableName}\\}|^\\{${interpolation.variableName}\\}`);
    const match = rest.match(pattern);
    if (!match) {
      position -= 1;
      continue;
    }

    sql = sql.slice(0, from) + placeholder + sql.slice(from + match[0].length);
    params.unshift({ name: interpolation.variableName, position });
    position -= 1;
  }

  return { sql, params };
}

function buildSemanticPlan(
  block: BlockDeclNode,
  semanticLayer?: SemanticLayer,
  driver?: string,
  tableMapping?: Record<string, string>,
  parameters?: Record<string, unknown>,
  semanticSql?: string,
): NotebookExecutionPlan {
  if (!semanticLayer) {
    throw new Error(
      'Semantic block requires a semantic-layer/ configuration. ' +
      'Add metric and dimension YAML files to your project\'s semantic-layer/ directory.',
    );
  }

  // Extract metric references: metricsRef (array) takes precedence over metricRef (single)
  const metrics: string[] = [];
  const dimensions: string[] = [];

  if (block.metricsRef && block.metricsRef.length > 0) {
    metrics.push(...block.metricsRef);
  } else if (block.metricRef) {
    metrics.push(block.metricRef);
  }
  if (block.dimensionsRef && block.dimensionsRef.length > 0) {
    dimensions.push(...block.dimensionsRef);
  }

  // Also extract dimensions/metrics from block params if they reference names
  for (const param of block.params?.params ?? []) {
    if (!param.initializer) continue;
    const val = evaluateExpression(param.initializer);
    if (param.name === 'dimensions' && Array.isArray(val)) {
      dimensions.push(...val.map(String));
    } else if (param.name === 'metrics' && Array.isArray(val)) {
      metrics.push(...val.map(String));
    }
  }

  if (metrics.length === 0) {
    throw new Error(
      `Semantic block "${block.name}" has no metric references. ` +
      'Add metrics = ["metric1", "metric2"] to your block declaration.',
    );
  }

  const runtimeBindings = blockSemanticRuntimeBindings(block, parameters);
  const composed = semanticSql
    ? { sql: semanticSql }
    : semanticLayer.composeQuery({
        metrics,
        dimensions,
        ...(block.timeDimension && block.granularity
          ? { timeDimension: { name: block.timeDimension, granularity: block.granularity } }
          : {}),
        ...(runtimeBindings.filters.length > 0 ? { filters: runtimeBindings.filters } : {}),
        ...((runtimeBindings.limit ?? block.limit) !== undefined
          ? { limit: runtimeBindings.limit ?? block.limit }
          : {}),
        driver,
        tableMapping,
      });
  if (!composed) {
    // Distinguish the three real causes instead of sending users to check
    // definitions that are usually fine: (a) the metric genuinely is not
    // defined, (b) it exists but is a derived/ratio/cumulative metric DQL
    // cannot compose natively (needs dbt Cloud Semantic Layer or local
    // MetricFlow), (c) everything resolves but the dimension set is unjoinable.
    const reasons = metrics.map((name) => {
      if (semanticLayer.canComposeMetric(name)) return null;
      const metric = semanticLayer.getMetric(name);
      if (!metric) return `metric "${name}" is not defined in the semantic layer`;
      const kind = metric.metricType || metric.type || 'metric';
      return `metric "${name}" exists but is a ${kind} metric ZLens cannot compose natively — run it through a full semantic runtime (dbt Cloud Semantic Layer or local MetricFlow)`;
    }).filter((reason): reason is string => Boolean(reason));
    throw new Error(
      reasons.length > 0
        ? `Could not compose SQL for semantic block "${block.name}": ${reasons.join('; ')}.`
        : `Could not compose SQL for semantic block "${block.name}". The metrics resolved, but the selected dimensions do not share a governed join path with them — remove or replace the unjoinable dimension.`,
    );
  }

  const chartConfig = block.visualization ? lowerChartConfig(block.visualization.properties) : undefined;
  const variables = Object.fromEntries(
    (block.params?.params ?? [])
      .filter((param) => param.initializer)
      .map((param) => [param.name, evaluateExpression(param.initializer!)]),
  );

  const processed = applyRLSDecorators(block.decorators, { sql: composed.sql, params: [] });

  return {
    title: block.name,
    sql: processed.sql,
    sqlParams: processed.params,
    variables,
    chartConfig,
    tests: (block.tests ?? []).map((test) => ({
      field: test.field,
      operator: test.operator,
      expected: evaluateExpression(test.expected),
    })),
  };
}

const SAFE_RLS_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const RLS_TEMPLATE_VARIABLE = /^\{([A-Za-z_][A-Za-z0-9_.]*)\}$/;

function applyRLSDecorators(
  decorators: DecoratorNode[],
  processed: { sql: string; params: SQLParamSpec[] },
): { sql: string; params: SQLParamSpec[] } {
  const rlsDecorators = decorators.filter((d) => d.name === 'rls');
  if (rlsDecorators.length === 0) return processed;

  const clauses: string[] = [];
  const params = [...processed.params];
  let nextPosition = params.reduce((max, p) => Math.max(max, p.position), 0);
  let literalCounter = 0;

  for (const rls of rlsDecorators) {
    if (rls.arguments.length < 2) continue;
    const column = normalizeRLSColumn(rls.arguments[0]);
    if (!column) continue;
    const binding = resolveRLSValueBinding(rls.arguments[1]);
    if (!binding) continue;
    nextPosition += 1;
    if (binding.type === 'variable') {
      params.push({ name: binding.variableName, position: nextPosition });
    } else {
      literalCounter += 1;
      params.push({
        name: `__rls_literal_${literalCounter}`,
        position: nextPosition,
        literalValue: binding.literalValue,
      });
    }
    clauses.push(`${column} = COALESCE($${nextPosition}, ${column})`);
  }

  if (clauses.length === 0) return { sql: processed.sql, params };
  return {
    sql: `SELECT * FROM (${processed.sql}) _dql_rls WHERE ${clauses.join(' AND ')}`,
    params,
  };
}

function normalizeRLSColumn(arg: ExpressionNode): string | null {
  const raw = arg.kind === NodeKind.StringLiteral
    ? arg.value
    : arg.kind === NodeKind.Identifier
      ? arg.name
      : evaluateExpression(arg);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return SAFE_RLS_COLUMN.test(trimmed) ? trimmed : null;
}

function resolveRLSValueBinding(
  arg: ExpressionNode,
): { type: 'variable'; variableName: string } | { type: 'literal'; literalValue: unknown } | null {
  if (arg.kind === NodeKind.StringLiteral) {
    const raw = String(arg.value ?? '');
    const match = raw.trim().match(RLS_TEMPLATE_VARIABLE);
    if (match) return { type: 'variable', variableName: match[1] };
    return { type: 'literal', literalValue: raw };
  }
  if (arg.kind === NodeKind.Identifier) return { type: 'variable', variableName: arg.name };
  if (arg.kind === NodeKind.NumberLiteral || arg.kind === NodeKind.BooleanLiteral) {
    return { type: 'literal', literalValue: arg.value };
  }
  const value = evaluateExpression(arg);
  if (value !== undefined) return { type: 'literal', literalValue: value };
  return null;
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
      return node.elements.map((element) => evaluateExpression(element));
    case NodeKind.IntervalExpr:
      return node.value;
    case NodeKind.BinaryExpr:
      return `${evaluateExpression(node.left)} ${node.operator} ${evaluateExpression(node.right)}`;
    case NodeKind.FunctionCall:
      return node.callee;
    case NodeKind.TemplateString:
      return node.parts.map((part) => (typeof part === 'string' ? part : String(evaluateExpression(part)))).join('');
  }
}
