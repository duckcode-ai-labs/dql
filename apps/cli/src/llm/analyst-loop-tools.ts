import type { AgentToolDefinition, AnswerLoopInput } from '@zlens/agent';
import {
  buildPreviewQueryTool,
  buildSearchValuesTool,
  buildSemanticStageTools,
} from '@zlens/agent';

/**
 * The tools the analyst loop may call.
 *
 * `buildAnswerLoopTools` carries the host's catalog tools, but NOT the governed
 * semantic ones — so a loop given only those could search metadata and validate
 * SQL, yet never compile a governed query. `compile_semantic_query` is the IR:
 * metrics + dimensions + grain + filters in, dialect SQL or a typed refusal out.
 * It is also the only path whose output the pipeline will label governed, since
 * it validates every member against the layer instead of trusting the model.
 *
 * Extracted from the provider seam so the tool surface is assertable directly;
 * it is the loop's entire view of what it can do, and a silently missing tool
 * degrades answers rather than failing loudly.
 */
export function buildAnalystLoopTools(
  loopInput: AnswerLoopInput,
  options: { valuesEnabled: boolean },
): AgentToolDefinition[] {
  const execute = loopInput.executeGeneratedSql;
  const semanticTools = buildSemanticStageTools({
    ...(loopInput.semanticLayer ? { semanticLayer: loopInput.semanticLayer } : {}),
    kg: loopInput.kg,
    ...(loopInput.semanticDriver ? { driver: loopInput.semanticDriver } : {}),
    ...(loopInput.semanticTableMapping ? { tableMapping: loopInput.semanticTableMapping } : {}),
    ...(loopInput.semanticQueryCompiler
      ? { semanticQueryCompiler: loopInput.semanticQueryCompiler }
      : {}),
  });
  return [
    ...(loopInput.answerLoopTools ?? []),
    ...semanticTools,
    // `preview_query` lets the loop ESTABLISH identifiers rather than only
    // verify ones another tool happened to surface: the warehouse resolving a
    // name is the strongest evidence it exists. Only offered when an executor
    // is present — without one the tool could only ever fail.
    ...(execute ? [buildPreviewQueryTool((sql) => execute(sql))] : []),
    // `search_values` is the antidote to the recorded false-absence defect:
    // without it a named member can never become a filter, the plan freezes
    // filterless, and a truncated result gets narrated as absence. Probing is
    // opt-in per project, and the tool says so rather than returning a silent
    // empty result — "did not look" and "looked and found nothing" are
    // different facts, and only one of them licenses an absence claim.
    ...(execute
      ? [buildSearchValuesTool({
          execute: async (sql) => execute(sql),
          relations: (loopInput.schemaContext ?? []).map((table) => ({
            relation: table.relation,
            columns: (table.columns ?? []).map((column) => ({
              name: column.name,
              ...(column.type ? { type: column.type } : {}),
            })),
          })),
          enabled: options.valuesEnabled,
        })]
      : []),
  ];
}
