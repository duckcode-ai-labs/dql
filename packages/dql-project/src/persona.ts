/**
 * Active-persona registry.
 *
 * The OSS desktop runs as a single local owner, but Apps declare members,
 * roles, policies, and RLS bindings in `dql.app.json`. The persona registry
 * is the runtime source of truth for "who is this query running as right now"
 * — read by the dql-governance PolicyEngine and the @rls deferred resolver.
 *
 * Rules:
 * - Single active persona per process. Switching is explicit. A host that
 *   serves several people (RFC 0010) installs a slot resolver so each person
 *   has their own active persona; one person's switch never reaches another.
 * - The registry never writes auth state to disk; persistence (last-used
 *   persona) is the UI's job, not the library's.
 * - When no persona is set, the default owner context applies (full access,
 *   no RLS narrowing). This matches today's single-user behaviour.
 */

import type { AppDocument, AppMember } from '@zlens/core';
import { resolveRlsContext } from '@zlens/core';

export interface ActivePersona {
  /** Stable user id (typically email). */
  userId: string;
  /** Display name surfaced in the UI. */
  displayName?: string;
  /** Roles this persona currently holds within an App. */
  roles: string[];
  /** Free-form attributes. */
  attributes: Record<string, string | number | boolean>;
  /**
   * RLS context resolved from the App's `rlsBindings`. Keys here are the
   * `{user.<key>}` template variables; values are the substitutions.
   * Empty when no App is active or no bindings match.
   */
  rlsContext: Record<string, string | number | boolean>;
  /** App id this persona is currently scoped to (if any). */
  appId?: string;
}

export interface UserContextLike {
  userId: string;
  roles: string[];
  department?: string;
}

type Listener = (next: ActivePersona | null) => void;

/** Where the active persona lives for the current caller. */
export interface PersonaSlot {
  value: ActivePersona | null;
}

/**
 * Process-wide persona registry. Designed to be a single instance per
 * process (use `defaultPersonaRegistry`). Tests can construct fresh
 * instances for isolation.
 */
export class PersonaRegistry {
  private current: ActivePersona | null = null;
  private readonly listeners = new Set<Listener>();
  private slotResolver: (() => PersonaSlot | undefined) | null = null;

  /**
   * Keep the active persona per caller instead of per process: the resolver
   * returns the slot for whoever is calling now (e.g. the signed-in person
   * of the current request), or undefined to use the process-wide persona.
   * Pass null to go back to one persona per process.
   */
  useSlots(resolver: (() => PersonaSlot | undefined) | null): void {
    this.slotResolver = resolver;
  }

  /** Currently active persona, or null when no App is bound. */
  get active(): ActivePersona | null {
    const slot = this.slotResolver?.();
    return slot ? slot.value : this.current;
  }

  /** Set the active persona to a fully-resolved record. */
  set(next: ActivePersona | null): void {
    const slot = this.slotResolver?.();
    if (slot) slot.value = next;
    else this.current = next;
    for (const cb of this.listeners) cb(next);
  }

  /**
   * Resolve and activate a persona from an `AppDocument` + a `userId`.
   * Returns the resolved persona, or `null` if the user is not a member of the App.
   */
  setFromApp(app: AppDocument, userId: string): ActivePersona | null {
    const member = app.members.find((m) => m.userId === userId);
    if (!member) {
      this.set(null);
      return null;
    }
    const persona = personaFromMember(app, member);
    this.set(persona);
    return persona;
  }

  /** Clear the active persona; downstream code falls back to owner default. */
  clear(): void {
    this.set(null);
  }

  /** Subscribe to changes. Returns an unsubscribe handle. */
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Build the dql-governance UserContext shape. Owner default if unset. */
  toUserContext(ownerFallback: UserContextLike = OWNER_DEFAULT): UserContextLike {
    const current = this.active;
    if (!current) return ownerFallback;
    return {
      userId: current.userId,
      roles: current.roles,
      department: typeof current.attributes.department === 'string'
        ? (current.attributes.department as string)
        : undefined,
    };
  }

  /**
   * Resolve a `{user.<var>}` reference against the active RLS context.
   * Returns `undefined` when no value is bound — callers should typically
   * fail-closed (reject the query) rather than leak unfiltered data.
   */
  resolveUserVar(name: string): string | number | boolean | undefined {
    return this.active?.rlsContext[name];
  }
}

/** Build a fully-resolved persona from an App + a member. */
export function personaFromMember(app: AppDocument, member: AppMember): ActivePersona {
  return {
    userId: member.userId,
    displayName: member.displayName,
    roles: [...member.roles],
    attributes: { ...(member.attributes ?? {}) },
    rlsContext: resolveRlsContext(app, member),
    appId: app.id,
  };
}

/**
 * Default owner context — used when no persona is active. Matches today's
 * single-user behaviour: full read/execute, no RLS narrowing.
 */
export const OWNER_DEFAULT: UserContextLike = {
  userId: '__owner__',
  roles: ['owner'],
};

/** Process-singleton. Other modules should import this rather than constructing their own. */
export const defaultPersonaRegistry = new PersonaRegistry();
