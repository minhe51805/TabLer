import { create } from "zustand";

export interface TablerTheme {
  id: string;
  name: string;
  type: "dark" | "light";
  editor: {
    background: string;
    foreground: string;
    selection: string;
    cursor: string;
    lineHighlight: string;
    lineNumber: string;
    lineNumberActive: string;
    keyword: string;
    string: string;
    number: string;
    comment: string;
    operator: string;
  };
  font: {
    family: string;
    size: number;
    ligatures: boolean;
    lineHeight: number;
  };
  layout: {
    tabHeight: number;
    sidebarWidth: number;
    panelSpacing: number;
    borderRadius: number;
  };
}

// Option A: the dark Tabler presets (Dark / Midnight / Graphite / Forest) and
// the old generic Tabler Light were retired. MiniMax is now the single global
// look, so the editor-color layer exposes exactly one preset whose surface,
// syntax, and chrome match the MiniMax Design System (white canvas #FFFFFF,
// charcoal text #111827, amber accent #C37D0D, success green #16A34A).
const TABLER_MINIMAX_PRESET: TablerTheme = {
  id: "tabler-minimax",
  name: "MiniMax",
  type: "light",
  editor: {
    background: "#FFFFFF",
    foreground: "#111827",
    selection: "#C37D0D26",
    cursor: "#C37D0D",
    lineHighlight: "#F9FAFB",
    lineNumber: "#9CA3AF",
    lineNumberActive: "#111827",
    keyword: "#C37D0D",
    string: "#16A34A",
    number: "#C37D0D",
    comment: "#9CA3AF",
    operator: "#111827",
  },
  font: {
    family: "DM Mono, JetBrains Mono, Consolas, monospace",
    size: 14,
    ligatures: true,
    lineHeight: 1.6,
  },
  layout: {
    tabHeight: 40,
    sidebarWidth: 320,
    panelSpacing: 8,
    borderRadius: 6,
  },
};

export const PRESET_THEMES: TablerTheme[] = [TABLER_MINIMAX_PRESET];

const CUSTOM_THEME_STORAGE_KEY = "tabler.customTheme";

function loadCustomTheme(): TablerTheme | null {
  try {
    const raw = window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as TablerTheme;
  } catch {
    // ignore
  }
  return null;
}

function saveCustomTheme(theme: TablerTheme) {
  try {
    window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // ignore
  }
}

function defaultCustomTheme(): TablerTheme {
  return {
    ...TABLER_MINIMAX_PRESET,
    id: "tabler-custom",
    name: "Custom",
  };
}

interface ThemeStoreState {
  activeThemeId: string;
  customTheme: TablerTheme;
  availableThemes: TablerTheme[];

  setActiveTheme: (id: string) => void;
  updateCustomTheme: (partial: Partial<TablerTheme>) => void;
  updateCustomEditor: (partial: Partial<TablerTheme["editor"]>) => void;
  updateCustomFont: (partial: Partial<TablerTheme["font"]>) => void;
  updateCustomLayout: (partial: Partial<TablerTheme["layout"]>) => void;
  exportCustomTheme: () => string;
  importCustomTheme: (json: string) => boolean;
  resetCustomTheme: () => void;
  getActiveTheme: () => TablerTheme;
}

