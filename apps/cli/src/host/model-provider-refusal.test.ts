import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGovernedAnswerRunner } from '../local-runtime.js';
import { saveProviderSettings } from '../settings/provider-settings.js';
import { HOST_MODEL_UNAVAILABLE, HostModelUnavailableError, setHostModelHooks, type DqlModelProvider } from './request-context.js';

/**
 * RFC 0010 HH-5: a host's model comes before the project's own provider settings. When the host's `modelProvider`
 * fails (or answers something that is not a model), DQL asks no model at all, in plain words: it never falls back
 * to a provider the project configured, which the host did not choose. A hook that answers nothing uses the
 * project's settings, as documented; without a host nothing changes.
 */
const roots: string[] = [];
afterEach(() => {
  setHostModelHooks(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithOwnModel(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-host-model-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'models' }));
  saveProviderSettings(root, { id: 'openai', enabled: true, apiKey: 'test-key-not-real', baseUrl: 'https://models.example.test/v1', model: 'gpt-test' });
  return root;
}

describe('the host\'s model hook, when it fails', () => {
  it('without a host, the project\'s own model is chosen, as before', async () => {
    const root = projectWithOwnModel();
    expect((await resolveGovernedAnswerRunner(root))?.provider).toBe('openai');
  });

  it('with a host whose hook answers nothing, the project\'s own model is chosen (the documented default)', async () => {
    const root = projectWithOwnModel();
    setHostModelHooks({ modelProvider: () => undefined });
    expect((await resolveGovernedAnswerRunner(root))?.provider).toBe('openai');
  });

  it('with a host whose hook fails or answers junk, no model is chosen, and the refusal says so plainly', async () => {
    const root = projectWithOwnModel();
    setHostModelHooks({ modelProvider: () => { throw new Error('model registry down at https://internal.example/registry'); } });
    const refused = await resolveGovernedAnswerRunner(root).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(HostModelUnavailableError);
    expect((refused as Error).message).toBe(HOST_MODEL_UNAVAILABLE);
    expect((refused as Error).message).not.toMatch(/registry|internal\.example/);
    setHostModelHooks({ modelProvider: () => ({ id: 'bedrock' }) as never });
    await expect(resolveGovernedAnswerRunner(root)).rejects.toBeInstanceOf(HostModelUnavailableError);
  });

  it('with a host whose hook answers a model, that model is chosen', async () => {
    const root = projectWithOwnModel();
    const hosted = { name: 'claude', available: async () => true, generate: async () => 'ok' } as unknown as DqlModelProvider;
    setHostModelHooks({ modelProvider: () => ({ id: 'anthropic', provider: hosted }) });
    expect((await resolveGovernedAnswerRunner(root))?.provider).toBe('anthropic');
  });
});
