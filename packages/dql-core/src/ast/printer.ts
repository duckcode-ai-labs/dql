import type {
  ExpressionNode,
  ProgramNode,
  DashboardNode,
  ChartCallNode,
  FilterCallNode,
  VariableDeclNode,
  DecoratorNode,
  SQLQueryNode,
  NamedArgNode,
  StatementNode,
  WorkbookNode,
  BlockDeclNode,
  DomainDeclNode,
  TermDeclNode,
  BusinessViewDeclNode,
} from './nodes.js';
import { datasetBlockSectionLines } from './dataset-sections.js';
import { NodeKind } from './nodes.js';

export function printAST(node: ProgramNode): string {
  let result = 'Program\n';
  for (const stmt of node.statements) {
    result += printStatement(stmt, 1);
  }
  return result;
}

function printStatement(node: StatementNode, indent: number): string {
  switch (node.kind) {
    case NodeKind.Dashboard:
      return printDashboard(node, indent);
    case NodeKind.ChartCall:
      return printChart(node, indent);
    case NodeKind.Workbook:
      return printWorkbook(node, indent);
    case NodeKind.ImportDecl:
      return `${'  '.repeat(indent)}Import [${node.names.join(', ')}] from "${node.path}"\n`;
    case NodeKind.BlockDecl:
      return printBlockDecl(node, indent);
    case NodeKind.DomainDecl:
      return printDomainDecl(node, indent);
    case NodeKind.TermDecl:
      return printTermDecl(node, indent);
    case NodeKind.BusinessViewDecl:
      return printBusinessViewDecl(node, indent);
    default:
      return '';
  }
}

function printWorkbook(node: WorkbookNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}Workbook "${node.title}"\n`;
  for (const dec of node.decorators) {
    result += printDecorator(dec, indent + 1);
  }
  for (const page of node.pages) {
    result += `${prefix}  Page "${page.title}"\n`;
    for (const item of page.body) {
      switch (item.kind) {
        case NodeKind.VariableDecl:
          result += printVariable(item, indent + 2);
          break;
        case NodeKind.ChartCall:
          result += printChart(item, indent + 2);
          break;
        case NodeKind.FilterCall:
          result += printFilter(item, indent + 2);
          break;
      }
    }
  }
  return result;
}

function printDashboard(node: DashboardNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}Dashboard "${node.title}"\n`;
  for (const dec of node.decorators) {
    result += printDecorator(dec, indent + 1);
  }
  for (const item of node.body) {
    switch (item.kind) {
      case NodeKind.VariableDecl:
        result += printVariable(item, indent + 1);
        break;
      case NodeKind.ChartCall:
        result += printChart(item, indent + 1);
        break;
      case NodeKind.FilterCall:
        result += printFilter(item, indent + 1);
        break;
    }
  }
  return result;
}

function printChart(node: ChartCallNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}ChartCall .${node.chartType}\n`;
  result += `${prefix}  SQL: ${node.query.rawSQL}\n`;
  for (const arg of node.args) {
    result += printNamedArg(arg, indent + 1);
  }
  return result;
}

function printFilter(node: FilterCallNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}FilterCall .${node.filterType}\n`;
  if (node.query) {
    result += `${prefix}  SQL: ${node.query.rawSQL}\n`;
  }
  for (const arg of node.args) {
    result += printNamedArg(arg, indent + 1);
  }
  return result;
}

function printVariable(node: VariableDeclNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  return `${prefix}Let ${node.name} = ${expressionToString(node.initializer)}\n`;
}

