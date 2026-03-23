import { useEffect } from "react";
import type { Tab } from "../types";

interface KeyboardHandlerProps {
  activeTab: Tab | null;
  onNewQuery: () => void;
  onOpenAISlidePanel: (prompt?: string) => void;
  onToggleSidebar: () => void;
  setUiFontScale: (fn: (current: number) => number) => void;
  setShowAISlidePanel: (value: boolean | ((current: boolean) => boolean)) => void;
}

export function AppKeyboardHandler({
  activeTab,
  onNewQuery,
  onOpenAISlidePanel,
  onToggleSidebar,
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
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeTab, onNewQuery, onOpenAISlidePanel, onToggleSidebar, setUiFontScale, setShowAISlidePanel]);

  return null;
}
