import type { Command } from "../../stores/commandPaletteStore";
import { useAppStore } from "../../stores/appStore";
import { useEditorPreferencesStore } from "../../stores/editorPreferencesStore";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";
import { UI_FONT_SCALE_MAX, UI_FONT_SCALE_MIN, UI_FONT_SCALE_STEP } from "../../utils/ui-scale";

// Type for command action context that handlers can use
interface CommandContext {
  addRecentCommand: (id: string) => void;
  close: () => void;
}

/** Fuzzy-match helper: returns true if `pattern` is a subsequence of `text` (case-insensitive). */
function fuzzyMatch(pattern: string, text: string): boolean {
  if (!pattern) return true;
  const lower = text.toLowerCase();
  const pat = pattern.toLowerCase();
  let pi = 0;
  for (let i = 0; i < lower.length && pi < pat.length; i++) {
    if (lower[i] === pat[pi]) pi++;
  }
  return pi === pat.length;
}

export { fuzzyMatch };

function makeAction(id: string, action: () => void, ctx: CommandContext): () => void {
  return () => {
    ctx.addRecentCommand(id);
    ctx.close();
    action();
  };
}

/**
 * Build the full command registry. Each command wraps its action so that
 * executing it also records it in recent commands and closes the palette.
 */
export function buildCommandRegistry(ctx: CommandContext): Command[] {
  const appStore = useAppStore.getState();
  const editorPrefs = useEditorPreferencesStore.getState();

  const uiFontScale = () => {
    const stored = Number(window.localStorage.getItem("tabler.uiFontScale") ?? "100");
    return Number.isFinite(stored) ? stored : 100;
  };

  const setFontScale = (delta: number) => {
    const current = uiFontScale();
    const next = Math.min(UI_FONT_SCALE_MAX, Math.max(UI_FONT_SCALE_MIN, current + delta));
    window.localStorage.setItem("tabler.uiFontScale", String(next));
    document.documentElement.style.fontSize = `${next}%`;
    window.dispatchEvent(new CustomEvent("font-scale-changed", { detail: { scale: next } }));
  };

  return [
    // ── File ──────────────────────────────────────────────────────────────────
    {
      id: "file.new-query",
      label: "New Query",
      shortcut: "Ctrl+N",
      category: "File",
      action: makeAction("file.new-query", () => {
        const { activeConnectionId } = useAppStore.getState();
        if (!activeConnectionId) return;
        const tabs = useAppStore.getState().tabs;
        const queryCount = tabs.filter((t) => t.type === "query").length;
        useAppStore.getState().addTab({
          id: `query-${crypto.randomUUID()}`,
          type: "query",
          title: `Query ${queryCount + 1}`,
          connectionId: activeConnectionId,
        });
      }, ctx),
    },
    {
      id: "file.open-sql-file",
      label: "Open SQL File",
      shortcut: "Ctrl+O",
      category: "File",
      action: makeAction("file.open-sql-file", () => {
        window.dispatchEvent(new CustomEvent("open-sql-file-palette"));
      }, ctx),
    },
    {
      id: "file.import-sql-file",
      label: "Import SQL File",
      category: "File",
      action: makeAction("file.import-sql-file", () => {
        window.dispatchEvent(new CustomEvent("import-sql-file-palette"));
      }, ctx),
    },
    {
      id: "file.close-tab",
      label: "Close Tab",
      shortcut: "Ctrl+W",
      category: "File",
      action: makeAction("file.close-tab", () => {
        const { activeTabId, removeTab } = useAppStore.getState();
        if (activeTabId) removeTab(activeTabId);
      }, ctx),
    },
    {
      id: "file.close-all-tabs",
      label: "Close All Tabs",
      category: "File",
      action: makeAction("file.close-all-tabs", () => {
        useAppStore.getState().clearTabs();
      }, ctx),
    },

    // ── View ───────────────────────────────────────────────────────────────────
    {
      id: "view.toggle-sidebar",
      label: "Toggle Sidebar",
      shortcut: "Ctrl+B",
      category: "View",
      action: makeAction("view.toggle-sidebar", () => {
        window.dispatchEvent(new CustomEvent("toggle-sidebar-palette"));
      }, ctx),
    },
    {
      id: "view.toggle-results-pane",
      label: "Toggle Results Pane",
      shortcut: "Ctrl+Shift+`",
      category: "View",
      action: makeAction("view.toggle-results-pane", () => {
        const { activeTabId } = useAppStore.getState();
        if (activeTabId) {
          window.dispatchEvent(new CustomEvent("toggle-query-results-pane", { detail: { tabId: activeTabId } }));
        }
      }, ctx),
    },
    {
      id: "view.toggle-ai-panel",
      label: "Toggle AI Panel",
      shortcut: "Ctrl+P",
      category: "View",
      action: makeAction("view.toggle-ai-panel", () => {
        window.dispatchEvent(new CustomEvent("toggle-ai-panel-palette"));
      }, ctx),
    },
    {
      id: "view.increase-font",
      label: "Increase Font Size",
      shortcut: "Ctrl+=",
      category: "View",
      action: makeAction("view.increase-font", () => setFontScale(UI_FONT_SCALE_STEP), ctx),
    },
    {
      id: "view.decrease-font",
      label: "Decrease Font Size",
      shortcut: "Ctrl+-",
      category: "View",
      action: makeAction("view.decrease-font", () => setFontScale(-UI_FONT_SCALE_STEP), ctx),
    },
    {
      id: "view.reset-font",
      label: "Reset Font Size",
      shortcut: "Ctrl+0",
      category: "View",
      action: makeAction("view.reset-font", () => {
        window.localStorage.setItem("tabler.uiFontScale", "100");
        document.documentElement.style.fontSize = "100%";
        window.dispatchEvent(new CustomEvent("font-scale-changed", { detail: { scale: 100 } }));
      }, ctx),
    },
    {
      id: "view.toggle-vim-mode",
      label: "Toggle Vim Mode",
      shortcut: "Ctrl+Shift+V",
      category: "View",
      action: makeAction("view.toggle-vim-mode", () => {
        editorPrefs.toggleVimMode();
      }, ctx),
    },
    {
      id: "view.toggle-terminal",
      label: "Toggle Terminal Panel",
      shortcut: "Ctrl+`",
      category: "View",
      action: makeAction("view.toggle-terminal", () => {
        window.dispatchEvent(new CustomEvent("toggle-terminal-panel-palette"));
      }, ctx),
    },

    // ── Query ──────────────────────────────────────────────────────────────────
    {
      id: "query.execute",
      label: "Execute Query",
      shortcut: "Ctrl+Enter",
      category: "Query",
      action: makeAction("query.execute", () => {
        window.dispatchEvent(new CustomEvent("execute-query-palette"));
      }, ctx),
    },
    {
      id: "query.format",
      label: "Format SQL",
      shortcut: "Ctrl+Shift+I",
      category: "Query",
      action: makeAction("query.format", () => {
        window.dispatchEvent(new CustomEvent("format-sql-palette"));
      }, ctx),
    },
    {
      id: "query.new-tab",
      label: "New Query Tab",
      shortcut: "Ctrl+N",
      category: "Query",
      action: makeAction("query.new-tab", () => {
        const { activeConnectionId } = useAppStore.getState();
        if (!activeConnectionId) return;
        const tabs = useAppStore.getState().tabs;
        const queryCount = tabs.filter((t) => t.type === "query").length;
        useAppStore.getState().addTab({
          id: `query-${crypto.randomUUID()}`,
          type: "query",
          title: `Query ${queryCount + 1}`,
          connectionId: activeConnectionId,
        });
      }, ctx),
    },
    {
      id: "query.duplicate-tab",
      label: "Duplicate Tab",
      category: "Query",
      action: makeAction("query.duplicate-tab", () => {
        const { activeTabId, tabs, addTab } = useAppStore.getState();
        if (!activeTabId) return;
        const src = tabs.find((t) => t.id === activeTabId);
        if (!src) return;
        addTab({
          id: `query-${crypto.randomUUID()}`,
          type: src.type,
          title: `${src.title} (Copy)`,
          connectionId: src.connectionId,
          database: src.database,
          content: src.content,
        });
      }, ctx),
    },
    {
      id: "query.close-tab",
      label: "Close Query Tab",
      shortcut: "Ctrl+W",
      category: "Query",
      action: makeAction("query.close-tab", () => {
        const { activeTabId, removeTab } = useAppStore.getState();
        if (activeTabId) removeTab(activeTabId);
      }, ctx),
    },

    // ── Database ───────────────────────────────────────────────────────────────
    {
      id: "database.new-connection",
      label: "New Connection",
      category: "Database",
      action: makeAction("database.new-connection", () => {
        window.dispatchEvent(new CustomEvent("open-connection-form-palette", { detail: { intent: "connect" } }));
      }, ctx),
    },
    {
      id: "database.connect",
      label: "Connect to Database",
      category: "Database",
      action: makeAction("database.connect", () => {
        window.dispatchEvent(new CustomEvent("open-connection-form-palette", { detail: { intent: "connect" } }));
      }, ctx),
    },
    {
      id: "database.disconnect",
      label: "Disconnect",
      category: "Database",
      action: makeAction("database.disconnect", () => {
        const { activeConnectionId } = useAppStore.getState();
        if (activeConnectionId) {
          void useAppStore.getState().disconnectFromDatabase(activeConnectionId);
        }
      }, ctx),
    },
    {
      id: "database.refresh-explorer",
      label: "Refresh Explorer",
      shortcut: "Ctrl+R",
      category: "Database",
      action: makeAction("database.refresh-explorer", () => {
        const { activeConnectionId, currentDatabase } = useAppStore.getState();
        if (!activeConnectionId) return;
        void useAppStore.getState().fetchDatabases(activeConnectionId);
        if (currentDatabase) {
          void useAppStore.getState().fetchTables(activeConnectionId, currentDatabase);
          void useAppStore.getState().fetchSchemaObjects(activeConnectionId, currentDatabase);
        }
      }, ctx),
    },
    {
      id: "database.refresh-tables",
      label: "Refresh Tables",
      category: "Database",
      action: makeAction("database.refresh-tables", () => {
        const { activeConnectionId, currentDatabase } = useAppStore.getState();
        if (!activeConnectionId || !currentDatabase) return;
        void useAppStore.getState().fetchTables(activeConnectionId, currentDatabase);
      }, ctx),
    },

    // ── AI ─────────────────────────────────────────────────────────────────────
    {
      id: "ai.open-panel",
      label: "Open AI Panel",
      shortcut: "Ctrl+P",
      category: "AI",
      action: makeAction("ai.open-panel", () => {
        window.dispatchEvent(new CustomEvent("open-ai-slide-panel", {}));
      }, ctx),
    },
    {
      id: "ai.ask",
      label: "Ask AI",
      category: "AI",
      action: makeAction("ai.ask", () => {
        window.dispatchEvent(new CustomEvent("open-ai-slide-panel", {}));
      }, ctx),
    },
    {
      id: "ai.clear-history",
      label: "Clear AI History",
      category: "AI",
      action: makeAction("ai.clear-history", () => {
        window.dispatchEvent(new CustomEvent("clear-ai-history-palette"));
      }, ctx),
    },

    // ── Tools ──────────────────────────────────────────────────────────────────
    {
      id: "tools.keyboard-shortcuts",
      label: "Keyboard Shortcuts",
      category: "Tools",
      action: makeAction("tools.keyboard-shortcuts", () => {
        window.dispatchEvent(new CustomEvent("open-keyboard-shortcuts-palette"));
      }, ctx),
    },
    {
      id: "tools.plugin-manager",
      label: "Plugin Manager",
      category: "Tools",
      action: makeAction("tools.plugin-manager", () => {
        window.dispatchEvent(new CustomEvent("open-plugin-manager-palette"));
      }, ctx),
    },
    {
      id: "tools.settings",
      label: "Settings",
      category: "Tools",
      action: makeAction("tools.settings", () => {
        window.dispatchEvent(new CustomEvent("open-settings-palette"));
      }, ctx),
    },
    {
      id: "tools.query-history",
      label: "Query History",
      shortcut: "Ctrl+H",
      category: "Tools",
      action: makeAction("tools.query-history", () => {
        window.dispatchEvent(new CustomEvent("toggle-query-history-palette"));
      }, ctx),
    },
    {
      id: "tools.sql-favorites",
      label: "SQL Favorites",
      shortcut: "Ctrl+Shift+S",
      category: "Tools",
      action: makeAction("tools.sql-favorites", () => {
        window.dispatchEvent(new CustomEvent("toggle-sql-favorites-palette"));
      }, ctx),
    },

    // ── Navigation ─────────────────────────────────────────────────────────────
    {
      id: "nav.focus-explorer",
      label: "Focus Explorer",
      category: "Navigation",
      action: makeAction("nav.focus-explorer", () => {
        window.dispatchEvent(new CustomEvent("focus-explorer-search"));
      }, ctx),
    },
    {
      id: "nav.focus-sql-editor",
      label: "Focus SQL Editor",
      category: "Navigation",
      action: makeAction("nav.focus-sql-editor", () => {
        window.dispatchEvent(new CustomEvent("focus-sql-editor-palette"));
      }, ctx),
    },
    {
      id: "nav.focus-results",
      label: "Focus Results",
      category: "Navigation",
      action: makeAction("nav.focus-results", () => {
        window.dispatchEvent(new CustomEvent("focus-results-palette"));
      }, ctx),
    },
    {
      id: "nav.next-tab",
      label: "Next Tab",
      shortcut: "Ctrl+Tab",
      category: "Navigation",
      action: makeAction("nav.next-tab", () => {
        const { tabs, activeTabId } = useAppStore.getState();
        const visible = tabs.filter((t) => t.type !== "metrics");
        const idx = visible.findIndex((t) => t.id === activeTabId);
        const next = visible[(idx + 1) % visible.length];
        if (next) useAppStore.getState().setActiveTab(next.id);
      }, ctx),
    },
    {
      id: "nav.prev-tab",
      label: "Previous Tab",
      shortcut: "Ctrl+Shift+Tab",
      category: "Navigation",
      action: makeAction("nav.prev-tab", () => {
        const { tabs, activeTabId } = useAppStore.getState();
        const visible = tabs.filter((t) => t.type !== "metrics");
        const idx = visible.findIndex((t) => t.id === activeTabId);
        const prev = visible[(idx - 1 + visible.length) % visible.length];
        if (prev) useAppStore.getState().setActiveTab(prev.id);
      }, ctx),
    },

    // ── Help ───────────────────────────────────────────────────────────────────
    {
      id: "help.keyboard-shortcuts",
      label: "Keyboard Shortcuts",
      category: "Help",
      action: makeAction("help.keyboard-shortcuts", () => {
        window.dispatchEvent(new CustomEvent("open-keyboard-shortcuts-palette"));
      }, ctx),
    },
    {
      id: "help.about",
      label: "About",
      category: "Help",
      action: makeAction("help.about", () => {
        window.dispatchEvent(new CustomEvent("open-about-palette"));
      }, ctx),
    },
    {
      id: "help.documentation",
      label: "Documentation",
      category: "Help",
      action: makeAction("help.documentation", () => {
        window.open("https://github.com/minhe51805/TableR", "_blank");
      }, ctx),
    },
  ];
}

/** Filter and sort commands by fuzzy match and recency. */
export function filterCommands(
  commands: Command[],
  query: string,
  recentIds: string[],
): Command[] {
  const matched = commands.filter(
    (cmd) =>
      fuzzyMatch(query, cmd.label) ||
      fuzzyMatch(query, cmd.category) ||
      fuzzyMatch(query, cmd.shortcut ?? ""),
  );

  return matched.sort((a, b) => {
    // Recent commands first
    const aRecent = recentIds.indexOf(a.id);
    const bRecent = recentIds.indexOf(b.id);
    if (aRecent !== -1 && bRecent === -1) return -1;
    if (aRecent === -1 && bRecent !== -1) return 1;
    if (aRecent !== -1 && bRecent !== -1 && aRecent < bRecent) return -1;

    // Then by fuzzy score (shorter label is better match)
    const score = (cmd: Command) => {
      const ql = cmd.label.toLowerCase();
      const q = query.toLowerCase();
      // Exact prefix match scores highest
      if (ql.startsWith(q)) return 0;
      if (ql.includes(q)) return 1;
      return 2;
    };
    return score(a) - score(b);
  });
}
