import type { InstalledPluginRecord, PluginDriverContribution } from "../types/plugin";

export interface RuntimePluginDriver extends PluginDriverContribution {
  pluginId: string;
  pluginName: string;
}

export function getEnabledPluginDrivers(
  plugins: InstalledPluginRecord[],
): RuntimePluginDriver[] {
  return plugins.flatMap((plugin) => {
    if (!plugin.enabled || !plugin.verified || plugin.validationError) return [];
    if (!plugin.manifest.capabilities.includes("database")) return [];
    return plugin.manifest.contributes.drivers.map((driver) => ({
      ...driver,
      pluginId: plugin.manifest.id,
      pluginName: plugin.manifest.name,
    }));
  });
}

/**
 * Engine protocols delivered as declarative HTTP plugins — the exact
 * `DriverDistribution::PluginHttp` set in capabilities.rs. These engines only
 * connect once a matching plugin is installed, enabled, and verified.
 */
export const PLUGIN_HTTP_PROTOCOLS = [
  "opensearch",
  "clickhouse",
  "bigquery",
  "snowflake",
  "cloudflare_d1",
] as const;

export type PluginHttpProtocol = (typeof PLUGIN_HTTP_PROTOCOLS)[number];

export function isPluginHttpProtocol(key: string): key is PluginHttpProtocol {
  return (PLUGIN_HTTP_PROTOCOLS as readonly string[]).includes(key);
}

export function findStableDriverForProtocol(
  plugins: InstalledPluginRecord[],
  protocol: string,
) {
  return getEnabledPluginDrivers(plugins).find(
    (driver) =>
      driver.protocol === protocol &&
      driver.runtime === "declarative-http-v1" &&
      driver.status === "stable",
  );
}

export function findStableOpenSearchDriver(plugins: InstalledPluginRecord[]) {
  return findStableDriverForProtocol(plugins, "opensearch");
}

/** Map each PluginHttp protocol to its installed stable driver, if any. */
export function resolvePluginHttpDrivers(
  plugins: InstalledPluginRecord[],
): Record<PluginHttpProtocol, RuntimePluginDriver | undefined> {
  const map = {} as Record<PluginHttpProtocol, RuntimePluginDriver | undefined>;
  for (const protocol of PLUGIN_HTTP_PROTOCOLS) {
    map[protocol] = findStableDriverForProtocol(plugins, protocol);
  }
  return map;
}

/**
 * Runtime availability of a PluginHttp engine's driver, derived from the
 * installed plugin set. This is the single source of truth that keeps the
 * connection picker and the Plugin Manager in sync so an installed-but-disabled
 * driver is never presented as a not-yet-available "roadmap" engine.
 *  - "active"    -> an enabled, verified, stable declarative-http driver exists
 *                   (connectable now; same as the legacy `supported === true`).
 *  - "installed" -> a matching driver bundle is installed but not active yet
 *                   (disabled, unverified, or non-stable) — it needs enabling,
 *                   it is NOT a roadmap-only engine.
 *  - "roadmap"   -> no matching driver bundle is installed at all.
 */
export type PluginHttpAvailability = "active" | "installed" | "roadmap";

/**
 * Whether any installed plugin bundle contributes a declarative-http driver for
 * this protocol, regardless of its enabled/verified/status flags. Used to tell
 * an installed-but-inactive engine apart from a true roadmap engine.
 */
export function hasInstalledPluginHttpDriver(
  plugins: InstalledPluginRecord[],
  protocol: string,
): boolean {
  return plugins.some(
    (plugin) =>
      plugin.manifest.capabilities.includes("database") &&
      plugin.manifest.contributes.drivers.some(
        (driver) =>
          driver.protocol === protocol &&
          driver.runtime === "declarative-http-v1",
      ),
  );
}

/** Resolve the {@link PluginHttpAvailability} for a single protocol. */
export function resolvePluginHttpAvailability(
  plugins: InstalledPluginRecord[],
  protocol: PluginHttpProtocol,
): PluginHttpAvailability {
  if (findStableDriverForProtocol(plugins, protocol)) return "active";
  if (hasInstalledPluginHttpDriver(plugins, protocol)) return "installed";
  return "roadmap";
}

