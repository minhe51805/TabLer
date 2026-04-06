/**
 * ThemeEngine — Singleton store for theming.
 * Inspired by TablePro's ThemeEngine.swift.
 *
 * Features:
 * - Centralized theme definition (editor, datagrid, ui, sidebar, toolbar, spacing, typography)
 * - Resolved colors (hex → CSS variables) for components to consume
 * - Dark/light theme switching via CSS custom properties
 * - Monaco editor theme registration
 * - Accessibility font scale support
 */

import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Theme Definition
// ---------------------------------------------------------------------------

export type ThemeAppearance = "dark" | "light" | "auto";

export interface ThemeDefinition {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
  spacing: ThemeSpacing;
  typography: ThemeTypography;
  fonts: ThemeFonts;
  animations: ThemeAnimations;
}

// --- Color Palettes ---

export interface SyntaxColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  operator: string;
  function: string;
  type: string;
}

export interface EditorColors {
  background: string;
  text: string;
  cursor: string;
  currentLineHighlight: string;
  selection: string;
  lineNumber: string;
  invisibles: string;
  syntax: SyntaxColors;
}

export interface DataGridColors {
  background: string;
  text: string;
  alternateRow: string;
  nullValue: string;
  boolTrue: string;
  boolFalse: string;
  rowNumber: string;
  modified: string;
  inserted: string;
  deleted: string;
  deletedText: string;
  focusBorder: string;
}

export interface StatusColors {
  success: string;
  warning: string;
  error: string;
  info: string;
}

export interface BadgeColors {
  background: string;
  primaryKey: string;
  autoIncrement: string;
}

export interface UIColors {
  windowBackground: string;
  controlBackground: string;
  cardBackground: string;
  border: string;
  borderLight?: string;
  primaryText: string;
  secondaryText: string;
  tertiaryText: string;
  accent: string;
  accentHover: string;
  accentDim: string;
  selectionBackground: string;
  hoverBackground: string;
  status: StatusColors;
  badges: BadgeColors;
}

export interface SidebarColors {
  background: string;
  text: string;
  selectedItem: string;
  hover: string;
  sectionHeader: string;
}

export interface ThemeColors {
  editor: EditorColors;
  dataGrid: DataGridColors;
  ui: UIColors;
  sidebar: SidebarColors;
}

// --- Spacing ---

export interface ThemeSpacing {
  xxxs: number;
  xxs: number;
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
}

// --- Typography ---

export interface ThemeTypography {
  tiny: number;
  caption: number;
  small: number;
  medium: number;
  body: number;
  title3: number;
  title2: number;
}

// --- Fonts ---

export interface ThemeFonts {
  editorFontFamily: string;
  editorFontSize: number;
  dataGridFontFamily: string;
  dataGridFontSize: number;
}

// --- Animations ---

export interface ThemeAnimations {
  fast: number;
  normal: number;
  smooth: number;
  slow: number;
}

// ---------------------------------------------------------------------------
// Default Light Theme
// ---------------------------------------------------------------------------

