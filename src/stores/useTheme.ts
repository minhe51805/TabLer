/**
 * useTheme — React hook for theme access.
 * Re-exports from theme-engine with convenience helpers.
 */

export {
  useTheme,
  ThemeEngine,
  registerMonacoTheme,
} from "./theme-engine";
export type {
  ThemeDefinition,
  ThemeAppearance,
  ThemeColors,
  EditorColors,
  DataGridColors,
  UIColors,
  SidebarColors,
  SyntaxColors,
  StatusColors,
  BadgeColors,
  ThemeSpacing,
  ThemeTypography,
  ThemeFonts,
  ThemeAnimations,
} from "./theme-engine";
