import type { Tab } from "../types";
import { invokeMutation, invokeWithTimeout } from "./tauri-utils";

const TAB_PERSISTENCE_TIMEOUT_MS = 15_000;

/**
 * Max query/editor content (in UTF-16 code units) persisted per tab.
 *
 * Large SQL dumps can be multiple megabytes on a single tab. Serializing them to
 * JSON on every tab save (and again on the Rust side via `serde_json::to_string_pretty`)
 * stalls the save path and can freeze the UI. When content exceeds this cap we drop it
 * from the snapshot rather than block persistence; the tab is still restored, just empty.
 */
export const MAX_PERSISTABLE_CONTENT_LENGTH = 500_000;

export interface PersistedTab {
  tabId: string;
  tabType: "query" | "table" | "structure" | "metrics" | "er-diagram";
  title: string;
  database?: string;
  tableName?: string;
  content?: string;
  cursorLine?: number;
  cursorColumn?: number;
  scrollTop?: number;
  panelHeights?: { editorHeight?: number; resultsHeight?: number };
  isActive: boolean;
  createdAtMs: number;
}

/** Drop tab content that exceeds the persistence cap to keep snapshots small. */
function persistableContent(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  return content.length > MAX_PERSISTABLE_CONTENT_LENGTH ? "" : content;
}

export function buildPersistableTabs(tabs: Tab[], activeTabId: string | null): PersistedTab[] {
  return tabs
    .filter((tab) => tab.type !== "metrics")
    .map((tab): PersistedTab => ({
      tabId: tab.id,
      tabType: tab.type,
      title: tab.title,
      database: tab.database,
      tableName: tab.tableName,
      content: persistableContent(tab.content),
      cursorLine: tab.editorCursor?.lineNumber,
      cursorColumn: tab.editorCursor?.column,
      isActive: tab.id === activeTabId,
      createdAtMs: Date.now(),
    }));
}

export async function saveTabState(
  connectionId: string,
  tabs: Tab[],
  activeTabId: string | null,
): Promise<void> {
  try {
    await invokeMutation("save_tabs", {
      connectionId,
      tabsJson: JSON.stringify(buildPersistableTabs(tabs, activeTabId)),
    });
  } catch (error) {
    // Non-critical: tab restore should never block the app.
    console.warn("[TabPersistence] Failed to save tabs:", error);
  }
}

export async function loadTabState(connectionId: string): Promise<PersistedTab[]> {
  try {
    const tabs = await invokeWithTimeout<PersistedTab[]>(
      "load_tabs",
      { connectionId },
      TAB_PERSISTENCE_TIMEOUT_MS,
      "Loading persisted tabs",
    );
    return tabs || [];
  } catch (error) {
    console.warn("[TabPersistence] Failed to load tabs:", error);
    return [];
  }
}

export function restoreTabSnapshot(snapshot: PersistedTab, connectionId: string): Tab | null {
  const baseTab: Tab = {
    id: snapshot.tabId,
    type: snapshot.tabType,
    title: snapshot.title,
    connectionId,
    database: snapshot.database,
  };

  switch (snapshot.tabType) {
    case "query":
      return {
        ...baseTab,
        content: snapshot.content,
        editorCursor:
          snapshot.cursorLine && snapshot.cursorColumn
            ? { lineNumber: snapshot.cursorLine, column: snapshot.cursorColumn }
            : undefined,
      };
    case "table":
    case "structure":
      return snapshot.tableName ? { ...baseTab, tableName: snapshot.tableName } : null;
    case "er-diagram":
      return baseTab;
    case "metrics":
      return null;
  }
}
