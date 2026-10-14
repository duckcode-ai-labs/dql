/**
 * `ZLENS_<X>` first, then the old `DQL_<X>`; any other name is read as is.
 * A copy of `readEnv` from `@zlens/core` (packages/dql-core/src/env.ts), kept
 * here so this package stays free of dependencies. Keep the two identical.
 */
export function readEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
): string | undefined {
  const suffix = name.startsWith('ZLENS_') ? name.slice(6) : name.startsWith('DQL_') ? name.slice(4) : undefined;
  if (!suffix) return env[name];
  const current = env[`ZLENS_${suffix}`];
  return current !== undefined ? current : env[`DQL_${suffix}`];
}
