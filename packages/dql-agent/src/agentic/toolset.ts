/** @deprecated Superseded by the Ask pipeline (`ask-pipeline/pipeline.ts`); kept one release as a public export with no runtime consumer, removed in the next. */
/**
 * Stage-B semantic toolset.
 *
 * These tools are built from the answer-loop's own in-scope objects — the resolved
 * `SemanticLayer` and the `KGStore` — with NO dependency on the MCP DQLContext or
 * a live server, so the answer loop can hand them to the agentic tool loop
 * directly. They are the governed half of Stage B's tool surface (the host's
 * warehouse/validation tools — search_metadata, get_table_schema, validate_sql,
 * query_via_block — are merged in from `input.answerLoopTools`).
 *
 * Governance lives here, in the backends:
 *   - `compile_semantic_query` is the ONLY way to produce SQL the pipeline will
 *     label "governed": it runs `composeSemanticQueryFromMembers`, which validates
 *     every member against the layer and REFUSES hallucinated dimensions. The model
 *     never writes governed SQL itself.
 *   - `search_semantic_layer` / `scan_manifest` are read-only discovery.
 */

import { semanticDimensionReference, type SemanticLayer } from '@zlens/core';
import type { AgentToolDefinition } from '../providers/types.js';
import type { KGStore } from '../kg/sqlite-fts.js';
import type { KGNode, KGNodeKind } from '../kg/types.js';
import {
  composeSemanticQueryFromCompiledMembers,
  composeSemanticQueryFromMembers,
  type SemanticBridgeFilter,
  type SemanticBridgeOrderBy,
  type SemanticMemberSelection,
} from '../semantic-bridge/compose.js';

export interface SemanticStageToolsInput {
  semanticLayer?: SemanticLayer;
  kg: KGStore;
  driver?: string;
  tableMapping?: Record<string, string>;
  /** Host-owned dbt Cloud/MetricFlow compiler used when the native compiler cannot compose a member set. */
  semanticQueryCompiler?: (selection: SemanticMemberSelection) => Promise<{
    sql: string;
    engine: 'native' | 'metricflow-cli' | 'dbt-cloud';
    /** The compiler may add deterministic requirements such as metric_time. */
    selection?: SemanticMemberSelection;
  }>;
  /** Records the compiled result of the last successful compile_semantic_query call. */
  onCompiled?: (result: {
    sql: string;
    metrics: string[];
    dimensions: string[];
    dqlArtifactSource: string;
    engine?: 'native' | 'metricflow-cli' | 'dbt-cloud';
  }) => void;
}

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/**
 * Build the governed Stage-B tools (semantic search, compile, manifest scan). When
 * no semantic layer is configured, the compile/search tools are omitted (there is
 * nothing to compile against) and only `scan_manifest` is returned.
 */
export function buildSemanticStageTools(input: SemanticStageToolsInput): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [scanManifestTool(input.kg)];
  if (input.semanticLayer) {
    tools.unshift(searchSemanticLayerTool(input.semanticLayer));
    tools.push(compileSemanticQueryTool(input));
    tools.push(checkCompatibilityTool(input.semanticLayer));
    tools.push(explainMetricTool(input.semanticLayer));
  }
  return tools;
}

/**
 * Ask whether a metric can actually be sliced by the requested dimensions —
 * BEFORE composing a query that cannot compile.
 *
 * This is the tool that turns a modeling gap from a terminal state into a fact
 * the agent can route around. Today an unreachable dimension surfaces as a
 * `modeling_gap` refusal ("the semantic models don't declare a join path…
 * Nothing was executed"), which is true and useless: it ends the turn instead of
 * offering the dimensions that ARE reachable. `explainCompatibleDimensions`
 * already computes both halves with typed reasons — it was simply never exposed
 * where the agent could ask.
 */
/**
 * Explain what a governed metric MEANS, without computing it.
 *
 * The loop can find a metric and compile it, but it could not read its
 * definition — so a question about meaning ("what counts as revenue here?", "why
 * is this different from bookings?") had to be answered by running the number
 * and describing the output, which answers a different question.
 *
 * Everything here is already in the semantic layer. Surfacing it also gives the
 * loop a cheap way to DISAMBIGUATE: two similarly named metrics are usually
 * distinguishable from their expression and filters alone, with no execution.
 */
