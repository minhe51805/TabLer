/**
 * App types — shared interfaces and constants for App.tsx coordinator.
 * Exported types are re-imported by AppTitleBar and other components.
 */

export interface QueryChromeState {
  isRunning: boolean;
  executionTimeMs?: number;
  rowCount?: number;
  affectedRows?: number;
  queryCount?: number;
}

export interface WorkspaceActivityState {
  label: string;
  durationMs: number;
  at: number;
}

export interface GlobalToastState {
  id: number;
  tone: "success" | "info" | "error";
  title: string;
  description?: string;
  isClosing: boolean;
}

// ─── Window menu types (shared with AppTitleBar) ───────────────────────────

export type WindowMenuSectionKey =
  | "file"
  | "edit"
  | "view"
  | "tools"
  | "connection"
  | "plugins"
  | "navigate"
  | "language"
  | "help";

export interface WindowMenuItem {
  key?: string;
  label?: string;
  action?: () => void;
  disabled?: boolean;
  divider?: boolean;
  selected?: boolean;
  shortcut?: string;
  children?: WindowMenuItem[];
  controlType?: "font-scale-slider";
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange?: (next: number) => void;
  onDecrease?: () => void;
  onIncrease?: () => void;
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const GLOBAL_ERROR_AUTO_DISMISS_MS = 8000;
export const GLOBAL_TOAST_AUTO_DISMISS_MS = 4200;
export const GLOBAL_TOAST_EXIT_MS = 220;
export const RECOVERABLE_CONNECTION_ERROR_DELAY_MS = 3000;
export const UI_FONT_SCALE_STORAGE_KEY = "tabler.uiFontScale";
export const DEFAULT_WINDOW_MENU_SECTION: WindowMenuSectionKey = "file";
export const RECOVERABLE_CONNECTION_ERROR_PATTERNS = [/please connect first/i];
