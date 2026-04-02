/**
 * EventCenter — Cross-component event bus.
 * Inspired by Swift's NotificationCenter in TablePro.
 *
 * Provides a typed custom event system so components can communicate
 * without props drilling or direct imports.
 *
 * Usage:
 *   // Listen
 *   const off = EventCenter.on("workspace-refresh", (e: CustomEvent) => { ... });
 *   // Emit
 *   EventCenter.emit("workspace-refresh", { connectionId, database });
 *   // Cleanup
 *   off();
 */

export type EventMap = {
  // Workspace events
  "workspace-refresh": { connectionId: string; database?: string };
  "workspace-resize": { sidebarWidth: number };
  "workspace-toggle-sidebar": void;
  "workspace-toggle-ai-panel": { prompt?: string };

  // Connection events
  "connection-status-change": { connectionId: string; status: "connecting" | "connected" | "disconnected" | "error" };
  "connection-session-switch": { connectionId: string; database: string };

  // Tab events
  "tab-focus": { tabId: string };
  "tab-close": { tabId: string };
  "tab-create": { type: "query" | "table" | "structure"; connectionId: string; tableName?: string };
  "tab-broadcast": { tabId: string; event: string; data?: unknown };

  // Table data events
  "table-data-updated": { connectionId: string; database?: string; tableName?: string; invalidateStructure?: boolean };
  "table-structure-updated": { connectionId: string; database?: string; tableName: string };

  // AI panel events
  "ai-panel-open": { prompt?: string; context?: Record<string, unknown> };
  "ai-panel-close": void;
  "ai-insert-sql": { sql: string; cursorOffset?: number };

  // Theme events
  "theme-change": { themeId: string };

  // Search events
  "explorer-search-focus": void;
  "explorer-search-submit": { query: string };

  // Metrics events
  "metrics-widget-update": { boardId: string; widgetId: string; query?: string };
  "metrics-board-save": { boardId: string };

  // Query history events
  "query-history-updated": { connectionId?: string };

  // App lifecycle
  "app-ready": void;
  "app-panic": { error: string; stack?: string };
};

// Type-safe event names
export type EventName = keyof EventMap;

// Type-safe event detail
export type EventDetail<N extends EventName> = EventMap[N];

/**
 * Centralized event bus using DOM CustomEvent + event emitter pattern.
 * Components subscribe to typed events and emit events without direct coupling.
 */
export const EventCenter = {
  /** Subscribe to an event. Returns an unsubscribe function. */
  on<N extends EventName>(name: N, listener: (event: CustomEvent<EventDetail<N>>) => void): () => void {
    const handler = (e: Event) => listener(e as CustomEvent<EventDetail<N>>);
    window.addEventListener(name, handler);
    return () => window.removeEventListener(name, handler);
  },

  /** Subscribe to an event once (auto-removes after first fire). */
  once<N extends EventName>(name: N, listener: (event: CustomEvent<EventDetail<N>>) => void): void {
    const handler = (e: Event) => {
      listener(e as CustomEvent<EventDetail<N>>);
      window.removeEventListener(name, handler);
    };
    window.addEventListener(name, handler);
  },

  /** Emit an event. Detail must match the event name. */
  emit<N extends EventName>(name: N, detail: EventDetail<N>): void {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  },

  /** Remove all listeners for a given event (useful in cleanup). */
  removeAllListeners<N extends EventName>(name: N): void {
    window.removeEventListener(name, () => {});
  },
};

// ---------------------------------------------------------------------------
// React hook: useEvent
// ---------------------------------------------------------------------------

import { useEffect } from "react";

/** Hook: subscribe to an EventCenter event, auto-cleans up on unmount. */
export function useEvent<N extends EventName>(
  name: N,
  listener: (detail: EventDetail<N>) => void,
  deps: React.DependencyList = [],
) {
  useEffect(() => {
    const off = EventCenter.on(name, (e) => listener(e.detail));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, ...deps]);
}

/** Hook: emit an event from a component. Returns the emit function. */
export function useEmit<N extends EventName>(name: N) {
  return (detail: EventDetail<N>) => EventCenter.emit(name, detail);
}