function printDecorator(node: DecoratorNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}@${node.name}`;
  if (node.arguments.length > 0) {
    result += `(${node.arguments.map((a: ExpressionNode) => expressionToString(a)).join(', ')})`;
  }
  return result + '\n';
}

function printNamedArg(node: NamedArgNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  return `${prefix}${node.name} = ${expressionToString(node.value)}\n`;
}

function printBlockDecl(node: BlockDeclNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}Block "${node.name}"\n`;
  for (const dec of node.decorators) {
    result += printDecorator(dec, indent + 1);
  }
  if (node.domain) result += `${prefix}  domain = "${node.domain}"\n`;
  if (node.blockType) result += `${prefix}  type = "${node.blockType}"\n`;
  if (node.description) result += `${prefix}  description = "${node.description}"\n`;
  if (node.tags) result += `${prefix}  tags = [${node.tags.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.termRefs) result += `${prefix}  terms = [${node.termRefs.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.pattern) result += `${prefix}  pattern = "${node.pattern}"\n`;
  if (node.datasetGrain || node.datasetFields?.length || node.datasetMeasures?.length) {
    for (const line of datasetBlockSectionLines(node, (depth) => `${prefix}${'  '.repeat(depth)}`, (value) => JSON.stringify(value))) {
      result += `${line}\n`;
    }
  }
  if (!node.datasetGrain && node.grain) result += `${prefix}  grain = "${node.grain}"\n`;
  if (node.entities) result += `${prefix}  entities = [${node.entities.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.outputs) result += `${prefix}  outputs = [${node.outputs.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.dimensions) result += `${prefix}  dimensions = [${node.dimensions.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.allowedFilters) result += `${prefix}  allowedFilters = [${node.allowedFilters.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.sourceSystems) result += `${prefix}  sourceSystems = [${node.sourceSystems.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.replacementFor) result += `${prefix}  replacementFor = [${node.replacementFor.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.replacedBy) result += `${prefix}  replacedBy = "${node.replacedBy}"\n`;
  if (node.deprecatedOn) result += `${prefix}  deprecatedOn = "${node.deprecatedOn}"\n`;
  const metricRefs = node.metricsRef ?? (node.metricRef !== undefined ? [node.metricRef] : undefined);
  if (metricRefs) result += `${prefix}  metrics = [${metricRefs.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.dimensionsRef) result += `${prefix}  dimensions = [${node.dimensionsRef.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.query) result += `${prefix}  SQL: ${node.query.rawSQL.substring(0, 60)}...\n`;
  if (node.visualization) {
    result += `${prefix}  visualization\n`;
    for (const prop of node.visualization.properties) {
      result += printNamedArg(prop, indent + 2);
    }
  }
  if (node.tests) {
    result += `${prefix}  tests (${node.tests.length})\n`;
  }
  return result;
}

function printDomainDecl(node: DomainDeclNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}Domain "${node.name}"\n`;
  for (const dec of node.decorators) {
    result += printDecorator(dec, indent + 1);
  }
  if (node.id) result += `${prefix}  id = "${node.id}"\n`;
  if (node.parent) result += `${prefix}  parent = "${node.parent}"\n`;
  if (node.owner) result += `${prefix}  owner = "${node.owner}"\n`;
  if (node.businessOwner) result += `${prefix}  businessOwner = "${node.businessOwner}"\n`;
  if (node.boundedContext) result += `${prefix}  boundedContext = "${node.boundedContext}"\n`;
  if (node.sourceSystems) result += `${prefix}  sourceSystems = [${node.sourceSystems.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.primaryTerms) result += `${prefix}  primaryTerms = [${node.primaryTerms.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.reviewCadence) result += `${prefix}  reviewCadence = "${node.reviewCadence}"\n`;
  if (node.tags) result += `${prefix}  tags = [${node.tags.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.businessOutcome) result += `${prefix}  businessOutcome = "${node.businessOutcome}"\n`;
  if (node.description) result += `${prefix}  description = "${node.description}"\n`;
  if (node.inScope) result += `${prefix}  inScope = [${node.inScope.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.outOfScope) result += `${prefix}  outOfScope = [${node.outOfScope.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.dbtGroups) result += `${prefix}  dbtGroups = [${node.dbtGroups.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.dbtPaths) result += `${prefix}  dbtPaths = [${node.dbtPaths.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.dbtTags) result += `${prefix}  dbtTags = [${node.dbtTags.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.semanticDomains) result += `${prefix}  semanticDomains = [${node.semanticDomains.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.semanticTags) result += `${prefix}  semanticTags = [${node.semanticTags.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.exports) result += `${prefix}  exports = [${node.exports.map(t => `"${t}"`).join(', ')}]\n`;
  return result;
}

function printTermDecl(node: TermDeclNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}Term "${node.name}"\n`;
  for (const dec of node.decorators) {
    result += printDecorator(dec, indent + 1);
  }
  if (node.domain) result += `${prefix}  domain = "${node.domain}"\n`;
  if (node.termType) result += `${prefix}  type = "${node.termType}"\n`;
  if (node.status) result += `${prefix}  status = "${node.status}"\n`;
  if (node.description) result += `${prefix}  description = "${node.description}"\n`;
  if (node.tags) result += `${prefix}  tags = [${node.tags.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.owner) result += `${prefix}  owner = "${node.owner}"\n`;
  if (node.identifiers) result += `${prefix}  identifiers = [${node.identifiers.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.synonyms) result += `${prefix}  synonyms = [${node.synonyms.map(t => `"${t}"`).join(', ')}]\n`;
  return result;
}

function printBusinessViewDecl(node: BusinessViewDeclNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}BusinessView "${node.name}"\n`;
  for (const dec of node.decorators) {
    result += printDecorator(dec, indent + 1);
  }
  if (node.domain) result += `${prefix}  domain = "${node.domain}"\n`;
  if (node.status) result += `${prefix}  status = "${node.status}"\n`;
  if (node.description) result += `${prefix}  description = "${node.description}"\n`;
  if (node.tags) result += `${prefix}  tags = [${node.tags.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.owner) result += `${prefix}  owner = "${node.owner}"\n`;
  if (node.termRefs) result += `${prefix}  terms = [${node.termRefs.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.includes.length > 0) {
    result += `${prefix}  includes\n`;
    for (const ref of node.includes) {
      result += `${prefix}    ${ref.refType} "${ref.name}"\n`;
    }
  }
  return result;
}

function expressionToString(node: ExpressionNode): string {
  switch (node.kind) {
    case NodeKind.StringLiteral:
      return `"${node.value}"`;
    case NodeKind.NumberLiteral:
      return String(node.value);
    case NodeKind.BooleanLiteral:
      return String(node.value);
    case NodeKind.Identifier:
      return node.name;
    case NodeKind.ArrayLiteral:
      return `[${node.elements.map(expressionToString).join(', ')}]`;
    case NodeKind.BinaryExpr:
      return `(${expressionToString(node.left)} ${node.operator} ${expressionToString(node.right)})`;
    case NodeKind.IntervalExpr:
      return `INTERVAL '${node.value}'`;
    case NodeKind.FunctionCall:
      return `${node.callee}(${node.arguments.map(expressionToString).join(', ')})`;
    case NodeKind.TemplateString:
      return node.parts
        .map((p) => (typeof p === 'string' ? p : `{${expressionToString(p)}}`))
        .join('');
  }
}
