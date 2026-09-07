import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Database,
  Plus,
  Search,
} from "lucide-react";
import type { MetricsBoardDefinition } from "../../../types";
import { getWidgetLibraryItem } from "../utils/query-builder";

interface Props {
  displayDatabaseLabel: string;
  displayConnectionLabel: string;
  boards: MetricsBoardDefinition[];
  filteredBoards: MetricsBoardDefinition[];
  activeBoardId: string | null;
  activeWidgetId: string | null;
  boardSearch: string;
  onBoardSearchChange: (value: string) => void;
  onCreateBoard: () => void;
  onSelectBoard: (boardId: string) => void;
  onSelectWidget: (widgetId: string) => void;
  onOpenDatabaseSidebar: () => void;
  onFocusMetricsSidebar: () => void;
}

export function MetricsBoardSidebar({
  displayDatabaseLabel,
  displayConnectionLabel,
  boards,
  filteredBoards,
  activeBoardId,
  activeWidgetId,
  boardSearch,
  onBoardSearchChange,
  onCreateBoard,
  onSelectBoard,
  onSelectWidget,
  onOpenDatabaseSidebar,
  onFocusMetricsSidebar,
}: Props) {
  const handleFocus = () => {
    onFocusMetricsSidebar();
  };

  return (
    <>
      <aside className="metrics-board-rail">
        <button
          type="button"
          className="metrics-board-rail-card"
          onClick={onOpenDatabaseSidebar}
          title={`Open explorer for ${displayDatabaseLabel}`}
        >
          <Database className="w-4 h-4" />
          <span>{displayDatabaseLabel}</span>
          <small>{displayConnectionLabel}</small>
        </button>

        <button
          type="button"
          className="metrics-board-rail-card active"
          onClick={handleFocus}
          title="Focus metrics boards"
        >
          <BarChart3 className="w-4 h-4" />
          <span>Metrics</span>
          <small>{boards.length} board{boards.length === 1 ? "" : "s"}</small>
        </button>
      </aside>

      <aside className="metrics-board-sidebar">
        <div className="metrics-board-sidebar-head">
          <div className="metrics-board-sidebar-copy">
            <span className="metrics-board-sidebar-kicker">Metrics</span>
            <strong className="metrics-board-sidebar-title">Boards</strong>
          </div>
          <span className="metrics-board-sidebar-count">{filteredBoards.length}</span>
        </div>

        <div className="metrics-board-sidebar-search">
          <Search className="w-3.5 h-3.5" />
          <input
            value={boardSearch}
            onChange={(event) => onBoardSearchChange(event.target.value)}
            placeholder="Search for metrics board..."
          />
          <button type="button" className="metrics-board-inline-action" onClick={onCreateBoard} title="Create metrics board">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="metrics-board-list">
          {filteredBoards.map((board) => {
            const isActive = board.id === activeBoardId;
            return (
              <div key={board.id} className="metrics-board-list-group">
                <button
                  type="button"
                  className={`metrics-board-list-item ${isActive ? "active" : ""}`}
                  onClick={() => onSelectBoard(board.id)}
                >
                  {isActive ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <BarChart3 className="w-3.5 h-3.5" />
                  <div className="metrics-board-list-copy">
                    <span>{board.name}</span>
                    <small>
                      {board.widgets.length} widget{board.widgets.length === 1 ? "" : "s"}
                    </small>
                  </div>
                </button>

                {isActive && board.widgets.length > 0 && (
                  <div className="metrics-board-list-children">
                    {board.widgets.map((widget) => {
                      const Icon = getWidgetLibraryItem(widget.type).icon;
                      return (
                        <button
                          key={widget.id}
                          type="button"
                          className={`metrics-board-list-child ${activeWidgetId === widget.id ? "active" : ""}`}
                          onClick={() => onSelectWidget(widget.id)}
                        >
                          <Icon className="w-3 h-3" />
                          <span>{widget.title}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {filteredBoards.length === 0 && (
            <div className="metrics-board-empty-side">No boards match this search.</div>
          )}
        </div>
      </aside>
    </>
  );
}
