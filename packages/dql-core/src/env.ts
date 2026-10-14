/**
 * Environment variables after the rename to ZLens.
 *
 * Every product setting is read as `ZLENS_<X>` first and falls back to the
 * old `DQL_<X>`, so existing shells, compose files and CI secrets keep working.
 * Call sites name the new variable (`readEnv('ZLENS_SERVER_TOKEN')`); passing
 * the old `DQL_` name resolves the same pair. Any other name is read as is.
 *
 * A set `ZLENS_<X>` wins even when it is the empty string, so it can override
 * an inherited `DQL_<X>`. Values are returned untouched and never logged.
 *
 * This module has no imports and does not assume Node: in a browser bundle it
 * reads from an empty environment. Packages that must not depend on
 * `@zlens/core` (connectors, telemetry, openlineage) carry a copy of
 * `readEnv`; keep those copies identical to this one.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export const ENV_PREFIX = 'ZLENS_';
export const LEGACY_ENV_PREFIX = 'DQL_';

function processEnv(): EnvSource {
  const proc = (globalThis as { process?: { env?: EnvSource } }).process;
  return proc?.env ?? {};
}

/** `[ZLENS_<X>, DQL_<X>]` for a product variable, or `[name]` for anything else. */
export function envNames(name: string): readonly string[] {
  const suffix = name.startsWith(ENV_PREFIX)
    ? name.slice(ENV_PREFIX.length)
    : name.startsWith(LEGACY_ENV_PREFIX)
      ? name.slice(LEGACY_ENV_PREFIX.length)
      : undefined;
  if (!suffix) return [name];
  return [`${ENV_PREFIX}${suffix}`, `${LEGACY_ENV_PREFIX}${suffix}`];
}

/** Reads `ZLENS_<X>`, then `DQL_<X>`; other names are read directly. */
export function readEnv(name: string, env: EnvSource = processEnv()): string | undefined {
  for (const candidate of envNames(name)) {
    const value = env[candidate];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Both spellings of a product variable with one value, for the environment of
 * a child process: the child reads `ZLENS_<X>` first, so setting only the old
 * name would let an inherited `ZLENS_<X>` win over the value meant for it.
 */
export function envPair(name: string, value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const candidate of envNames(name)) out[candidate] = value;
  return out;
}
