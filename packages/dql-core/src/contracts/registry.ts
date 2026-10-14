/**
 * DataLex contract registry — the consumer side of the manifest-spec
 * `datalex_contract` interop pattern.
 *
 * Reads a DataLex manifest (JSON file) and indexes its contracts by id so
 * the DQL compiler can resolve `datalex_contract = "domain.Entity.name@1"`
 * references at compile time. Resolution failures are returned as
 * structured `ContractResolution` values; they become DQL compiler
 * diagnostics in the analyzer wiring (Phase 2.1 follow-up).
 *
 * See:
 *   - manifest-spec/docs/interop.md (resolution rules)
 *   - manifest-spec/schemas/v1/datalex-manifest.schema.json (source of truth)
 */

import { existsSync, readFileSync } from 'node:fs';

import {
  type ContractId,
  type ContractRef,
  type ContractResolution,
  type DataLexConformance,
  type DataLexContract,
  type DataLexManifest,
  type DataLexRelationship,
  type DataLexRelationshipEndpoint,
  type JoinPathResolution,
  type RelationshipCardinality,
  parseContractRef,
} from './types.js';

interface IndexedContract {
  contract: DataLexContract;
  domain: string;
  entity: string;
}

/**
 * Loads a DataLex manifest into an indexed contract lookup. One registry
 * instance per ZLens project. Re-create or call `reload()` between
 * compilation runs if the manifest changes on disk.
 */
export class DataLexContractRegistry {
  private readonly byId = new Map<ContractId, IndexedContract[]>();
  private readonly diagnostics: string[] = [];
  private readonly relationshipList: DataLexRelationship[] = [];
  private readonly conformanceList: DataLexConformance[] = [];

  constructor(private readonly source: { manifestPath?: string; manifest?: DataLexManifest } = {}) {
    this.reload();
  }

  /** Reload from the configured source. Useful when the manifest is regenerated mid-session. */
  reload(): void {
    this.byId.clear();
    this.diagnostics.length = 0;
    this.relationshipList.length = 0;
    this.conformanceList.length = 0;

    let manifest: DataLexManifest | null = null;
    if (this.source.manifest) {
      manifest = this.source.manifest;
    } else if (this.source.manifestPath) {
      manifest = this.loadFromDisk(this.source.manifestPath);
    }
    if (!manifest) return;
    this.indexManifest(manifest);
  }

  /**
   * Resolve a `datalex_contract` reference from a DQL block.
   *
   * The resolution rules match `manifest-spec/docs/interop.md`:
   *   - The ref MUST parse as `<domain>.<Entity>.<contract_name>` with an
   *     optional `@<version>` suffix. Otherwise: `malformed_ref`.
   *   - The id MUST exist in the registry. Otherwise: `not_found`.
   *   - If a version is pinned, a contract with that version MUST exist
   *     under the id. Otherwise: `version_mismatch`.
   *   - If no version is pinned, the highest version wins; the caller may
   *     emit a "version-pinning recommended" warning separately.
   */
  resolve(ref: ContractRef): ContractResolution {
    const parsed = parseContractRef(ref);
    if (!parsed.ok || !parsed.id) {
      return {
        ok: false,
        reason: 'malformed_ref',
        message: parsed.reason ?? 'invalid contract reference',
        requestedRef: ref,
      };
    }
    const indexed = this.byId.get(parsed.id);
    if (!indexed || indexed.length === 0) {
      return {
        ok: false,
        reason: 'not_found',
        message: `No DataLex contract with id "${parsed.id}" found in the loaded manifest.`,
        requestedRef: ref,
        requestedVersion: parsed.version,
      };
    }
    if (parsed.version === undefined) {
      const winner = indexed.reduce((best, candidate) =>
        candidate.contract.version > best.contract.version ? candidate : best,
      );
      return {
        ok: true,
        contract: winner.contract,
        domain: winner.domain,
        entity: winner.entity,
      };
    }
    const match = indexed.find((c) => c.contract.version === parsed.version);
    if (!match) {
      return {
        ok: false,
        reason: 'version_mismatch',
        message: `DataLex contract "${parsed.id}" has no version ${parsed.version} in the loaded manifest.`,
        requestedRef: ref,
        requestedVersion: parsed.version,
        availableVersions: indexed.map((c) => c.contract.version).sort((a, b) => a - b),
      };
    }
    return { ok: true, contract: match.contract, domain: match.domain, entity: match.entity };
  }

  /** All contracts known to this registry, in stable id-then-version order. */
  list(): IndexedContract[] {
    const out: IndexedContract[] = [];
    for (const id of Array.from(this.byId.keys()).sort()) {
      const versions = this.byId.get(id) ?? [];
      out.push(
        ...[...versions].sort((a, b) => a.contract.version - b.contract.version),
      );
    }
    return out;
  }

  /** True when the registry was constructed from a real source. */
  isLoaded(): boolean {
    return this.byId.size > 0;
  }

  /** Diagnostics emitted while loading the manifest (parse errors, schema drift, etc.). */
  loadDiagnostics(): string[] {
    return [...this.diagnostics];
  }

