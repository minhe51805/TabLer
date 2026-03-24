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
      accent: "#4c6ef5",
      accentHover: "#364fc7",
      accentDim: "rgba(76,110,245,0.12)",
      selectionBackground: "#4c6ef5",
      hoverBackground: "#edf2f7",
      status: {
        success: "#37b24d",
        warning: "#f59f00",
        error: "#e03131",
        info: "#4c6ef5",
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
      cursor: "#4c6ef5",
      currentLineHighlight: "#e8ecf420",
      selection: "#4c6ef520",
      lineNumber: "#a0aec0",
      invisibles: "#a0aec0",
      syntax: {
        keyword: "#4c6ef5",
        string: "#c92a2a",
        number: "#087f5b",
        comment: "#868e96",
        operator: "#364fc7",
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
      focusBorder: "#4c6ef5",
    },
    sidebar: {
      background: "#f5f7fa",
      text: "#4a5568",
      selectedItem: "#4c6ef5",
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
      accent: "#8fb1ff",
      accentHover: "#d4e0ff",
      accentDim: "rgba(143,177,255,0.14)",
      selectionBackground: "#8fb1ff",
      hoverBackground: "#1b2531",
      status: {
        success: "#84cfb3",
        warning: "#e6b975",
        error: "#eb8c87",
        info: "#8fb1ff",
      },
      badges: {
        background: "#1b2531",
        primaryKey: "#e6b975",
        autoIncrement: "#c7a0e0",
      },
    },
    editor: {
      background: "#101826",
      text: "#e7ecf8",
      cursor: "#aec4ff",
      currentLineHighlight: "#22314f66",
      selection: "#7aa2ff36",
      lineNumber: "#62779d",
      invisibles: "#62779d",
      syntax: {
        keyword: "#7AA2FF",
        string: "#E8BF7A",
        number: "#FFB285",
        comment: "#65789A",
        operator: "#9CB7FF",
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
      modified: "#e6b975",
      inserted: "#84cfb3",
      deleted: "#eb8c87",
      deletedText: "#62779d",
      focusBorder: "#8fb1ff",
    },
    sidebar: {
      background: "#0b1014",
      text: "#98a8ba",
      selectedItem: "#8fb1ff",
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

// ---------------------------------------------------------------------------
// Theme Engine (singleton logic — not React yet, pure functions)
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = "tabler.activeTheme";
const THEMES_STORAGE_KEY = "tabler.themes";

export const ThemeEngine = {
  default: DEFAULT_DARK_THEME,
  light: DEFAULT_LIGHT_THEME,

  getAvailableThemes(): ThemeDefinition[] {
    return [DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME];
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
    try {
      const stored = localStorage.getItem(THEMES_STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored) as ThemeDefinition[];
      }
    } catch {
      // ignore
    }
    return [];
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
