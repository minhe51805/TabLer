/**
 * Keyboard Shortcuts Store — rebindable shortcuts with conflict detection.
 * Shortcuts are persisted in localStorage.
 */

export type ShortcutAction =
  | "new-query"
  | "toggle-sidebar"
  | "toggle-ai-panel"
  | "toggle-terminal"
  | "run-query"
  | "font-increase"
  | "font-decrease"
  | "font-reset"
  | "toggle-results"
  | "toggle-right-sidebar"
  | "open-sql-file"
  | "open-sql-favorites"
  | "open-query-history"
  | "open-keyboard-shortcuts"
  | "open-database-file"
  | "font-scale"
  | "focus-editor"
  | "focus-sidebar"
  | "copy"
  | "paste"
  | "undo"
  | "redo"
  | "duplicate-row";

export interface ShortcutBinding {
  action: ShortcutAction;
  label: string;
  defaultKey: string;  // e.g. "Ctrl+N"
  currentKey: string;
  category: "general" | "navigation" | "query" | "editing";
}

const STORAGE_KEY = "tabler.keyboard-shortcuts";

export interface ShortcutMap {
  [action: string]: string;
}

function loadShortcuts(): ShortcutMap {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // ignore
  }
  return {};
}

function saveShortcuts(shortcuts: ShortcutMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
  } catch {
    // ignore
  }
}

const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { action: "new-query", label: "New query", defaultKey: "Ctrl+N", currentKey: "Ctrl+N", category: "query" },
  { action: "toggle-sidebar", label: "Toggle sidebar", defaultKey: "Ctrl+B", currentKey: "Ctrl+B", category: "navigation" },
  { action: "toggle-ai-panel", label: "Toggle AI panel", defaultKey: "Ctrl+P", currentKey: "Ctrl+P", category: "navigation" },
  { action: "toggle-terminal", label: "Toggle terminal", defaultKey: "Ctrl+`", currentKey: "Ctrl+`", category: "navigation" },
  { action: "run-query", label: "Run query", defaultKey: "Ctrl+Enter", currentKey: "Ctrl+Enter", category: "query" },
  { action: "font-increase", label: "Increase font size", defaultKey: "Ctrl++", currentKey: "Ctrl++", category: "general" },
  { action: "font-decrease", label: "Decrease font size", defaultKey: "Ctrl+-", currentKey: "Ctrl+-", category: "general" },
  { action: "font-reset", label: "Reset font size", defaultKey: "Ctrl+0", currentKey: "Ctrl+0", category: "general" },
  { action: "toggle-results", label: "Toggle results panel", defaultKey: "Ctrl+Shift+`", currentKey: "Ctrl+Shift+`", category: "general" },
  { action: "toggle-right-sidebar", label: "Toggle right sidebar", defaultKey: "Ctrl+Space", currentKey: "Ctrl+Space", category: "navigation" },
  { action: "open-sql-file", label: "Open SQL file", defaultKey: "Ctrl+O", currentKey: "Ctrl+O", category: "query" },
  { action: "open-sql-favorites", label: "SQL Favorites", defaultKey: "Ctrl+Shift+S", currentKey: "Ctrl+Shift+S", category: "query" },
  { action: "open-query-history", label: "Query History", defaultKey: "Ctrl+H", currentKey: "Ctrl+H", category: "query" },
  { action: "open-keyboard-shortcuts", label: "Keyboard Shortcuts", defaultKey: "Ctrl+Shift+/", currentKey: "Ctrl+Shift+/", category: "general" },
  { action: "open-database-file", label: "Open Database File", defaultKey: "Ctrl+Shift+O", currentKey: "Ctrl+Shift+O", category: "query" },
  { action: "duplicate-row", label: "Duplicate row", defaultKey: "Ctrl+D", currentKey: "Ctrl+D", category: "editing" },
];

// Singleton state
let cachedShortcuts: ShortcutBinding[] | null = null;
let cachedMap: Map<string, ShortcutAction> | null = null;

function buildMap(shortcuts: ShortcutBinding[]): Map<string, ShortcutAction> {
  const map = new Map<string, ShortcutAction>();
  for (const s of shortcuts) {
    if (s.currentKey) {
      map.set(normalizeKey(s.currentKey), s.action);
    }
  }
  return map;
}

function normalizeKey(key: string): string {
  return key
    .replace(/\s+/g, "")
    .replace(/Control/gi, "Ctrl")
    .replace(/Command/gi, "Cmd")
    .replace(/Option/gi, "Alt")
    .toUpperCase();
}

function loadAllShortcuts(): ShortcutBinding[] {
  if (cachedShortcuts) return cachedShortcuts;

  const stored = loadShortcuts();
  cachedShortcuts = DEFAULT_SHORTCUTS.map((def) => ({
    ...def,
    currentKey: stored[def.action] ?? def.defaultKey,
  }));
  cachedMap = buildMap(cachedShortcuts);
  return cachedShortcuts;
}

export function getAllShortcuts(): ShortcutBinding[] {
  return loadAllShortcuts();
}

export function getShortcutMap(): Map<string, ShortcutAction> {
  if (!cachedMap) loadAllShortcuts();
  return cachedMap!;
}

export function resolveShortcut(key: string): ShortcutAction | undefined {
  const map = getShortcutMap();
  return map.get(normalizeKey(key));
}

export function rebindShortcut(
  action: ShortcutAction,
  newKey: string,
  skipConflictCheck?: ShortcutAction,
): {
  success: boolean;
  conflict?: { action: ShortcutAction; label: string };
} {
  const shortcuts = loadAllShortcuts();
  const normalized = normalizeKey(newKey);

  // Check for conflicts (skip the specified action — useful for override)
  for (const s of shortcuts) {
    if (s.action !== action && s.action !== skipConflictCheck && normalizeKey(s.currentKey) === normalized) {
      return { success: false, conflict: { action: s.action, label: s.label } };
    }
  }

  // Apply binding
  const shortcut = shortcuts.find((s) => s.action === action);
  if (!shortcut) return { success: false };

  shortcut.currentKey = newKey;
  cachedMap = buildMap(shortcuts);

  // Persist
  const map: ShortcutMap = {};
  for (const s of shortcuts) {
    if (s.currentKey !== s.defaultKey) {
      map[s.action] = s.currentKey;
    }
  }
  saveShortcuts(map);

  return { success: true };
}

export function resetShortcut(action: ShortcutAction): void {
  const shortcuts = loadAllShortcuts();
  const shortcut = shortcuts.find((s) => s.action === action);
  if (!shortcut) return;

  shortcut.currentKey = shortcut.defaultKey;
  cachedMap = buildMap(shortcuts);

  const map: ShortcutMap = {};
  for (const s of shortcuts) {
    if (s.currentKey !== s.defaultKey) {
      map[s.action] = s.currentKey;
    }
  }
  saveShortcuts(map);
}

export function resetAllShortcuts(): void {
  cachedShortcuts = null;
  cachedMap = null;
  localStorage.removeItem(STORAGE_KEY);
}
