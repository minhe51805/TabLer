/**
 * Workspace bundle export/import helpers (team sharing).
 * A .tabler-bundle is a plain JSON document bundling connections (secrets
 * stripped, hasPassword flag kept), SQL favorites, schedules, AI provider
 * settings, and UI preferences (the `tabler.*` localStorage snapshot).
 * Distinct from utils/workspace-bundle.ts, which is the encrypted
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
  /** One row per bundled localStorage key; `exists` = key already set locally. */
  uiPrefs: BundleItemPreview[];
}

export interface TeamBundleSelection {
  connections?: number[];
  sqlFavorites?: number[];
  schedules?: number[];
  aiProviders?: number[];
  /** Indices into preview.uiPrefs — the UI selects all or none. */
  uiPrefs?: number[];
}

export interface TeamBundleCounts {
  connections: number;
  sqlFavorites: number;
  schedules: number;
  aiProviders: number;
  /** localStorage keys returned for writing (missing keys only). */
  uiPrefs: number;
}

export interface TeamBundleImportResult {
  preview: TeamBundlePreview;
  /** Present only when a selection was supplied (real import). */
  counts?: TeamBundleCounts;
  /** Selected UI-pref entries missing locally — write them to localStorage. */
  uiPrefs?: Record<string, string>;
}

const UI_PREF_PREFIX = "tabler.";

/**
 * `tabler.*` keys that must not travel in a bundle: safety/consent posture,
 * per-device sync state, crash diagnostics, and transient per-tab data that
 * would be meaningless (or harmful) on another machine.
 */
const UI_PREF_EXCLUDED_PREFIXES = [
  "tabler.safe-mode",
  "tabler.ai.dataReadApprovals",
  "tabler.ai.workspace.agentAutonomy",
  "tabler.ai.workspace.history",
  "tabler.ai.chat-workspaces",
  "tabler.ai.insights",
  "tabler.ai.skill-usage",
  "tabler.workspace-sync",
  "tabler.bootFailure",
  "tabler.editor-draft",
  "tabler.sql-parameters",
  "tabler.schema-snapshot",
];

function uiPrefKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (
        key &&
        key.startsWith(UI_PREF_PREFIX) &&
        !UI_PREF_EXCLUDED_PREFIXES.some((excluded) => key.startsWith(excluded))
      ) {
        keys.push(key);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

/** Snapshot every shareable `tabler.*` localStorage key into a {key: value} map. */
export function collectUiPrefs(): Record<string, string> {
  const prefs: Record<string, string> = {};
  for (const key of uiPrefKeys()) {
    try {
      const value = window.localStorage.getItem(key);
      if (value !== null) prefs[key] = value;
    } catch {
      /* storage unavailable — skip */
    }
  }
  return prefs;
}

/** Write bundled UI prefs into localStorage; returns how many keys were written. */
export function applyUiPrefs(prefs: Record<string, string>): number {
  let written = 0;
  for (const [key, value] of Object.entries(prefs)) {
    try {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, value);
        written += 1;
      }
    } catch {
      /* storage unavailable — skip */
    }
  }
  return written;
}

/** Error prefix the backend emits when a picked bundle file is encrypted. */
export const ENCRYPTED_BUNDLE_CODE = "TABLER_EXPORT_ENCRYPTED";

/** Write the whole shareable workspace to a .tabler-bundle file at `path`.
 *  With `encryptPassword` the bundle is wrapped in the AES-256-GCM export
 *  envelope and lands at `<path>.texp`; the returned path is the real one. */
export async function exportWorkspaceBundle(
  path: string,
  encryptPassword?: string,
): Promise<string> {
  return invoke<string>("export_workspace_bundle", {
    path,
    uiPrefs: collectUiPrefs(),
    encryptPassword: encryptPassword ?? null,
  });
}

/** Preview a bundle without saving anything. `password` decrypts
 *  `tabler.export` envelopes; a missing one throws ENCRYPTED_BUNDLE_CODE. */
export async function previewWorkspaceBundle(
  path: string,
  password?: string,
): Promise<TeamBundleImportResult> {
  return invoke<TeamBundleImportResult>("import_workspace_bundle", {
    path,
    uiPrefKeys: uiPrefKeys(),
    password: password ?? null,
  });
}

/** Persist the selected bundle items; returns the preview plus counts. */
export async function importWorkspaceBundle(
  path: string,
  selection: TeamBundleSelection,
  password?: string,
): Promise<TeamBundleImportResult> {
  return invoke<TeamBundleImportResult>("import_workspace_bundle", {
    path,
    selection,
    uiPrefKeys: uiPrefKeys(),
    password: password ?? null,
  });
}
