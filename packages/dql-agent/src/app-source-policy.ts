import type { ManifestBlock } from '@zlens/core';

/** Parser-supported tag recording an explicit App-source reuse decision. */
export const APP_SOURCE_REUSABLE_TAG = 'app-source';

const GENERATED_ORIGIN_TAGS = new Set([
  'ai-generated',
  'ai-generated-app',
  'ask-generated',
  'agent-generated',
  'dql-generated',
  'generated-analysis',
  'analysis-generated',
  'llm-generated',
  'notebook-research',
]);

type AppSourceProvenanceBlock = Pick<ManifestBlock, 'draftMetadata' | 'tags'>;

/**
 * Generated origin is narrower than `draftMetadata`: manual semantic drafts
 * can legitimately carry requested filters, time settings, limits, or a draft
 * path. Only durable Ask/research origin fields or an explicit generated tag
 * classify a declaration as a generated artifact.
 */
export function hasGeneratedAppSourceOrigin(block: AppSourceProvenanceBlock): boolean {
  const metadata = block.draftMetadata;
  const generatedMetadata = Boolean(
    nonEmpty(metadata?.sourceQuestion)
    || nonEmpty(metadata?.contextPackId)
    || nonEmpty(metadata?.routeIntent)
    || typeof metadata?.askedTimes === 'number'
    || nonEmpty(metadata?.firstAsked)
    || nonEmpty(metadata?.lastAsked),
  );
  if (generatedMetadata) return true;
  return (block.tags ?? []).some((tag) => GENERATED_ORIGIN_TAGS.has(tag.trim().toLowerCase()));
}

export function isExplicitlyReusableAppSource(block: Pick<ManifestBlock, 'tags'>): boolean {
  return (block.tags ?? []).some((tag) => tag.trim().toLowerCase() === APP_SOURCE_REUSABLE_TAG);
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}
