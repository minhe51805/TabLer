/**
 * EventCenter — Cross-component event bus.
 * Provides TableR's typed cross-component event channel.
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
  "connection-status-change": {
    connectionId: string;
    status: "connecting" | "connected" | "disconnected" | "error";
  };
  "connection-session-switch": { connectionId: string; database: string };

  // Tab events
  "tab-focus": { tabId: string };
  "tab-close": { tabId: string };
  "tab-create": { type: "query" | "table" | "structure"; connectionId: string; tableName?: string };
  "tab-broadcast": { tabId: string; event: string; data?: unknown };

  // Table data events
  "table-data-updated": {
    connectionId: string;
    database?: string;
    tableName?: string;
    invalidateStructure?: boolean;
    sourceId?: string;
  };
  "table-structure-updated": { connectionId: string; database?: string; tableName: string };

  // Workspace activity & cache invalidation
  "workspace-activity": {
    connectionId?: string | null;
    label?: string;
    durationMs: number;
  };
  "schema-cache-invalidated": { connectionId: string; database?: string };
  "metrics-boards-updated": { connectionId?: string } | undefined;
  "focus-metrics-widget": { boardId?: string; widgetId: string };

  // AI & workspace navigation bridge
  "open-ai-slide-panel":
    | {
        prompt?: string;
        attachment?: { text?: string; source?: string; boardId?: string };
      }
    | undefined;
  "open-ai-workspace-query": import("../hooks/useWorkspaceEventBridge").OpenAIWorkspaceQueryDetail;
  "open-ai-metrics-board": import("../utils/metrics-board-templates").OpenAIMetricsBoardDetail;
  "open-ai-metrics-board-complete": {
    requestId: string;
  } & import("../utils/metrics-board-templates").OpenAIMetricsBoardCompletionDetail;
  "open-ai-settings": void;
  "open-left-sidebar-panel": {
    panel?: "database" | "metrics";
    focusSearch?: boolean;
  };
  "insert-sql-from-ai": { sql: string };
  "toggle-query-results-pane": { tabId?: string } | undefined;
  "focus-explorer-search": void;
  "open-live-profiler": void;
  "open-keyboard-shortcuts-palette": void;
  "toggle-query-schedules-palette": void;
  "launcher-focus-connection": { connectionId: string; immediate?: boolean };

  // DataGrid scoped keyboard commands
  "datagrid-undo": void;
  "datagrid-redo": void;
  "datagrid-duplicate-row": void;
  "datagrid-fk-preview": void;

  // Palette & UI shell commands
  "format-sql-palette": void;
  "focus-sql-editor-palette": void;
  "focus-results-palette": void;
  "open-sql-file-palette": void;
  "import-sql-file-palette": void;
  "clear-ai-history-palette": void;
  "font-scale-changed": { scale: number };
  "open-connection-form-palette": { intent: "connect" | "bootstrap" };
  "open-data-import-palette": { path?: string } | undefined;
  "open-schema-diff-palette": void;

  // AI panel events
  "ai-panel-open": { prompt?: string; context?: Record<string, unknown> };
  "ai-panel-close": void;
  "ai-insert-sql": { sql: string; cursorOffset?: number };
  // Agent proposes an edit to one query tab's SQL. The tab shows an
  // Accept/Reject proposal — nothing is applied without user consent, and
  // nothing is executed by the agent itself. Mutating proposals carry a
  // non-executing EXPLAIN dry-run result so the user sees the plan (or the
  // syntax error) before accepting.
  "ai-edit-query-sql": {
    tabId: string;
    sql: string;
    reason: string;
    explain?: AiProposalExplainResult;
  };

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

  // Row inspector events
  "row-inspector-open": {
    rowIndex: number;
    row: (string | number | boolean | null)[];
    columns: import("../components/DataGrid/hooks/useDataGrid").ResolvedColumn[];
    primaryKeyValues: Record<string, string | number | boolean | null>;
    tableName?: string;
    database?: string;
    canEdit?: boolean;
    maskedColumnNames?: string[];
    gridInstanceId?: string;
    connectionId?: string;
  };
  "row-inspector-close": void;
  "row-inspector-edit-cell": {
    gridInstanceId?: string;
    connectionId?: string;
    tableName?: string;
    database?: string;
    rowIndex: number;
    columnName: string;
    value: string | number | boolean | null;
  };

  // App lifecycle
  "app-ready": void;
  "app-panic": { error: string; stack?: string };
};

/**
 * Dry-run EXPLAIN outcome attached to a mutating `ai-edit-query-sql` proposal.
 * - `ok`: the engine planned the statement; `summary` is the plan digest.
 * - `error`: EXPLAIN failed on an explainable (DML) statement — the SQL is
 *   almost certainly broken; `error` carries the engine message.
 * - `unsupported`: the engine could not plan this statement kind (DDL is
 *   best-effort); `error` carries the engine message for context.
 */
export interface AiProposalExplainResult {
  status: "ok" | "error" | "unsupported";
  summary?: string;
  error?: string;
}

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
  on<N extends EventName>(
    name: N,
    listener: (event: CustomEvent<EventDetail<N>>) => void,
  ): () => void {
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

  /** Emit an event. Detail is optional only for void / optional-detail events. */
  emit<N extends EventName>(
    name: N,
    ...args: undefined extends EventDetail<N> ? [detail?: EventDetail<N>] : [detail: EventDetail<N>]
  ): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(name, { detail: args[0] }));
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
