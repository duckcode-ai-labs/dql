import { logUnderReference } from './plain-errors.js';

/**
 * A HOST'S STORES, AS DQL CALLS THEM (RFC 0010 HH-6). A host may keep runs,
 * conversations and notes in its own database. When one of its calls fails —
 * the database is down, a password expired, a connection was cut — the
 * driver's words (addresses, role names, statements) never reach the person:
 * they read a plain sentence with a reference of eight letters, and the
 * store's own text goes to the server's log under that reference. An answer
 * of the wrong shape (a list that is not a list, a count that is not a
 * number) is read as nothing, or as a failure where DQL cannot go on without
 * it; it never reaches a route as it came.
 */
export type HostStoreKind = 'runs' | 'conversations' | 'memory';

const WHAT: Record<HostStoreKind, string> = {
  runs: 'its saved answers',
  conversations: 'its saved conversations',
  memory: 'its saved notes',
};

export class HostStoreError extends Error {
  readonly code = 'HOST_STORE_UNAVAILABLE';
  readonly reference: string;
  constructor(kind: HostStoreKind, reference: string) {
    super(`DQL could not reach ${WHAT[kind]} right now. Try again in a minute; if it keeps happening, ask your administrator about reference ${reference}.`);
    this.name = 'HostStoreError';
    this.reference = reference;
  }
}

/** A store's failure as the person reads it: its own text to the log under a new reference. */
export function hostStoreFailure(kind: HostStoreKind, error: unknown): HostStoreError {
  if (error instanceof HostStoreError) return error;
  return new HostStoreError(kind, logUnderReference(`A host ${kind} store failed`, error));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type Shape = (value: unknown, fail: (why: string) => never) => unknown;

/** A list of records; anything else is an empty list. */
const records: Shape = (value) => (Array.isArray(value) ? value.filter(isRecord) : []);
/** One record, or nothing. */
const recordOrNothing = (nothing: null | undefined): Shape => (value) => (isRecord(value) ? value : nothing);
/** One record DQL cannot go on without: anything else is the store failing. */
const record: Shape = (value, fail) => (isRecord(value) ? value : fail('answered without a record'));
const count: Shape = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const yes: Shape = (value) => value === true;
const idOrNull: Shape = (value) => (typeof value === 'string' && value ? value : null);

const SHAPES: Record<HostStoreKind, Record<string, Shape>> = {
  runs: {
    list: records,
    get: recordOrNothing(undefined),
    getProgress: recordOrNothing(undefined),
    requestClaim: recordOrNothing(undefined),
    claimRequest: record,
    count,
  },
  conversations: {
    createThread: record,
    threadIdForRun: idOrNull,
    getThread: recordOrNothing(null),
    listThreads: records,
    renameThread: yes,
    setThreadFavorite: yes,
    deleteThread: yes,
    appendTurn: record,
    recentTurns: records,
    tierDistribution: record,
    turnsForCompaction: records,
    searchTurns: records,
    pruneThreads: count,
  },
  memory: {
    get: recordOrNothing(null),
    list: records,
    search: records,
  },
};

/**
 * The host's store with every call answered plainly: a failure (a throw, a
 * rejection) is a `HostStoreError`; an answer is shaped as DQL reads it.
 * `deadline` bounds each call (RFC 0010 rule 1, HH-6) when given.
 */
export function guardHostStore<T extends object>(kind: HostStoreKind, store: T, deadline?: <R>(work: () => R | Promise<R>, hook?: string) => Promise<R>): T {
  const shapes = SHAPES[kind];
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      const shape = shapes[property];
      return async (...args: unknown[]) => {
        let answer: unknown;
        try {
          const call = () => (value as (...a: unknown[]) => unknown).apply(target, args);
          answer = deadline ? await deadline(call, `stores.${kind}.${property}`) : await call();
        } catch (error) {
          throw hostStoreFailure(kind, error);
        }
        if (!shape) return answer;
        return shape(answer, (why) => { throw hostStoreFailure(kind, new Error(`${property} ${why}`)); });
      };
    },
  });
}

/** A host's store factory (`stores.memory`, `stores.conversations`), whose own failure is a plain store failure too. */
export function openHostStore<T extends object>(kind: HostStoreKind, open: () => T, deadline?: <R>(work: () => R | Promise<R>, hook?: string) => Promise<R>): T {
  let store: T;
  try {
    store = open();
  } catch (error) {
    throw hostStoreFailure(kind, error);
  }
  if (!isRecord(store)) throw hostStoreFailure(kind, new Error('the store factory answered without a store'));
  return guardHostStore(kind, store, deadline);
}
