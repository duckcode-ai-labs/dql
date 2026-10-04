import type { DqlHostHooks } from './request-context.js';

/**
 * A TIME LIMIT ON EVERY HOOK DQL WAITS FOR (RFC 0010 rule 1). A host's
 * policy store, identity provider or database can hang; DQL then must not
 * hold the person's request (or their Ask run) until their browser gives
 * up. Each hook DQL waits on gets a deadline; one that does not answer in
 * time is treated as one that failed, which every hook already handles by
 * failing closed (a refusal, no figures, nothing listed, a plain message).
 * An answer that arrives after the deadline is ignored.
 *
 * - Decisions and stores (who is asking, what they may do or see, figures,
 *   sources, columns, the screens around DQL, follows, Home, groups,
 *   knowledge sources, the stores): `hostHookTimeoutMs`, 10 seconds unless
 *   the embedding program sets it.
 * - Work the host does outside DQL (delivery, signing, git): six times that.
 * - The tool gate's own decision: until it calls `next()`; the tool's run
 *   after that is not bounded here.
 * - Observers DQL does not wait for (audit, traces, statements, page
 *   editions) and the synchronous model hooks are left as they are.
 */
export const DEFAULT_HOST_HOOK_TIMEOUT_MS = 10_000;
const EFFECT_FACTOR = 6;

export class HostHookTimeoutError extends Error {
  readonly code = 'HOST_HOOK_TIMEOUT';
  readonly hook: string;
  constructor(hook: string, ms: number) {
    super(`The host did not answer ${hook} within ${ms} ms.`);
    this.name = 'HostHookTimeoutError';
    this.hook = hook;
  }
}

/** `work`'s answer, or a `HostHookTimeoutError` when it does not answer within `ms`. */
export function withDeadline<R>(hook: string, ms: number, work: () => R | Promise<R>): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new HostHookTimeoutError(hook, ms));
    }, ms);
    timer.unref?.();
    Promise.resolve().then(work).then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } },
    );
  });
}

/** The deadline every decision and store call of one server uses. */
export function hookDeadline(ms: number): <R>(work: () => R | Promise<R>, hook?: string) => Promise<R> {
  return (work, hook = 'a store call') => withDeadline(hook, ms, work);
}

/** A valid time limit, or the default. */
export function hostHookTimeoutMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_HOST_HOOK_TIMEOUT_MS;
}

type AnyFunction = (...args: never[]) => unknown;

/** The decision hooks DQL waits on, each bounded by the decision deadline. */
const DECISION_HOOKS = [
  'resolvePrincipal', 'authorize', 'rowPolicy', 'credentials', 'columnsVisible', 'audience', 'ui', 'answerStatus',
  'sourceAccess', 'answerFigures', 'figuresDependOnReader', 'keepsAnswerText', 'knowledgeSources', 'homeCards',
  'directoryGroups',
] as const satisfies ReadonlyArray<keyof DqlHostHooks>;

/**
 * The host's hooks with a deadline on every one DQL waits for (see above).
 * Only the hooks the host gave are present, so "has a hook" checks keep their
 * meaning. Stores are bounded where DQL opens them (`host-stores.ts`).
 */
export function hooksWithDeadlines(hooks: DqlHostHooks, timeoutMs?: number): DqlHostHooks {
  const ms = hostHookTimeoutMs(timeoutMs);
  const effectMs = ms * EFFECT_FACTOR;
  const bounded: DqlHostHooks = { ...hooks };
  const target = bounded as Record<string, unknown>;
  for (const name of DECISION_HOOKS) {
    const raw = hooks[name] as AnyFunction | undefined;
    if (typeof raw !== 'function') continue;
    target[name] = (...args: never[]) => withDeadline(name, ms, () => raw.apply(hooks, args));
  }
  if (hooks.follows && typeof hooks.follows === 'object') {
    bounded.follows = boundedMethods(hooks.follows, { list: ms, set: ms }, 'follows');
  }
  if (typeof hooks.tools === 'function') {
    const tools = hooks.tools;
    bounded.tools = (call, next) => new Promise<unknown>((resolve, reject) => {
      // The gate decides before it calls next(); a gate that has not decided in time refuses the tool, and a next()
      // it calls after that never runs it.
      let decided = false;
      let refused = false;
      const timer = setTimeout(() => {
        if (decided) return;
        refused = true;
        reject(new HostHookTimeoutError('tools', ms));
      }, ms);
      timer.unref?.();
      const gatedNext = () => {
        if (refused) return Promise.reject(new HostHookTimeoutError('tools', ms));
        decided = true;
        clearTimeout(timer);
        return next();
      };
      Promise.resolve().then(() => tools(call, gatedNext)).then(
        (value) => { clearTimeout(timer); if (!refused) resolve(value); },
        (error) => { clearTimeout(timer); if (!refused) reject(error); },
      );
    });
  }
  if (typeof hooks.delivery === 'function') {
    const delivery = hooks.delivery;
    bounded.delivery = (message) => withDeadline('delivery', effectMs, () => delivery(message));
  }
  if (hooks.signing && typeof hooks.signing === 'object') {
    bounded.signing = boundedMethods(hooks.signing, { sign: effectMs }, 'signing');
  }
  if (hooks.git && typeof hooks.git === 'object') {
    bounded.git = boundedMethods(hooks.git, { openPullRequest: effectMs }, 'git');
  }
  return bounded;
}

/** An object of the host's whose named methods answer within their deadline; everything else read as it is. */
function boundedMethods<T extends object>(object: T, limits: Record<string, number>, label: string): T {
  return new Proxy(object, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property !== 'string' || typeof value !== 'function' || limits[property] === undefined) return value;
      return (...args: unknown[]) => withDeadline(`${label}.${property}`, limits[property]!, () => (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });
}
