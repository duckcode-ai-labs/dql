import { renderSemanticBlockSource } from '@zlens/core/blocks';

export function buildNotebookSemanticBlock(metrics: string[], dimensions: string[]): string {
  const uniqueMetrics = Array.from(new Set(metrics.filter(Boolean)));
  const uniqueDimensions = Array.from(new Set(dimensions.filter(Boolean)));
  const stem = [...uniqueMetrics.slice(0, 2), ...uniqueDimensions.slice(0, 1)].join('_by_') || 'semantic_query';
  const name = stem.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'semantic_query';
  return renderSemanticBlockSource({
    name,
    status: 'draft',
    metrics: uniqueMetrics,
    dimensions: uniqueDimensions,
  }).trimEnd();
}
