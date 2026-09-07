import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppLayoutStore } from "../stores/appLayoutStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useUIStore } from "../stores/uiStore";
import { emitAppToast } from "../utils/app-toast";

interface DeepLinkBase {
  connection: string;
  database?: string;
}

export interface DeepLinkConnectPayload extends DeepLinkBase {
  action: "connect";
}

export interface DeepLinkQueryPayload extends DeepLinkBase {
  action: "query";
  sql?: string;
}

export interface DeepLinkTablePayload extends DeepLinkBase {
  action: "table";
  schema?: string;
  table: string;
}

export interface DeepLinkMetricsPayload extends DeepLinkBase {
  action: "metrics";
  board?: string;
}

export interface DeepLinkErdPayload extends DeepLinkBase {
  action: "erd";
}

export type DeepLinkPayload =
  | DeepLinkConnectPayload
  | DeepLinkQueryPayload
  | DeepLinkTablePayload
  | DeepLinkMetricsPayload
  | DeepLinkErdPayload;

async function resolveSavedConnection(connectionId: string) {
  let state = useConnectionStore.getState();
  if (!state.connections.some((connection) => connection.id === connectionId)) {
    await state.loadSavedConnections();
    state = useConnectionStore.getState();
  }
  const connection = state.connections.find((item) => item.id === connectionId);
  if (!connection) {
    throw new Error(`Saved connection "${connectionId}" was not found.`);
  }
  return connection;
}

async function activateTarget(payload: DeepLinkBase) {
  const connection = await resolveSavedConnection(payload.connection);
  let state = useConnectionStore.getState();
  if (
    state.activeConnectionId !== payload.connection ||
    !state.connectedIds.has(payload.connection)
  ) {
    await state.connectSavedConnection(payload.connection);
    state = useConnectionStore.getState();
  }
  if (payload.database && state.currentDatabase !== payload.database) {
    await state.switchDatabase(payload.connection, payload.database);
  }
  return connection;
}

function describeRequest(payload: DeepLinkPayload, connectionName: string) {
  switch (payload.action) {
    case "connect":
      return `Connect to saved workspace "${connectionName}"?`;
    case "query": {
      const preview = payload.sql?.trim();
      return preview
        ? `Open a query in "${connectionName}"?\n\n${preview.slice(0, 300)}${preview.length > 300 ? "..." : ""}\n\nThe query will not run automatically.`
        : `Open a blank query in "${connectionName}"?`;
    }
    case "table":
      return `Open table "${payload.schema ? `${payload.schema}.` : ""}${payload.table}" in "${connectionName}"?`;
    case "metrics":
      return `Open Metrics in "${connectionName}"?`;
    case "erd":
      return `Open the ER Diagram in "${connectionName}"?`;
  }
}

async function handleDeepLink(payload: DeepLinkPayload) {
  const savedConnection = await resolveSavedConnection(payload.connection);
  if (!window.confirm(describeRequest(payload, savedConnection.name))) return;

  await activateTarget(payload);
  if (payload.action === "connect") return;

  const ui = useUIStore.getState();
  const database = payload.database || useConnectionStore.getState().currentDatabase || undefined;
  if (payload.action === "query") {
    const id = `query-${crypto.randomUUID()}`;
    ui.addTab({
      id,
      type: "query",
      title: "Linked Query",
      connectionId: payload.connection,
      database,
      content: payload.sql || "",
    });
    ui.setActiveTab(id);
    return;
  }
  if (payload.action === "table") {
    const tableName = payload.schema ? `${payload.schema}.${payload.table}` : payload.table;
    const id = `table-${crypto.randomUUID()}`;
    ui.addTab({
      id,
      type: "table",
      title: payload.table,
      connectionId: payload.connection,
      database,
      tableName,
    });
    ui.setActiveTab(id);
    return;
  }
  if (payload.action === "metrics") {
    const id = `metrics-${crypto.randomUUID()}`;
    useAppLayoutStore.getState().setLeftPanel("metrics");
    ui.addTab({
      id,
      type: "metrics",
      title: "Metrics",
      connectionId: payload.connection,
      database,
      metricsBoardId: payload.board,
    });
    ui.setActiveTab(id);
    return;
  }

  const id = `er-${crypto.randomUUID()}`;
  useAppLayoutStore.getState().setLeftPanel("database");
  ui.addTab({
    id,
    type: "er-diagram",
    title: "ER Diagram",
    connectionId: payload.connection,
    database,
  });
  ui.setActiveTab(id);
}

export function useDeepLink(isDesktopWindow: boolean) {
  useEffect(() => {
    if (!isDesktopWindow) return;
    let unlisten: (() => void) | undefined;
    let handling = false;

    listen<string>("deep-link", async (event) => {
      if (handling) return;
      handling = true;
      try {
        const payload = await invoke<DeepLinkPayload>("parse_deep_link", {
          url: event.payload,
        });
        await handleDeepLink(payload);
      } catch (error) {
        emitAppToast({
          tone: "error",
          title: "Could not open link",
          description: String(error),
        });
      } finally {
        handling = false;
      }
    }).then((off) => {
      unlisten = off;
    });

    return () => unlisten?.();
  }, [isDesktopWindow]);
}