function explainMetricTool(layer: SemanticLayer): AgentToolDefinition {
  return {
    name: 'explain_metric',
    description:
      'Read a governed metric\'s definition: its expression, aggregation, backing table, filters, owner, and description. Use it to answer what a metric MEANS, and to tell two similarly named metrics apart, without running a query.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['metric'],
      properties: {
        metric: { type: 'string', description: 'Metric name exactly as returned by search_semantic_layer.' },
      },
    },
    run: async (args) => {
      const { metric } = objectArg(args);
      const name = typeof metric === 'string' ? metric.trim() : '';
      if (!name) return { error: 'Pass a governed metric name from search_semantic_layer.' };
      const all = layer.listMetrics(undefined, { includeMeasures: true });
      const found = all.find((entry) => entry.name === name)
        ?? all.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
        // A leaf match, so `orders.revenue` finds `revenue` and vice versa.
        ?? all.find((entry) => entry.name.toLowerCase().split('.').pop() === name.toLowerCase().split('.').pop());
      if (!found) {
        // Name the near misses rather than just failing: a wrong metric name is
        // usually a near miss, and the alternatives are the correction.
        const nearby = all
          .filter((entry) => entry.name.toLowerCase().includes(name.toLowerCase().split('.').pop() ?? ''))
          .slice(0, 5)
          .map((entry) => entry.name);
        return {
          found: false,
          error: `No governed metric named "${name}".`,
          ...(nearby.length > 0 ? { didYouMean: nearby } : {}),
        };
      }
      return {
        found: true,
        name: found.name,
        label: found.label,
        description: found.description,
        expression: found.sql,
        aggregation: found.aggregation ?? found.type,
        table: found.table,
        domain: found.domain,
        ...(found.owner ? { owner: found.owner } : {}),
        ...(found.status ? { status: found.status } : {}),
        // Filters baked into the definition are the usual reason two similar
        // metrics disagree, so they are reported explicitly.
        ...(found.filters && Object.keys(found.filters).length > 0 ? { definitionFilters: found.filters } : {}),
        ...(typeof found.filter === 'string' && found.filter ? { definitionFilter: found.filter } : {}),
        ...(found.semanticModelIds?.length ? { semanticModels: found.semanticModelIds } : {}),
      };
    },
  };
}

function checkCompatibilityTool(layer: SemanticLayer): AgentToolDefinition {
  return {
    name: 'check_compatibility',
    description:
      'Check whether governed metrics can be grouped by the requested dimensions. Returns the compatible dimensions and, for each incompatible one, WHY (no_join_path, one_to_many_only, not_shared_across_metrics, metric_unresolved; one_to_many_only means the only path walks a join one-to-many, which would repeat each metric value, so no governed query can group by it). Call this before compile_semantic_query when a question asks for a breakdown, and use the compatible list to pick an alternative instead of giving up.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['metrics'],
      properties: {
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Governed metric names, exactly as returned by search_semantic_layer.',
        },
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional dimensions to check. Omit to list everything the metric set can be sliced by.',
        },
        limit: { type: 'number', description: 'Max compatible dimensions to return. Default 25.' },
      },
    },
    run: async (args) => {
      const { metrics, dimensions, limit } = objectArg(args);
      const metricNames = Array.isArray(metrics) ? metrics.filter((m): m is string => typeof m === 'string') : [];
      if (metricNames.length === 0) {
        return { error: 'Pass at least one governed metric name from search_semantic_layer.' };
      }
      const max = typeof limit === 'number' && limit > 0 ? Math.min(limit, 100) : 25;
      const explained = layer.explainCompatibleDimensions(metricNames);
      const requested = Array.isArray(dimensions)
        ? dimensions.filter((d): d is string => typeof d === 'string')
        : [];
      const matches = (candidate: string, name: string): boolean => {
        const left = candidate.toLowerCase();
        const right = name.toLowerCase();
        return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
      };
      const compatible = explained.compatible.map((dimension) => ({
        name: dimension.qualifiedName ?? dimension.name,
        label: dimension.label,
        ...(dimension.entityPath?.length ? { via: dimension.entityPath } : {}),
      }));
      // When the caller named dimensions, answer about THOSE first — a verdict on
      // the question actually asked, with the alternatives kept alongside.
      const verdicts = requested.map((name) => {
        const ok = explained.compatible.find((d) => matches(d.qualifiedName ?? d.name, name));
        if (ok) {
          return { dimension: name, compatible: true as const, resolvedName: ok.qualifiedName ?? ok.name };
        }
        const blocked = explained.incompatible.find((d) => matches(d.qualifiedName ?? d.name, name));
        return {
          dimension: name,
          compatible: false as const,
          reason: blocked?.reason ?? 'not_modeled',
          explanation: blocked?.reason === 'no_join_path'
            ? 'No declared join path reaches this dimension from the metric. Pick one of the compatible dimensions, or the modeling has to change.'
            : blocked?.reason === 'one_to_many_only'
              ? layer.explainDimensionGap(metricNames, name)
                ?? 'This dimension is reachable only through a one-to-many join, which would repeat each metric value. Pick one of the compatible dimensions, or the modeling has to change.'
              : blocked?.reason === 'not_shared_across_metrics'
                ? 'One metric in the set cannot reach this dimension. Ask about the metrics separately, or drop the one that cannot.'
                : blocked?.reason === 'metric_unresolved'
                  ? 'A named metric does not exist in the semantic layer. Re-check the name with search_semantic_layer.'
                  : 'This dimension is not modeled for these metrics.',
        };
      });
      return {
        metrics: metricNames,
        ...(verdicts.length > 0 ? { requested: verdicts } : {}),
        compatibleDimensions: compatible.slice(0, max),
        compatibleCount: compatible.length,
        incompatibleCount: explained.incompatible.length,
      };
    },
  };
}

