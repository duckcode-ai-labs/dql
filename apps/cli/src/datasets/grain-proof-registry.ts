import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatasetGrainProofV1 } from '@duckcodeailabs/dql-core';
import {
  DATASET_PROOF_RELATIVE_PATH,
  LOCAL_DATASET_PROOF_RELATIVE_PATH,
  type DatasetBlockProofMaterial,
} from '@duckcodeailabs/dql-agent';
import type { DatasetGrainRuntimeEvidence } from './grain-proof-execution.js';

/**
 * Turn an actual complete-source grain probe into target-bound local evidence.
 * The Dataset declaration owns the stable proof ID; this function never mints
 * a source artifact or promotes the source lifecycle.
 */
export function datasetGrainProofFromRuntime(input: {
  proofId: string;
  material: DatasetBlockProofMaterial;
  evidence: DatasetGrainRuntimeEvidence;
}): DatasetGrainProofV1 {
  const proofId = input.proofId.trim();
  if (!proofId) throw new Error('DATASET_GRAIN_PROOF_ID_REQUIRED: the Dataset declaration must name keyEvidence before validation.');
  if (input.evidence.declaredProofId && input.evidence.declaredProofId !== proofId) {
    throw new Error('DATASET_GRAIN_PROOF_ID_DRIFT: the complete-source probe did not run for this Dataset declaration.');
  }
  return {
    version: 1,
    id: proofId,
    status: input.evidence.status,
    sourceFingerprint: input.evidence.sourceRevision,
    queryFingerprint: input.material.queryFingerprint,
    keyFingerprint: input.material.keyFingerprint,
    parameterFingerprint: input.material.parameterFingerprint,
    targetFingerprint: input.evidence.targetFingerprint,
    snapshotId: input.material.scope.snapshotId,
    snapshotFingerprint: input.material.scope.snapshotFingerprint,
    checkedAt: input.evidence.checkedAt,
    uniqueness: { ...input.evidence.uniqueness },
  };
}

/**
 * Persist only local target evidence. A generated target fingerprint belongs
 * under `.dql/local`, while the stable `keyEvidence` reference stays in the
 * checked-in Dataset declaration. Replacement is atomic for a given proof ID.
 */
export function persistLocalDatasetGrainProof(projectRoot: string, proof: DatasetGrainProofV1, options: { path?: string } = {}): {
  path: string;
  proof: DatasetGrainProofV1;
} {
  const path = options.path ?? join(projectRoot, LOCAL_DATASET_PROOF_RELATIVE_PATH);
  const current = readLocalProofs(path);
  const next = [...current.filter((candidate) => candidate.id !== proof.id), proof]
    .sort((left, right) => left.id.localeCompare(right.id));
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, proofs: next }, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
  return { path, proof };
}

/**
 * RFC 0010: with a host, a grain check runs under the asking person's row rules and credentials, so what it proves
 * is theirs: it is kept in their own file (by the identity that decides their rows), never as shared evidence.
 */
export function personDatasetProofPath(projectRoot: string, personKey: string): string {
  const safe = /^[a-z0-9-]{1,80}$/.test(personKey) ? personKey : 'unknown';
  return join(projectRoot, '.dql', 'local', 'private', 'datasets', 'proofs', `${safe}.json`);
}

/** The proofs one person may go on: the project's checked-in (reviewed) proofs, then their own local ones. */
export function loadPersonDatasetGrainProofs(projectRoot: string, personKey: string): Map<string, DatasetGrainProofV1> {
  const proofs = new Map<string, DatasetGrainProofV1>();
  for (const path of [join(projectRoot, DATASET_PROOF_RELATIVE_PATH), personDatasetProofPath(projectRoot, personKey)]) {
    for (const proof of readLocalProofs(path)) proofs.set(proof.id, proof);
  }
  return proofs;
}

/**
 * With a host: local proofs written before were computed under whoever ran a page then, so they stop being shared
 * evidence. The file is moved where nothing reads it (kept, not deleted). Returns whether there was one.
 */
export function retireSharedLocalDatasetProofs(projectRoot: string): boolean {
  const shared = join(projectRoot, LOCAL_DATASET_PROOF_RELATIVE_PATH);
  if (!existsSync(shared)) return false;
  const kept = join(projectRoot, '.dql', 'local', 'private', 'datasets', 'shared-proofs-before-host.json');
  mkdirSync(dirname(kept), { recursive: true });
  renameSync(shared, kept);
  return true;
}

function readLocalProofs(path: string): DatasetGrainProofV1[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; proofs?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.proofs)) return [];
    return raw.proofs.filter(isProof);
  } catch {
    return [];
  }
}

function isProof(value: unknown): value is DatasetGrainProofV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  const uniqueness = proof.uniqueness;
  return proof.version === 1
    && typeof proof.id === 'string'
    && (proof.status === 'passed' || proof.status === 'failed')
    && ['sourceFingerprint', 'queryFingerprint', 'keyFingerprint', 'parameterFingerprint', 'targetFingerprint', 'snapshotId', 'snapshotFingerprint', 'checkedAt']
      .every((key) => typeof proof[key] === 'string' && Boolean(String(proof[key]).trim()))
    && Boolean(uniqueness) && typeof uniqueness === 'object' && !Array.isArray(uniqueness)
    && ['rowCount', 'distinctKeyCount', 'nullKeyCount', 'duplicateKeyCount']
      .every((key) => Number.isSafeInteger((uniqueness as Record<string, unknown>)[key]) && Number((uniqueness as Record<string, unknown>)[key]) >= 0);
}