const DEFAULT_LIGHT_THEME: ThemeDefinition = {
  id: "tabler.light",
  name: "TableR Light",
  appearance: "light",
  colors: {
    ui: {
      windowBackground: "#ffffff",
      controlBackground: "#f5f7fa",
      cardBackground: "#ffffff",
      border: "#d1d9e6",
      borderLight: "#e8ecf4",
      primaryText: "#1a2332",
      secondaryText: "#4a5568",
      tertiaryText: "#718096",
      accent: "#f59e0b",
      accentHover: "#fbbf24",
      accentDim: "rgba(245,158,11,0.12)",
      selectionBackground: "#f59e0b",
      hoverBackground: "#edf2f7",
      status: {
        success: "#37b24d",
        warning: "#f59f00",
        error: "#e03131",
        info: "#f59e0b",
      },
      badges: {
        background: "#edf2f7",
        primaryKey: "#d97706",
        autoIncrement: "#7c3aed",
      },
    },
    editor: {
      background: "#f8f9fc",
      text: "#1a2332",
      cursor: "#f59e0b",
      currentLineHighlight: "#e8ecf420",
      selection: "#f59e0b20",
      lineNumber: "#a0aec0",
      invisibles: "#a0aec0",
      syntax: {
        keyword: "#f59e0b",
        string: "#c92a2a",
        number: "#087f5b",
        comment: "#868e96",
        operator: "#fbbf24",
        function: "#2b8a3e",
        type: "#7c3aed",
      },
    },
    dataGrid: {
      background: "#ffffff",
      text: "#1a2332",
      alternateRow: "#f8f9fc",
      nullValue: "#a0aec0",
      boolTrue: "#37b24d",
      boolFalse: "#e03131",
      rowNumber: "#a0aec0",
      modified: "#d97706",
      inserted: "#37b24d",
      deleted: "#e03131",
      deletedText: "#a0aec0",
      focusBorder: "#f59e0b",
    },
    sidebar: {
      background: "#f5f7fa",
      text: "#4a5568",
      selectedItem: "#f59e0b",
      hover: "#edf2f7",
      sectionHeader: "#a0aec0",
    },
  },
  spacing: {
    xxxs: 2,
    xxs: 4,
    xs: 8,
    sm: 12,
    md: 16,
    lg: 20,
    xl: 24,
  },
  typography: {
    tiny: 9,
    caption: 10,
    small: 11,
    medium: 12,
    body: 13,
    title3: 15,
    title2: 17,
  },
  fonts: {
    editorFontFamily: "JetBrains Mono, Fira Code, Consolas, monospace",
    editorFontSize: 13,
    dataGridFontFamily: "JetBrains Mono, Fira Code, Consolas, monospace",
    dataGridFontSize: 12,
  },
  animations: {
    fast: 0.1,
    normal: 0.2,
    smooth: 0.3,
    slow: 0.5,
  },
};

// ---------------------------------------------------------------------------
// Default Dark Theme (matches current TableR CSS)
// ---------------------------------------------------------------------------

const DEFAULT_DARK_THEME: ThemeDefinition = {
  id: "tabler.dark",
  name: "TableR Dark",
  appearance: "dark",
  colors: {
    ui: {
      windowBackground: "#0b1014",
      controlBackground: "#10161d",
      cardBackground: "#131b23",
      border: "#25313d",
      borderLight: "#324253",
      primaryText: "#edf3fa",
      secondaryText: "#d5dee8",
      tertiaryText: "#98a8ba",
      accent: "#22d3ee",
      accentHover: "#67e8f9",
      accentDim: "rgba(34,211,238,0.14)",
      selectionBackground: "#22d3ee",
      hoverBackground: "#1b2531",
      status: {
        success: "#84cfb3",
        warning: "#e6b975",
        error: "#eb8c87",
        info: "#22d3ee",
      },
      badges: {
        background: "#1b2531",
        primaryKey: "#22d3ee",
        autoIncrement: "#c7a0e0",
      },
    },
    editor: {
      background: "#101826",
      text: "#e7ecf8",
      cursor: "#22d3ee",
      currentLineHighlight: "#0b2f3c66",
      selection: "#22d3ee2a",
      lineNumber: "#62779d",
      invisibles: "#62779d",
      syntax: {
        keyword: "#22d3ee",
        string: "#7fe0c2",
        number: "#7dc9d8",
        comment: "#65789A",
        operator: "#22d3ee",
        function: "#B4F0A0",
        type: "#C7A0E0",
      },
    },
    dataGrid: {
      background: "#101826",
      text: "#edf3fa",
      alternateRow: "#131b27",
      nullValue: "#62779d",
      boolTrue: "#84cfb3",
      boolFalse: "#eb8c87",
      rowNumber: "#62779d",
      modified: "#22d3ee",
      inserted: "#84cfb3",
      deleted: "#eb8c87",
      deletedText: "#62779d",
      focusBorder: "#22d3ee",
    },
    sidebar: {
      background: "#0b1014",
      text: "#98a8ba",
      selectedItem: "#22d3ee",
      hover: "#1b2531",
      sectionHeader: "#62779d",
    },
  },
  spacing: {
    xxxs: 2,
    xxs: 4,
    xs: 8,
    sm: 12,
    md: 16,
    lg: 20,
    xl: 24,
  },
  typography: {
    tiny: 9,
    caption: 10,
    small: 11,
    medium: 12,
    body: 13,
    title3: 15,
    title2: 17,
  },
  fonts: {
    editorFontFamily: "JetBrains Mono, Fira Code, Consolas, monospace",
    editorFontSize: 13,
    dataGridFontFamily: "JetBrains Mono, Fira Code, Consolas, monospace",
    dataGridFontSize: 12,
  },
  animations: {
    fast: 0.1,
    normal: 0.2,
    smooth: 0.3,
    slow: 0.5,
  },
};

