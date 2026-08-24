import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction, type UIEvent } from "react";
import { CheckCheck, Search, Sparkles, Square } from "lucide-react";
import type { TableSchema } from "../../types/database";
import { TABLE_COLORS } from "./erd-graph";

interface ERDSidePanelProps {
  isSidePanelCollapsed: boolean;
  selectedTables: Set<string>;  filteredTables: TableSchema[];
  tableColorMap: Map<string, string>;
  tableFilter: string;
  setTableFilter: Dispatch<SetStateAction<string>>;
  handleRecommendedSelection: () => void;
  handleSelectAll: () => void;
  handleClearAll: () => void;
  handleTableToggle: (name: string) => void;
}

const ROW_HEIGHT = 30;
const ROW_SLOT = 34;
const LIST_OVERSCAN_ROWS = 6;

interface ERDTableRowProps {
  table: TableSchema;
  accent: string;
  checked: boolean;
  isCollapsed: boolean;
  onToggle: (tableName: string) => void;
}

const ERDTableRow = memo(function ERDTableRow({
  table,
  accent,
  checked,
  isCollapsed,
  onToggle,
}: ERDTableRowProps) {
  const showSchema =
    !isCollapsed && Boolean(table.schema) && table.schema !== "public";

  return (
    <button
      type="button"
      onClick={() => onToggle(table.name)}
      aria-pressed={checked}
      aria-label={table.name}
      title={`${table.name} · ${table.columns.length} columns`}
      className={`erd-table-toggle ${checked ? "is-active" : ""}`}
      style={{ "--erd-table-accent": accent } as CSSProperties}
    >
      <span className="erd-table-toggle-dot" />
      {!isCollapsed && (
        <>
          <span className="erd-table-toggle-name">{table.name}</span>
          {showSchema && (
            <span className="erd-table-toggle-schema">{table.schema}</span>
          )}
          <span className="erd-table-toggle-count">
            {table.columns.length}
          </span>
        </>
      )}
    </button>
  );
});

/** Table-browser side panel for the ER canvas (windowed list rendering). */
export function ERDSidePanel({
  isSidePanelCollapsed,
  selectedTables,
  filteredTables,
  tableColorMap,
  tableFilter,
  setTableFilter,
  handleRecommendedSelection,
  handleSelectAll,
  handleClearAll,
  handleTableToggle,
}: ERDSidePanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;

    const measureViewport = () => setViewportHeight(element.clientHeight);
    measureViewport();
    const observer = new ResizeObserver(measureViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    cancelAnimationFrame(scrollFrameRef.current);
    listRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [tableFilter]);

  const handleListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() =>
      setScrollTop(nextScrollTop),
    );
  }, []);

  const totalRows = filteredTables.length;
  const firstVisibleRow =
    totalRows === 0 || viewportHeight <= 0
      ? 0
      : Math.max(0, Math.floor(scrollTop / ROW_SLOT) - LIST_OVERSCAN_ROWS);
  const visibleRowCount =
    viewportHeight <= 0
      ? totalRows
      : Math.ceil(viewportHeight / ROW_SLOT) + LIST_OVERSCAN_ROWS * 2;
  const lastVisibleRow = Math.min(totalRows, firstVisibleRow + visibleRowCount);
  const visibleRows = filteredTables.slice(firstVisibleRow, lastVisibleRow);

  return (
    <aside
      className={`erd-sidepanel ${isSidePanelCollapsed ? "is-collapsed" : ""}`}
    >
      <div className="erd-sidepanel-header">
        <strong className="erd-sidepanel-title">Tables</strong>
        <span className="erd-sidepanel-meta">
          {selectedTables.size} selected
        </span>
      </div>

      <div className="erd-sidepanel-actions">
        <button
          type="button"
          onClick={handleRecommendedSelection}
          className="erd-sidepanel-action is-recommended"
          title="Show the most connected tables"
        >
          <Sparkles className="erd-sidepanel-action-icon" />
          Overview
        </button>
        <button
          type="button"
          onClick={handleSelectAll}
          className="erd-sidepanel-action"
        >
          <CheckCheck className="erd-sidepanel-action-icon" />
          All
        </button>
        <button
          type="button"
          onClick={handleClearAll}
          className="erd-sidepanel-action"
        >
          <Square className="erd-sidepanel-action-icon" />
          None
        </button>
      </div>

      <label className="erd-filter">
        <Search className="erd-filter-icon" />
        <input
          type="text"
          value={tableFilter}
          onChange={(event) => setTableFilter(event.target.value)}
          placeholder="Find a table"
          className="erd-filter-input"
        />
      </label>

      <div
        ref={listRef}
        onScroll={handleListScroll}
        className="erd-table-list custom-scrollbar"
      >
        {totalRows === 0 ? (
          <div className="erd-empty-list">
            <Search className="erd-empty-list-icon" />
            {!isSidePanelCollapsed && (
              <>
                <strong>No matching tables</strong>
                <span>Clear the search and try again.</span>
              </>
            )}
          </div>
        ) : (
          <div
            className="erd-virtual-list"
            style={{ height: totalRows * ROW_SLOT }}
          >
            {visibleRows.map((table, offset) => (
              <div
                key={table.name}
                className={`erd-virtual-row ${isSidePanelCollapsed ? "is-centered" : ""}`}
                style={{
                  top: (firstVisibleRow + offset) * ROW_SLOT,
                  height: ROW_HEIGHT,
                }}
              >
                <ERDTableRow
                  table={table}
                  accent={tableColorMap.get(table.name) || TABLE_COLORS[0]}
                  checked={selectedTables.has(table.name)}
                  isCollapsed={isSidePanelCollapsed}
                  onToggle={handleTableToggle}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