function searchSemanticLayerTool(layer: SemanticLayer): AgentToolDefinition {
  return {
    name: 'search_semantic_layer',
    description:
      'Search the governed semantic layer for metrics and dimensions matching a question. Returns member NAMES to pass to compile_semantic_query, with labels, descriptions, and backing tables. Use this before compile_semantic_query.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language terms, e.g. "tax by region and product".' },
        limit: { type: 'number', description: 'Max members per kind. Default 8.' },
      },
    },
    run: async (args) => {
      const { query, limit } = objectArg(args);
      const terms = tokenizeQuery(typeof query === 'string' ? query : '');
      const max = typeof limit === 'number' && limit > 0 ? Math.min(limit, 25) : 8;
      const metrics = rankSemanticMembers(
        layer.listMetrics(undefined, { includeMeasures: false }).map((m) => ({
          name: m.name,
          label: m.label,
          description: m.description,
          table: m.table,
          tags: m.tags,
          semanticModelIds: m.semanticModelIds ?? (m.cube ? [m.cube] : []),
        })),
        terms,
      ).slice(0, max);
      const compatibilityByMetric = new Map<string, string[]>();
      const compatibleDimensionReferences = new Set<string>();
      for (const metric of metrics) {
        const compatible = layer.explainCompatibleDimensions([metric.name]).compatible
          .map(semanticDimensionReference);
        compatibilityByMetric.set(metric.name, compatible);
        for (const reference of compatible) compatibleDimensionReferences.add(reference);
      }
      const metricCards = metrics.map((metric) => ({
        ...metric,
        compatibleDimensions: compatibilityByMetric.get(metric.name) ?? [],
      }));
      const dimensions = rankSemanticMembers(
        layer.listDimensions(undefined, { includeVariants: true })
          .filter((dimension) => compatibleDimensionReferences.has(semanticDimensionReference(dimension)))
          .map((d) => ({
            name: semanticDimensionReference(d),
            label: d.label,
            description: d.description,
            table: d.table,
            tags: d.tags,
            semanticModelId: d.cube,
            qualifiedName: d.qualifiedName,
          })),
        terms,
      ).slice(0, max);
      const timeDimensions = layer.listTimeDimensions(undefined, { includeVariants: true })
        .filter((dimension) => compatibleDimensionReferences.has(semanticDimensionReference(dimension)))
        .map((d) => ({
          name: semanticDimensionReference(d),
          label: d.label,
          granularities: (d as { granularities?: string[] }).granularities,
        }));
      return {
        metrics: metricCards,
        dimensions,
        timeDimensions,
        note: metrics.length === 0 && dimensions.length === 0
          ? 'No semantic members matched. Try scan_manifest, or fall back to grounded SQL via search_metadata + get_table_schema.'
          : 'Pass member names to compile_semantic_query. The compiler owns the SQL and will refuse members that do not exist.',
      };
    },
  };
}

