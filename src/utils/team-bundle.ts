/**
 * Workspace bundle export/import helpers (team sharing).
 * A .tabler-bundle is a plain JSON document bundling connections (secrets
 * stripped, hasPassword flag kept), SQL favorites, schedules, and AI provider
 * settings. Distinct from utils/workspace-bundle.ts, which is the encrypted
 * workspace-sync payload format.
 */
import { invoke } from "@tauri-apps/api/core";

export interface BundleItemPreview {
  index: number;
  id: string;
  name: string;
  detail: string;
  /** Already present locally — importing it is a no-op. */
  exists: boolean;
  /** Credentials were stripped on export; re-enter after import. */
  needsPassword?: boolean;
}

export interface TeamBundlePreview {
  exportedAt: string;
  connections: BundleItemPreview[];
  sqlFavorites: BundleItemPreview[];
  schedules: BundleItemPreview[];
  aiProviders: BundleItemPreview[];
}

export interface TeamBundleSelection {
  connections?: number[];
  sqlFavorites?: number[];
  schedules?: number[];
  aiProviders?: number[];
}

export interface TeamBundleCounts {
  connections: number;
  sqlFavorites: number;
  schedules: number;
  aiProviders: number;
}

export interface TeamBundleImportResult {
  preview: TeamBundlePreview;
  /** Present only when a selection was supplied (real import). */
  counts?: TeamBundleCounts;
}

/** Write the whole shareable workspace to a .tabler-bundle file at `path`. */
export async function exportWorkspaceBundle(path: string): Promise<string> {
  return invoke<string>("export_workspace_bundle", { path });
}

/** Preview a bundle without saving anything. */
export async function previewWorkspaceBundle(path: string): Promise<TeamBundleImportResult> {
  return invoke<TeamBundleImportResult>("import_workspace_bundle", { path });
}

/** Persist the selected bundle items; returns the preview plus counts. */
export async function importWorkspaceBundle(
  path: string,
  selection: TeamBundleSelection,
): Promise<TeamBundleImportResult> {
  return invoke<TeamBundleImportResult>("import_workspace_bundle", {
    path,
    selection,
  });
}
