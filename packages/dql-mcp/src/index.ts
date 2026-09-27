/**
 * @duckcodeailabs/dql-mcp — MCP server exposing DQL blocks, semantic layer,
 * lineage, and governance to LLM agents.
 */

export { createDQLMCPServer } from './server.js';
export { DQLContext, findProjectRoot } from './context.js';
export type { DQLContextOptions } from './context.js';
export { runStdio } from './transports/stdio.js';
export { runLoopbackHTTP } from './transports/http.js';
export {
  createMcpKnowledgeSource,
  closeKnowledgeConnections,
  parseHits as parseKnowledgeHits,
  parseDocument as parseKnowledgeDocument,
  KnowledgeServerError,
  type KnowledgeServerConfig,
} from './client/knowledge-client.js';
export { startFakeKnowledgeServer, type FakeKnowledgePage, type FakeKnowledgeServer, type FakeKnowledgeServerOptions } from './testing/fake-knowledge-server.js';

export { searchBlocks, searchBlocksInput } from './tools/search-blocks.js';
export { getBlock, getBlockInput } from './tools/get-block.js';
export { queryViaBlock, queryViaBlockInput } from './tools/query-via-block.js';
export {
  listMetrics,
  listMetricsInput,
  listDimensions,
  listDimensionsInput,
} from './tools/semantic.js';
export { lineageImpact, lineageImpactInput } from './tools/lineage-impact.js';
export { certify, certifyInput } from './tools/certify.js';
export { suggestBlock, suggestBlockInput } from './tools/suggest-block.js';
export { querySemanticModel, querySemanticModelInput } from './tools/query-semantic-model.js';
export { expandContext, expandContextInput } from './tools/expand-context.js';
export { kgSearch, kgSearchInput, feedbackRecord, feedbackRecordInput } from './tools/kg.js';
export { inspectMetadataContext, inspectMetadataContextInput } from './tools/kg.js';
export { queryViaMetadata, queryViaMetadataInput } from './tools/query-via-metadata.js';
export {
  listDatasets,
  listDatasetsInput,
  describeDataset,
  describeDatasetInput,
  previewTileQuery,
  previewTileQueryInput,
  queryDataset,
  queryDatasetInput,
} from './tools/datasets.js';
export {
  searchMetadata,
  searchMetadataInput,
  getTableSchema,
  getTableSchemaInput,
  validateSql,
  validateSqlInput,
  resolveAnalyticalPath,
  explainRelationshipProof,
} from './tools/metadata.js';
export {
  askDql,
  askDqlInput,
  buildDqlApp,
  buildDqlAppInput,
  buildDqlBlock,
  buildDqlBlockInput,
  inspectDqlProject,
  inspectDqlProjectInput,
} from './tools/workflows.js';
