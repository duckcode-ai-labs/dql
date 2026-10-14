import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  embeddingOptionsFromEnv,
  resolveEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingResolveOptions,
} from './provider.js';
import { readEnv } from '@zlens/core';

/**
 * Embedding settings a project declares in `dql.config.json`.
 *
 * Retrieval was previously semantic only if you exported an environment
 * variable, which no product surface mentioned — so in practice every project
 * ran the deterministic hashed fallback and "plain English" questions could
 * only ever match on shared tokens. Project config makes it a setting a user
 * can actually find and change.
 */
export interface ProjectEmbeddingSettings {
  /** `hashed` is the offline default; the others need an endpoint or key. */
  provider?: 'hashed' | 'ollama' | 'openai';
  /** Ollama base URL, e.g. http://127.0.0.1:11434 */
  endpoint?: string;
  /** Embedding model, e.g. nomic-embed-text (Ollama) or text-embedding-3-small. */
  model?: string;
  /** Only for the OpenAI-compatible provider. */
  apiKey?: string;
  baseUrl?: string;
}

export function readProjectEmbeddingSettings(projectRoot: string): ProjectEmbeddingSettings {
  const configPath = join(projectRoot, 'dql.config.json');
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const ai = raw.ai && typeof raw.ai === 'object' && !Array.isArray(raw.ai)
      ? raw.ai as Record<string, unknown>
      : {};
    const embeddings = ai.embeddings && typeof ai.embeddings === 'object' && !Array.isArray(ai.embeddings)
      ? ai.embeddings as Record<string, unknown>
      : {};
    const str = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const provider = str(embeddings.provider);
    return {
      ...(provider === 'hashed' || provider === 'ollama' || provider === 'openai' ? { provider } : {}),
      ...(str(embeddings.endpoint) ? { endpoint: str(embeddings.endpoint) } : {}),
      ...(str(embeddings.model) ? { model: str(embeddings.model) } : {}),
      ...(str(embeddings.apiKey) ? { apiKey: str(embeddings.apiKey) } : {}),
      ...(str(embeddings.baseUrl) ? { baseUrl: str(embeddings.baseUrl) } : {}),
    };
  } catch {
    // A malformed config must not break retrieval; fall back to the default.
    return {};
  }
}

export function embeddingOptionsFromSettings(settings: ProjectEmbeddingSettings): EmbeddingResolveOptions {
  if (settings.provider === 'ollama' && settings.endpoint) {
    return {
      ollamaEndpoint: settings.endpoint,
      ...(settings.model ? { ollamaModel: settings.model } : {}),
    };
  }
  if (settings.provider === 'openai' && settings.apiKey) {
    return {
      openaiApiKey: settings.apiKey,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    };
  }
  return {};
}

const cache = new Map<string, { key: string; provider: EmbeddingProvider }>();

/**
 * The embedding provider for a project: its own settings first, then the
 * environment, then the deterministic hashed default.
 *
 * Environment stays supported so an operator can point a whole deployment at
 * one embedder without editing each project, but an explicit project setting
 * wins because that is the one a user chose in the product.
 */
