import { currentRequestContext } from './request-context.js';

/**
 * RFC 0010: who a per-person record (a question, an answer, a result computed
 * under someone's row rules) is kept for, and the only one who reads it.
 *
 * - `undefined`: no host. No owner and no filter: the one local user reads
 *   every record, as before.
 * - a string: the signed-in person's id. Records are stamped with it and only
 *   theirs are read; someone else's id reads as not found.
 * - `null`: a host that names nobody for this request. Such a caller reads no
 *   one's records, and what it keeps is no one's.
 *
 * Records from before the host have no owner and are no one's with a host.
 */
export type RecordOwner = string | null | undefined;

/**
 * The owner for the current request, from its context alone: the signed-in person's id; null when the request ran
 * under host hooks with nobody signed in; undefined without a host.
 */
export function currentRecordOwner(): RecordOwner {
  const context = currentRequestContext();
  const principal = context?.principal;
  if (principal && principal.source !== 'local') return principal.id;
  return context?.hooks ? null : undefined;
}

/** Whether a record kept for `ownerId` may be read by `reader` (see RecordOwner). */
export function ownedBy(ownerId: string | null | undefined, reader: RecordOwner): boolean {
  if (reader === undefined) return true;
  return reader !== null && typeof ownerId === 'string' && ownerId === reader;
}
