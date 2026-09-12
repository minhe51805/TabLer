import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Typed access to the generated plugin catalog served at
 * `/plugins/store.json`. The catalog is produced by
 * `scripts/build-plugin-repository.mjs` in the desktop app repo, which also
 * writes the app-facing `registry.json` and the downloadable `.zip` bundles
 * into `website/public/plugins/`.
 */

export type PluginCategory = "http" | "native" | "format";

export type PluginEngine = {
  id: string;
  label: string;
  protocol: string;
  status: string;
};

export type PluginBundle = {
  /** Site-relative path so the browser download works on any origin. */
  path: string;
  size: number;
  sha256: string;
};

export type PluginCatalogEntry = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: PluginCategory;
  runtime: string | null;
  engine: PluginEngine | null;
  engines: PluginEngine[];
  formats: string[];
  permissions: string[];
  minAppVersion: string | null;
  installMode: "registry" | "disk-binary";
  binaryPending: boolean;
  bundle: PluginBundle;
  docsSlug: string | null;
  digest: string;
};

export type PluginCatalog = {
  schemaVersion: number;
  generatedAt: string;
  repoBaseUrl: string;
  registryUrl: string;
  counts: {
    total: number;
    http: number;
    native: number;
    format: number;
    installable: number;
  };
  plugins: PluginCatalogEntry[];
};

const EMPTY_CATALOG: PluginCatalog = {
  schemaVersion: 1,
  generatedAt: "",
  repoBaseUrl: "",
  registryUrl: "",
  counts: { total: 0, http: 0, native: 0, format: 0, installable: 0 },
  plugins: [],
};

/**
 * Reads the generated catalog from `public/plugins/store.json`. Returns an
 * empty catalog (never throws) when the file is missing, so the page degrades
 * gracefully if the repository generator has not run yet.
 */
export async function getPluginCatalog(): Promise<PluginCatalog> {
  try {
    const filePath = join(process.cwd(), "public", "plugins", "store.json");
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as PluginCatalog;
  } catch {
    return EMPTY_CATALOG;
  }
}

/** Human-readable file size for bundle links (KB with one decimal, or bytes). */
export function formatBundleSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