const MIDNIGHT_BLUE_THEME: ThemeDefinition = {
  id: "tabler.midnight",
  name: "Midnight Blue",
  appearance: "dark",
  colors: {
    ui: {
      windowBackground: "#091019",
      controlBackground: "#0d1521",
      cardBackground: "#111b29",
      border: "#223246",
      borderLight: "#2d4059",
      primaryText: "#edf5ff",
      secondaryText: "#cad7e7",
      tertiaryText: "#8ea2bb",
      accent: "#6ea8ff",
      accentHover: "#97c1ff",
      accentDim: "rgba(110,168,255,0.16)",
      selectionBackground: "#6ea8ff",
      hoverBackground: "#162233",
      status: {
        success: "#73d2ad",
        warning: "#f0bf72",
        error: "#ef8f8d",
        info: "#6ea8ff",
      },
      badges: {
        background: "#162233",
        primaryKey: "#8eb9ff",
        autoIncrement: "#9f8dff",
      },
    },
    editor: {
      background: "#0f1726",
      text: "#eaf2ff",
      cursor: "#6ea8ff",
      currentLineHighlight: "#1d2d475c",
      selection: "#6ea8ff2c",
      lineNumber: "#617998",
      invisibles: "#617998",
      syntax: {
        keyword: "#88b4ff",
        string: "#8fe0c0",
        number: "#f4c47d",
        comment: "#69809d",
        operator: "#9dc0ff",
        function: "#c3d7ff",
        type: "#b39dff",
      },
    },
    dataGrid: {
      background: "#0f1726",
      text: "#edf5ff",
      alternateRow: "#121d2d",
      nullValue: "#667c98",
      boolTrue: "#73d2ad",
      boolFalse: "#ef8f8d",
      rowNumber: "#667c98",
      modified: "#7fb0ff",
      inserted: "#73d2ad",
      deleted: "#ef8f8d",
      deletedText: "#667c98",
      focusBorder: "#6ea8ff",
    },
    sidebar: {
      background: "#091019",
      text: "#96a8bf",
      selectedItem: "#6ea8ff",
      hover: "#162233",
      sectionHeader: "#657c96",
    },
  },
  spacing: DEFAULT_DARK_THEME.spacing,
  typography: DEFAULT_DARK_THEME.typography,
  fonts: DEFAULT_DARK_THEME.fonts,
  animations: DEFAULT_DARK_THEME.animations,
};

const GRAPHITE_THEME: ThemeDefinition = {
  id: "tabler.graphite",
  name: "Graphite Glow",
  appearance: "dark",
  colors: {
    ui: {
      windowBackground: "#101113",
      controlBackground: "#17191d",
      cardBackground: "#1b1f25",
      border: "#313842",
      borderLight: "#414a56",
      primaryText: "#f1f4f8",
      secondaryText: "#d0d6df",
      tertiaryText: "#98a1ad",
      accent: "#8fd3ff",
      accentHover: "#b7e5ff",
      accentDim: "rgba(143,211,255,0.16)",
      selectionBackground: "#8fd3ff",
      hoverBackground: "#232831",
      status: {
        success: "#95d9b0",
        warning: "#edc27e",
        error: "#ef9a96",
        info: "#8fd3ff",
      },
      badges: {
        background: "#232831",
        primaryKey: "#8fd3ff",
        autoIncrement: "#d1a3ff",
      },
    },
    editor: {
      background: "#171a1f",
      text: "#f0f4fa",
      cursor: "#8fd3ff",
      currentLineHighlight: "#26303f66",
      selection: "#8fd3ff24",
      lineNumber: "#778291",
      invisibles: "#778291",
      syntax: {
        keyword: "#9cd5ff",
        string: "#f0cf8d",
        number: "#9be2bf",
        comment: "#7b8694",
        operator: "#cfe9ff",
        function: "#cce6ff",
        type: "#caa8ff",
      },
    },
    dataGrid: {
      background: "#171a1f",
      text: "#f1f4f8",
      alternateRow: "#1c2027",
      nullValue: "#7c8796",
      boolTrue: "#95d9b0",
      boolFalse: "#ef9a96",
      rowNumber: "#7c8796",
      modified: "#8fd3ff",
      inserted: "#95d9b0",
      deleted: "#ef9a96",
      deletedText: "#7c8796",
      focusBorder: "#8fd3ff",
    },
    sidebar: {
      background: "#101113",
      text: "#9fa9b6",
      selectedItem: "#8fd3ff",
      hover: "#232831",
      sectionHeader: "#7c8796",
    },
  },
  spacing: DEFAULT_DARK_THEME.spacing,
  typography: DEFAULT_DARK_THEME.typography,
  fonts: DEFAULT_DARK_THEME.fonts,
  animations: DEFAULT_DARK_THEME.animations,
};

