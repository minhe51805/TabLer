import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Command as LucideCommand, X } from "lucide-react";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";
import { buildCommandRegistry, filterCommands } from "./commands-registry";
import type { Command, CommandCategory } from "../../stores/commandPaletteStore";

const CATEGORY_ORDER: CommandCategory[] = [
  "File",
  "Edit",
  "View",
  "Query",
  "Database",
  "AI",
  "Tools",
  "Navigation",
  "Help",
];

const CATEGORY_ICONS: Record<CommandCategory, string> = {
  File: "F",
  Edit: "E",
  View: "V",
  Query: "Q",
  Database: "D",
  AI: "A",
  Tools: "T",
  Navigation: "N",
  Help: "H",
};

interface CommandPaletteProps {
  onToggleSidebar?: () => void;
  onToggleTerminal?: () => void;
  onOpenAI?: () => void;
  onRunQuery?: () => void;
  onFormatSQL?: () => void;
  onFocusSQL?: () => void;
  onFocusResults?: () => void;
  onToggleQueryHistory?: () => void;
  onToggleSQLFavorites?: () => void;
  onOpenKeyboardShortcuts?: () => void;
  onOpenPluginManager?: () => void;
  onOpenSettings?: () => void;
  onOpenAbout?: () => void;
  onOpenSQLFile?: () => void;
  onImportSQLFile?: () => void;
  onClearAIHistory?: () => void;
  onToggleAISlidePanel?: (open: boolean) => void;
  uiFontScale?: number;
  onSetFontScale?: (scale: number) => void;
}

