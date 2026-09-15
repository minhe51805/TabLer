/**
 * Typed layer for the per-connection pool-size knob (Phase 3D #4 UI).
 *
 * The value is carried in `ConnectionConfig.additional_fields` under
 * `pool_max_connections` (alias `poolMaxConnections`) — the same
 * backward-compatible mechanism the backend reads in
 * `src-tauri/src/config.rs::resolve_pool_max_connections`. Keeping the numbers
 * and semantics here in one typed place mirrors the Rust constants so the form
 * control, the stored value and the driver-side clamp never drift apart.
 */
import type { DatabaseType } from "../../types/database";

/** `additional_fields` key the backend resolver reads (snake_case canonical). */
export const POOL_MAX_CONNECTIONS_KEY = "pool_max_connections";
/** Legacy camelCase alias also accepted by the backend for saved profiles. */
export const POOL_MAX_CONNECTIONS_ALIAS_KEY = "poolMaxConnections";

/** Compiled fallback used when the knob is unset/blank. Mirrors `POOL_MAX_CONNECTIONS`. */
export const POOL_MAX_CONNECTIONS_DEFAULT = 8;
/** Lower clamp bound. Mirrors `MIN_POOL_MAX_CONNECTIONS`. */
export const MIN_POOL_MAX_CONNECTIONS = 1;
/** Upper clamp bound. Mirrors `MAX_POOL_MAX_CONNECTIONS`. */
export const MAX_POOL_MAX_CONNECTIONS = 64;

/**
 * Engines whose driver actually builds an SQLx pool sized by this knob
 * (PostgreSQL + the MySQL/MariaDB driver). For every other engine the value is
 * a no-op, so the control is hidden.
 */
export const POOL_CAPABLE_ENGINES: readonly DatabaseType[] = ["postgresql", "mysql", "mariadb"];

/** True when the selected engine honours the pool-size override. */
export function engineSupportsPoolSizing(dbType: DatabaseType | undefined): boolean {
  return dbType != null && POOL_CAPABLE_ENGINES.includes(dbType);
}

/**
 * Clamp a positive pool size into `[MIN, MAX]`, mirroring the backend resolver.
 * Non-finite / non-positive inputs return the compiled default.
 */
export function clampPoolMaxConnections(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return POOL_MAX_CONNECTIONS_DEFAULT;
  const floored = Math.floor(value);
  return Math.min(Math.max(floored, MIN_POOL_MAX_CONNECTIONS), MAX_POOL_MAX_CONNECTIONS);
}

/**
 * Read the effective override from `additional_fields`, or `undefined` when it
 * is unset / blank / non-numeric / non-positive (all of which mean "use the
 * backend default"). Accepts both the canonical key and the legacy alias.
 */
export function getPoolMaxConnections(
  additionalFields: Record<string, string> | undefined,
): number | undefined {
  const raw =
    additionalFields?.[POOL_MAX_CONNECTIONS_KEY] ??
    additionalFields?.[POOL_MAX_CONNECTIONS_ALIAS_KEY];
  if (raw == null || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}
