import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// Resident mode: when enabled, closing the main window hides it to the system
// tray instead of quitting (the Rust side reads the flag synchronously inside
// CloseRequested, so the mirror lives behind a Tauri command, not an event).
const STORAGE_KEY = "tabler.keepRunningInBackground";

function readStoredPreference(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "true";
}

function syncBackend(enabled: boolean) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  invoke("set_keep_running_in_background", { enabled }).catch((error) => {
    console.error("[TableR] failed to sync keep-running preference", error);
  });
}

type WindowBehaviorState = {
  keepRunningInBackground: boolean;
  setKeepRunningInBackground: (enabled: boolean) => void;
};

export const useWindowBehaviorStore = create<WindowBehaviorState>((set) => ({
  keepRunningInBackground: readStoredPreference(),
  setKeepRunningInBackground: (enabled) => {
    window.localStorage.setItem(STORAGE_KEY, String(enabled));
    set({ keepRunningInBackground: enabled });
    syncBackend(enabled);
  },
}));

// Mirror the persisted preference to the backend at module load so the flag
// is set before the user can close the window.
syncBackend(readStoredPreference());
