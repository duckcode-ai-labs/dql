/**
 * Resolved configuration for the `zlens propose` engine.
 *
 * Conventions are **convention-agnostic by default**: with no config the
 * classifier falls back to a weighted cascade (meta → exposure → semantic →
 * folder → tag → name). The optional `propose` block in `dql.config.json` only
 * *overrides* the defaults — it is additive and backward-compatible.
 *
 * Everything here is deterministic. There is no LLM input to config resolution.
 */

/** Raw shape a user may put under `"propose"` in `dql.config.json`. */
export interface ProposeConfigInput {
  /** Folder/tag tokens that mean "business layer". */
  businessLayers?: string[];
  /** Folder/tag tokens that mean "plumbing" (excluded from generation). */
  excludeLayers?: string[];
  /** Max candidates generated per domain. */
  maxPerDomain?: number;
  /** Minimum demand score a candidate needs to be selected. */
  minScore?: number;
  /** Whether the optional AI enrichment hook may run. */
  aiEnrichment?: 'auto' | 'on' | 'off';
}

/** Fully-resolved config (defaults applied). */
export interface ProposeConfig {
  businessLayers: string[];
  excludeLayers: string[];
  maxPerDomain: number;
  minScore: number;
  aiEnrichment: 'auto' | 'on' | 'off';
}

export const DEFAULT_PROPOSE_CONFIG: ProposeConfig = {
  businessLayers: ['marts', 'core', 'reporting'],
  excludeLayers: ['staging', 'intermediate', 'base'],
  maxPerDomain: 8,
  minScore: 0,
  aiEnrichment: 'auto',
};

function normalizeTokens(values: unknown, fallback: string[]): string[] {
  if (!Array.isArray(values)) return fallback;
  const out = values
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return out.length > 0 ? Array.from(new Set(out)) : fallback;
}

/**
 * Resolve a user-supplied `propose` config block into a complete config, with
 * sensible defaults for every field. Unknown / malformed values fall back to the
 * default — config can only refine behaviour, never break it.
 */
export function resolveProposeConfig(input?: ProposeConfigInput | null): ProposeConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_PROPOSE_CONFIG };

  const maxPerDomain =
    typeof input.maxPerDomain === 'number' && Number.isFinite(input.maxPerDomain) && input.maxPerDomain > 0
      ? Math.floor(input.maxPerDomain)
      : DEFAULT_PROPOSE_CONFIG.maxPerDomain;

  const minScore =
    typeof input.minScore === 'number' && Number.isFinite(input.minScore)
      ? input.minScore
      : DEFAULT_PROPOSE_CONFIG.minScore;

  const aiEnrichment =
    input.aiEnrichment === 'on' || input.aiEnrichment === 'off' || input.aiEnrichment === 'auto'
      ? input.aiEnrichment
      : DEFAULT_PROPOSE_CONFIG.aiEnrichment;

  return {
    businessLayers: normalizeTokens(input.businessLayers, DEFAULT_PROPOSE_CONFIG.businessLayers),
    excludeLayers: normalizeTokens(input.excludeLayers, DEFAULT_PROPOSE_CONFIG.excludeLayers),
    maxPerDomain,
    minScore,
    aiEnrichment,
  };
}
