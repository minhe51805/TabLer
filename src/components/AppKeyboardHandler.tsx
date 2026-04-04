import { useEffect } from "react";
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

      if (metaPressed && key === "enter" && activeTab?.type === "query" && (isMonacoTarget || !isEditableTarget)) {
        e.preventDefault();
        e.stopPropagation();
        onRunActiveQuery();
        return;
      }

      if (metaPressed && !e.altKey && key === "p") {
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

      if (metaPressed && !e.shiftKey && e.key === "0") {
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
        window.dispatchEvent(
          new CustomEvent("toggle-query-results-pane", {
            detail: { tabId: activeTab.id },
          }),
        );
      }

      if (metaPressed && !e.shiftKey && key === "z") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("datagrid-undo"));
        return;
      }

      if (metaPressed && (e.shiftKey && key === "z") || (metaPressed && key === "y")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("datagrid-redo"));
        return;
      }

      if (metaPressed && key === "d") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("datagrid-duplicate-row"));
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeTab, onNewQuery, onRunActiveQuery, onToggleSidebar, onToggleQueryHistory, onToggleSQLFavorites, onToggleTerminalPanel, setUiFontScale, setShowAISlidePanel]);

  return null;
}
