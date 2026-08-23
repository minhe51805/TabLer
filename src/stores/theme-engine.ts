/**
 * ThemeEngine — Singleton store for theming.
 * Centralizes TableR theme state and token application.
 *
 * Features:
 * - Centralized theme definition (editor, datagrid, ui, sidebar, toolbar, spacing, typography)
 * - Resolved colors (hex → CSS variables) for components to consume
 * - Dark/light theme switching via CSS custom properties
 * - Monaco editor theme registration
 * - Accessibility font scale support
 */

import { useCallback, useEffect, useState } from "react";
import {
  BUILT_IN_THEMES,
  DEFAULT_LIGHT_THEME,
  MINIMAX_THEME,
  type ThemeAppearance,
  type ThemeDefinition,
} from "./theme-presets";

export * from "./theme-presets";
export { registerMonacoTheme } from "./theme-monaco";

// ---------------------------------------------------------------------------
// Theme Engine (singleton logic — not React yet, pure functions)
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = "tabler.activeTheme";
const THEMES_STORAGE_KEY = "tabler.themes";
const BUILT_IN_THEME_IDS = new Set(BUILT_IN_THEMES.map((theme) => theme.id));

// Option A: these legacy dark presets are retired in favour of the single
// MiniMax look. Any persisted active theme pointing at one of them is migrated
// to MiniMax on load so existing users land on the new global design.
const RETIRED_THEME_IDS = new Set<string>([
  "tabler.dark",
  "tabler.midnight",
  "tabler.graphite",
  "tabler.forest",
  "tabler.light",
]);

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
    case "tabler.minimax":
      return {
        buttonRadius: "8px",
        cardRadius: "8px",
        panelRadius: "8px",
      };
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
  default: MINIMAX_THEME,
  light: DEFAULT_LIGHT_THEME,
  minimax: MINIMAX_THEME,

  getAvailableThemes(): ThemeDefinition[] {
    // Option A: MiniMax is the single, global look. Only MiniMax (plus any
    // user-created themes) is offered in the theme menu; the legacy dark
    // presets are retired.
    return [MINIMAX_THEME, ...loadStoredUserThemes()];
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
    return "light";
  },

  applyAppearance(appearance: ThemeAppearance): void {
    const resolved = appearance === "auto" ? "light" : appearance;
    const root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    root.style.colorScheme = resolved;
  },

  loadActive(): ThemeDefinition {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<ThemeDefinition>;
        // Option A: the legacy dark presets are retired. If a previously
        // persisted theme points at one of them (or the old default), migrate
        // it to MiniMax so existing users land on the single global look.
        if (parsed.id && RETIRED_THEME_IDS.has(parsed.id)) {
          return MINIMAX_THEME;
        }
        if (parsed.id) {
          const matchedTheme = getAllThemes().find((theme) => theme.id === parsed.id);
          if (matchedTheme) {
            return matchedTheme;
          }
        }
        if (parsed.id && parsed.colors) {
          return { ...MINIMAX_THEME, ...parsed };
        }
      }
    } catch {
      // ignore
    }
    return MINIMAX_THEME;
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
  // applyAppearance already resolves "auto" → "light" (Option A is light-only).
  ThemeEngine.applyAppearance(theme.appearance);
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

  // MiniMax-style elevation tokens (consumed by minimax-design-system.css)
  if (theme.id === "tabler.minimax") {
    root.style.setProperty(
      "--mmx-shadow-flat",
      "none",
    );
    root.style.setProperty(
      "--mmx-shadow-raised",
      "rgb(255, 255, 255) 0px 0px 0px 0px, rgba(159, 159, 159, 0.30) 0px 0px 0px 1px, rgba(0, 0, 0, 0.05) 0px 1px 2px 0px",
    );
    root.style.setProperty(
      "--mmx-shadow-elevated",
      "rgb(255, 255, 255) 0px 0px 0px 0px, rgba(159, 159, 159, 0.30) 0px 0px 0px 1px, rgba(0, 0, 0, 0.08) 0px 4px 6px 0px",
    );
    root.style.setProperty(
      "--mmx-shadow-floating",
      "rgb(255, 255, 255) 0px 0px 0px 0px, rgba(159, 159, 159, 0.30) 0px 0px 0px 1px, rgba(0, 0, 0, 0.12) 0px 8px 16px 0px",
    );
    root.style.setProperty(
      "--mmx-focus-ring",
      "rgba(0, 0, 0, 0.05) 0px 0px 0px 3px",
    );
    root.style.setProperty("--mmx-font-sans", "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif");
    root.style.setProperty("--mmx-font-mono", "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace");
  }
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
