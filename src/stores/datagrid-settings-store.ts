import { useState, useEffect, useCallback } from "react";

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
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
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

let cachedSettings: DataGridSettings | null = null;

export function useDataGridSettings() {
  const [settings, setSettings] = useState<DataGridSettings>(() => {
    if (!cachedSettings) {
      cachedSettings = loadSettings();
    }
    return cachedSettings;
  });

  const updateSettings = useCallback((updates: Partial<DataGridSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...updates };
      cachedSettings = next;
      saveSettings(next);
      return next;
    });
  }, []);

  // Sync across tabs
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          const next = JSON.parse(e.newValue) as DataGridSettings;
          cachedSettings = next;
          setSettings(next);
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return { settings, updateSettings };
}
