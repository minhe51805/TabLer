import { describe, expect, it } from "vitest";
import type { InstalledPluginRecord, PluginDriverContribution } from "../../src/types/plugin";
import { findStableOpenSearchDriver } from "../../src/utils/plugin-driver-runtime";

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
