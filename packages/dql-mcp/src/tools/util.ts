import type { ManifestBlock } from '@zlens/core';
import type { BlockRecord, BlockStatus } from '@zlens/project';

/**
 * Adapt a ManifestBlock (what the compiler produces) into a BlockRecord
 * (what governance rules consume). Fills the registry-only fields with
 * best-effort defaults so the Certifier can score a block discovered on
 * disk — without requiring a populated SQLite registry.
 */
export function manifestBlockToRecord(block: ManifestBlock): BlockRecord {
  const now = new Date();
  return {
    id: block.name,
    name: block.name,
    domain: block.domain ?? '',
    type: block.blockType ?? 'block',
    version: '0.1.0',
    status: (block.status as BlockStatus) ?? 'draft',
    gitRepo: '',
    gitPath: block.filePath,
    gitCommitSha: '',
    description: block.description,
    owner: block.owner ?? '',
    tags: block.tags ?? [],
    dependencies: block.allDependencies,
    usedInCount: 0,
    createdAt: now,
    updatedAt: now,
    // The agent-facing metadata the rules read. Without it a certified block
    // was reported as missing llmContext, tests, grain, outputs and entities
    // it declares.
    testAssertions: block.tests ?? [],
    llmContext: block.llmContext,
    examples: block.examples,
    invariants: block.invariants,
    pattern: block.pattern,
    metricRef: block.metricRef,
    metricsRef: block.metricsRef,
    dimensionsRef: block.dimensionsRef,
    grain: block.grain,
    entities: block.entities,
    declaredOutputs: block.declaredOutputs,
    dimensions: block.dimensions,
    allowedFilters: block.allowedFilters,
    parameterPolicy: block.parameterPolicy,
    filterBindings: block.filterBindings,
    sourceSystems: block.sourceSystems,
    replacementFor: block.replacementFor,
    reviewCadence: block.reviewCadence,
  };
}
