import type { Tab } from "../types";
import { invokeMutation, invokeWithTimeout } from "./tauri-utils";

const TAB_PERSISTENCE_TIMEOUT_MS = 15_000;

export interface PersistedTab {
  tabId: string;
  tabType: "query" | "table" | "structure" | "metrics" | "er-diagram";
  title: string;
  database?: string;
  tableName?: string;
  content?: string;
  scrollTop?: number;
  panelHeights?: { editorHeight?: number; resultsHeight?: number };
  isActive: boolean;
  createdAtMs: number;
}

function buildPersistableTabs(tabs: Tab[], activeTabId: string | null): PersistedTab[] {
  return tabs
    .filter((tab) => tab.type !== "metrics")
    .map((tab): PersistedTab => ({
      tabId: tab.id,
      tabType: tab.type,
      title: tab.title,
      database: tab.database,
      tableName: tab.tableName,
      content: tab.content,
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