function compileSemanticQueryTool(input: SemanticStageToolsInput): AgentToolDefinition {
  const layer = input.semanticLayer!;
  return {
    name: 'compile_semantic_query',
    description:
      'Compile a governed SQL query from EXPLICIT semantic members (metrics + dimensions + optional time grain/filters). This is the governed path: the compiler validates every member and joins tables via the semantic graph. Prefer this over hand-written SQL whenever the semantic layer covers the question. Returns compiled SQL, or a refusal reason (e.g. a member that does not exist or an uncomposable metric×dimension pair) so you can adjust and retry.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['metrics'],
      properties: {
        metrics: { type: 'array', items: { type: 'string' }, description: 'Semantic metric names (from search_semantic_layer).' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Semantic dimension names to group by.' },
        timeDimension: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'granularity'],
          properties: { name: { type: 'string' }, granularity: { type: 'string' } },
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['dimension', 'operator', 'values'],
            properties: {
              dimension: { type: 'string' },
              operator: { type: 'string' },
              values: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        orderBy: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'direction'],
            properties: { name: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } },
          },
        },
        limit: { type: 'number' },
      },
    },
    run: async (args) => {
      const record = objectArg(args);
      const metrics = stringArray(record.metrics);
      if (metrics.length === 0) return { error: 'Provide at least one metric name.' };
      const selection: SemanticMemberSelection = {
        metrics,
        dimensions: stringArray(record.dimensions),
        timeDimension: parseTimeDimension(record.timeDimension),
        filters: parseFilters(record.filters),
        orderBy: parseOrderBy(record.orderBy),
        limit: typeof record.limit === 'number' ? record.limit : undefined,
      };
      let compiled = composeSemanticQueryFromMembers({
        semanticLayer: layer,
        question: typeof record.question === 'string' ? record.question : metrics.join(', '),
        selection,
        driver: input.driver,
        tableMapping: input.tableMapping,
      });
      let compiledEngine: 'native' | 'metricflow-cli' | 'dbt-cloud' = 'native';
      if (!compiled && input.semanticQueryCompiler) {
        try {
          const external = await input.semanticQueryCompiler(selection);
          compiledEngine = external.engine;
          compiled = composeSemanticQueryFromCompiledMembers({
            semanticLayer: layer,
            question: typeof record.question === 'string' ? record.question : metrics.join(', '),
            selection: external.selection ?? selection,
            sql: external.sql,
          });
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            runtimeRequired: true,
          };
        }
      }
      if (!compiled) {
        return {
          error:
            'The compiler could not produce governed SQL for these members. A member may not exist, or the metric×dimension pair may be uncomposable (unjoinable dimension, derived metric). Re-check names with search_semantic_layer, drop the offending dimension, or fall back to grounded SQL.',
        };
      }
      input.onCompiled?.({
        sql: compiled.sql,
        metrics: compiled.metrics,
        dimensions: compiled.dimensions,
        dqlArtifactSource: compiled.dqlArtifact.source,
        engine: compiledEngine,
      });
      return {
        governed: true,
        sql: compiled.sql,
        metrics: compiled.metrics,
        dimensions: compiled.dimensions,
        engine: compiledEngine,
        note: `Governed SQL compiled from the semantic layer through ${compiledEngine}. Use this SQL verbatim in your final answer; it is labeled governed.`,
      };
    },
  };
}

