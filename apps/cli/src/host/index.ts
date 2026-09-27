/**
 * The supported way to run DQL inside another program (RFC 0010): start the
 * server with host hooks. Import from `@duckcodeailabs/dql-cli/host`.
 */
export { startLocalServer, type LocalServerOptions } from '../local-runtime.js';
/** The full server with its UI for one project — what `dql notebook` runs — as a hosted runtime. */
export { startProjectRuntime, type ProjectRuntimeHandle } from '../commands/notebook.js';
export {
  currentPrincipal,
  currentRequestContext,
  type DqlDecision,
  type DqlModelProvider,
  type DqlHostHooks,
  type DqlHostUi,
  type DqlHostBanner,
  type DqlAnswerStatus,
  type DqlHostIcon,
  type DqlPrincipal,
  type DqlRequestContext,
  type DqlRunStore,
  type DqlMemoryStore,
  type DqlConversationStore,
  type DqlSourceRef,
  type DqlKnowledgeServer,
  type DqlDestination,
  type DqlHomeCard,
  type DqlFollow,
  type DqlFollowStore,
  type DqlPageEdition,
  type DqlDirectoryGroup,
} from './request-context.js';
export type { DqlAuditEvent, DqlAuditSink, DqlTraceSink } from './observability.js';
export type { DeliverySink } from '../schedule/notifiers/index.js';
export { snapshotKeyId, verifySnapshot, type SnapshotSigner } from '../snapshot/app-snapshot.js';
export { routeAction, type DqlAction, type DqlResource, type DqlRouteAction } from './route-actions.js';
export {
  CredentialsRefusedError,
  RowPolicyRefusedError,
  type DqlCredentialsContext,
  type DqlCredentialsHook,
  type DqlCredentialsResult,
  type DqlQueryContext,
  type DqlRowPolicy,
  type DqlRowPolicyResult,
} from './row-policy.js';

export { answerFactsFromRun, answerSql, tablesRead, type DqlAnswerFacts } from './answer-facts.js';
