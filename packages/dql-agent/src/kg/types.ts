/**
 * Knowledge graph node + edge shapes for the ZLens agent.
 *
 * The KG is built from the compiled `dql-manifest.json` (terms, business views,
 * blocks, dashboards, apps, metrics, dimensions, sources) plus dbt manifest data
 * and the project's Skills folder. It is stored in SQLite at
 * `.dql/cache/agent-kg.sqlite` with an FTS5 index for keyword search and
 * structured filters for domain/kind.
 */

import type { TrustLabelId } from '@zlens/core';
import type { BlockParameterDefinition } from '@zlens/core';

export type KGNodeKind =
  | 'block'
  | 'term'
  | 'business_view'
  | 'metric'
  | 'dimension'
  | 'measure'
  | 'entity'
  | 'model_area'
  | 'semantic_model'
  | 'saved_query'
  | 'domain'
  | 'dbt_model'
  | 'dbt_source'
  | 'notebook'
  | 'dashboard'
  | 'app'
  | 'skill'
  | 'relationship'
  | 'contract'
  | 'domain_export'
  | 'domain_import'
  | 'conformance'
  | 'concept'
  | 'policy'
  | 'evaluation';

export type KGSourceTier =
  | 'certified_artifact'
  | 'semantic_layer'
  | 'dbt_manifest'
  | 'business_context'
  | 'memory'
  | 'project';

export type KGCertification = TrustLabelId;

export interface KGOutputLineage {
  name: string;
  isAggregate?: boolean;
  aggregateFn?: string;
  sources: Array<{ table: string; column: string }>;
  unresolved?: boolean;
}

export interface KGOutputContractColumn {
  name: string;
  type?: string;
  role?: string;
}

