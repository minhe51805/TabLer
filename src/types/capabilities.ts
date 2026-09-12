export type CapabilitySupport = "supported" | "limited" | "unsupported" | "not_applicable";

export type QueryModel = "sql" | "cql" | "document" | "kv" | "search";

/**
 * How an engine is packaged (mirrors `DriverDistribution` in capabilities.rs).
 * `builtin` ships in-app; `plugin_http` engines can move behind installable HTTP
 * plugin manifests; `plugin_native` engines need a feature-flag build or sidecar.
 */
export type DriverDistribution = "builtin" | "plugin_http" | "plugin_native";

export interface DriverCapabilitySet {
  connect: CapabilitySupport;
  query: CapabilitySupport;
  preparedParameters: CapabilitySupport;
  queryCancellation: CapabilitySupport;
  pagination: CapabilitySupport;
  inlineEdit: CapabilitySupport;
  atomicEditQueue: CapabilitySupport;
  atomicCsvImport: CapabilitySupport;
  dataExport: CapabilitySupport;
  explain: CapabilitySupport;
  schemaEdit: CapabilitySupport;
  backupRestore: CapabilitySupport;
  administration: CapabilitySupport;
}

export interface DriverCapabilityProfile {
  key: string;
  label: string;
  tier: "core" | "extended" | "specialized";
  queryModel: QueryModel;
  distribution: DriverDistribution;
  capabilities: DriverCapabilitySet;
  limitations: string[];
}

export function isCapabilitySupported(value: CapabilitySupport | undefined): boolean {
  return value === "supported";
}