function scanManifestTool(kg: KGStore): AgentToolDefinition {
  return {
    name: 'scan_manifest',
    description:
      'Grep-style, index-independent scan over the live project graph (certified blocks, metrics, dimensions, dbt models). Returns objects whose name/description/context contains ALL query terms, then ANY. Use when FTS search misses or you want a fresh, ranking-free lookup.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Terms to scan for, e.g. "tax region product".' },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional node-kind filter, e.g. ["block","metric","dimension","dbt_model"]. Default all.',
        },
        limit: { type: 'number', description: 'Max results. Default 20.' },
      },
    },
    run: async (args) => {
      const record = objectArg(args);
      const terms = tokenizeQuery(typeof record.query === 'string' ? record.query : '');
      const kinds = stringArray(record.kinds).filter(isKgNodeKind);
      const scanKinds: KGNodeKind[] = kinds.length > 0 ? kinds : ['block', 'metric', 'dimension', 'measure', 'entity', 'semantic_model', 'dbt_model', 'dbt_source', 'term', 'business_view'];
      const max = typeof record.limit === 'number' && record.limit > 0 ? Math.min(record.limit, 50) : 20;
      // Prefer the graph's ranked FTS path. The former first-500-per-kind scan
      // made a relevant metric/model invisible solely because it sorted late.
      const indexed = terms.length > 0
        ? kg.search({ query: typeof record.query === 'string' ? record.query : '', kinds: scanKinds, limit: max })
        : [];
      if (indexed.length > 0) {
        return {
          total: indexed.length,
          returned: indexed.length,
          objects: indexed.map((entry) => ({
            id: entry.node.nodeId,
            kind: entry.node.kind,
            name: entry.node.name,
            domain: entry.node.domain ?? null,
            status: entry.node.status ?? null,
            description: entry.node.description ?? null,
          })),
        };
      }
      // Index-independent repair remains available, but examines complete
      // compact node headers rather than an arbitrary alphabetical prefix.
      const nodes: KGNode[] = scanKinds.flatMap((kind) => kg.getNodesByKind(kind, 100_000));
      const scored = nodes
        .map((node) => {
          const haystack = `${node.name} ${node.description ?? ''} ${node.llmContext ?? ''} ${(node.tags ?? []).join(' ')}`.toLowerCase();
          const nameHay = node.name.toLowerCase();
          let matched = 0;
          let nameMatched = 0;
          for (const term of terms) {
            if (haystack.includes(term)) matched += 1;
            if (nameHay.includes(term)) nameMatched += 1;
          }
          return { node, matched, nameMatched };
        })
        .filter((entry) => terms.length === 0 || entry.matched > 0);
      const allTerms = scored.filter((entry) => entry.matched === terms.length);
      const pool = allTerms.length > 0 ? allTerms : scored;
      const results = pool
        .sort((a, b) => b.nameMatched - a.nameMatched || b.matched - a.matched || a.node.name.localeCompare(b.node.name))
        .slice(0, max)
        .map((entry) => ({
          id: entry.node.nodeId,
          kind: entry.node.kind,
          name: entry.node.name,
          domain: entry.node.domain ?? null,
          status: entry.node.status ?? null,
          description: entry.node.description ?? null,
        }));
      return { total: pool.length, returned: results.length, objects: results };
    },
  };
}

interface RankableMember {
  name: string;
  label?: string;
  description?: string;
  table?: string;
  tags?: string[];
}

function rankSemanticMembers<T extends RankableMember>(members: T[], terms: string[]): T[] {
  if (terms.length === 0) {
    return members.slice(0, 25);
  }
  return members
    .map((member) => {
      const haystack = `${member.name} ${member.name.replace(/[_.]+/g, ' ')} ${member.label ?? ''} ${member.description ?? ''} ${(member.tags ?? []).join(' ')}`.toLowerCase();
      const name = `${member.name} ${member.name.replace(/[_.]+/g, ' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name.includes(term)) score += 3;
        else if (haystack.includes(term)) score += 1;
      }
      return { member, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.member.name.localeCompare(b.member.name))
    .map((entry) => entry.member);
}

function tokenizeQuery(text: string): string[] {
  return Array.from(new Set((text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1)));
}

function objectArg(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const KG_NODE_KINDS = new Set<KGNodeKind>([
  'block', 'term', 'business_view', 'metric', 'dimension', 'measure', 'entity',
  'model_area', 'semantic_model', 'saved_query', 'domain', 'dbt_model', 'dbt_source',
  'notebook', 'dashboard', 'app', 'skill', 'relationship', 'contract',
  'domain_export', 'domain_import', 'conformance', 'policy', 'evaluation',
]);

function isKgNodeKind(value: string): value is KGNodeKind {
  return KG_NODE_KINDS.has(value as KGNodeKind);
}

function parseTimeDimension(value: unknown): { name: string; granularity: string } | undefined {
  const record = objectArg(value);
  return typeof record.name === 'string' && typeof record.granularity === 'string'
    ? { name: record.name, granularity: record.granularity }
    : undefined;
}

function parseFilters(value: unknown): SemanticBridgeFilter[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const record = objectArg(raw);
      return typeof record.dimension === 'string'
        ? { dimension: record.dimension, operator: typeof record.operator === 'string' ? record.operator : 'equals', values: stringArray(record.values) }
        : undefined;
    })
    .filter((filter): filter is SemanticBridgeFilter => Boolean(filter && filter.values.length > 0));
}

function parseOrderBy(value: unknown): SemanticBridgeOrderBy[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const record = objectArg(raw);
      return typeof record.name === 'string'
        ? { name: record.name, direction: record.direction === 'asc' ? 'asc' as const : 'desc' as const }
        : undefined;
    })
    .filter((order): order is SemanticBridgeOrderBy => Boolean(order));
}
