import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../stores/appStore";

export interface DeepLinkConnectPayload {
  action: "connect";
  host?: string;
  port?: number;
  database?: string;
  db_type?: string;
  user?: string;
  password?: string;
}

export interface DeepLinkQueryPayload {
  action: "query";
  connection?: string;
  sql?: string;
}

export interface DeepLinkTablePayload {
  action: "table";
  connection?: string;
  database?: string;
  table?: string;
}

export type DeepLinkPayload = DeepLinkConnectPayload | DeepLinkQueryPayload | DeepLinkTablePayload;

export function useDeepLink(
  isDesktopWindow: boolean,
  isConnected: boolean,
  handleOpenConnectionForm: (intent: "connect") => void,
  setQueryRunRequestByTab: React.Dispatch<React.SetStateAction<Record<string, number>>>
) {
  const {
    activeConnectionId,
    currentDatabase,
    addTab,
    setActiveTab,
  } = useAppStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      currentDatabase: state.currentDatabase,
      addTab: state.addTab,
      setActiveTab: state.setActiveTab,
    }))
  );

  useEffect(() => {
    if (!isDesktopWindow) return;

    let unlisten: (() => void) | undefined;

    listen<string>("deep-link", async (event) => {
      const url: string = event.payload;
      try {
        const parsed = await invoke<DeepLinkPayload>("parse_deep_link", { url });

        if (parsed.action === "connect") {
          const conn = parsed;
          const confirmed = window.confirm(
            `Open TableR and connect to ${conn.host || "database"}:${conn.port || ""}?`
          );
          if (!confirmed) return;

          handleOpenConnectionForm("connect");
          // Dispatch to connection form via event
          window.dispatchEvent(new CustomEvent("tabler-deep-link-connect", {
            detail: {
              host: conn.host,
              port: conn.port,
              database: conn.database,
              dbType: conn.db_type,
              user: conn.user,
              password: conn.password,
            },
          }));
        } else if (parsed.action === "query") {
          const q = parsed;
          const sql = q.sql || "";
          if (!sql) return;

          if (!isConnected) {
            const confirmed = window.confirm(
              `Open query tab with SQL?\n\n${sql.length > 200 ? sql.slice(0, 200) + "..." : sql}\n\n(Requires an active connection to execute.)`
            );
            if (!confirmed) return;
          }

          if (!isConnected || !activeConnectionId) {
            handleOpenConnectionForm("connect");
            return;
          }

          const tabId = `query-${crypto.randomUUID()}`;
          const finalTabId = tabId;
          addTab({
            id: tabId,
            type: "query",
            title: "Deep Link Query",
            connectionId: activeConnectionId,
            database: currentDatabase || undefined,
            content: sql,
          });

          setActiveTab(finalTabId);
          setQueryRunRequestByTab((prev) => ({
            ...prev,
            [finalTabId]: (prev[finalTabId] ?? 0) + 1,
          }));
        } else if (parsed.action === "table") {
          const t = parsed;
          const connectionId = t.connection || activeConnectionId;
          if (!connectionId) {
            handleOpenConnectionForm("connect");
            return;
          }

          const tabId = `table-${crypto.randomUUID()}`;
          addTab({
            id: tabId,
            type: "table",
            title: t.table || "Table",
            connectionId,
            database: t.database || currentDatabase || undefined,
            tableName: t.table,
          });
          setActiveTab(tabId);
        }
      } catch (err) {
        console.error("[DeepLink] Failed to parse URL:", url, err);
      }
    }).then((off: () => void) => {
      unlisten = off;
    });

    return () => {
      unlisten?.();
    };
  }, [
    isDesktopWindow,
    isConnected,
    activeConnectionId,
    currentDatabase,
    addTab,
    setActiveTab,
    setQueryRunRequestByTab,
    handleOpenConnectionForm,
  ]);
}
