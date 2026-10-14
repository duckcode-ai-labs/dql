/**
 * Digest build helper — resolves block sources + SHAs and drives digest-emitter.
 *
 * Runs outside compile() so the narrative (potentially LLM-backed) stays an
 * async post-process step and doesn't push async up through the core compiler.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest, type DQLManifest } from '@zlens/core';
import {
  buildDigest,
  type BlockSourceMap,
  type CompilationOutput,
  type DigestBuildResult,
  type DigestLLMProvider,
} from '@zlens/dql-compiler';

export function isDigestOutput(output: CompilationOutput): boolean {
  return Boolean(output.metadata?.narrative);
}

export async function runDigestBuild(
  output: CompilationOutput,
  projectRoot: string,
  llm?: DigestLLMProvider,
): Promise<DigestBuildResult> {
  const narrative = output.metadata?.narrative;
  if (!narrative) {
    throw new Error('runDigestBuild called on non-digest output');
  }

  const sources = loadBlockSources(projectRoot, narrative.sources);
  const digestIR = {
    title: output.metadata.title,
    narrative,
    // The digest-emitter only needs `title` + `narrative` + `sources` for
    // narrative composition; the dashboard HTML is threaded in separately.
    charts: [],
    filters: [],
    params: [],
    notifications: output.metadata.notifications ?? [],
    alerts: output.metadata.alerts ?? [],
    layout: { type: 'grid' as const, columns: 12, items: [] },
    variables: {},
  };

  return buildDigest(digestIR, output.html, sources, llm);
}

function loadBlockSources(projectRoot: string, sourceNames: string[]): BlockSourceMap {
  const manifest = loadOrBuildManifest(projectRoot);
  const sources: BlockSourceMap = new Map();

  for (const name of sourceNames) {
    const block = manifest?.blocks?.[name];
    if (!block) {
      sources.set(name, { path: name, description: undefined });
      continue;
    }
    sources.set(name, {
      path: block.filePath,
      description: block.description,
      gitCommitSha: resolveGitSha(projectRoot, block.filePath),
    });
  }

  return sources;
}

function loadOrBuildManifest(projectRoot: string): DQLManifest | null {
  const cached = join(projectRoot, 'dql-manifest.json');
  if (existsSync(cached)) {
    try {
      return JSON.parse(readFileSync(cached, 'utf-8')) as DQLManifest;
    } catch {
      // fall through to fresh build
    }
  }
  try {
    return buildManifest({ projectRoot, dqlVersion: '0.0.0' });
  } catch {
    return null;
  }
}

function resolveGitSha(projectRoot: string, filePath: string): string | undefined {
  try {
    const sha = execSync(`git log -1 --format=%H -- "${filePath}"`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}
