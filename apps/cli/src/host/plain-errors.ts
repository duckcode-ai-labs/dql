import { randomBytes } from 'node:crypto';

/**
 * PLAIN WORDS FOR WHAT WENT WRONG, WITH A HOST (RFC 0010 rule 1). A failure's
 * own text can name code (`Cannot read properties of undefined`), quote a
 * value a hook answered with, or carry a database's message (an address, a
 * role name). With a host, such text goes to the server's log under a short
 * reference (the host scrubs its log), and the person reads a plain sentence
 * and that reference.
 */

const REFERENCE_LETTERS = 'bcdfghjkmnpqrstvwxz';

/**
 * Eight letters, no digits and no vowels: a log scrubber that blanks long
 * numbers or quoted text leaves it whole, so the reference a person reads is
 * the one an administrator finds in the log.
 */
export function newReference(): string {
  return [...randomBytes(8)].map((byte) => REFERENCE_LETTERS[byte % REFERENCE_LETTERS.length]).join('');
}

/** A JavaScript runtime error (a bug, or a value of an unexpected shape): its text names code, never a reason for a person. */
export function isProgramError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError;
}

/** Writes the failure's own text to the server's log under a new reference, and returns the reference. */
export function logUnderReference(what: string, error: unknown): string {
  const reference = newReference();
  try {
    const text = error instanceof Error ? error.message : String(error);
    console.warn(`[dql] ${what} (reference ${reference}): ${text}`);
  } catch { /* the person still gets the reference */ }
  return reference;
}

/** The plain sentence a person reads for a failure DQL did not expect, with a host. */
export function plainFailureMessage(reference: string, sentence = 'DQL could not finish this request.'): string {
  return `${sentence} Try again; if it keeps happening, ask your administrator about reference ${reference}.`;
}
