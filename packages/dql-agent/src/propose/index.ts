/**
 * `zlens propose` — turn dbt evidence into a ranked queue of DRAFT blocks.
 * AI drafts, humans certify. Nothing here is ever written as certified.
 */
export { propose, proposePlan, buildProposePreview } from './propose.js';
export type {
  ProposeOptions,
  ProposeSummary,
  ProposalResult,
  ProposalInference,
  ProposalRanking,
  ProposedPattern,
  ProposePlan,
  ProposePlanOptions,
  ProposePlanDomain,
  ProposePlanCandidate,
  ProposePreviewOptions,
} from './propose.js';
export { buildFromPrompt } from './build-from-prompt.js';
export type {
  BuildFromPromptOptions,
  BuildFromPromptContext,
  BuildFromPromptResult,
  BuildCellResult,
  BuildBlockResult,
  BuildMode,
  BuildRoute,
  CertifierVerdict,
  AppliedSkill,
} from './build-from-prompt.js';
export {
  loadBlockForEdit,
  renderEditedBlock,
  resolveEditedStatus,
} from './edit-block.js';
export type { LoadedBlock, EditedBlockFields } from './edit-block.js';
export {
  resolveProposeConfig,
  DEFAULT_PROPOSE_CONFIG,
} from './config.js';
export type { ProposeConfig, ProposeConfigInput } from './config.js';
export { classifyModel, resolveDomain } from './classify.js';
export type { Classification, ClassificationResult } from './classify.js';
export { loadDbtArtifacts, buildQualifiedRelation } from './dbt-artifacts.js';
export type {
  DbtArtifacts,
  DbtModelNode,
  DbtSourceNode,
  DbtColumn,
  SemanticMetricRef,
  SemanticModelRef,
} from './dbt-artifacts.js';
export { buildBusinessQuery } from './generate-sql.js';
export {
  upsertProposedDraft,
  renderProposedDraft,
  blockSlug,
} from './write-draft.js';
export type { ProposedDraftRecord, WrittenDraft } from './write-draft.js';
export { enrichProposal, enrichProposals } from './enrich.js';
export type { EnrichFacts, EnrichedContent, EnrichOptions } from './enrich.js';
export { reflectAndReviseBlock } from './reflect-block.js';
export type {
  ReflectableDraft,
  ExecutionProbe,
  BlockReflection,
  ReflectionFix,
} from './reflect-block.js';
