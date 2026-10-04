import type { RecordOwner } from './record-owner.js';

type OwnedRecord = { id: string; ownerId?: string };

/**
 * Answers belong to the person who asked (RFC 0010). With a host, every run a
 * signed-in person starts records them as its owner, and reading a run
 * someone else asked answers "not found" wherever DQL reads it: the run
 * routes, traces, repair, follow-ups and Research. A host person also cannot
 * see runs recorded before the host (they have no owner). A request the host
 * names no one for (`null`) reads none. Without a host (`dql notebook`)
 * nothing changes.
 */
export function withRunOwnership<T extends object>(store: T, ownerOf: () => RecordOwner): T {
  const visible = <R extends OwnedRecord | undefined>(record: R, owner: RecordOwner): R | undefined =>
    record && owner !== undefined && (owner === null || record.ownerId !== owner) ? undefined : record;
  const stamp = <R extends OwnedRecord>(record: R): R => {
    const owner = ownerOf();
    return typeof owner === 'string' && record && record.ownerId === undefined ? { ...record, ownerId: owner } : record;
  };

  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const call = (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
      switch (property) {
        case 'save':
        case 'saveProgress':
          return (record: OwnedRecord) => call(stamp(record));
        case 'get':
        case 'getProgress':
          return (id: string) => {
            const owner = ownerOf();
            const result = call(id);
            return result instanceof Promise
              ? result.then((record) => visible(record as OwnedRecord | undefined, owner))
              : visible(result as OwnedRecord | undefined, owner);
          };
        case 'list':
          return (limit?: number) => {
            const owner = ownerOf();
            if (owner === undefined) return call(limit);
            if (owner === null) return [];
            const filter = (runs: unknown) => (Array.isArray(runs) ? runs.filter((run: OwnedRecord) => run.ownerId === owner) : runs);
            const result = call(limit, { ownerId: owner });
            return result instanceof Promise ? result.then(filter) : filter(result);
          };
        case 'count':
          return () => {
            const owner = ownerOf();
            if (owner === null) return 0;
            return owner === undefined ? call() : call({ ownerId: owner });
          };
        default:
          return value.bind(target);
      }
    },
  });
}
