/**
 * Theme definitions and built-in preset data.
 * Data-only module consumed by the theme engine.
 */

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

export const DEFAULT_LIGHT_THEME: ThemeDefinition = {
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

export const DEFAULT_DARK_THEME: ThemeDefinition = {
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

export const MIDNIGHT_BLUE_THEME: ThemeDefinition = {
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

export const GRAPHITE_THEME: ThemeDefinition = {
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

export const FOREST_THEME: ThemeDefinition = {
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

// ---------------------------------------------------------------------------
// MiniMax Theme - light palette with Apple blue #007AFF
// ---------------------------------------------------------------------------

export const MINIMAX_THEME: ThemeDefinition = {
  id: "tabler.minimax",
  name: "MiniMax",
  appearance: "light",
  colors: {
    ui: {
      windowBackground: "#FFFFFF",
      controlBackground: "#F7F7F8",
      cardBackground: "#FFFFFF",
      border: "#D8D8DC",
      borderLight: "#E5E5EA",
      primaryText: "#000000",
      secondaryText: "#3C3C43",
      tertiaryText: "#8E8E93",
      accent: "#007AFF",
      accentHover: "#0A6CFF",
      accentDim: "rgba(0, 122, 255, 0.10)",
      selectionBackground: "#B4D8FD",
      hoverBackground: "#F0F0F2",
      status: {
        success: "#248A3D",
        warning: "#C55B00",
        error: "#D70015",
        info: "#007AFF",
      },
      badges: {
        background: "#E5E5EA",
        primaryKey: "rgba(0, 122, 255, 0.15)",
        autoIncrement: "rgba(175, 82, 222, 0.15)",
      },
    },
    editor: {
      background: "#FFFFFF",
      text: "#000000",
      cursor: "#007AFF",
      currentLineHighlight: "rgba(0, 122, 255, 0.08)",
      selection: "#B4D8FD",
      lineNumber: "#8E8E93",
      invisibles: "#C7C7CC",
      syntax: {
        keyword: "#0A49A5",
        string: "#C41A16",
        number: "#6C36A9",
        comment: "#007400",
        operator: "#000000",
        function: "#326D74",
        type: "#3F6E74",
      },
    },
    dataGrid: {
      background: "#FFFFFF",
      text: "#000000",
      alternateRow: "#F5F5F5",
      nullValue: "#8E8E93",
      boolTrue: "#248A3D",
      boolFalse: "#D70015",
      rowNumber: "#8E8E93",
      modified: "rgba(255, 214, 10, 0.30)",
      inserted: "rgba(52, 199, 89, 0.30)",
      deleted: "rgba(255, 59, 48, 0.30)",
      deletedText: "#8E8E93",
      focusBorder: "#007AFF",
    },
    sidebar: {
      background: "#FFFFFF",
      text: "#8E8E93",
      selectedItem: "#007AFF",
      hover: "#F0F0F2",
      sectionHeader: "#8E8E93",
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
    tiny: 10,
    caption: 12,
    small: 12,
    medium: 13,
    body: 14,
    title3: 16,
    title2: 24,
  },
  fonts: {
    editorFontFamily:
      "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
    editorFontSize: 13,
    dataGridFontFamily:
      "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
    dataGridFontSize: 13,
  },
  animations: {
    fast: 0.1,
    normal: 0.2,
    smooth: 0.3,
    slow: 0.5,
  },
};

export const BUILT_IN_THEMES: ThemeDefinition[] = [
  MINIMAX_THEME,
  DEFAULT_DARK_THEME,
  MIDNIGHT_BLUE_THEME,
  GRAPHITE_THEME,
  FOREST_THEME,
  DEFAULT_LIGHT_THEME,
];
