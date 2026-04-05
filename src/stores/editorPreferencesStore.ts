import { create } from "zustand";

const EDITOR_PREFERENCES_STORAGE_KEY = "tabler.editorPreferences.v1";

interface EditorPreferencesSnapshot {
  vimModeEnabled?: boolean;
}

interface EditorPreferencesState {
  vimModeEnabled: boolean;
  setVimModeEnabled: (enabled: boolean) => void;
  toggleVimMode: () => void;
}

function readInitialPreferences(): EditorPreferencesSnapshot {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(EDITOR_PREFERENCES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as EditorPreferencesSnapshot;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function persistPreferences(snapshot: EditorPreferencesSnapshot) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(EDITOR_PREFERENCES_STORAGE_KEY, JSON.stringify(snapshot));
}

const initialPreferences = readInitialPreferences();

export const useEditorPreferencesStore = create<EditorPreferencesState>((set) => ({
  vimModeEnabled: initialPreferences.vimModeEnabled ?? false,
  setVimModeEnabled: (enabled) => {
    persistPreferences({ vimModeEnabled: enabled });
    set({ vimModeEnabled: enabled });
  },
  toggleVimMode: () =>
    set((state) => {
      const next = !state.vimModeEnabled;
      persistPreferences({ vimModeEnabled: next });
      return { vimModeEnabled: next };
    }),
}));