const FOREST_THEME: ThemeDefinition = {
  id: "tabler.forest",
  name: "Forest Signal",
  appearance: "dark",
  colors: {
    ui: {
      windowBackground: "#0a120f",
      controlBackground: "#101a16",
      cardBackground: "#14211c",
      border: "#23362f",
      borderLight: "#305146",
      primaryText: "#eef7f2",
      secondaryText: "#cfddd7",
      tertiaryText: "#8fa59d",
      accent: "#58d39b",
      accentHover: "#7be5b3",
      accentDim: "rgba(88,211,155,0.16)",
      selectionBackground: "#58d39b",
      hoverBackground: "#1a2a24",
      status: {
        success: "#7fe7ae",
        warning: "#e1c17a",
        error: "#ee9c9c",
        info: "#58d39b",
      },
      badges: {
        background: "#1a2a24",
        primaryKey: "#7de4b1",
        autoIncrement: "#89b7ff",
      },
    },
    editor: {
      background: "#101916",
      text: "#eff7f2",
      cursor: "#58d39b",
      currentLineHighlight: "#16312666",
      selection: "#58d39b24",
      lineNumber: "#6f897f",
      invisibles: "#6f897f",
      syntax: {
        keyword: "#7fe7ae",
        string: "#c4ef9f",
        number: "#f1c47a",
        comment: "#6f897f",
        operator: "#9cf0c0",
        function: "#bfeccf",
        type: "#9ec8ff",
      },
    },
    dataGrid: {
      background: "#101916",
      text: "#eef7f2",
      alternateRow: "#13201b",
      nullValue: "#6f897f",
      boolTrue: "#7fe7ae",
      boolFalse: "#ee9c9c",
      rowNumber: "#6f897f",
      modified: "#58d39b",
      inserted: "#7fe7ae",
      deleted: "#ee9c9c",
      deletedText: "#6f897f",
      focusBorder: "#58d39b",
    },
    sidebar: {
      background: "#0a120f",
      text: "#94aaa2",
      selectedItem: "#58d39b",
      hover: "#1a2a24",
      sectionHeader: "#6f897f",
    },
  },
  spacing: DEFAULT_DARK_THEME.spacing,
  typography: DEFAULT_DARK_THEME.typography,
  fonts: DEFAULT_DARK_THEME.fonts,
  animations: DEFAULT_DARK_THEME.animations,
};

const BUILT_IN_THEMES: ThemeDefinition[] = [
  DEFAULT_DARK_THEME,
  MIDNIGHT_BLUE_THEME,
  GRAPHITE_THEME,
  FOREST_THEME,
  DEFAULT_LIGHT_THEME,
];

// ---------------------------------------------------------------------------
// Theme Engine (singleton logic — not React yet, pure functions)
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = "tabler.activeTheme";
const THEMES_STORAGE_KEY = "tabler.themes";
const BUILT_IN_THEME_IDS = new Set(BUILT_IN_THEMES.map((theme) => theme.id));

function isThemeDefinitionCandidate(value: unknown): value is ThemeDefinition {
  if (!value || typeof value !== "object") return false;
  const theme = value as Partial<ThemeDefinition>;
  return typeof theme.id === "string" && typeof theme.name === "string" && !!theme.colors;
}

function loadStoredUserThemes(): ThemeDefinition[] {
  try {
    const stored = localStorage.getItem(THEMES_STORAGE_KEY);
    if (!stored) return [];

    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isThemeDefinitionCandidate).filter((theme) => !BUILT_IN_THEME_IDS.has(theme.id));
  } catch {
    return [];
  }
}

function getAllThemes(): ThemeDefinition[] {
  return [...BUILT_IN_THEMES, ...loadStoredUserThemes()];
}