export function projectEmbeddingProvider(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider {
  const settings = readProjectEmbeddingSettings(projectRoot);
  const fromSettings = embeddingOptionsFromSettings(settings);
  const options = Object.keys(fromSettings).length > 0 ? fromSettings : embeddingOptionsFromEnv(env);
  const key = JSON.stringify({
    e: options.ollamaEndpoint ?? '',
    om: options.ollamaModel ?? '',
    // Never cache-key on the raw secret.
    k: options.openaiApiKey ? 'set' : '',
    m: options.model ?? '',
    b: options.baseUrl ?? '',
  });
  const hit = cache.get(projectRoot);
  if (hit?.key === key) return hit.provider;
  const provider = resolveEmbeddingProvider(options);
  cache.set(projectRoot, { key, provider });
  return provider;
}

/** True when the project is on the offline lexical fallback, not real semantics. */
export function isHashedEmbeddingProvider(provider: EmbeddingProvider): boolean {
  return provider.id.startsWith('hashed-token');
}

/** Settings changed — drop the memo so the next call re-resolves. */
export function clearProjectEmbeddingCache(projectRoot?: string): void {
  if (projectRoot) cache.delete(projectRoot);
  else cache.clear();
}

export interface EmbeddingAutoUpgradeResult {
  /** What retrieval will now use. */
  providerId: string;
  /** True only when the vector index was actually re-embedded by this call. */
  upgraded: boolean;
  /** Why nothing changed, when nothing changed. */
  reason?:
    | 'configured'
    | 'test_environment'
    | 'disabled'
    | 'no_local_model'
    | 'already_current'
    | 'reembed_failed'
    | 'error';
  /** The local model adopted, when one was. */
  model?: string;
}

/**
 * Adopt local Ollama embeddings for a project when the machine already serves
 * them, re-embedding the vector index in the same step.
 *
 * The hashed provider is a token hash: it matches shared words and nothing
 * else, so "customer accounts" cannot find a model documented as "billing
 * entities" however good the ranking is. It was every project's default
 * because switching it off needed an environment variable no product surface
 * mentioned.
 *
 * This lives here, rather than inline in the server, because the server was
 * the ONLY caller — so `zlens agent ask` and `zlens agent reindex` kept running
 * lexical retrieval on a machine with `nomic-embed-text` already pulled, and
 * the vector lane contributed zero candidates to every CLI answer.
 *
 * Re-embedding is not optional: `searchVectorObjects` returns NOTHING when the
 * requested provider disagrees with the index's, so upgrading the provider
 * without upgrading the index makes retrieval strictly worse. Both move
 * together or neither does.
 */
export async function autoUpgradeProjectEmbeddings(
  projectRoot: string,
  deps: {
    probeLocalOllamaEmbeddings: () => Promise<{ endpoint: string; model: string } | null | undefined>;
    upgradeVectorIndexForProject: (
      projectRoot: string,
      provider: EmbeddingProvider,
    ) => Promise<{ upgraded: boolean; providerId: string }>;
    setProcessDefaultEmbeddingProvider: (provider: EmbeddingProvider | undefined) => void;
  },
): Promise<EmbeddingAutoUpgradeResult> {
  try {
    // Never inside a test run: the probe touches the network and the upgrade
    // rewrites the vector index, either of which would make a suite's
    // retrieval results depend on whether the developer happens to be running
    // Ollama. Same rule the deadline auto-scale follows.
    if (process.env.VITEST) return { providerId: 'hashed-token-v1', upgraded: false, reason: 'test_environment' };
    const configured = readProjectEmbeddingSettings(projectRoot);
    // An explicit project setting or environment override is the user's
    // decision and is never second-guessed.
    if (configured.provider
      || readEnv('ZLENS_OLLAMA_EMBED_URL')
      || readEnv('ZLENS_OPENAI_API_KEY')) {
      return { providerId: configured.provider ?? 'configured', upgraded: false, reason: 'configured' };
    }
    if (readEnv('ZLENS_EMBEDDINGS_AUTODETECT') === 'off') {
      return { providerId: 'hashed-token-v1', upgraded: false, reason: 'disabled' };
    }
    const local = await deps.probeLocalOllamaEmbeddings();
    if (!local) return { providerId: 'hashed-token-v1', upgraded: false, reason: 'no_local_model' };
    const provider = resolveEmbeddingProvider({ ollamaEndpoint: local.endpoint, ollamaModel: local.model });
    const upgrade = await deps.upgradeVectorIndexForProject(projectRoot, provider);
    if (!upgrade.upgraded && upgrade.providerId !== provider.id) {
      // Could not re-embed (model pulled but not serving, disk, etc.). Stay on
      // the index the catalog actually holds rather than silently emptying the
      // vector lane.
      return { providerId: upgrade.providerId, upgraded: false, reason: 'reembed_failed' };
    }
    deps.setProcessDefaultEmbeddingProvider(provider);
    return {
      providerId: provider.id,
      upgraded: upgrade.upgraded,
      model: local.model,
      ...(upgrade.upgraded ? {} : { reason: 'already_current' as const }),
    };
  } catch {
    // Retrieval must start regardless; hashed remains a working default.
    return { providerId: 'hashed-token-v1', upgraded: false, reason: 'error' };
  }
}
