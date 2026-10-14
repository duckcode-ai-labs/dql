import { createHash } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { buildManifest } from '@zlens/core';
import { defaultKgPath, reindexProject } from '@zlens/agent';

export interface ProjectRefreshWorkerInput {
  projectRoot: string;
  dbtManifestPath?: string;
  writeManifest: boolean;
}

export interface ProjectRefreshWorkerResult {
  snapshotId: string;
  objectCount: number;
  edgeCount: number;
  metadataFingerprint: string;
  kgFingerprint: string;
}

async function run(input: ProjectRefreshWorkerInput): Promise<ProjectRefreshWorkerResult> {
  parentPort?.postMessage({ type: 'progress', phase: 'compiling', progress: 15, message: 'Compiling project snapshot.' });
  const manifest = buildManifest({
    projectRoot: input.projectRoot,
    dqlVersion: 'notebook',
    dbtManifestPath: input.dbtManifestPath,
  });
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  const snapshotId = createHash('sha256').update(serializedManifest).digest('hex');

  if (input.writeManifest) await writeManifestAtomically(input.projectRoot, serializedManifest);

  parentPort?.postMessage({ type: 'progress', phase: 'indexing', progress: 55, message: 'Updating governed search indexes.' });
  const indexed = await reindexProject(input.projectRoot, {
    manifest,
    kgPath: defaultKgPath(input.projectRoot),
    forceMetadataCatalog: true,
    forceKgIndex: true,
  });

  return {
    snapshotId,
    objectCount: indexed.nodes,
    edgeCount: indexed.edges,
    metadataFingerprint: indexed.metadataFingerprint,
    kgFingerprint: indexed.kgFingerprint,
  };
}

async function writeManifestAtomically(projectRoot: string, manifest: string): Promise<void> {
  const manifestPath = join(projectRoot, 'dql-manifest.json');
  const tempPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, manifest, 'utf8');
    await rename(tempPath, manifestPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

void run(workerData as ProjectRefreshWorkerInput)
  .then((result) => parentPort?.postMessage({ type: 'complete', result }))
  .catch((error: unknown) => {
    parentPort?.postMessage({
      type: 'error',
      error: {
        code: error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? 'PROJECT_REFRESH_FAILED')
          : 'PROJECT_REFRESH_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  });
