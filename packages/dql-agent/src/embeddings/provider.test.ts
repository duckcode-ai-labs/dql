import { describe, expect, it } from 'vitest';
import {
  CachingEmbeddingProvider,
  HashedTokenEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  ResilientEmbeddingProvider,
  cosineSimilarity,
  clearEnvEmbeddingProviderCache,
  defaultEmbeddingProvider,
  embeddingOptionsFromEnv,
  envEmbeddingProvider,
  hybridRank,
  probeLocalOllamaEmbeddings,
  resolveEmbeddingProvider,
  setProcessDefaultEmbeddingProvider,
  type EmbeddingFetch,
  type ProbeFetch,
  type EmbeddingProvider,
} from './provider.js';

describe('deterministic embedding provider', () => {
  it('is deterministic — identical text yields identical vectors', async () => {
    const provider = new HashedTokenEmbeddingProvider(128);
    const [a] = await provider.embed(['revenue net amount excludes refunds']);
    const [b] = await provider.embed(['revenue net amount excludes refunds']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(128);
  });

  it('scores semantically-overlapping text higher than unrelated text', async () => {
    const provider = defaultEmbeddingProvider();
    const [query, related, unrelated] = await provider.embed([
      'revenue net amount excludes refunds',
      'net revenue should exclude refunds and returns',
      'player rebounds and assists per game by team',
    ]);
    const simRelated = cosineSimilarity(query, related);
    const simUnrelated = cosineSimilarity(query, unrelated);
    expect(simRelated).toBeGreaterThan(simUnrelated);
  });

  it('cosine similarity handles degenerate vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
  });
});

describe('hybrid rank', () => {
  const items = [
    { item: 'a', text: 'revenue net amount refunds', ftsScore: 0.4 },
    { item: 'b', text: 'churn logo retention quarterly', ftsScore: 0.6 },
  ];

  it('alpha=0 is a pure FTS5 pass-through (safe default)', async () => {
    const ranked = await hybridRank('revenue net', items, { alpha: 0 });
    expect(ranked[0].item).toBe('b'); // higher ftsScore wins, vector ignored
    expect(ranked.every((r) => r.vectorScore === 0)).toBe(true);
  });

  it('alpha>0 blends vector similarity and can re-order', async () => {
    const ranked = await hybridRank('revenue net amount refunds', items, { alpha: 1 });
    // With full vector weight, the lexically-identical item wins despite lower fts.
    expect(ranked[0].item).toBe('a');
    expect(ranked[0].vectorScore).toBeGreaterThan(ranked[1].vectorScore);
  });

  it('is deterministic across runs', async () => {
    const r1 = await hybridRank('revenue net', items, { alpha: 0.5 });
    const r2 = await hybridRank('revenue net', items, { alpha: 0.5 });
    expect(r1.map((x) => [x.item, x.score])).toEqual(r2.map((x) => [x.item, x.score]));
  });
});

describe('OpenAI embedding provider (R3.3)', () => {
  const fakeVectors: Record<string, number[]> = {
    'who are our best customers': [1, 0, 0],
    'top customers by revenue': [0.9, 0.1, 0],
    'player rebounds per game': [0, 0, 1],
  };
  const fetchImpl: EmbeddingFetch = async (_url, init) => {
    const body = JSON.parse(init.body) as { input: string[] };
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: body.input.map((text, index) => ({ index, embedding: fakeVectors[text] ?? [0, 0, 0] })) }),
    };
  };

  it('embeds via the /embeddings endpoint and preserves order', async () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test', fetchImpl });
    const [a, b] = await provider.embed(['who are our best customers', 'player rebounds per game']);
    expect(a).toEqual([1, 0, 0]);
    expect(b).toEqual([0, 0, 1]);
  });

  it('caches by content hash — the inner provider is called once per unique text', async () => {
    let calls = 0;
    const counting: EmbeddingProvider = {
      id: 'counting', dimensions: 3,
      embed: async (texts) => { calls += 1; return texts.map(() => [1, 2, 3]); },
    };
    const cached = new CachingEmbeddingProvider(counting);
    await cached.embed(['x', 'y']);
    await cached.embed(['x', 'y']); // second time fully cached
    expect(calls).toBe(1);
  });

  it('returns every vector in order when one batch is larger than the cache', async () => {
    const counting: EmbeddingProvider = {
      id: 'counting', dimensions: 1,
      embed: async (texts) => texts.map((text) => [Number(text.slice(1))]),
    };
    const cached = new CachingEmbeddingProvider(counting, 4);
    const values = Array.from({ length: 12 }, (_, index) => `v${index}`);
    const vectors = await cached.embed(values);
    expect(vectors).toEqual(values.map((_, index) => [index]));
  });

  it('resolver returns a real embedder when keyed, hashed fallback otherwise', () => {
    expect(resolveEmbeddingProvider({ openaiApiKey: 'sk-test', fetchImpl }).id).toContain('openai');
    expect(resolveEmbeddingProvider({}).id).toBe('hashed-token-v1');
  });

  it('real embeddings let a PARAPHRASE outrank a lexically-closer distractor', async () => {
    // "who are our best customers" should match "top customers by revenue"
    // semantically even though the hashed-token overlap is weak.
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test', fetchImpl });
    const ranked = await hybridRank(
      'who are our best customers',
      [
        { item: 'best_customers_block', text: 'top customers by revenue', ftsScore: 0.2 },
        { item: 'nba_block', text: 'player rebounds per game', ftsScore: 0.5 },
      ],
      { alpha: 0.8, provider },
    );
    expect(ranked[0].item).toBe('best_customers_block');
  });
});

