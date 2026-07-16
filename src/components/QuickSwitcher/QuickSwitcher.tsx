/**
 * Quick Switcher — Cmd+P overlay for fast navigation across tabs, tables, saved queries, and connections.
 * Separate from Command Palette (Ctrl+Shift+P) which is for commands.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  Table2,
  Bookmark,
  Columns3,
  Database,
  FileSearch,
  History,
  X,
  Hash,
  Clock,
} from "lucide-react";
import { useQuickSwitcherStore, fuzzySearch, type SwitcherItem, type SwitcherItemKind } from "../../stores/quickSwitcherStore";
import { useUIStore } from "../../stores/uiStore";
import { useSqlFavoritesStore } from "../../stores/sql-favorites-store";
import { useConnectionStore } from "../../stores/connectionStore";
import { useQueryStore } from "../../stores/queryStore";
import { useQueryHistoryStore } from "../../stores/queryHistoryStore";
import type { ColumnDetail } from "../../types";
import "../../styles/lazy-overlays.css";

const ITEM_ICONS: Record<SwitcherItemKind, React.ReactNode> = {
  tab: <FileText size={14} />,
  table: <Table2 size={14} />,
  column: <Columns3 size={14} />,
  "schema-object": <FileSearch size={14} />,
  "saved-query": <Bookmark size={14} />,
  history: <History size={14} />,
  connection: <Database size={14} />,
};

const KIND_LABELS: Record<SwitcherItemKind, string> = {
  tab: "Tab",
  table: "Table",
  column: "Column",
  "schema-object": "Schema object",
  "saved-query": "Saved Query",
  history: "History",
  connection: "Connection",
};

interface QuickSwitcherProps {
  /** Called when a saved-query item is selected — app should open it */
  onOpenSavedQuery?: (id: string) => void;
  /** Called when a connection item is selected — app should connect */
  onConnect?: (connectionId: string) => void;
}

