import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { APP_EVENTS } from "@/utils/app-events";
import { EventCenter } from "@/stores/event-center";
import { CommandPalette } from "@/components/CommandPalette/CommandPalette";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { AppKeyboardHandler } from "@/components/AppKeyboardHandler";

describe("EventCenter and APP_EVENTS bus", () => {
  it("interoperates bidirectionally with DOM CustomEvent listeners and unsubscribes cleanly", () => {
    const busListener = vi.fn();
    const domListener = vi.fn();

    const off = EventCenter.on(APP_EVENTS.tableDataUpdated, (event) => {
      busListener(event.detail);
    });
    window.addEventListener(APP_EVENTS.focusExplorerSearch, domListener);

    act(() => {
      EventCenter.emit(APP_EVENTS.tableDataUpdated, {
        connectionId: "conn-1",
        tableName: "users",
        sourceId: "grid-a",
      });
      window.dispatchEvent(
        new CustomEvent(APP_EVENTS.tableDataUpdated, {
          detail: { connectionId: "conn-2", tableName: "orders", sourceId: "grid-b" },
        }),
      );
      EventCenter.emit(APP_EVENTS.focusExplorerSearch);
    });

    expect(busListener).toHaveBeenCalledTimes(2);
    expect(busListener).toHaveBeenNthCalledWith(1, {
      connectionId: "conn-1",
      tableName: "users",
      sourceId: "grid-a",
    });
    expect(busListener).toHaveBeenNthCalledWith(2, {
      connectionId: "conn-2",
      tableName: "orders",
      sourceId: "grid-b",
    });
    expect(domListener).toHaveBeenCalledTimes(1);

    off();
    window.removeEventListener(APP_EVENTS.focusExplorerSearch, domListener);

    EventCenter.emit(APP_EVENTS.tableDataUpdated, { connectionId: "conn-3" });
    EventCenter.emit(APP_EVENTS.focusExplorerSearch);
    expect(busListener).toHaveBeenCalledTimes(2);
    expect(domListener).toHaveBeenCalledTimes(1);
  });

  it("handles CommandPalette events without recursive re-dispatch (Bug EV-1)", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const formatListener = vi.fn();
    const focusSqlListener = vi.fn();
    const focusResultsListener = vi.fn();
    const clearAiListener = vi.fn();

    const offFormat = EventCenter.on(APP_EVENTS.formatSqlPalette, formatListener);
    const offFocusSql = EventCenter.on(APP_EVENTS.focusSqlEditorPalette, focusSqlListener);
    const offFocusResults = EventCenter.on(APP_EVENTS.focusResultsPalette, focusResultsListener);
    const offClearAi = EventCenter.on(APP_EVENTS.clearAiHistoryPalette, clearAiListener);

    try {
      act(() => {
        useCommandPaletteStore.setState({ isOpen: true });
        root.render(createElement(CommandPalette));
      });

      expect(() => {
        act(() => {
          EventCenter.emit(APP_EVENTS.formatSqlPalette);
          EventCenter.emit(APP_EVENTS.focusSqlEditorPalette);
          EventCenter.emit(APP_EVENTS.focusResultsPalette);
          EventCenter.emit(APP_EVENTS.clearAiHistoryPalette);
        });
      }).not.toThrow();

      expect(formatListener).toHaveBeenCalledTimes(1);
      expect(focusSqlListener).toHaveBeenCalledTimes(1);
      expect(focusResultsListener).toHaveBeenCalledTimes(1);
      expect(clearAiListener).toHaveBeenCalledTimes(1);
      expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    } finally {
      offFormat();
      offFocusSql();
      offFocusResults();
      offClearAi();
      act(() => root.unmount());
      container.remove();
    }
  });

  it("does not toggle Vim mode on Ctrl+Shift+V inside .datagrid-shell (Bug DG-4)", () => {
    const onToggleVimMode = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          createElement(
            "div",
            null,
            createElement(AppKeyboardHandler, {
              activeTab: null,
              onNewQuery: vi.fn(),
              onRunActiveQuery: vi.fn(),
              onToggleTerminalPanel: vi.fn(),
              onToggleSidebar: vi.fn(),
              onToggleQueryHistory: vi.fn(),
              onToggleSQLFavorites: vi.fn(),
              onToggleVimMode,
              onOpenCommandPalette: vi.fn(),
              onOpenQuickSwitcher: vi.fn(),
              onOpenGlobalSearch: vi.fn(),
              setUiFontScale: vi.fn(),
              setShowAISlidePanel: vi.fn(),
            }),
            createElement(
              "div",
              { className: "datagrid-shell" },
              createElement("div", { tabIndex: 0, "data-testid": "grid-target" }),
            ),
          ),
        );
      });

      const gridTarget = container.querySelector('[data-testid="grid-target"]') as HTMLElement;
      expect(gridTarget).not.toBeNull();

      const gridEvent = new KeyboardEvent("keydown", {
        key: "V",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        gridTarget.dispatchEvent(gridEvent);
      });

      expect(onToggleVimMode).not.toHaveBeenCalled();
      expect(gridEvent.defaultPrevented).toBe(false);

      const globalEvent = new KeyboardEvent("keydown", {
        key: "V",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.body.dispatchEvent(globalEvent);
      });

      expect(onToggleVimMode).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
