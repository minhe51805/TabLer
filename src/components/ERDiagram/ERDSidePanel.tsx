import type { Dispatch, CSSProperties, SetStateAction } from "react";
import { CheckCheck, PanelLeftClose, PanelLeftOpen, Search, Sparkles, Square } from "lucide-react";
import type { TableSchema } from "../../types/database";
import { TABLE_COLORS } from "./erd-graph";

interface ERDSidePanelProps {
  isSidePanelCollapsed: boolean;
  setIsSidePanelCollapsed: Dispatch<SetStateAction<boolean>>;
  selectedTables: Set<string>;
  filteredTables: TableSchema[];
  tableColorMap: Map<string, string>;
  tableFilter: string;
  setTableFilter: Dispatch<SetStateAction<string>>;
  handleRecommendedSelection: () => void;
  handleSelectAll: () => void;
  handleClearAll: () => void;
  handleTableToggle: (name: string) => void;
}

/** Table-browser side panel for the ER canvas. */
export function ERDSidePanel({
  isSidePanelCollapsed,
  setIsSidePanelCollapsed,
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
  return (
<aside
            className={`erd-sidepanel ${isSidePanelCollapsed ? "is-collapsed" : ""}`}
          >
            <div className="erd-sidepanel-header">
              <div className="erd-sidepanel-copy">
                <strong className="erd-sidepanel-title">Tables</strong>
                <span className="erd-sidepanel-meta">
                  {selectedTables.size} selected
                </span>
              </div>

              <button
                type="button"
                className="erd-sidepanel-collapse"
                aria-label={
                  isSidePanelCollapsed
                    ? "Expand tables panel"
                    : "Collapse tables panel"
                }
                onClick={() => setIsSidePanelCollapsed((value) => !value)}
              >
                {isSidePanelCollapsed ? (
                  <PanelLeftOpen className="erd-sidepanel-collapse-icon" />
                ) : (
                  <PanelLeftClose className="erd-sidepanel-collapse-icon" />
                )}
              </button>
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

            <div className="erd-table-list custom-scrollbar">
              {filteredTables.length === 0 ? (
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
                filteredTables.map((table) => {
                  const checked = selectedTables.has(table.name);
                  const accent =
                    tableColorMap.get(table.name) || TABLE_COLORS[0];

                  return (
                    <button
                      key={table.name}
                      type="button"
                      onClick={() => handleTableToggle(table.name)}
                      aria-pressed={checked}
                      aria-label={table.name}
                      title={table.name}
                      className={`erd-table-toggle ${checked ? "is-active" : ""}`}
                      style={{ "--erd-table-accent": accent } as CSSProperties}
                    >
                      <span className="erd-table-toggle-check" />
                      {!isSidePanelCollapsed && (
                        <>
                          <div className="erd-table-toggle-copy">
                            <span className="erd-table-toggle-name">
                              {table.name}
                            </span>
                            <span className="erd-table-toggle-meta">
                              {table.schema || "Table"}
                            </span>
                          </div>
                          <span
                            className="erd-table-toggle-count"
                            title={`${table.columns.length} columns`}
                          >
                            {table.columns.length}
                          </span>
                        </>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </aside>
  );
}
