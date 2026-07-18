export type CapabilitySupport = "supported" | "limited" | "unsupported" | "not_applicable";

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
  capabilities: DriverCapabilitySet;
  limitations: string[];
}

export function isCapabilitySupported(value: CapabilitySupport | undefined): boolean {
  return value === "supported";
}
