import { create } from "zustand";
import type { SafeModeLevel, SafeModeSettings, ConnectionSafeModeOverride } from "../types/safe-mode";
import { isBlockedAtLevel, requiresConfirmationAtLevel } from "../types/safe-mode";

const STORAGE_KEY = "tabler.safe-mode.v1";

const DEFAULT_SETTINGS: SafeModeSettings = {
  globalLevel: 1,
  connectionOverrides: [],
};

function loadSettings(): SafeModeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(s: SafeModeSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

/** Simple hash for admin password (not cryptographic — just a deterrent). */
function hashPassword(password: string): string {
  let hash = 5381;
  for (let i = 0; i < password.length; i++) {
    hash = ((hash << 5) + hash) + password.charCodeAt(i);
    hash = hash & hash;
  }
  return hash.toString(36);
}

interface SafeModeState {
  settings: SafeModeSettings;

  getEffectiveLevel: (connectionId?: string) => SafeModeLevel;
  setGlobalLevel: (level: SafeModeLevel) => void;
  setConnectionOverride: (connectionId: string, level: SafeModeLevel) => void;
  removeConnectionOverride: (connectionId: string) => void;
  clearConnectionOverrides: () => void;

  isBlocked: (sql: string, connectionId?: string) => boolean;
  needsConfirmation: (sql: string, connectionId?: string) => boolean;
  getEffectiveLevelForConnection: (connectionId: string) => SafeModeLevel;

  setAdminPassword: (password: string) => void;
  clearAdminPassword: () => void;
  verifyAdminPassword: (password: string) => boolean;
  hasAdminPassword: () => boolean;

  /** Show a confirmation dialog for the given SQL. Returns true if confirmed. */
  confirmSql: (
    sql: string,
    connectionId?: string,
    bypassPassword?: string
  ) => Promise<boolean>;

  /** Check if a given password can bypass confirmation (level 4-5). */
  canBypassConfirmation: (password: string, connectionId?: string) => boolean;
}

export const useSafeModeStore = create<SafeModeState>((set, get) => {
  const initial = loadSettings();
  return {
    settings: initial,

    getEffectiveLevel: (connectionId?: string) => {
      const { settings } = get();
      if (!connectionId) return settings.globalLevel;
      const override = settings.connectionOverrides.find((o) => o.connectionId === connectionId);
      return override?.level ?? settings.globalLevel;
    },

    setGlobalLevel: (level: SafeModeLevel) => {
      set((state) => {
        const next = { ...state.settings, globalLevel: level };
        saveSettings(next);
        return { settings: next };
      });
    },

    setConnectionOverride: (connectionId: string, level: SafeModeLevel) => {
      set((state) => {
        const overrides = state.settings.connectionOverrides.filter(
          (o) => o.connectionId !== connectionId
        );
        overrides.push({ connectionId, level });
        const next = { ...state.settings, connectionOverrides: overrides };
        saveSettings(next);
        return { settings: next };
      });
    },

    removeConnectionOverride: (connectionId: string) => {
      set((state) => {
        const next = {
          ...state.settings,
          connectionOverrides: state.settings.connectionOverrides.filter(
            (o) => o.connectionId !== connectionId
          ),
        };
        saveSettings(next);
        return { settings: next };
      });
    },

    clearConnectionOverrides: () => {
      set((state) => {
        const next = { ...state.settings, connectionOverrides: [] };
        saveSettings(next);
        return { settings: next };
      });
    },

    isBlocked: (sql: string, connectionId?: string) => {
      const level = get().getEffectiveLevel(connectionId);
      return isBlockedAtLevel(level, sql);
    },

    needsConfirmation: (sql: string, connectionId?: string) => {
      const level = get().getEffectiveLevel(connectionId);
      return requiresConfirmationAtLevel(level, sql);
    },

    getEffectiveLevelForConnection: (connectionId: string) => {
      return get().getEffectiveLevel(connectionId);
    },

    setAdminPassword: (password: string) => {
      if (!password) return;
      set((state) => {
        const next = { ...state.settings, adminPasswordHash: hashPassword(password) };
        saveSettings(next);
        return { settings: next };
      });
    },

    clearAdminPassword: () => {
      set((state) => {
        const next = { ...state.settings, adminPasswordHash: undefined };
        saveSettings(next);
        return { settings: next };
      });
    },

    hasAdminPassword: () => {
      return !!get().settings.adminPasswordHash;
    },

    verifyAdminPassword: (password: string) => {
      const { settings } = get();
      if (!settings.adminPasswordHash) return false;
      return hashPassword(password) === settings.adminPasswordHash;
    },

    canBypassConfirmation: (password: string, connectionId?: string) => {
      const level = get().getEffectiveLevel(connectionId);
      if (level < 4) return true; // Levels 0-3 don't need bypass
      return get().verifyAdminPassword(password);
    },

    confirmSql: async (sql: string, connectionId?: string, bypassPassword?: string) => {
      const { settings, canBypassConfirmation, needsConfirmation, getEffectiveLevel } = get();
      const level = getEffectiveLevel(connectionId);

      // If needs no confirmation, allow through
      if (!needsConfirmation(sql, connectionId)) return true;

      // Level 4+ need admin bypass
      if (level >= 4) {
        if (bypassPassword && canBypassConfirmation(bypassPassword, connectionId)) {
          return true;
        }
        // No password provided — need to prompt (handled by the UI layer)
        return false;
      }

      // Level 3 — basic confirmation (UI will handle the dialog)
      // The UI should call this again with bypassPassword set once user confirms
      return false;
    },
  };
});

/** Awaits user confirmation via window.confirm for level 3, or returns false for level 4-5 (UI must handle modal). */
export async function promptConfirmation(
  sql: string,
  connectionId?: string
): Promise<boolean> {
  const { needsConfirmation, getEffectiveLevel } = useSafeModeStore.getState();
  const level = getEffectiveLevel(connectionId);

  if (!needsConfirmation(sql, connectionId)) return true;

  // Level 3: simple confirm dialog
  if (level === 3) {
    const preview = sql.length > 200 ? sql.slice(0, 200) + "..." : sql;
    return window.confirm(`Execute this write statement?\n\n${preview}`);
  }

  // Level 4-5: must be handled by a proper modal (returns false here)
  return false;
}
