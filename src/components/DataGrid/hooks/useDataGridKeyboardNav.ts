import { useEffect } from "react";
import { EventCenter } from "../../../stores/event-center";
import type { QueryResult } from "../../../types";
import { APP_EVENTS } from "../../../utils/app-events";
import { createEmptyGridSelection, moveGridSelection, selectEntireGrid } from "../grid-selection";
import type { DataGridStoreApi } from "../store/dataGridStore";

export interface UseDataGridKeyboardNavParams {
  viewMode: "table" | "chart";
  isActive: boolean;
  tableName?: string;
  externalResult?: QueryResult;
  tableWrapRef: { current: HTMLDivElement | null };
  dataColumnsLength: number;
  displayedRowsLength: number;
  structureColumnsLength: number;
  dataGridStore: DataGridStoreApi;
  handleRangeCopy: () => boolean;
  handleRangePaste: () => boolean;
  handleRangeDelete: () => boolean;
  handleRangeFillDown: () => boolean;
  handlePasteRowsFromClipboard: () => Promise<void>;
  handleDuplicateRow: () => Promise<void>;
  handleUndo: () => void;
  handleRedo: () => void;
  isInsertDialogOpen: boolean;
  closeInsertDialog: () => void;
  isPasteDialogOpen: boolean;
  closePasteDialog: () => void;
}

/**
 * Keyboard navigation, clipboard/range shortcuts, modal Escape dismissal,
 * and global grid command subscriptions for `<DataGrid />`.
 */
export function useDataGridKeyboardNav({
  viewMode,
  isActive,
  tableName,
  externalResult,
  tableWrapRef,
  dataColumnsLength,
  displayedRowsLength,
  structureColumnsLength,
  dataGridStore,
  handleRangeCopy,
  handleRangePaste,
  handleRangeDelete,
  handleRangeFillDown,
  handlePasteRowsFromClipboard,
  handleDuplicateRow,
  handleUndo,
  handleRedo,
  isInsertDialogOpen,
  closeInsertDialog,
  isPasteDialogOpen,
  closePasteDialog,
}: UseDataGridKeyboardNavParams) {
  // Arrow keys, Ctrl+A, and Escape navigation on the table wrapper.
  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element || viewMode !== "table") return;

    const handleGridKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

      const bounds = {
        rowCount: displayedRowsLength,
        columnCount: structureColumnsLength || dataColumnsLength,
      };
      if (bounds.rowCount === 0 || bounds.columnCount === 0) return;

      const { setGridSelection } = dataGridStore.getState();

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setGridSelection(selectEntireGrid(bounds));
        return;
      }
      if (event.key === "Escape") {
        setGridSelection(createEmptyGridSelection());
        return;
      }

      const deltas: Record<string, { row: number; col: number }> = {
        ArrowUp: { row: -1, col: 0 },
        ArrowDown: { row: 1, col: 0 },
        ArrowLeft: { row: 0, col: -1 },
        ArrowRight: { row: 0, col: 1 },
      };
      const delta = deltas[event.key];
      if (!delta) return;

      event.preventDefault();
      setGridSelection((previous) => moveGridSelection(previous, delta, bounds, event.shiftKey));
    };

    element.addEventListener("keydown", handleGridKeyDown);
    return () => element.removeEventListener("keydown", handleGridKeyDown);
  }, [
    dataColumnsLength,
    dataGridStore,
    displayedRowsLength,
    structureColumnsLength,
    tableWrapRef,
    viewMode,
  ]);

  // Range editing keys (copy / paste / fill / clear).
  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element || viewMode !== "table") return;

    const handleRangeEditingKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

      const key = event.key.toLowerCase();
      const primary = event.ctrlKey || event.metaKey;

      if (primary && !event.shiftKey && !event.altKey && (key === "c" || key === "v")) {
        const handled = key === "c" ? handleRangeCopy() : handleRangePaste();
        if (handled) event.preventDefault();
        return;
      }
      if (primary && !event.shiftKey && !event.altKey && key === "d") {
        // When AppKeyboardHandler handled Ctrl+D in capture phase, it already
        // emitted `datagridDuplicateRow`; avoid double-running fill-down here.
        if (event.defaultPrevented) return;
        if (handleRangeFillDown()) event.preventDefault();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (handleRangeDelete()) event.preventDefault();
      }
    };

    element.addEventListener("keydown", handleRangeEditingKeyDown);
    return () => element.removeEventListener("keydown", handleRangeEditingKeyDown);
  }, [
    handleRangeCopy,
    handleRangeDelete,
    handleRangeFillDown,
    handleRangePaste,
    tableWrapRef,
    viewMode,
  ]);

  // Ctrl+Shift+V: paste rows from clipboard (in DataGrid, not in insert mode).
  useEffect(() => {
    if (!isActive || !tableName || externalResult) return;

    const handlePasteRows = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key === "V") {
        event.preventDefault();
        void handlePasteRowsFromClipboard();
      }
    };

    window.addEventListener("keydown", handlePasteRows);
    return () => window.removeEventListener("keydown", handlePasteRows);
  }, [isActive, tableName, externalResult, handlePasteRowsFromClipboard]);

  // Global grid commands: Undo, Redo, and Duplicate-Row / Range Fill-Down (Bug DG-3).
  useEffect(() => {
    if (!isActive) return;

    const unlistenUndo = EventCenter.on(APP_EVENTS.datagridUndo, handleUndo);
    const unlistenRedo = EventCenter.on(APP_EVENTS.datagridRedo, handleRedo);
    const unlistenDupRow = EventCenter.on(APP_EVENTS.datagridDuplicateRow, () => {
      // Multi-cell ranges own Ctrl+D via range fill-down; single cells fall through
      // to duplicate row so AppKeyboardHandler's capture listener stays lossless.
      if (handleRangeFillDown()) return;
      void handleDuplicateRow();
    });

    return () => {
      unlistenUndo();
      unlistenRedo();
      unlistenDupRow();
    };
  }, [handleDuplicateRow, handleRangeFillDown, handleRedo, handleUndo, isActive]);

  useEffect(() => {
    if (!isInsertDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeInsertDialog();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeInsertDialog, isInsertDialogOpen]);

  useEffect(() => {
    if (!isPasteDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePasteDialog();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePasteDialog, isPasteDialogOpen]);
}
