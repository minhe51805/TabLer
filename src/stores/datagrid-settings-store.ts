import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "tabler.datagrid-settings";

export type RowHeight = "small" | "medium" | "large";

export interface DataGridSettings {
  nullPlaceholder: string;
  rowHeight: RowHeight;
  alternatingRows: boolean;
}

const DEFAULT_SETTINGS: DataGridSettings = {
  nullPlaceholder: "NULL",
  rowHeight: "medium",
  alternatingRows: true,
};

function loadSettings(): DataGridSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(stored) as Partial<DataGridSettings>) };
    }
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(s: DataGridSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

// Module-level shared store so every consumer (toolbar popover + the grid that
// renders the rows) reads and reacts to the same state. A plain per-hook
// useState made each caller isolated, so changing a setting in the popover
// never reached the grid.
let currentSettings: DataGridSettings = loadSettings();
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DataGridSettings {
  return currentSettings;
}

export function setDataGridSettings(updates: Partial<DataGridSettings>) {
  currentSettings = { ...currentSettings, ...updates };
  saveSettings(currentSettings);
  emitChange();
}

// Keep multiple windows/tabs in sync.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      currentSettings = { ...DEFAULT_SETTINGS, ...(JSON.parse(event.newValue) as Partial<DataGridSettings>) };
      emitChange();
    } catch {
      // ignore
    }
  });
}

export function useDataGridSettings() {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const updateSettings = useCallback((updates: Partial<DataGridSettings>) => {
    setDataGridSettings(updates);
  }, []);

  return { settings, updateSettings };
}
