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

const TABLER_DARK_PRESET: TablerTheme = {
  id: "tabler-dark",
  name: "Tabler Dark",
  type: "dark",
  editor: {
    background: "#101826",
    foreground: "#e7ecf8",
    selection: "#22d3ee2a",
    cursor: "#22d3ee",
    lineHighlight: "#0b2f3c66",
    lineNumber: "#62779d",
    lineNumberActive: "#e7ecf8",
    keyword: "#22D3EE",
    string: "#7FE0C2",
    number: "#7DC9D8",
    comment: "#65789A",
    operator: "#22D3EE",
  },
  font: {
    family: "JetBrains Mono, Fira Code, Consolas, monospace",
    size: 13,
    ligatures: true,
    lineHeight: 1.6,
  },
  layout: {
    tabHeight: 40,
    sidebarWidth: 320,
    panelSpacing: 8,
    borderRadius: 8,
  },
};

const TABLER_MIDNIGHT_PRESET: TablerTheme = {
  id: "tabler-midnight",
  name: "Tabler Midnight",
  type: "dark",
  editor: {
    background: "#0d1117",
    foreground: "#c9d1d9",
    selection: "#388bfd26",
    cursor: "#58a6ff",
    lineHighlight: "#161b2280",
    lineNumber: "#484f58",
    lineNumberActive: "#c9d1d9",
    keyword: "#ff7b72",
    string: "#a5d6ff",
    number: "#79c0ff",
    comment: "#8b949e",
    operator: "#ff7b72",
  },
  font: {
    family: "JetBrains Mono, Fira Code, Consolas, monospace",
    size: 13,
    ligatures: true,
    lineHeight: 1.6,
  },
  layout: {
    tabHeight: 40,
    sidebarWidth: 320,
    panelSpacing: 8,
    borderRadius: 8,
  },
};

const TABLER_GRAPHITE_PRESET: TablerTheme = {
  id: "tabler-graphite",
  name: "Tabler Graphite",
  type: "dark",
  editor: {
    background: "#1a1a2e",
    foreground: "#eaeaea",
    selection: "#b4a7d6cc",
    cursor: "#b4a7d6",
    lineHighlight: "#16213e80",
    lineNumber: "#6e6e8a",
    lineNumberActive: "#eaeaea",
    keyword: "#b4a7d6",
    string: "#85e89d",
    number: "#f8c555",
    comment: "#6e6e8a",
    operator: "#b4a7d6",
  },
  font: {
    family: "JetBrains Mono, Fira Code, Consolas, monospace",
    size: 13,
    ligatures: true,
    lineHeight: 1.6,
  },
  layout: {
    tabHeight: 40,
    sidebarWidth: 320,
    panelSpacing: 8,
    borderRadius: 8,
  },
};

const TABLER_FOREST_PRESET: TablerTheme = {
  id: "tabler-forest",
  name: "Tabler Forest",
  type: "dark",
  editor: {
    background: "#1b2b1f",
    foreground: "#d4e3c7",
    selection: "#2ea04366",
    cursor: "#3fb950",
    lineHighlight: "#2ea04333",
    lineNumber: "#4a6b3f",
    lineNumberActive: "#d4e3c7",
    keyword: "#3fb950",
    string: "#a5d6ff",
    number: "#79c0ff",
    comment: "#4a6b3f",
    operator: "#3fb950",
  },
  font: {
    family: "JetBrains Mono, Fira Code, Consolas, monospace",
    size: 13,
    ligatures: true,
    lineHeight: 1.6,
  },
  layout: {
    tabHeight: 40,
    sidebarWidth: 320,
    panelSpacing: 8,
    borderRadius: 8,
  },
};

const TABLER_LIGHT_PRESET: TablerTheme = {
  id: "tabler-light",
  name: "Tabler Light",
  type: "light",
  editor: {
    background: "#ffffff",
    foreground: "#1f2328",
    selection: "#0969da26",
    cursor: "#0969da",
    lineHighlight: "#f6f8fa",
    lineNumber: "#6e7781",
    lineNumberActive: "#1f2328",
    keyword: "#0550ae",
    string: "#0a3069",
    number: "#0550ae",
    comment: "#6e7781",
    operator: "#0550ae",
  },
  font: {
    family: "JetBrains Mono, Fira Code, Consolas, monospace",
    size: 13,
    ligatures: true,
    lineHeight: 1.6,
  },
  layout: {
    tabHeight: 40,
    sidebarWidth: 320,
    panelSpacing: 8,
    borderRadius: 8,
  },
};

export const PRESET_THEMES: TablerTheme[] = [
  TABLER_DARK_PRESET,
  TABLER_MIDNIGHT_PRESET,
  TABLER_GRAPHITE_PRESET,
  TABLER_FOREST_PRESET,
  TABLER_LIGHT_PRESET,
];

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
    ...TABLER_DARK_PRESET,
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
  activeThemeId: "tabler-dark",
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