export function QuickSwitcher(props: QuickSwitcherProps) {
  const {
    onOpenSavedQuery,
    onConnect,
  } = props;

  const {
    isOpen,
    searchQuery,
    recentItemIds,
    close,
    setSearchQuery,
    addRecentItem,
  } = useQuickSwitcherStore();

  const tabs = useUIStore((s) => s.tabs);
  const addTab = useUIStore((s) => s.addTab);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const favorites = useSqlFavoritesStore((s) => s.favorites);
  const loadFavorites = useSqlFavoritesStore((s) => s.loadFavorites);
  const { connections, activeConnectionId, currentDatabase, tables, schemaObjects } = useConnectionStore((s) => s);
  const getTableColumnsPreview = useQueryStore((s) => s.getTableColumnsPreview);
  const { entries: historyEntries, loadHistory } = useQueryHistoryStore((s) => s);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [columnItems, setColumnItems] = useState<SwitcherItem[]>([]);
  const columnScopeRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const shouldSearchColumns = isOpen && searchQuery.trim().length >= 2;

  useEffect(() => {
    if (!isOpen) return;
    if (favorites.length === 0) void loadFavorites();
    if (activeConnectionId && historyEntries.length === 0) void loadHistory(activeConnectionId);
  }, [activeConnectionId, favorites.length, historyEntries.length, isOpen, loadFavorites, loadHistory]);

  useEffect(() => {
    if (!shouldSearchColumns || !activeConnectionId) return;
    const scope = `${activeConnectionId}|${currentDatabase || ""}`;
    if (columnScopeRef.current === scope) return;
    let cancelled = false;
    columnScopeRef.current = scope;

    const loadColumns = async () => {
      const nextItems: SwitcherItem[] = [];
      const visibleTables = tables.slice(0, 160);
      for (let start = 0; start < visibleTables.length; start += 4) {
        const batch = visibleTables.slice(start, start + 4);
        const results = await Promise.allSettled(
          batch.map((table) => getTableColumnsPreview(activeConnectionId, table.name, currentDatabase || undefined)),
        );
        results.forEach((result, index) => {
          if (result.status !== "fulfilled") return;
          const table = batch[index];
          for (const column of result.value as ColumnDetail[]) {
            nextItems.push({
              id: `column:${table.name}:${column.name}`,
              kind: "column",
              label: column.name,
              description: `${table.name} - ${column.column_type || column.data_type}`,
              meta: table.schema,
              action: () => {
                addTab({
                  id: `structure-${activeConnectionId}-${currentDatabase || ""}-${table.name}`,
                  type: "structure",
                  title: `${table.name} structure`,
                  connectionId: activeConnectionId,
                  database: currentDatabase || undefined,
                  tableName: table.name,
                  structureFocusSection: "columns",
                  structureFocusColumn: column.name,
                  structureFocusToken: crypto.randomUUID(),
                });
                addRecentItem(`column:${table.name}:${column.name}`);
                close();
              },
            });
          }
        });
        if (cancelled) return;
      }
      if (!cancelled) setColumnItems(nextItems);
    };

    void loadColumns();
    return () => { cancelled = true; };
  }, [activeConnectionId, addRecentItem, addTab, close, currentDatabase, getTableColumnsPreview, shouldSearchColumns, tables]);

  useEffect(() => {
    const handleSchemaInvalidation = () => {
      columnScopeRef.current = null;
      setColumnItems([]);
    };
    window.addEventListener("schema-cache-invalidated", handleSchemaInvalidation);
    return () => window.removeEventListener("schema-cache-invalidated", handleSchemaInvalidation);
  }, []);

  // Build searchable items from current app state
  const allItems = useMemo<SwitcherItem[]>(() => {
    const items: SwitcherItem[] = [];

    // Open tabs
    for (const tab of tabs) {
      const title = tab.title || tab.type;
      items.push({
        id: `tab:${tab.id}`,
        kind: "tab",
        label: title,
        description: tab.type === "query" && tab.content?.trim()
          ? tab.content.replace(/\s+/g, " ").trim().slice(0, 80)
          : tab.tableName ? `Table: ${tab.tableName}` : tab.type,
        meta: tab.database,
        action: () => {
          setActiveTab(tab.id);
          addRecentItem(`tab:${tab.id}`);
          close();
        },
      });
    }

    if (activeConnectionId) {
      for (const table of tables) {
        items.push({
          id: `table:${table.name}`,
          kind: "table",
          label: table.name,
          description: table.table_type || "Table",
          meta: table.schema,
          action: () => {
            addTab({
              id: `table-${activeConnectionId}-${currentDatabase || ""}-${table.name}`,
              type: "table",
              title: table.name,
              connectionId: activeConnectionId,
              database: currentDatabase || undefined,
              tableName: table.name,
            });
            addRecentItem(`table:${table.name}`);
            close();
          },
        });
      }

      for (const object of schemaObjects) {
        items.push({
          id: `object:${object.object_type}:${object.name}`,
          kind: "schema-object",
          label: object.name,
          description: object.object_type,
          meta: object.schema,
          action: () => {
            addTab({
              id: `query-${crypto.randomUUID()}`,
              type: "query",
              title: object.name,
              connectionId: activeConnectionId,
              database: currentDatabase || undefined,
              content: object.definition || `-- ${object.object_type} ${object.name}`,
            });
            addRecentItem(`object:${object.object_type}:${object.name}`);
            close();
          },
        });
      }
    }

    items.push(...columnItems);

    // Saved queries
    for (const fav of favorites) {
      items.push({
        id: `query:${fav.id}`,
        kind: "saved-query",
        label: fav.name,
        description: fav.sql.replace(/\s+/g, " ").trim().slice(0, 80),
        meta: fav.tags.length > 0 ? fav.tags.join(", ") : undefined,
        action: () => {
          onOpenSavedQuery?.(fav.id);
          addRecentItem(`query:${fav.id}`);
          close();
        },
      });
    }

    for (const entry of historyEntries) {
      items.push({
        id: `history:${entry.id ?? entry.executed_at}`,
        kind: "history",
        label: entry.query_text.replace(/\s+/g, " ").trim().slice(0, 72) || "SQL query",
        description: entry.error || `${entry.duration_ms} ms - ${entry.executed_at}`,
        meta: entry.database,
        action: () => {
          addTab({
            id: `query-${crypto.randomUUID()}`,
            type: "query",
            title: "History query",
            connectionId: entry.connection_id,
            database: entry.database,
            content: entry.query_text,
          });
          addRecentItem(`history:${entry.id ?? entry.executed_at}`);
          close();
        },
      });
    }

    // Connections
    for (const conn of connections) {
      items.push({
        id: `conn:${conn.id}`,
        kind: "connection",
        label: conn.name || conn.host || "Connection",
        description: `${conn.db_type} — ${conn.database || conn.file_path || ""}`.trim(),
        action: () => {
          onConnect?.(conn.id);
          addRecentItem(`conn:${conn.id}`);
          close();
        },
      });
    }

    return items;
  }, [activeConnectionId, addRecentItem, addTab, close, columnItems, connections, currentDatabase, favorites, historyEntries, onConnect, onOpenSavedQuery, schemaObjects, setActiveTab, tabs, tables]);

  // Filter with fuzzy search
  const filteredItems = useMemo(
    () => fuzzySearch(allItems, searchQuery, recentItemIds),
    [allItems, searchQuery, recentItemIds],
  );

  // Group by kind
  const groupedItems = useMemo(() => {
    const groups: Array<{ kind: SwitcherItemKind; items: SwitcherItem[] }> = [];
    const seen = new Set<SwitcherItemKind>();
    for (const item of filteredItems) {
      if (!seen.has(item.kind)) {
        seen.add(item.kind);
        groups.push({ kind: item.kind, items: [] });
      }
      groups.find((g) => g.kind === item.kind)!.items.push(item);
    }
    return groups;
  }, [filteredItems]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen, setSearchQuery]);

  // Reset selection on query change
  useEffect(() => setSelectedIndex(0), [searchQuery]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = filteredItems[selectedIndex];
        if (item) item.action();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    },
    [filteredItems, selectedIndex, close],
  );

  if (!isOpen) return null;

  let globalIdx = 0;

  return (
    <div className="qs-backdrop" onClick={close} role="dialog" aria-modal aria-label="Quick Switcher">
      <div className="qs-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        {/* Search */}
        <div className="qs-search">
          <Hash size={16} className="qs-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="qs-input"
            placeholder="Search tabs, objects, columns, saved SQL, history..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {searchQuery && (
            <button type="button" className="qs-clear-btn" onClick={() => setSearchQuery("")}>
              <X size={14} />
            </button>
          )}
        </div>

        {/* List */}
        <div className="qs-list" ref={listRef}>
          {filteredItems.length === 0 ? (
            <div className="qs-empty">
              {searchQuery ? "No results found" : "No items available"}
            </div>
          ) : (
            <>
              {!searchQuery && recentItemIds.length > 0 && (
                <div className="qs-section-header">
                  <Clock size={12} />
                  <span>Recent</span>
                </div>
              )}
              {groupedItems.map((group) => (
                <div key={group.kind} className="qs-group">
                  {searchQuery && (
                    <div className="qs-section-header">
                      {ITEM_ICONS[group.kind]}
                      <span>{KIND_LABELS[group.kind]}s</span>
                    </div>
                  )}
                  {group.items.map((item) => {
                    const idx = globalIdx++;
                    const isSelected = idx === selectedIndex;
                    return (
                      <div
                        key={item.id}
                        data-idx={idx}
                        className={`qs-item ${isSelected ? "selected" : ""}`}
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => item.action()}
                        onMouseEnter={() => setSelectedIndex(idx)}
                      >
                        <span className="qs-item-icon">{ITEM_ICONS[item.kind]}</span>
                        <div className="qs-item-body">
                          <span className="qs-item-label">{item.label}</span>
                          {item.description && (
                            <span className="qs-item-desc">{item.description}</span>
                          )}
                        </div>
                        {item.meta && (
                          <span className="qs-item-meta">{item.meta}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="qs-footer">
          <span><kbd>↑↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
