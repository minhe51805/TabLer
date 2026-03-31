import { useEffect } from "react";
import type { Tab } from "../types";

interface KeyboardHandlerProps {
  activeTab: Tab | null;
  onNewQuery: () => void;
  onOpenAISlidePanel: (prompt?: string) => void;
  onToggleSidebar: () => void;
  onToggleQueryHistory: () => void;
  onToggleSQLFavorites: () => void;
  setUiFontScale: (fn: (current: number) => number) => void;
  setShowAISlidePanel: (value: boolean | ((current: boolean) => boolean)) => void;
}

export function AppKeyboardHandler({
  activeTab,
  onNewQuery,
  onOpenAISlidePanel,
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

      if (metaPressed && !e.altKey && key === "p") {
        e.preventDefault();
        e.stopPropagation();
        onOpenAISlidePanel();
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
        setUiFontScale((current) => Math.min(135, current + 5));
        return;
      }

      if (metaPressed && !e.shiftKey && e.key === "-") {
        e.preventDefault();
        setUiFontScale((current) => Math.max(85, current - 5));
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

      if (metaPressed && e.code === "Backquote") {
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
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeTab, onNewQuery, onOpenAISlidePanel, onToggleSidebar, onToggleQueryHistory, onToggleSQLFavorites, setUiFontScale, setShowAISlidePanel]);

  return null;
}
