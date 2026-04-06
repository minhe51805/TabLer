/**
 * Plugin system types for TableR plugin registry.
 * Plugins are `.tableplugin` bundles with a `plugin.json` manifest.
 */

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: string;
  description?: string | null;
  author?: string | null;
  entry?: string | null;
  capabilities: string[];
}

export interface InstalledPluginRecord {
  manifest: PluginManifest;
  bundlePath: string;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
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
