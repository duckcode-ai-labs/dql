/**
 * Model area identity helpers.
 *
 * Deliberately dependency-free: this module is exposed as the browser-safe
 * `@zlens/core/modeling-ids` subpath so the notebook can share one
 * implementation with the server instead of re-deriving area ids by hand. The
 * rest of `manifest/` reaches Node built-ins and cannot be bundled.
 *
 * Do not add imports here.
 */

/** The area every model lands in when the author has not chosen one. */
export const DEFAULT_MODEL_AREA_ID = 'core';

/**
 * The local id of a model area, given either the qualified
 * `<domain>::model_area::<localId>` form or the local form.
 *
 * Four server call sites and one UI call site used to split on `'::area::'`,
 * which never matches the real separator, so `.at(-1)` handed back the entire
 * qualified id. Passed on as an `areaId`, that reached the authoring layer's
 * safe-id regex — which rejects `:` — and failed the whole proposal. Binding a
 * dbt model whose `relationships` test pointed at an already-area-owned entity
 * was unreachable as a result. Everything that needs a local id comes here.
 *
 * Takes the last `::` segment rather than slicing after the marker: a local id
 * can never contain `::` (the safe-id charset excludes `:`), so the final
 * segment is always the local id, and an unexpectedly-shaped input still yields
 * something writable instead of a value that fails validation downstream.
 */
export function modelAreaLocalId(value: string): string;
export function modelAreaLocalId(value: string | undefined | null): string | undefined;
export function modelAreaLocalId(value: string | undefined | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.split('::').at(-1)?.trim() || undefined;
}
