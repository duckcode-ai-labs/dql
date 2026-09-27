/**
 * Store shapes for hosts that keep DQL's state elsewhere (RFC 0010 HH-6).
 *
 * DQL's own stores are SQLite files and answer synchronously. A host that runs
 * several copies of DQL on one database (Postgres, say) answers with
 * Promises. DQL awaits every store call, so either works:
 *
 * - `PromisedMethods<T>`: the host contract, every method returns a Promise.
 * - `AwaitableMethods<T>`: what DQL itself accepts, a value or a Promise.
 */

export type Awaitable<T> = T | Promise<T>;

type Method = (...args: never[]) => unknown;

/** Every method of `T` returns a Promise of what it returned. */
export type PromisedMethods<T> = {
  [K in keyof T]: T[K] extends Method
    ? (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>>
    : T[K];
};

/** Every method of `T` may return its value or a Promise of it. */
export type AwaitableMethods<T> = {
  [K in keyof T]: T[K] extends Method
    ? (...args: Parameters<T[K]>) => Awaitable<Awaited<ReturnType<T[K]>>>
    : T[K];
};
