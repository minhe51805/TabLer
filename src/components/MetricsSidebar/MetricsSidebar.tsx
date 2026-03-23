import { createPortal } from "react-dom";
import { BarChart3, ChevronDown, ChevronRight, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../stores/appStore";
import type { MetricsBoardDefinition, MetricsWidgetDefinition, Tab } from "../../types";
import { formatCountLabel, useI18n } from "../../i18n";
import {
  createBoardDefinition,
  readStoredBoards,
  writeStoredBoards,
} from "../MetricsBoard/utils/query-builder";

interface Props {
  connectionId: string;
  database?: string;
}

export function MetricsSidebar({ connectionId, database }: Props) {
  const { language, t } = useI18n();
  const { tabs, activeTabId, addTab, setActiveTab, updateTab, removeTab } = useAppStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      addTab: state.addTab,
      setActiveTab: state.setActiveTab,
      updateTab: state.updateTab,
      removeTab: state.removeTab,
    })),
  );
  const [boards, setBoards] = useState<MetricsBoardDefinition[]>([]);
  const [boardSearch, setBoardSearch] = useState("");
  const [boardMenu, setBoardMenu] = useState<{ boardId: string; left: number; top: number } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ boardId: string; value: string } | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const syncBoards = useCallback(() => {
    setBoards(readStoredBoards().filter((board) => board.connection_id === connectionId));
  }, [connectionId]);

  useEffect(() => {
    syncBoards();
  }, [syncBoards]);

  useEffect(() => {
    const handleBoardsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId?: string }>).detail;
      if (detail?.connectionId && detail.connectionId !== connectionId) return;
      syncBoards();
    };

    window.addEventListener("metrics-boards-updated", handleBoardsUpdated);
    return () => window.removeEventListener("metrics-boards-updated", handleBoardsUpdated);
  }, [connectionId, syncBoards]);

  useEffect(() => {
    if (!boardMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".metrics-board-side-menu")) return;
      setBoardMenu(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBoardMenu(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [boardMenu]);

  useEffect(() => {
    if (!renameDialog) return;

    const focusTimer = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRenameDialog(null);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [renameDialog?.boardId]);

  const filteredBoards = useMemo(() => {
    const query = boardSearch.trim().toLowerCase();
    if (!query) return boards;
    return boards.filter((board) => board.name.toLowerCase().includes(query));
  }, [boardSearch, boards]);

  const activeMetricsTab = useMemo(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
    if (
      activeTab?.type === "metrics" &&
      activeTab.connectionId === connectionId &&
      (activeTab.database || "") === (database || "")
    ) {
      return activeTab;
    }

    return (
      tabs.find(
        (tab) =>
          tab.type === "metrics" &&
          tab.connectionId === connectionId &&
          (tab.database || "") === (database || ""),
      ) || null
    );
  }, [activeTabId, connectionId, database, tabs]);

  const activeBoardId = activeMetricsTab?.metricsBoardId || boards[0]?.id || null;

  const ensureMetricsTab = useCallback(
    (board: MetricsBoardDefinition): Tab | null => {
      const matchingTab =
        tabs.find(
          (tab) =>
            tab.type === "metrics" &&
            tab.connectionId === connectionId &&
            (tab.database || "") === (database || ""),
        ) || null;

      if (matchingTab) {
        updateTab(matchingTab.id, {
          metricsBoardId: board.id,
          title: board.name,
        });
        setActiveTab(matchingTab.id);
        return {
          ...matchingTab,
          metricsBoardId: board.id,
          title: board.name,
        };
      }

      const nextTab: Tab = {
        id: `metrics-${crypto.randomUUID()}`,
        type: "metrics",
        title: board.name,
        connectionId,
        database,
        metricsBoardId: board.id,
      };
      addTab(nextTab);
      return nextTab;
    },
    [addTab, connectionId, database, setActiveTab, tabs, updateTab],
  );

  const handleBoardClick = useCallback(
    (board: MetricsBoardDefinition) => {
      ensureMetricsTab(board);
    },
    [ensureMetricsTab],
  );

  const handleWidgetClick = useCallback(
    (board: MetricsBoardDefinition, widget: MetricsWidgetDefinition) => {
      ensureMetricsTab(board);
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("focus-metrics-widget", {
            detail: {
              boardId: board.id,
              widgetId: widget.id,
            },
          }),
        );
      }, 0);
    },
    [ensureMetricsTab],
  );

  const handleCreateBoard = useCallback(() => {
    const allBoards = readStoredBoards();
    const existingBoards = allBoards.filter((board) => board.connection_id === connectionId);
    const nextBoard = createBoardDefinition(connectionId, database, existingBoards);
    writeStoredBoards([...allBoards, nextBoard]);
    window.dispatchEvent(
      new CustomEvent("metrics-boards-updated", {
        detail: { connectionId },
      }),
    );
    setBoardSearch("");
    ensureMetricsTab(nextBoard);
  }, [connectionId, database, ensureMetricsTab]);

  const commitRenameBoard = useCallback(
    (board: MetricsBoardDefinition, nextName: string) => {
      const allBoards = readStoredBoards();
      const nextBoards = allBoards.map((entry) =>
        entry.id === board.id
          ? {
              ...entry,
              name: nextName,
              updated_at: Date.now(),
            }
          : entry,
      );
      writeStoredBoards(nextBoards);

      tabs
        .filter((tab) => tab.type === "metrics" && tab.metricsBoardId === board.id)
        .forEach((tab) => updateTab(tab.id, { title: nextName }));

      window.dispatchEvent(
        new CustomEvent("metrics-boards-updated", {
          detail: { connectionId },
        }),
      );
    },
    [connectionId, tabs, updateTab],
  );

  const handleRenameBoard = useCallback(
    (board: MetricsBoardDefinition) => {
      setBoardMenu(null);
      setRenameDialog({ boardId: board.id, value: board.name });
    },
    [],
  );

  const handleDeleteBoard = useCallback(
    (board: MetricsBoardDefinition) => {
      const allBoards = readStoredBoards();
      const sameConnectionBoards = allBoards.filter((entry) => entry.connection_id === connectionId);
      const remainingConnectionBoards = sameConnectionBoards.filter((entry) => entry.id !== board.id);
      const otherBoards = allBoards.filter((entry) => entry.connection_id !== connectionId);
      const fallbackBoard =
        remainingConnectionBoards[0] || createBoardDefinition(connectionId, database, []);
      writeStoredBoards([...otherBoards, ...remainingConnectionBoards, ...(remainingConnectionBoards.length > 0 ? [] : [fallbackBoard])]);

      tabs
        .filter((tab) => tab.type === "metrics" && tab.metricsBoardId === board.id)
        .forEach((tab) => {
          if (remainingConnectionBoards.length > 0) {
            updateTab(tab.id, {
              metricsBoardId: fallbackBoard.id,
              title: fallbackBoard.name,
              database: fallbackBoard.database || tab.database,
            });
          } else if (tab.id === activeTabId) {
            updateTab(tab.id, {
              metricsBoardId: fallbackBoard.id,
              title: fallbackBoard.name,
              database: fallbackBoard.database || tab.database,
            });
          } else {
            removeTab(tab.id);
          }
        });

      window.dispatchEvent(
        new CustomEvent("metrics-boards-updated", {
          detail: { connectionId },
        }),
      );
      setBoardMenu(null);
    },
    [activeTabId, connectionId, database, removeTab, tabs, updateTab],
  );

  const handleBoardContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, board: MetricsBoardDefinition) => {
      event.preventDefault();
      const sidebarRect = sidebarRef.current?.getBoundingClientRect();
      if (!sidebarRect) return;

      const menuWidth = 180;
      const menuHeight = 118;
      const localLeft = event.clientX - sidebarRect.left;
      const localTop = event.clientY - sidebarRect.top;
      const left = Math.max(8, Math.min(localLeft, sidebarRect.width - menuWidth - 8));
      const top = Math.max(8, Math.min(localTop, sidebarRect.height - menuHeight - 8));
      setBoardMenu({ boardId: board.id, left, top });
    },
    [],
  );

  const handleRenameSubmit = useCallback(() => {
    if (!renameDialog) return;

    const board = boards.find((entry) => entry.id === renameDialog.boardId);
    const nextName = renameDialog.value.trim();

    if (!board || !nextName || nextName === board.name) {
      setRenameDialog(null);
      return;
    }

    commitRenameBoard(board, nextName);
    setRenameDialog(null);
  }, [boards, commitRenameBoard, renameDialog]);

  return (
    <div className="metrics-board-sidebar metrics-board-sidebar-standalone" ref={sidebarRef}>
      <div className="metrics-board-sidebar-head">
        <div className="metrics-board-sidebar-copy">
          <span className="metrics-board-sidebar-kicker">{t("metrics.sidebarKicker")}</span>
          <strong className="metrics-board-sidebar-title">{t("metrics.sidebarTitle")}</strong>
        </div>
        <span className="metrics-board-sidebar-count">{filteredBoards.length}</span>
      </div>

      <div className="metrics-board-sidebar-search">
        <Search className="w-3.5 h-3.5" />
        <input
          ref={searchInputRef}
          value={boardSearch}
          onChange={(event) => setBoardSearch(event.target.value)}
          placeholder={t("metrics.searchPlaceholder")}
        />
        <button
          type="button"
          className="metrics-board-inline-action"
          onClick={handleCreateBoard}
          title={t("metrics.createBoard")}
        >
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
                onClick={() => handleBoardClick(board)}
                onContextMenu={(event) => handleBoardContextMenu(event, board)}
              >
                {isActive ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <BarChart3 className="w-3.5 h-3.5" />
                <div className="metrics-board-list-copy">
                  <span>{board.name}</span>
                  <small>
                    {formatCountLabel(language, board.widgets.length, {
                      one: "widget",
                      other: "widgets",
                      vi: "widget",
                    })}
                  </small>
                </div>
              </button>

              {isActive && board.widgets.length > 0 && (
                <div className="metrics-board-list-children">
                  {board.widgets.map((widget) => (
                    <button
                      key={widget.id}
                      type="button"
                      className="metrics-board-list-child"
                      onClick={() => handleWidgetClick(board, widget)}
                    >
                      <span>{widget.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {filteredBoards.length === 0 && (
          <div className="metrics-board-empty-side">{t("metrics.noBoardsMatch")}</div>
        )}
      </div>

      {boardMenu ? (
        <div
          className="metrics-board-side-menu"
          style={{ left: `${boardMenu.left}px`, top: `${boardMenu.top}px` }}
        >
          <button type="button" className="metrics-board-side-menu-item" onClick={handleCreateBoard}>
            {t("metrics.newBoard")}
          </button>
          <button
            type="button"
            className="metrics-board-side-menu-item"
            onClick={() => {
              const board = boards.find((entry) => entry.id === boardMenu.boardId);
              if (board) handleRenameBoard(board);
            }}
          >
            {t("metrics.renameBoard")}
          </button>
          <div className="metrics-board-side-menu-divider" />
          <button
            type="button"
            className="metrics-board-side-menu-item danger"
            onClick={() => {
              const board = boards.find((entry) => entry.id === boardMenu.boardId);
              if (board) handleDeleteBoard(board);
            }}
          >
            {t("metrics.deleteBoard")}
          </button>
        </div>
      ) : null}

      {renameDialog
        ? createPortal(
            <div
              className="metrics-board-rename-overlay"
              onMouseDown={() => setRenameDialog(null)}
            >
              <div
                className="metrics-board-rename-modal"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="metrics-board-rename-copy">
                  <span className="metrics-board-rename-kicker">{t("metrics.renameBoardModalKicker")}</span>
                  <strong className="metrics-board-rename-title">{t("metrics.renameBoardModalTitle")}</strong>
                  <p className="metrics-board-rename-subtitle">
                    {t("metrics.renameBoardModalSubtitle")}
                  </p>
                </div>

                <label className="metrics-board-rename-field">
                  <span>{t("common.name")}</span>
                  <input
                    ref={renameInputRef}
                    value={renameDialog.value}
                    onChange={(event) =>
                      setRenameDialog((current) =>
                        current ? { ...current, value: event.target.value } : current,
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleRenameSubmit();
                      }
                    }}
                    placeholder={t("metrics.boardNamePlaceholder")}
                  />
                </label>

                <div className="metrics-board-rename-actions">
                  <button
                    type="button"
                    className="metrics-board-rename-btn secondary"
                    onClick={() => setRenameDialog(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="metrics-board-rename-btn primary"
                    onClick={handleRenameSubmit}
                  >
                    {t("common.rename")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