  /** All typed relationships from the manifest (any layer), in load order. */
  relationships(): DataLexRelationship[] {
    return [...this.relationshipList];
  }

  /** All concept-to-physical conformance records from the manifest. */
  conformance(): DataLexConformance[] {
    return [...this.conformanceList];
  }

  /**
   * Conformance record for a business concept (e.g. "Customer"), so a consumer
   * can resolve its canonical join key and the physical models that realize it.
   * Matches case-insensitively on concept name, and on domain when provided.
   */
  conformanceFor(concept: string, domain?: string): DataLexConformance | undefined {
    const want = concept.toLowerCase();
    return this.conformanceList.find(
      (c) =>
        c.concept.toLowerCase() === want &&
        (domain === undefined || (c.domain ?? '').toLowerCase() === domain.toLowerCase()),
    );
  }

  /**
   * Resolve a grain-safe join path between two entities. Returns the connecting
   * relationship oriented base -> target, with `fansOut` set when joining
   * `target` onto `base` can multiply base rows. Column-carrying (logical /
   * physical) relationships are preferred over column-less conceptual ones.
   */
  joinPath(
    baseEntity: string,
    targetEntity: string,
    opts: { baseDomain?: string; targetDomain?: string } = {},
  ): JoinPathResolution {
    const matches = this.relationshipList.filter((rel) => {
      const direct =
        this.endpointMatches(rel.from, baseEntity, opts.baseDomain) &&
        this.endpointMatches(rel.to, targetEntity, opts.targetDomain);
      const reverse =
        this.endpointMatches(rel.from, targetEntity, opts.targetDomain) &&
        this.endpointMatches(rel.to, baseEntity, opts.baseDomain);
      return direct || reverse;
    });
    if (matches.length === 0) {
      return {
        ok: false,
        reason: 'no_relationship',
        message: `No DataLex relationship connects "${baseEntity}" and "${targetEntity}".`,
      };
    }
    const withColumns = matches.filter((r) => r.from.column && r.to.column);
    const candidates = withColumns.length > 0 ? withColumns : matches;
    if (candidates.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        message: `Multiple relationships connect "${baseEntity}" and "${targetEntity}"; pin one by name.`,
      };
    }
    const rel = candidates[0];
    const directBase = this.endpointMatches(rel.from, baseEntity, opts.baseDomain);
    const base = directBase ? rel.from : rel.to;
    const target = directBase ? rel.to : rel.from;
    const cardinality = directBase ? rel.cardinality : this.invertCardinality(rel.cardinality);
    const fansOut = cardinality === 'one_to_many' || cardinality === 'many_to_many';
    return { ok: true, relationship: rel, base, target, cardinality, fansOut };
  }

  private endpointMatches(
    ep: DataLexRelationshipEndpoint,
    entity: string,
    domain?: string,
  ): boolean {
    if (ep.entity.toLowerCase() !== entity.toLowerCase()) return false;
    if (domain !== undefined && ep.domain !== undefined) {
      return ep.domain.toLowerCase() === domain.toLowerCase();
    }
    return true;
  }

  private invertCardinality(
    cardinality?: RelationshipCardinality,
  ): RelationshipCardinality | undefined {
    switch (cardinality) {
      case 'one_to_many':
        return 'many_to_one';
      case 'many_to_one':
        return 'one_to_many';
      default:
        return cardinality;
    }
  }

  private loadFromDisk(path: string): DataLexManifest | null {
    if (!existsSync(path)) {
      this.diagnostics.push(`DataLex manifest not found at ${path}.`);
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (err) {
      this.diagnostics.push(
        `Failed to read DataLex manifest at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        this.diagnostics.push(`DataLex manifest at ${path} is not a JSON object.`);
        return null;
      }
      return parsed as DataLexManifest;
    } catch (err) {
      this.diagnostics.push(
        `Failed to parse DataLex manifest at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private indexManifest(manifest: DataLexManifest): void {
    if (Array.isArray(manifest.domains)) {
      for (const domain of manifest.domains) {
        if (!domain || !Array.isArray(domain.entities)) continue;
        for (const entity of domain.entities) {
          if (!entity || !Array.isArray(entity.contracts)) continue;
          for (const contract of entity.contracts) {
            if (!contract || typeof contract.id !== 'string') continue;
            const list = this.byId.get(contract.id) ?? [];
            list.push({ contract, domain: domain.name, entity: entity.name });
            this.byId.set(contract.id, list);
          }
        }
      }
    }
    if (Array.isArray(manifest.relationships)) {
      for (const rel of manifest.relationships) {
        if (rel && typeof rel.name === 'string' && rel.from?.entity && rel.to?.entity) {
          this.relationshipList.push(rel);
        }
      }
    }
    if (Array.isArray(manifest.conformance)) {
      for (const record of manifest.conformance) {
        if (record && typeof record.concept === 'string') {
          this.conformanceList.push(record);
        }
      }
    }
  }
}