/** Map every PluginHttp protocol to its {@link PluginHttpAvailability}. */
export function resolvePluginHttpAvailabilityMap(
  plugins: InstalledPluginRecord[],
): Record<PluginHttpProtocol, PluginHttpAvailability> {
  const map = {} as Record<PluginHttpProtocol, PluginHttpAvailability>;
  for (const protocol of PLUGIN_HTTP_PROTOCOLS) {
    map[protocol] = resolvePluginHttpAvailability(plugins, protocol);
  }
  return map;
}

/**
 * Engine protocols delivered as compiled native-crate drivers — the exact
 * `DriverDistribution::PluginNative` set in capabilities.rs (DuckDB, Cassandra,
 * Redis, LibSQL). Unlike HTTP plugins these are linked at build time behind a
 * Cargo feature, so a lean build may omit them. The backend
 * `get_native_driver_availability` command reports which are actually compiled
 * in; the connection picker gates on that instead of failing at connect time.
 */
export const PLUGIN_NATIVE_PROTOCOLS = [
  "duckdb",
  "cassandra",
  "redis",
  "libsql",
] as const;

export type PluginNativeProtocol = (typeof PLUGIN_NATIVE_PROTOCOLS)[number];

export function isPluginNativeProtocol(key: string): key is PluginNativeProtocol {
  return (PLUGIN_NATIVE_PROTOCOLS as readonly string[]).includes(key);
}

/**
 * Whether a native engine is connectable in the running build, read from the
 * backend availability map (`get_native_driver_availability`). Non-native keys
 * are always available; an unknown/missing native key defaults to `true` so a
 * failed or not-yet-loaded report never hides an engine the build supports (the
 * backend still guards the connect path). The default build ships all four, so
 * this only changes behavior for intentionally lean builds.
 */
export function isNativeDriverAvailable(
  availability: Record<string, boolean> | undefined,
  key: string,
): boolean {
  if (!isPluginNativeProtocol(key)) return true;
  return availability?.[key] ?? true;
}

/**
 * Find an installed, enabled, verified sidecar driver for a native protocol.
 * Mirrors {@link findStableDriverForProtocol} but for the out-of-process
 * `driver-sidecar-v1` runtime (Phase 4). Both `stable` and `experimental`
 * statuses count because the manifest validator accepts either for sidecars —
 * a lean build that installs a sidecar plugin should be able to connect through
 * it regardless of maturity label.
 */
export function findSidecarDriverForProtocol(
  plugins: InstalledPluginRecord[],
  protocol: string,
) {
  return getEnabledPluginDrivers(plugins).find(
    (driver) =>
      driver.protocol === protocol &&
      driver.runtime === "driver-sidecar-v1" &&
      (driver.status === "stable" || driver.status === "experimental"),
  );
}

/** Map each PluginNative protocol to its installed sidecar driver, if any. */
export function resolveNativeSidecarDrivers(
  plugins: InstalledPluginRecord[],
): Record<PluginNativeProtocol, RuntimePluginDriver | undefined> {
  const map = {} as Record<PluginNativeProtocol, RuntimePluginDriver | undefined>;
  for (const protocol of PLUGIN_NATIVE_PROTOCOLS) {
    map[protocol] = findSidecarDriverForProtocol(plugins, protocol);
  }
  return map;
}

/**
 * Whether a native engine is connectable at all: either the driver was compiled
 * into the running build (see {@link isNativeDriverAvailable}) OR a verified
 * `driver-sidecar-v1` plugin is installed for it. This closes the "download and
 * connect" loop for native engines the same way an installed HTTP plugin does
 * for `PluginHttp` engines. Non-native keys are always connectable.
 */
export function isNativeEngineConnectable(
  availability: Record<string, boolean> | undefined,
  sidecarDrivers: Record<PluginNativeProtocol, RuntimePluginDriver | undefined>,
  key: string,
): boolean {
  if (!isPluginNativeProtocol(key)) return true;
  return isNativeDriverAvailable(availability, key) || Boolean(sidecarDrivers[key]);
}