function getThemeShapeTokens(themeId: string) {
  switch (themeId) {
    case "tabler.midnight":
      return {
        buttonRadius: "10px",
        cardRadius: "18px",
        panelRadius: "20px",
      };
    case "tabler.graphite":
      return {
        buttonRadius: "7px",
        cardRadius: "13px",
        panelRadius: "15px",
      };
    case "tabler.forest":
      return {
        buttonRadius: "12px",
        cardRadius: "20px",
        panelRadius: "22px",
      };
    default:
      return {
        buttonRadius: "8px",
        cardRadius: "16px",
        panelRadius: "18px",
      };
  }
}

export const ThemeEngine = {
  default: DEFAULT_DARK_THEME,
  light: DEFAULT_LIGHT_THEME,

  getAvailableThemes(): ThemeDefinition[] {
    return getAllThemes();
  },

  getAppearance(): ThemeAppearance {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Partial<ThemeDefinition>;
        if (parsed.appearance) return parsed.appearance;
      } catch {
        // ignore
      }
    }
    return "dark";
  },

  applyAppearance(appearance: ThemeAppearance): void {
    const resolved = appearance === "auto" ? "dark" : appearance;
    const root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    root.style.colorScheme = resolved;
  },

  loadActive(): ThemeDefinition {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<ThemeDefinition>;
        if (parsed.id) {
          const matchedTheme = getAllThemes().find((theme) => theme.id === parsed.id);
          if (matchedTheme) {
            return matchedTheme;
          }
        }
        if (parsed.id && parsed.colors) {
          return { ...DEFAULT_DARK_THEME, ...parsed };
        }
      }
    } catch {
      // ignore
    }
    return DEFAULT_DARK_THEME;
  },

  saveActive(theme: ThemeDefinition): void {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
    } catch {
      // ignore
    }
  },

  loadUserThemes(): ThemeDefinition[] {
    return loadStoredUserThemes();
  },

  saveUserThemes(themes: ThemeDefinition[]): void {
    try {
      localStorage.setItem(THEMES_STORAGE_KEY, JSON.stringify(themes));
    } catch {
      // ignore
    }
  },
};

// ---------------------------------------------------------------------------
// CSS Variable Injection
// ---------------------------------------------------------------------------

function injectThemeAsCSSVars(theme: ThemeDefinition): void {
  ThemeEngine.applyAppearance(theme.appearance === "auto" ? "dark" : theme.appearance);
  const root = document.documentElement;
  const c = theme.colors;
  const s = theme.spacing;
  const t = theme.typography;
  const a = theme.animations;
  const shape = getThemeShapeTokens(theme.id);

  root.setAttribute("data-theme-preset", theme.id);

  // UI colors
  root.style.setProperty("--bg-primary", c.ui.windowBackground);
  root.style.setProperty("--bg-secondary", c.ui.controlBackground);
  root.style.setProperty("--bg-tertiary", c.ui.cardBackground);
  root.style.setProperty("--bg-surface", c.ui.cardBackground);
  root.style.setProperty("--bg-hover", c.ui.hoverBackground);
  root.style.setProperty("--bg-elevated", c.ui.controlBackground);

  root.style.setProperty("--text-primary", c.ui.primaryText);
  root.style.setProperty("--text-secondary", c.ui.secondaryText);
  root.style.setProperty("--text-muted", c.ui.tertiaryText);

  root.style.setProperty("--border-color", c.ui.border);
  root.style.setProperty("--border-light", c.ui.borderLight ?? c.ui.border);

  root.style.setProperty("--accent", c.ui.accent);
  root.style.setProperty("--accent-hover", c.ui.accentHover);
  root.style.setProperty("--accent-dim", c.ui.accentDim);

  root.style.setProperty("--success", c.ui.status.success);
  root.style.setProperty("--warning", c.ui.status.warning);
  root.style.setProperty("--error", c.ui.status.error);
  root.style.setProperty("--info", c.ui.status.info);

  // DataGrid
  root.style.setProperty("--datagrid-bg", c.dataGrid.background);
  root.style.setProperty("--datagrid-text", c.dataGrid.text);
  root.style.setProperty("--datagrid-alt-row", c.dataGrid.alternateRow);
  root.style.setProperty("--datagrid-null", c.dataGrid.nullValue);
  root.style.setProperty("--datagrid-bool-true", c.dataGrid.boolTrue);
  root.style.setProperty("--datagrid-bool-false", c.dataGrid.boolFalse);
  root.style.setProperty("--datagrid-row-num", c.dataGrid.rowNumber);
  root.style.setProperty("--datagrid-modified", c.dataGrid.modified);
  root.style.setProperty("--datagrid-inserted", c.dataGrid.inserted);
  root.style.setProperty("--datagrid-deleted", c.dataGrid.deleted);
  root.style.setProperty("--datagrid-focus-border", c.dataGrid.focusBorder);

  // Spacing
  root.style.setProperty("--space-xxxs", `${s.xxxs}px`);
  root.style.setProperty("--space-xxs", `${s.xxs}px`);
  root.style.setProperty("--space-xs", `${s.xs}px`);
  root.style.setProperty("--space-sm", `${s.sm}px`);
  root.style.setProperty("--space-md", `${s.md}px`);
  root.style.setProperty("--space-lg", `${s.lg}px`);
  root.style.setProperty("--space-xl", `${s.xl}px`);

  // Typography
  root.style.setProperty("--font-tiny", `${t.tiny}px`);
  root.style.setProperty("--font-caption", `${t.caption}px`);
  root.style.setProperty("--font-small", `${t.small}px`);
  root.style.setProperty("--font-medium", `${t.medium}px`);
  root.style.setProperty("--font-body", `${t.body}px`);
  root.style.setProperty("--font-title3", `${t.title3}px`);
  root.style.setProperty("--font-title2", `${t.title2}px`);

  // Animations
  root.style.setProperty("--anim-fast", `${a.fast}s`);
  root.style.setProperty("--anim-normal", `${a.normal}s`);
  root.style.setProperty("--anim-smooth", `${a.smooth}s`);
  root.style.setProperty("--anim-slow", `${a.slow}s`);

  root.style.setProperty("--theme-button-radius", shape.buttonRadius);
  root.style.setProperty("--theme-card-radius", shape.cardRadius);
  root.style.setProperty("--theme-panel-radius", shape.panelRadius);
}