describe('local-first embeddings (W3.1)', () => {
  const ollamaFetch: EmbeddingFetch = async (url, init) => {
    expect(url).toContain('/api/embed');
    const body = JSON.parse(init.body) as { input: string[] };
    return {
      ok: true,
      status: 200,
      json: async () => ({ embeddings: body.input.map((_, i) => [i, 1, 0]) }),
    };
  };

  it('Ollama provider embeds via /api/embed and preserves order', async () => {
    const provider = new OllamaEmbeddingProvider({ endpoint: 'http://localhost:11434', fetchImpl: ollamaFetch });
    const vectors = await provider.embed(['a', 'b']);
    expect(vectors).toEqual([[0, 1, 0], [1, 1, 0]]);
    expect(provider.id).toContain('ollama');
  });

  it('resolver prefers a local Ollama endpoint over hashed', () => {
    const provider = resolveEmbeddingProvider({ ollamaEndpoint: 'http://localhost:11434', fetchImpl: ollamaFetch });
    expect(provider.id).toContain('ollama');
  });

  it('resilient wrapper falls back to hashed vectors when the real provider fails', async () => {
    const failing: EmbeddingProvider = {
      id: 'boom', dimensions: 3,
      embed: async () => { throw new Error('connection refused'); },
    };
    const resilient = new ResilientEmbeddingProvider(failing, new HashedTokenEmbeddingProvider());
    const [vector] = await resilient.embed(['hello world']);
    // Fell back to a real (hashed) vector rather than throwing.
    expect(vector.length).toBeGreaterThan(0);
  });

  it('embeddingOptionsFromEnv reads Ollama and OpenAI config (Ollama wins)', () => {
    expect(embeddingOptionsFromEnv({ ZLENS_OLLAMA_EMBED_URL: 'http://x:11434', ZLENS_OLLAMA_EMBED_MODEL: 'nomic' }))
      .toEqual({ ollamaEndpoint: 'http://x:11434', ollamaModel: 'nomic' });
    expect(embeddingOptionsFromEnv({ ZLENS_OPENAI_API_KEY: 'sk-x' })).toEqual({ openaiApiKey: 'sk-x' });
    expect(embeddingOptionsFromEnv({ OPENAI_API_KEY: 'ambient-answer-key' })).toEqual({});
    expect(embeddingOptionsFromEnv({})).toEqual({});
  });

  it('offline (no config) stays on the deterministic hashed provider', () => {
    expect(resolveEmbeddingProvider(embeddingOptionsFromEnv({})).id).toBe('hashed-token-v1');
  });

  it('a registered process default wins over hashed when the environment is silent, and env still wins over it', () => {
    // The served project's configured embedder must reach library call sites
    // that have no project root (conversation matching, SQL-lane ranking) —
    // otherwise the catalog is semantic while every other similarity check is
    // lexical, and the product answers with two different notions of meaning.
    const projectProvider: EmbeddingProvider = {
      id: 'ollama:project-configured', dimensions: 3,
      embed: async (texts) => texts.map(() => [1, 0, 0]),
    };
    try {
      setProcessDefaultEmbeddingProvider(projectProvider);
      expect(envEmbeddingProvider({})).toBe(projectProvider);
      // An explicit environment override remains the operator's escape hatch.
      clearEnvEmbeddingProviderCache();
      expect(envEmbeddingProvider({ ZLENS_OLLAMA_EMBED_URL: 'http://localhost:11434' }).id).toContain('ollama:');
      expect(envEmbeddingProvider({ ZLENS_OLLAMA_EMBED_URL: 'http://localhost:11434' })).not.toBe(projectProvider);
    } finally {
      setProcessDefaultEmbeddingProvider(undefined);
      clearEnvEmbeddingProviderCache();
    }
    expect(envEmbeddingProvider({}).id).toBe('hashed-token-v1');
  });

  it('reuses the environment-selected provider so corpus vectors stay cached between questions', () => {
    clearEnvEmbeddingProviderCache();
    const env = { ZLENS_OLLAMA_EMBED_URL: 'http://localhost:11434', ZLENS_OLLAMA_EMBED_MODEL: 'nomic' };
    expect(envEmbeddingProvider(env)).toBe(envEmbeddingProvider(env));

    const changed = envEmbeddingProvider({ ...env, ZLENS_OLLAMA_EMBED_MODEL: 'mxbai' });
    expect(changed).not.toBe(envEmbeddingProvider(env));
    clearEnvEmbeddingProviderCache();
  });

  describe('probeLocalOllamaEmbeddings (zero-config semantic search)', () => {
    const tagsFetch = (models: string[]): ProbeFetch => async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: models.map((name) => ({ name })) }),
    });

    it('detects a pulled embedding model and returns endpoint + model', async () => {
      const result = await probeLocalOllamaEmbeddings('http://127.0.0.1:11434', tagsFetch(['llama3:latest', 'nomic-embed-text:latest']));
      expect(result).toEqual({ endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text' });
    });

    it('returns null when Ollama has no embedding model pulled', async () => {
      const result = await probeLocalOllamaEmbeddings('http://127.0.0.1:11434', tagsFetch(['llama3:latest', 'mistral:latest']));
      expect(result).toBeNull();
    });

    it('returns null when Ollama is unreachable (never throws)', async () => {
      const result = await probeLocalOllamaEmbeddings('http://127.0.0.1:11434', async () => { throw new Error('ECONNREFUSED'); });
      expect(result).toBeNull();
    });
  });
});
