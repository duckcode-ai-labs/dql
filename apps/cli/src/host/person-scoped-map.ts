/**
 * A map whose entries belong to whoever set them (RFC 0010): `get`, `has` and
 * `delete` see an entry only for the same owner — for run evidence, the
 * person and App persona who ran it — so knowing a key is never enough.
 */
export class PersonScopedMap<K, V> extends Map<K, V> {
  private readonly owners = new Map<K, string>();

  constructor(private readonly ownerOf: () => string) {
    super();
  }

  override set(key: K, value: V): this {
    // During Map construction `owners` is not ready; nothing is passed then.
    this.owners?.set(key, this.ownerOf());
    return super.set(key, value);
  }

  override get(key: K): V | undefined {
    return this.owners.get(key) === this.ownerOf() ? super.get(key) : undefined;
  }

  override has(key: K): boolean {
    return this.owners.get(key) === this.ownerOf() && super.has(key);
  }

  override delete(key: K): boolean {
    if (this.owners.get(key) !== this.ownerOf()) return false;
    this.owners.delete(key);
    return super.delete(key);
  }

  /** Remove every entry, whoever owns it, that `stale` says has expired (housekeeping, not access). */
  sweep(stale: (value: V) => boolean): void {
    for (const [key, value] of super.entries()) {
      if (!stale(value)) continue;
      this.owners.delete(key);
      super.delete(key);
    }
  }

  override clear(): void {
    this.owners.clear();
    super.clear();
  }
}
