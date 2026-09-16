import { describe, expect, it } from "vitest";
import type { InstalledPluginRecord, PluginDriverContribution } from "../../src/types/plugin";
import {
  findStableOpenSearchDriver,
  findSidecarDriverForProtocol,
  applyEngineRuntimeAvailability,
  BUILTIN_ENGINE_KEYS,
  isBuiltinEngine,
  resolveEnginePluginAvailability,
  hasInstalledPluginDriver,
  resolveNativeSidecarDrivers,
  isPluginNativeProtocol,
  isNativeDriverAvailable,
  isNativeEngineConnectable,
  hasInstalledPluginHttpDriver,
  resolvePluginHttpAvailability,
  resolvePluginHttpAvailabilityMap,
  PLUGIN_NATIVE_PROTOCOLS,
  PLUGIN_HTTP_PROTOCOLS,
} from "../../src/utils/plugin-driver-runtime";

const driver: PluginDriverContribution = {
  id: "opensearch",
  label: "OpenSearch",
  protocol: "opensearch",
  runtime: "declarative-http-v1",
  status: "stable",
};

function plugin(overrides: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord {
  return {
    manifest: {
      apiVersion: 1,
      id: "opensearch-driver",
      name: "OpenSearch driver",
      version: "1.0.0",
      kind: "adapter",
      capabilities: ["database"],
      permissions: ["connection.metadata", "query.read", "query.execute", "network.fetch"],
      compatibility: { platforms: [], architectures: [] },
      contributes: { formats: [], drivers: [driver] },
    },
    bundlePath: "opensearch-driver.tableplugin",
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
    verified: true,
    validationError: null,
    rollbackAvailable: false,
    ...overrides,
  };
}

describe("plugin driver runtime", () => {
  it("exposes only an enabled and verified stable OpenSearch contribution", () => {
    expect(findStableOpenSearchDriver([plugin()])?.pluginId).toBe("opensearch-driver");
    expect(findStableOpenSearchDriver([plugin({ enabled: false })])).toBeUndefined();
    expect(findStableOpenSearchDriver([plugin({ verified: false })])).toBeUndefined();
    expect(
      findStableOpenSearchDriver([plugin({ validationError: "tampered" })]),
    ).toBeUndefined();
  });

  it("rejects a contribution on the wrong runtime", () => {
    const candidate = plugin();
    candidate.manifest.contributes.drivers = [
      { ...driver, runtime: "wasm-component-v1", status: "experimental" },
    ];
    expect(findStableOpenSearchDriver([candidate])).toBeUndefined();
  });
});

describe("native driver build availability", () => {
  it("recognizes only the compiled native-crate protocols", () => {
    for (const key of PLUGIN_NATIVE_PROTOCOLS) {
      expect(isPluginNativeProtocol(key)).toBe(true);
    }
    // Builtin / HTTP-plugin engines are not native-crate protocols.
    for (const key of ["postgresql", "mysql", "sqlite", "clickhouse", "opensearch"]) {
      expect(isPluginNativeProtocol(key)).toBe(false);
    }
  });

  it("gates a native engine on the backend availability report", () => {
    const availability = { duckdb: true, cassandra: false, redis: true, libsql: false };
    expect(isNativeDriverAvailable(availability, "duckdb")).toBe(true);
    expect(isNativeDriverAvailable(availability, "cassandra")).toBe(false);
    expect(isNativeDriverAvailable(availability, "libsql")).toBe(false);
  });

  it("never hides non-native engines and fails open on a missing report", () => {
    // Non-native engines are always available regardless of the map.
    expect(isNativeDriverAvailable({}, "postgresql")).toBe(true);
    expect(isNativeDriverAvailable(undefined, "opensearch")).toBe(true);
    // Unknown/not-yet-loaded native availability defaults to available so a
    // failed report never hides an engine the build actually supports.
    expect(isNativeDriverAvailable(undefined, "redis")).toBe(true);
    expect(isNativeDriverAvailable({}, "duckdb")).toBe(true);
  });
});

describe("native sidecar driver gating (Phase 4f)", () => {
  const redisSidecar: PluginDriverContribution = {
    id: "redis",
    label: "Redis",
    protocol: "redis",
    runtime: "driver-sidecar-v1",
    status: "experimental",
  };

  function sidecarPlugin(
    overrides: Partial<InstalledPluginRecord> = {},
    driverOverrides: Partial<PluginDriverContribution> = {},
  ): InstalledPluginRecord {
    const record = plugin(overrides);
    record.manifest.id = "redis-sidecar-driver";
    record.manifest.name = "Redis sidecar driver";
    record.manifest.contributes.drivers = [{ ...redisSidecar, ...driverOverrides }];
    return record;
  }

  it("resolves only an enabled, verified sidecar contribution", () => {
    expect(findSidecarDriverForProtocol([sidecarPlugin()], "redis")?.pluginId).toBe(
      "redis-sidecar-driver",
    );
    expect(findSidecarDriverForProtocol([sidecarPlugin({ enabled: false })], "redis")).toBeUndefined();
    expect(findSidecarDriverForProtocol([sidecarPlugin({ verified: false })], "redis")).toBeUndefined();
    expect(
      findSidecarDriverForProtocol([sidecarPlugin({ validationError: "tampered" })], "redis"),
    ).toBeUndefined();
  });

  it("does not treat an HTTP-runtime contribution as a sidecar", () => {
    expect(
      findSidecarDriverForProtocol(
        [sidecarPlugin({}, { runtime: "declarative-http-v1" })],
        "redis",
      ),
    ).toBeUndefined();
  });

  it("maps each native protocol to its installed sidecar, if any", () => {
    const map = resolveNativeSidecarDrivers([sidecarPlugin()]);
    expect(map.redis?.pluginId).toBe("redis-sidecar-driver");
    expect(map.duckdb).toBeUndefined();
    expect(map.cassandra).toBeUndefined();
    expect(map.libsql).toBeUndefined();
  });

  it("makes a native engine connectable when compiled in OR a sidecar is installed", () => {
    const withSidecar = resolveNativeSidecarDrivers([sidecarPlugin()]);
    const noSidecar = resolveNativeSidecarDrivers([]);

    // Lean build (redis not compiled in) + installed sidecar -> connectable.
    expect(isNativeEngineConnectable({ redis: false }, withSidecar, "redis")).toBe(true);
    // Lean build + no sidecar -> not connectable.
    expect(isNativeEngineConnectable({ redis: false }, noSidecar, "redis")).toBe(false);
    // Compiled in -> connectable regardless of sidecar.
    expect(isNativeEngineConnectable({ redis: true }, noSidecar, "redis")).toBe(true);
    // A sidecar for redis does not enable a different native engine.
    expect(isNativeEngineConnectable({ duckdb: false }, withSidecar, "duckdb")).toBe(false);
    // Non-native engines are always connectable.
    expect(isNativeEngineConnectable({}, noSidecar, "postgresql")).toBe(true);
  });
});

describe("plugin http driver availability (installed vs roadmap)", () => {
  it("reports 'active' only for an enabled, verified, stable HTTP driver", () => {
    expect(resolvePluginHttpAvailability([plugin()], "opensearch")).toBe("active");
  });

  it("reports 'installed' when a matching bundle is present but not active", () => {
    // Disabled, unverified, or tampered bundles are installed-but-inactive; they
    // must not fall back to "roadmap" (which means no bundle is installed at all).
    expect(resolvePluginHttpAvailability([plugin({ enabled: false })], "opensearch")).toBe(
      "installed",
    );
    expect(resolvePluginHttpAvailability([plugin({ verified: false })], "opensearch")).toBe(
      "installed",
    );
    expect(
      resolvePluginHttpAvailability([plugin({ validationError: "tampered" })], "opensearch"),
    ).toBe("installed");
  });

  it("reports 'roadmap' when no bundle contributes the protocol", () => {
    expect(resolvePluginHttpAvailability([], "opensearch")).toBe("roadmap");
    // A bundle for a different protocol does not make opensearch installed.
    expect(resolvePluginHttpAvailability([plugin()], "snowflake")).toBe("roadmap");
  });

  it("does not treat a non declarative-http contribution as an installed HTTP driver", () => {
    const wasm = plugin();
    wasm.manifest.contributes.drivers = [
      { ...driver, runtime: "wasm-component-v1", status: "experimental" },
    ];
    expect(hasInstalledPluginHttpDriver([wasm], "opensearch")).toBe(false);
    expect(resolvePluginHttpAvailability([wasm], "opensearch")).toBe("roadmap");
  });

  it("hasInstalledPluginHttpDriver ignores the enabled/verified flags", () => {
    expect(
      hasInstalledPluginHttpDriver([plugin({ enabled: false, verified: false })], "opensearch"),
    ).toBe(true);
    expect(hasInstalledPluginHttpDriver([], "opensearch")).toBe(false);
  });

  it("maps every HTTP protocol, defaulting the unresolved ones to 'roadmap'", () => {
    const map = resolvePluginHttpAvailabilityMap([plugin({ enabled: false })]);
    expect(map.opensearch).toBe("installed");
    for (const protocol of PLUGIN_HTTP_PROTOCOLS) {
      if (protocol === "opensearch") continue;
      expect(map[protocol]).toBe("roadmap");
    }
  });
});

describe("applyEngineRuntimeAvailability (shared picker / plugin-manager truth)", () => {
  const engine = (key: string, supported: boolean) => ({ key, label: key, supported });

  function redisSidecarPlugin(): InstalledPluginRecord {
    const record = plugin();
    record.manifest.id = "redis-sidecar-driver";
    record.manifest.name = "Redis sidecar driver";
    record.manifest.contributes.drivers = [
      {
        id: "redis",
        label: "Redis",
        protocol: "redis",
        runtime: "driver-sidecar-v1",
        status: "experimental",
      },
    ];
    return record;
  }

  it("resolves a PluginHttp engine to active / installed / roadmap consistently", () => {
    const active = applyEngineRuntimeAvailability([engine("opensearch", false)], [plugin()]);
    expect(active[0].supported).toBe(true);
    expect(active[0].pluginHttpState).toBe("active");

    const installed = applyEngineRuntimeAvailability(
      [engine("opensearch", false)],
      [plugin({ enabled: false })],
    );
    expect(installed[0].supported).toBe(false);
    expect(installed[0].pluginHttpState).toBe("installed");

    const roadmap = applyEngineRuntimeAvailability([engine("opensearch", false)], []);
    expect(roadmap[0].supported).toBe(false);
    expect(roadmap[0].pluginHttpState).toBe("roadmap");
  });

  it("gates a native engine on the compiled build and installed sidecars", () => {
    // Dropped from the build and no sidecar -> not connectable (roadmap).
    const dropped = applyEngineRuntimeAvailability([engine("redis", true)], [], { redis: false });
    expect(dropped[0].supported).toBe(false);
    expect(dropped[0].pluginHttpState).toBeUndefined();

    // Dropped from the build but an installed sidecar restores it.
    const viaSidecar = applyEngineRuntimeAvailability(
      [engine("redis", true)],
      [redisSidecarPlugin()],
      { redis: false },
    );
    expect(viaSidecar[0].supported).toBe(true);

    // Compiled into the running build -> connectable.
    const compiled = applyEngineRuntimeAvailability([engine("redis", true)], [], { redis: true });
    expect(compiled[0].supported).toBe(true);
  });

  it("leaves built-in engines on their static flag and never adds pluginHttpState", () => {
    const result = applyEngineRuntimeAvailability(
      [engine("postgresql", true), engine("sqlite", false)],
      [],
    );
    expect(result[0].supported).toBe(true);
    expect(result[0].pluginHttpState).toBeUndefined();
    expect(result[1].supported).toBe(false);
  });

  it("produces identical results for every surface on the same inputs", () => {
    const engines = [
      engine("opensearch", false),
      engine("redis", true),
      engine("postgresql", true),
    ];
    const plugins = [plugin({ enabled: false })];
    const nativeAvailability = { redis: false };
    const picker = applyEngineRuntimeAvailability(engines, plugins, nativeAvailability);
    const pluginManager = applyEngineRuntimeAvailability(engines, plugins, nativeAvailability);
    expect(picker).toEqual(pluginManager);
  });
});

describe("builtin-7 vs plugin-gated engine classification", () => {
  const engine = (key: string, supported: boolean) => ({ key, label: key, supported });

  function cassandraSidecarPlugin(): InstalledPluginRecord {
    const record = plugin();
    record.manifest.id = "cassandra-sidecar-driver";
    record.manifest.name = "Cassandra sidecar driver";
    record.manifest.contributes.drivers = [
      {
        id: "cassandra",
        label: "Cassandra",
        protocol: "cassandra",
        runtime: "driver-sidecar-v1",
        status: "experimental",
      },
    ];
    return record;
  }

  it("ships exactly the seven default engines", () => {
    expect([...BUILTIN_ENGINE_KEYS].sort()).toEqual(
      ["duckdb", "mongodb", "mssql", "mysql", "postgresql", "redis", "sqlite"],
    );
    for (const key of BUILTIN_ENGINE_KEYS) expect(isBuiltinEngine(key)).toBe(true);
    for (const key of [
      "mariadb",
      "cockroachdb",
      "greenplum",
      "redshift",
      "vertica",
      "cassandra",
      "libsql",
      "clickhouse",
      "bigquery",
      "snowflake",
      "cloudflare_d1",
      "opensearch",
    ]) {
      expect(isBuiltinEngine(key)).toBe(false);
    }
  });

  it("keeps a non-plugin builtin engine available with no plugins installed", () => {
    const result = applyEngineRuntimeAvailability(
      [engine("postgresql", true), engine("mongodb", true)],
      [],
    );
    expect(result.every((db) => db.supported)).toBe(true);
    expect(result[0].pluginHttpState).toBeUndefined();
  });

  it("gates every non-builtin engine behind an installed plugin", () => {
    // A SQL-family engine that has no plugin can never leave roadmap.
    const mariadb = applyEngineRuntimeAvailability([engine("mariadb", true)], []);
    expect(mariadb[0].supported).toBe(false);
    expect(mariadb[0].pluginHttpState).toBe("roadmap");

    // A native engine that used to be built-in is now plugin-gated: even a
    // compiled build no longer makes it connectable without its plugin.
    const cassandraNoPlugin = applyEngineRuntimeAvailability(
      [engine("cassandra", true)],
      [],
      { cassandra: true },
    );
    expect(cassandraNoPlugin[0].supported).toBe(false);
    expect(cassandraNoPlugin[0].pluginHttpState).toBe("roadmap");

    // Installing + enabling the sidecar plugin turns it on.
    const cassandraActive = applyEngineRuntimeAvailability(
      [engine("cassandra", true)],
      [cassandraSidecarPlugin()],
    );
    expect(cassandraActive[0].supported).toBe(true);
    expect(cassandraActive[0].pluginHttpState).toBe("active");
  });

  it("resolveEnginePluginAvailability tracks active / installed / roadmap", () => {
    expect(resolveEnginePluginAvailability([plugin()], "opensearch")).toBe("active");
    expect(resolveEnginePluginAvailability([plugin({ enabled: false })], "opensearch")).toBe(
      "installed",
    );
    expect(resolveEnginePluginAvailability([], "opensearch")).toBe("roadmap");
    expect(hasInstalledPluginDriver([plugin({ enabled: false })], "opensearch")).toBe(true);
    expect(hasInstalledPluginDriver([], "opensearch")).toBe(false);
  });
});
