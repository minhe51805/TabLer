/**
 * Plugin system types for TableR plugin registry.
 * Plugins are `.tableplugin` bundles with a `plugin.json` manifest.
 */

export interface PluginManifest {
  apiVersion: number;
  id: string;
  name: string;
  version: string;
  kind: string;
  description?: string | null;
  author?: string | null;
  entry?: string | null;
  capabilities: string[];
  permissions: string[];
  compatibility: {
    minAppVersion?: string | null;
    maxAppVersion?: string | null;
    platforms: string[];
    architectures: string[];
  };
  integrity?: {
    algorithm: string;
    digest: string;
  } | null;
  updateUrl?: string | null;
  contributes: PluginContributions;
}

export interface PluginContributions {
  formats: PluginFormatContribution[];
  drivers: PluginDriverContribution[];
}

export interface PluginFormatContribution {
  id: string;
  label: string;
  description?: string | null;
  extension: string;
  mimeType: string;
  mode: "delimited" | "json-lines";
  delimiter?: string | null;
  includeHeader: boolean;
}

export interface PluginDriverContribution {
  id: string;
  label: string;
  protocol: string;
  runtime: "wasm-component-v1" | "declarative-http-v1";
  status: "experimental" | "stable";
}

export interface InstalledPluginRecord {
  manifest: PluginManifest;
  bundlePath: string;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  verified: boolean;
  computedIntegrity?: string | null;
  validationError?: string | null;
  rollbackAvailable: boolean;
  previousVersion?: string | null;
}

export interface PluginRegistryAsset {
  path: string;
  url: string;
  sha256: string;
  size: number;
}

export interface PluginRegistryPackage {
  manifest: PluginManifest;
  assets: PluginRegistryAsset[];
  publishedAt?: string | null;
  releaseNotes?: string | null;
}

export interface PluginRegistryIndex {
  schemaVersion: number;
  generatedAt: string;
  packages: PluginRegistryPackage[];
}

export interface PluginUpdateCandidate {
  pluginId: string;
  installedVersion: string;
  availableVersion: string;
  package: PluginRegistryPackage;
}

/** Plugin kind categories */
export type PluginKind =
  | "tooling"       // Developer tools, linters, formatters
  | "adapter"       // Database adapters
  | "visualization" // Chart/graph builders
  | "ai"            // AI integrations
  | "export"        // Export formats
  | "import"        // Import formats
  | "theme"         // Color themes
  | "extension";    // General extensions

/** Capability strings a plugin can declare */
export type PluginCapability =
  | "commands"           // Registers custom commands
  | "database"          // Adds database driver support
  | "export"            // Adds export format
  | "import"            // Adds import format
  | "sidebar"           // Adds sidebar panel
  | "ai"                // AI provider
  | "theme"             // UI theme
  | "autocomplete"      // SQL/code autocomplete
  | "file";             // File handler

export type PluginPermission =
  | "workspace.read"
  | "connection.metadata"
  | "query.read"
  | "query.execute"
  | "network.fetch"
  | "file.read"
  | "file.write"
  | "clipboard.write"
  | "notifications";
