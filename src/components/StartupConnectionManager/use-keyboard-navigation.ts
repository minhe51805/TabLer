import { useEffect } from "react";
import type { ConnectionConfig } from "./types";

interface FlatItem {
  type: "group-header" | "connection";
  groupId?: string;
  connection?: ConnectionConfig;
}

interface Props {
  flatItems: FlatItem[];
  selectedConnectionId: string | null;
  onSelectConnection: (id: string) => void;
  onConnect: (conn: ConnectionConfig) => void;
  onNewConnection: () => void;
  onToggleGroup: (groupId: string) => void;
  onSearchChange: (v: string) => void;
}

export function useKeyboardNavigation({
  flatItems,
  selectedConnectionId,
  onSelectConnection,
  onConnect,
  onNewConnection,
  onToggleGroup,
  onSearchChange,
}: Props) {
  const handleKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInputFocused =
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

    // Escape: clear search or blur
    if (e.key === "Escape") {
      e.preventDefault();
      if (isInputFocused) {
        onSearchChange("");
      }
      target.blur();
      return;
    }

    // Build flat connection-only index
    const connItems = flatItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.type === "connection");

    if (connItems.length === 0) return;

    const currentIdx = connItems.findIndex(
      ({ item }) => item.connection?.id === selectedConnectionId,
    );

    // Arrow navigation
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) {
      e.preventDefault();
      const next = currentIdx < connItems.length - 1 ? currentIdx + 1 : 0;
      const nextConn = connItems[next].item.connection!;
      onSelectConnection(nextConn.id);
      scrollToConnection(nextConn.id);
      return;
    }

    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) {
      e.preventDefault();
      const prev = currentIdx > 0 ? currentIdx - 1 : connItems.length - 1;
      const prevConn = connItems[prev].item.connection!;
      onSelectConnection(prevConn.id);
      scrollToConnection(prevConn.id);
      return;
    }

    // Enter: connect
    if (e.key === "Enter" && !isInputFocused) {
      e.preventDefault();
      if (selectedConnectionId) {
        const conn = flatItems.find(
          (item) => item.type === "connection" && item.connection?.id === selectedConnectionId,
        )?.connection;
        if (conn) onConnect(conn);
      }
      return;
    }

    // Ctrl+N: new connection
    if (e.ctrlKey && e.key === "n") {
      e.preventDefault();
      onNewConnection();
      return;
    }

    // Ctrl+H/L: collapse/expand group
    if (selectedConnectionId && (e.ctrlKey && e.key === "h")) {
      e.preventDefault();
      const groupId = findGroupOfConnection(selectedConnectionId);
      if (groupId) onToggleGroup(groupId);
      return;
    }

    if (selectedConnectionId && (e.ctrlKey && e.key === "l")) {
      e.preventDefault();
      const groupId = findGroupOfConnection(selectedConnectionId);
      if (groupId) onToggleGroup(groupId);
      return;
    }
  };

  const findGroupOfConnection = (connId: string): string | null => {
    const item = flatItems.find(
      (item) => item.type === "connection" && item.connection?.id === connId,
    );
    return item?.groupId ?? null;
  };

  const scrollToConnection = (connId: string) => {
    const el = document.querySelector(
      `.startup-connection-row[data-conn-id="${connId}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flatItems, selectedConnectionId]);
}
