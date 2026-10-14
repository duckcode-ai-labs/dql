/**
 * Shared best-effort AI-enrichment gather for `zlens propose` (CLI) and the
 * notebook generate endpoint. Runs a deterministic dryRun pass to collect facts,
 * then asks the configured provider to enrich human-facing content. Returns a
 * slug→content map, or `undefined` on any miss (no provider, 'off', no facts) so
 * callers fall back to deterministic dbt-derived content.
 *
 * The enrichment itself (and its timeout / JSON parsing) lives in dql-agent; the
 * engine never calls a provider — it only consumes `enrichedBySlug` as data.
 */

import {
  propose,
  pickProvider,
  enrichProposals,
  loadSkills,
  type EnrichFacts,
  type EnrichedContent,
  type ProposeConfigInput,
} from '@zlens/agent';

export async function gatherProposeEnrichment(
  projectRoot: string,
  manifestPath: string,
  proposeConfig: ProposeConfigInput | undefined,
  slugs?: string[],
): Promise<Map<string, EnrichedContent> | undefined> {
  const provider = await pickProvider();
  if (!(await provider.available())) return undefined;
  // dryRun gives deterministic facts for the bounded selection (writes nothing).
  const preview = propose({ projectRoot, dbtManifestPath: manifestPath, dryRun: true, config: proposeConfig });
  const wanted = slugs ? new Set(slugs) : null;
  const facts: EnrichFacts[] = preview.proposals
    .filter((proposal) => !wanted || wanted.has(proposal.slug))
    .map((proposal) => ({
      slug: proposal.slug,
      model: proposal.model,
      domain: proposal.domain,
      grain: proposal.inference.grain,
      pattern: proposal.inference.pattern,
      columns: proposal.inference.declaredOutputs,
      entities: proposal.inference.entities,
    }));
  if (facts.length === 0) return undefined;
  // Let the agent act with the editable `block-authoring` skill so drafts follow
  // the team's conventions (semantic-metric-first, business naming, grain, …).
  const guidance = loadSkills(projectRoot).skills.find((skill) => skill.id === 'block-authoring')?.body?.trim() || undefined;
  return enrichProposals(facts, provider, { timeoutMs: 25_000, concurrency: 4, guidance });
}