// ---------------------------------------------------------------------------
// React Hook: useTheme
// ---------------------------------------------------------------------------

export function useTheme() {
  const [activeTheme, setActiveTheme] = useState<ThemeDefinition>(() => ThemeEngine.loadActive());

  const activateTheme = useCallback((theme: ThemeDefinition) => {
    setActiveTheme(theme);
    ThemeEngine.saveActive(theme);
    injectThemeAsCSSVars(theme);
    window.dispatchEvent(new CustomEvent("theme-changed", { detail: theme }));
  }, []);

  // Apply theme on mount
  useEffect(() => {
    injectThemeAsCSSVars(activeTheme);
  }, [activeTheme]);

  useEffect(() => {
    const handleThemeChanged = (event: Event) => {
      const customEvent = event as CustomEvent<ThemeDefinition | undefined>;
      const nextTheme = customEvent.detail;
      if (!nextTheme) return;
      setActiveTheme(nextTheme);
    };

    window.addEventListener("theme-changed", handleThemeChanged as EventListener);

    return () => {
      window.removeEventListener("theme-changed", handleThemeChanged as EventListener);
    };
  }, []);

  return {
    theme: activeTheme,
    activateTheme,
    defaultTheme: ThemeEngine.default,
  };
}

// ---------------------------------------------------------------------------
// Monaco Editor Theme Registration
// ---------------------------------------------------------------------------

export function registerMonacoTheme(monaco: unknown): void {
  const theme = ThemeEngine.loadActive();
  const { editor } = theme.colors;

   
  (monaco as any).editor.defineTheme("tabler-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: editor.syntax.keyword, fontStyle: "bold" },
      { token: "string", foreground: editor.syntax.string },
      { token: "number", foreground: editor.syntax.number },
      { token: "comment", foreground: editor.syntax.comment, fontStyle: "italic" },
      { token: "operator", foreground: editor.syntax.operator },
      { token: "delimiter", foreground: editor.text },
      { token: "identifier", foreground: editor.text },
      { token: "type", foreground: editor.syntax.type },
    ],
    colors: {
      "editor.background": editor.background,
      "editor.foreground": editor.text,
      "editor.selectionBackground": editor.selection,
      "editor.lineHighlightBackground": editor.currentLineHighlight,
      "editorCursor.foreground": editor.cursor,
      "editorLineNumber.foreground": editor.lineNumber,
      "editorLineNumber.activeForeground": editor.text,
    },
  });
}
