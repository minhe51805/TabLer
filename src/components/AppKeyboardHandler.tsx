import { useEffect } from "react";
import { APP_EVENTS } from "../utils/app-events";
import { EventCenter } from "../stores/event-center";
import type { Tab } from "../types";
import { UI_FONT_SCALE_MAX, UI_FONT_SCALE_MIN, UI_FONT_SCALE_STEP } from "../utils/ui-scale";

interface KeyboardHandlerProps {
  activeTab: Tab | null;
  onNewQuery: () => void;
  onRunActiveQuery: () => void;
  onToggleTerminalPanel: () => void;
  onToggleSidebar: () => void;
  onToggleQueryHistory: () => void;
  onToggleSQLFavorites: () => void;
  onToggleVimMode: () => void;
  onOpenCommandPalette: () => void;
  onOpenQuickSwitcher: () => void;
  onOpenGlobalSearch: () => void;
  setUiFontScale: (fn: (current: number) => number) => void;
  setShowAISlidePanel: (value: boolean | ((current: boolean) => boolean)) => void;
}

export function AppKeyboardHandler({
  activeTab,
  onNewQuery,
  onRunActiveQuery,
  onToggleTerminalPanel,
  onToggleSidebar,
  onToggleQueryHistory,
  onToggleSQLFavorites,
  onToggleVimMode,
  onOpenCommandPalette,
  onOpenQuickSwitcher,
  onOpenGlobalSearch,
  setUiFontScale,
  setShowAISlidePanel,
}: KeyboardHandlerProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const metaPressed = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const target = e.target as HTMLElement | null;
      const isMonacoTarget = !!target?.closest(".monaco-editor");
      const isEditableTarget = !!target?.closest(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
      );

      if (
        metaPressed &&
        key === "enter" &&
        activeTab?.type === "query" &&
        (isMonacoTarget || !isEditableTarget)
      ) {
        e.preventDefault();
        e.stopPropagation();
        onRunActiveQuery();
        return;
      }

      // Shortcuts overlay: F1 outside the Monaco editor (Monaco keeps its own
      // F1 command palette); Ctrl+/ (and Ctrl+Shift+/) outside Monaco so the
      // editor keeps its own Ctrl+/ line-comment binding.
      if (
        (e.key === "F1" && !metaPressed && !e.altKey && !e.shiftKey && !isMonacoTarget) ||
        (metaPressed && e.code === "Slash" && !isMonacoTarget)
      ) {
        e.preventDefault();
        e.stopPropagation();
        EventCenter.emit(APP_EVENTS.openKeyboardShortcutsPalette);
        return;
      }

      if (metaPressed && e.altKey && key === "p") {
        e.preventDefault();
        e.stopPropagation();
        setShowAISlidePanel((current) => !current);
        return;
      }

      if (metaPressed && key === "n") {
        e.preventDefault();
        onNewQuery();
        return;
      }

      // Quick Switcher: Ctrl+P / Cmd+P (no shift)
      if (metaPressed && !e.shiftKey && !e.altKey && key === "p") {
        e.preventDefault();
        e.stopPropagation();
        onOpenQuickSwitcher();
        return;
      }

      // Command Palette: Ctrl+Shift+P / Cmd+Shift+P
      if (metaPressed && e.shiftKey && key === "p") {
        e.preventDefault();
        onOpenCommandPalette();
        return;
      }

      // Global Search: Ctrl+Shift+F / Cmd+Shift+F
      if (metaPressed && e.shiftKey && key === "f") {
        e.preventDefault();
        onOpenGlobalSearch();
        return;
      }

      if (metaPressed && key === "b") {
        e.preventDefault();
        onToggleSidebar();
        return;
      }

      if (metaPressed && !e.shiftKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setUiFontScale((current) => Math.min(UI_FONT_SCALE_MAX, current + UI_FONT_SCALE_STEP));
        return;
      }

      if (metaPressed && !e.shiftKey && e.key === "-") {
        e.preventDefault();
        setUiFontScale((current) => Math.max(UI_FONT_SCALE_MIN, current - UI_FONT_SCALE_STEP));
        return;
      }

      if (metaPressed && !e.shiftKey && key === "0") {
        e.preventDefault();
        onToggleSidebar();
        return;
      }

      if (metaPressed && e.code === "Space" && !e.shiftKey) {
        e.preventDefault();
        setShowAISlidePanel((current) => !current);
        return;
      }

      if (metaPressed && key === "h") {
        e.preventDefault();
        onToggleQueryHistory();
        return;
      }

      if (metaPressed && e.shiftKey && key === "s") {
        e.preventDefault();
        onToggleSQLFavorites();
        return;
      }

      if (metaPressed && e.shiftKey && key === "v") {
        // Bug DG-4: Ctrl+Shift+V inside a DataGrid triggers row-paste from clipboard,
        // not the SQL Editor Vim mode toggle.
        if (target?.closest(".datagrid-shell")) {
          return;
        }
        e.preventDefault();
        onToggleVimMode();
        return;
      }

      if (metaPressed && e.shiftKey && key === "q") {
        e.preventDefault();
        EventCenter.emit(APP_EVENTS.toggleQuerySchedulesPalette);
        return;
      }

      if (metaPressed && e.code === "Backquote" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        onToggleTerminalPanel();
        return;
      }

      if (metaPressed && e.code === "Backquote" && e.shiftKey) {
        if (activeTab?.type !== "query") {
          return;
        }
        e.preventDefault();
        EventCenter.emit(APP_EVENTS.toggleQueryResultsPane, { tabId: activeTab.id });
      }

      // DataGrid-scoped shortcuts must not fire while a Monaco editor has
      // focus: the editor owns Ctrl+Z/Y (undo/redo) and Ctrl+D (add selection
      // to next find match / multi-cursor). The window-level capture listener
      // runs before Monaco's own handler, so without this guard a keypress in
      // the SQL editor both edits text AND mutates the grid behind it.
      if (!isMonacoTarget && !isEditableTarget) {
        if (metaPressed && !e.shiftKey && key === "z") {
          e.preventDefault();
          EventCenter.emit(APP_EVENTS.datagridUndo);
          return;
        }

        if ((metaPressed && e.shiftKey && key === "z") || (metaPressed && key === "y")) {
          e.preventDefault();
          EventCenter.emit(APP_EVENTS.datagridRedo);
          return;
        }

        if (metaPressed && key === "d") {
          e.preventDefault();
          EventCenter.emit(APP_EVENTS.datagridDuplicateRow);
          return;
        }

        if (metaPressed && key === "Enter") {
          e.preventDefault();
          EventCenter.emit(APP_EVENTS.datagridFkPreview);
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    activeTab,
    onNewQuery,
    onOpenCommandPalette,
    onOpenQuickSwitcher,
    onRunActiveQuery,
    onToggleQueryHistory,
    onToggleSQLFavorites,
    onToggleSidebar,
    onToggleTerminalPanel,
    onToggleVimMode,
    setUiFontScale,
    setShowAISlidePanel,
    onOpenGlobalSearch,
  ]);

  return null;
}