/**
 * Engines shipped with the app and usable WITHOUT installing any plugin. This
 * is the product-level source of truth for "works out of the box". EVERY other
 * engine is plugin-gated: it only becomes connectable once a matching driver
 * plugin is installed and enabled. Keeping the set here (instead of a flag
 * duplicated per surface) is what stops an engine from ever being presented as
 * "ready here / needs-a-plugin there".
 */
export const BUILTIN_ENGINE_KEYS = [
  "mysql",
  "sqlite",
  "mssql",
  "postgresql",
  "mongodb",
  "redis",
  "duckdb",
] as const;

export type BuiltinEngineKey = (typeof BUILTIN_ENGINE_KEYS)[number];

/** Whether an engine ships by default and needs no plugin to be usable. */
export function isBuiltinEngine(key: string): boolean {
  return (BUILTIN_ENGINE_KEYS as readonly string[]).includes(key);
}

/**
 * Whether any installed plugin bundle contributes a driver for this protocol,
 * regardless of runtime / enabled / verified flags. Generalizes
 * {@link hasInstalledPluginHttpDriver} to every plugin-gated engine so an
 * installed-but-inactive bundle can be told apart from a true roadmap engine.
 */
export function hasInstalledPluginDriver(
  plugins: InstalledPluginRecord[],
  protocol: string,
): boolean {
  return plugins.some(
    (plugin) =>
      plugin.manifest.capabilities.includes("database") &&
      plugin.manifest.contributes.drivers.some(
        (driver) => driver.protocol === protocol,
      ),
  );
}

/**
 * Runtime availability of a plugin-gated engine, across BOTH the declarative
 * HTTP and the sidecar driver runtimes:
 *  - "active"    -> an enabled, verified, usable driver is installed.
 *  - "installed" -> a driver bundle is installed but not active yet (disabled /
 *                   unverified) — it needs enabling, NOT a roadmap engine.
 *  - "roadmap"   -> no matching driver bundle is installed at all.
 */
export function resolveEnginePluginAvailability(
  plugins: InstalledPluginRecord[],
  protocol: string,
): PluginHttpAvailability {
  if (
    findStableDriverForProtocol(plugins, protocol) ||
    findSidecarDriverForProtocol(plugins, protocol)
  ) {
    return "active";
  }
  if (hasInstalledPluginDriver(plugins, protocol)) return "installed";
  return "roadmap";
}

/**
 * Apply the FULL runtime availability of every engine in one place, so every
 * surface that lists engines (the connection picker, the Plugin Manager, ...)
 * derives `supported` / `pluginHttpState` from the exact same logic. This is
 * the single source of truth that stops an engine from being presented as
 * "ready here / needs-a-plugin there". Generic over any engine-like record that
 * has a `key` and its static build-time `supported` flag.
 *
 *  - Built-in engine (see {@link BUILTIN_ENGINE_KEYS}) -> ships by default and
 *    keeps its static `supported` flag. A built-in native crate (duckdb, redis)
 *    additionally honors the compiled-build report / an installed sidecar, so a
 *    deliberately lean build stays honest.
 *  - Any OTHER engine -> plugin-gated: `supported` iff a matching driver plugin
 *    is installed and active; `pluginHttpState` carries the 3-state
 *    "active" | "installed" | "roadmap" so an installed-but-disabled bundle is
 *    shown as "needs enabling", never as a not-installed roadmap engine.
 */
export function applyEngineRuntimeAvailability<
  T extends { key: string; supported: boolean },
>(
  engines: readonly T[],
  plugins: InstalledPluginRecord[],
  nativeDriverAvailability?: Record<string, boolean>,
): Array<T & { pluginHttpState?: PluginHttpAvailability }> {
  const sidecarDrivers = resolveNativeSidecarDrivers(plugins);
  return engines.map((engine) => {
    if (isBuiltinEngine(engine.key)) {
      if (isPluginNativeProtocol(engine.key)) {
        return {
          ...engine,
          supported:
            engine.supported &&
            isNativeEngineConnectable(
              nativeDriverAvailability,
              sidecarDrivers,
              engine.key,
            ),
        };
      }
      return engine;
    }
    const pluginHttpState = resolveEnginePluginAvailability(plugins, engine.key);
    return { ...engine, supported: pluginHttpState === "active", pluginHttpState };
  });
}