export function CommandPalette(props: CommandPaletteProps) {
  const {
    onToggleSidebar,
    onToggleTerminal,
    onRunQuery,
    onFormatSQL,
    onFocusSQL,
    onFocusResults,
    onToggleQueryHistory,
    onToggleSQLFavorites,
    onOpenKeyboardShortcuts,
    onOpenPluginManager,
    onOpenSettings,
    onOpenAbout,
    onOpenSQLFile,
    onImportSQLFile,
    onClearAIHistory,
    onToggleAISlidePanel,
  } = props;

  const { isOpen, searchQuery, recentCommandIds, allCommands, close, setSearchQuery, addRecentCommand, registerCommands } =
    useCommandPaletteStore();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Register commands once on mount
  useEffect(() => {
    const ctx = {
      addRecentCommand,
      close,
    };
    const commands = buildCommandRegistry(ctx);
    registerCommands(commands);
  }, [addRecentCommand, close, registerCommands]);

  // Wire up event listeners for CustomEvents dispatched by commands
  useEffect(() => {
    const handlers: Array<[string, () => void]> = [
      ["toggle-sidebar-palette", () => { onToggleSidebar?.(); close(); }],
      ["toggle-terminal-panel-palette", () => { onToggleTerminal?.(); close(); }],
      ["execute-query-palette", () => { onRunQuery?.(); close(); }],
      ["format-sql-palette", () => { onFormatSQL?.(); close(); }],
      ["focus-sql-editor-palette", () => { onFocusSQL?.(); close(); }],
      ["focus-results-palette", () => { onFocusResults?.(); close(); }],
      ["toggle-query-history-palette", () => { onToggleQueryHistory?.(); close(); }],
      ["toggle-sql-favorites-palette", () => { onToggleSQLFavorites?.(); close(); }],
      ["open-keyboard-shortcuts-palette", () => { onOpenKeyboardShortcuts?.(); close(); }],
      ["open-plugin-manager-palette", () => { onOpenPluginManager?.(); close(); }],
      ["open-settings-palette", () => { onOpenSettings?.(); close(); }],
      ["open-about-palette", () => { onOpenAbout?.(); close(); }],
      ["open-sql-file-palette", () => { onOpenSQLFile?.(); close(); }],
      ["import-sql-file-palette", () => { onImportSQLFile?.(); close(); }],
      ["clear-ai-history-palette", () => { onClearAIHistory?.(); close(); }],
      ["toggle-ai-panel-palette", () => { onToggleAISlidePanel?.(true); close(); }],
    ];

    const offs = handlers.map(([event, handler]) => {
      const cb = () => handler();
      window.addEventListener(event, cb);
      return () => window.removeEventListener(event, cb);
    });

    return () => offs.forEach((off) => off());
  }, [
    close, onClearAIHistory, onFocusResults, onFocusSQL, onFormatSQL, onImportSQLFile,
    onOpenAbout, onOpenKeyboardShortcuts, onOpenPluginManager, onOpenSettings,
    onOpenSQLFile, onRunQuery, onToggleAISlidePanel, onToggleQueryHistory,
    onToggleSidebar, onToggleSQLFavorites, onToggleTerminal,
  ]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen, setSearchQuery]);

  // Reset selection when search query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  const filteredCommands = useMemo(
    () => filterCommands(allCommands, searchQuery, recentCommandIds),
    [allCommands, searchQuery, recentCommandIds],
  );

  const groupedCommands = useMemo(() => {
    const groups: Array<{ category: CommandCategory; commands: Command[] }> = [];
    const seen = new Set<CommandCategory>();
    for (const cmd of filteredCommands) {
      if (!seen.has(cmd.category)) {
        seen.add(cmd.category);
        groups.push({ category: cmd.category, commands: [] });
      }
      const group = groups.find((g) => g.category === cmd.category)!;
      group.commands.push(cmd);
    }
    // Sort groups by category order
    groups.sort((a, b) => {
      return CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    });
    return groups;
  }, [filteredCommands]);

  const flatFiltered = filteredCommands;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatFiltered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = flatFiltered[selectedIndex];
        if (cmd) {
          cmd.action();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    },
    [close, flatFiltered, selectedIndex],
  );

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  let globalIndex = 0;

  return (
    <div
      className="command-palette-backdrop"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
    >
      <div
        className="command-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="command-palette-search">
          <LucideCommand className="command-palette-search-icon" size={16} />
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="Type a command or search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="command-palette-close-btn"
            onClick={close}
            aria-label="Close command palette"
          >
            <X size={14} />
          </button>
        </div>

        {/* Command list */}
        <div className="command-palette-list" ref={listRef} role="listbox">
          {filteredCommands.length === 0 ? (
            <div className="command-palette-empty">
              No commands found
            </div>
          ) : (
            groupedCommands.map((group) => (
              <div key={group.category} className="command-palette-group">
                <div className="command-palette-group-header">
                  <span
                    className="command-palette-group-icon"
                    style={{ background: getCategoryColor(group.category) }}
                  >
                    {CATEGORY_ICONS[group.category]}
                  </span>
                  <span className="command-palette-group-label">{group.category}</span>
                </div>
                {group.commands.map((cmd) => {
                  const idx = globalIndex++;
                  const isSelected = idx === selectedIndex;
                  return (
                    <div
                      key={cmd.id}
                      data-index={idx}
                      className={`command-palette-item ${isSelected ? "selected" : ""}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => cmd.action()}
                      onMouseEnter={() => setSelectedIndex(idx)}
                    >
                      <span className="command-palette-item-label">{cmd.label}</span>
                      {cmd.shortcut && (
                        <kbd className="command-palette-item-shortcut">{cmd.shortcut}</kbd>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="command-palette-footer">
          <span>
            <kbd>↑↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Execute
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  );
}

function getCategoryColor(category: CommandCategory): string {
  const colors: Record<CommandCategory, string> = {
    File: "#6366F1",
    Edit: "#22D3EE",
    View: "#A78BFA",
    Query: "#00D4AA",
    Database: "#F97316",
    AI: "#EC4899",
    Tools: "#A3E635",
    Navigation: "#7FE0C2",
    Help: "#65789A",
  };
  return colors[category] || "#65789A";
}