export const useThemeStore = create<ThemeStoreState>((set, get) => ({
  activeThemeId: "tabler-minimax",
  customTheme: loadCustomTheme() ?? defaultCustomTheme(),
  availableThemes: PRESET_THEMES,

  setActiveTheme: (id: string) => {
    set({ activeThemeId: id });
    const theme = id === "tabler-custom"
      ? get().customTheme
      : PRESET_THEMES.find((t) => t.id === id) ?? PRESET_THEMES[0];
    applyThemeToDOM(theme);
  },

  updateCustomTheme: (partial: Partial<TablerTheme>) => {
    set((state) => {
      const next = { ...state.customTheme, ...partial };
      saveCustomTheme(next);
      if (state.activeThemeId === "tabler-custom") {
        applyThemeToDOM(next);
      }
      return { customTheme: next };
    });
  },

  updateCustomEditor: (partial: Partial<TablerTheme["editor"]>) => {
    set((state) => {
      const next = { ...state.customTheme, editor: { ...state.customTheme.editor, ...partial } };
      saveCustomTheme(next);
      if (state.activeThemeId === "tabler-custom") {
        applyThemeToDOM(next);
      }
      return { customTheme: next };
    });
  },

  updateCustomFont: (partial: Partial<TablerTheme["font"]>) => {
    set((state) => {
      const next = { ...state.customTheme, font: { ...state.customTheme.font, ...partial } };
      saveCustomTheme(next);
      if (state.activeThemeId === "tabler-custom") {
        applyThemeToDOM(next);
      }
      return { customTheme: next };
    });
  },

  updateCustomLayout: (partial: Partial<TablerTheme["layout"]>) => {
    set((state) => {
      const next = { ...state.customTheme, layout: { ...state.customTheme.layout, ...partial } };
      saveCustomTheme(next);
      if (state.activeThemeId === "tabler-custom") {
        applyThemeToDOM(next);
      }
      return { customTheme: next };
    });
  },

  exportCustomTheme: () => {
    return JSON.stringify(get().customTheme, null, 2);
  },

  importCustomTheme: (json: string) => {
    try {
      const parsed = JSON.parse(json) as TablerTheme;
      // Basic validation
      if (!parsed.id || !parsed.name || !parsed.editor || !parsed.font || !parsed.layout) {
        return false;
      }
      const next = { ...parsed, id: "tabler-custom", name: parsed.name || "Custom" };
      saveCustomTheme(next);
      set({ customTheme: next });
      if (get().activeThemeId === "tabler-custom") {
        applyThemeToDOM(next);
      }
      return true;
    } catch {
      return false;
    }
  },

  resetCustomTheme: () => {
    const next = defaultCustomTheme();
    saveCustomTheme(next);
    set({ customTheme: next });
    if (get().activeThemeId === "tabler-custom") {
      applyThemeToDOM(next);
    }
  },

  getActiveTheme: () => {
    const { activeThemeId, customTheme } = get();
    if (activeThemeId === "tabler-custom") return customTheme;
    return PRESET_THEMES.find((t) => t.id === activeThemeId) ?? PRESET_THEMES[0];
  },
}));

/** Apply theme CSS variables to document root. */
function applyThemeToDOM(theme: TablerTheme) {
  const root = document.documentElement;
  root.style.setProperty("--theme-editor-bg", theme.editor.background);
  root.style.setProperty("--theme-editor-fg", theme.editor.foreground);
  root.style.setProperty("--theme-editor-selection", theme.editor.selection);
  root.style.setProperty("--theme-editor-cursor", theme.editor.cursor);
  root.style.setProperty("--theme-editor-line-highlight", theme.editor.lineHighlight);
  root.style.setProperty("--theme-editor-line-number", theme.editor.lineNumber);
  root.style.setProperty("--theme-editor-line-number-active", theme.editor.lineNumberActive);
  root.style.setProperty("--theme-editor-keyword", theme.editor.keyword);
  root.style.setProperty("--theme-editor-string", theme.editor.string);
  root.style.setProperty("--theme-editor-number", theme.editor.number);
  root.style.setProperty("--theme-editor-comment", theme.editor.comment);
  root.style.setProperty("--theme-editor-operator", theme.editor.operator);
  root.style.setProperty("--theme-font-family", theme.font.family);
  root.style.setProperty("--theme-font-size", `${theme.font.size}px`);
  root.style.setProperty("--theme-font-ligatures", theme.font.ligatures ? "normal" : "none");
  root.style.setProperty("--theme-line-height", String(theme.font.lineHeight));
  root.style.setProperty("--theme-tab-height", `${theme.layout.tabHeight}px`);
  root.style.setProperty("--theme-sidebar-width", `${theme.layout.sidebarWidth}px`);
  root.style.setProperty("--theme-panel-spacing", `${theme.layout.panelSpacing}px`);
  root.style.setProperty("--theme-border-radius", `${theme.layout.borderRadius}px`);
}