export interface KGNode {
  /** Stable identifier — `${kind}:${name}` (lower-cased). */
  nodeId: string;
  kind: KGNodeKind;
  name: string;
  /**
   * Governed domain. For semantic objects this is set ONLY when the dbt-derived
   * domain names a domain declared in `domains/`, because this field is what
   * retrieval filters on — see `sourceDomain`.
   */
  domain?: string;
  /**
   * The domain dbt reported, whatever it was.
   *
   * dbt derives a domain from `meta.domain || meta.group || config.group ||
   * fqn[1] || package_name || 'uncategorized'` — a folder or package name in
   * dbt's namespace. DQL domains are declared separately. The two were never
   * reconciled, so pinning DQL domain `growth` silently SQL-filtered out a
   * metric whose dbt-derived domain read `finance`, demoting the answer from
   * the governed semantic lane to raw SQL. Keeping the dbt value here and
   * leaving `domain` unset means an unreconciled metric stays retrievable
   * (the filter passes NULL) while the origin is preserved for ranking and
   * display.
   */
  sourceDomain?: string;
  status?: string;
  owner?: string;
  description?: string;
  tags?: string[];
  /** Free-form natural-language context for the LLM (block.llmContext, skill body, etc.). */
  llmContext?: string;
  /** Question/SQL pairs the agent can few-shot on. */
  examples?: Array<{ question: string; sql?: string }>;
  /** Raw SQL for DQL blocks / saved queries when available. */
  sql?: string;
  /** Path on disk so the UI can deep-link. */
  sourcePath?: string;
  /** Pinned git SHA at index time. */
  gitSha?: string;
  /** Governing source tier used by the agent's precedence policy. */
  sourceTier?: KGSourceTier;
  /** Certification/review state. Kept advisory; block.status remains authoritative for blocks. */
  certification?: KGCertification;
  /** Human-readable provenance label, e.g. "dbt semantic_manifest.json". */
  provenance?: string;
  /** ISO timestamp or source freshness marker when available. */
  freshness?: string;
  /**
   * Freshness-aware trust — effective data health rolled up from the block's
   * transitive dbt upstreams (`run_results.json` + source freshness). `'fresh'`
   * when all upstreams are healthy; `'stale'`/`'failed'`/`'unknown'` otherwise.
   * Mirrors `ManifestBlock.dataState`. Undefined for non-block nodes or when no
   * dbt run artifacts were imported.
   */
  dataState?: 'fresh' | 'stale' | 'failed' | 'unknown';
  /** Plain-language explanation of `dataState` (which upstream + why). */
  dataStateDetail?: string;
  /** Business outcome the artifact or semantic object is meant to support. */
  businessOutcome?: string;
  /** Business owner for the outcome, when distinct from the technical owner. */
  businessOwner?: string;
  /** Decision or workflow this asset is intended to inform. */
  decisionUse?: string;
  /** Expected review cadence for certification/freshness. */
  reviewCadence?: string;
  /** Row or business grain this artifact is designed to answer. */
  pattern?: string;
  grain?: string;
  /** Business entities represented by the artifact. */
  entities?: string[];
  /** Declared output field names for review and retrieval. */
  declaredOutputs?: string[];
  /** SQL-derived output lineage for this artifact, when the compiler can resolve it. */
  outputs?: KGOutputLineage[];
  /** Typed, reusable output contract for downstream block-fit and drift checks. */
  outputContract?: KGOutputContractColumn[];
  /** Business dimensions available for grouping or filters. */
  dimensions?: string[];
  /** Filters the artifact is designed to support safely. */
  allowedFilters?: string[];
  /** Parameter reuse policy per block parameter. */
  parameterPolicy?: Array<{ name: string; policy: string }>;
  /** Typed runtime parameter contract used by AI, notebooks, and apps. */
  parameters?: BlockParameterDefinition[];
  /** Business/app filter to physical column or expression bindings. */
  filterBindings?: Array<{ filter: string; binding: string }>;
  /** Business/source systems represented by this artifact. */
  sourceSystems?: string[];
  /** Replaced or superseded artifacts. */
  replacementFor?: string[];
  /** Stable SQL fingerprints used to detect exact and parameterized duplicates. */
  sqlFingerprints?: {
    version: string;
    exact: string;
    parameterized: string;
  };
  /** Stable business-shape fingerprint used to detect duplicate reusable block contracts. */
  businessFingerprint?: {
    version: string;
    hash: string;
    tokens: string[];
  };
  /** Optional DataLex contract reference, e.g. commerce.Customer.mau@1. */
  datalexContract?: string;
  /** Domain bounded context when this node represents a domain. */
  boundedContext?: string;
  /** Primary terms owned by a domain node. */
  primaryTerms?: string[];
  /** Business rules attached to this asset. */
  businessRules?: string[];
  /** Known caveats or interpretation constraints. */
  caveats?: string[];
  /** Manifest references that introduced this source, for example block or notebook ids. */
  referencedBy?: string[];
  /** Typed v3 analytical policy payload retained for deterministic planning. */
  payload?: Record<string, unknown>;
}

export interface KGEdge {
  src: string;
  dst: string;
  kind: 'feeds_into' | 'reads_from' | 'aggregates' | 'visualizes' | 'depends_on' | 'contains' | 'related_to' | 'defines' | 'composes'
    | 'parent_domain' | 'binds_to' | 'binds' | 'proves_join' | 'governed_by' | 'exports' | 'imports' | 'conforms_with' | 'validated_by';
  weight?: number;
}

export interface KGSearchHit {
  node: KGNode;
  /** BM25-derived score (lower is better in raw FTS5; we expose 1/(1+rank) so higher is better). */
  score: number;
  /** Match snippets per field, useful for UI surfacing. */
  snippet?: string;
}

export interface KGFeedbackRow {
  id: string;
  ts: string; // ISO-8601
  user: string;
  question: string;
  answerKind: 'certified' | 'uncertified';
  blockId?: string;
  rating: 'up' | 'down';
  comment?: string;
}

export interface KGSearchOptions {
  query: string;
  /** Restrict to specific kinds. Defaults to all. */
  kinds?: KGNodeKind[];
  /** Restrict to a domain. */
  domain?: string;
  /** Restrict to one of several server-authorized domains. */
  domains?: string[];
  /** Maximum hits to return. */
  limit?: number;
}
