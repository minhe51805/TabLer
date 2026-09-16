/**
 * Wires the Live Profiler in with a single tag in AppGlobalModals: it listens
 * for the global `open-live-profiler` window event (dispatched by the Command
 * Palette / activity rail) and resolves the active connection from the store —
 * no prop drilling.
 *
 * On the desktop shell it opens the profiler in a *detached native window* so it
 * can be dragged outside the app frame. On the web build (no Tauri) it falls
 * back to the in-app modal so the feature still works.
 */

import { useEffect, useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { isTauriDesktopWindow } from "../../hooks/useDesktopWindow";
import { ProfilerModal } from "./ProfilerModal";
import { openProfilerWindow } from "./profilerWindow";

export function ProfilerLauncher() {
  const connections = useConnectionStore((state) => state.connections);
  const activeConnectionId = useConnectionStore((state) => state.activeConnectionId);
  const [openInline, setOpenInline] = useState(false);

  useEffect(() => {
    const handler = () => {
      const active = connections.find((connection) => connection.id === activeConnectionId);
      if (!activeConnectionId || !active) return;
      if (isTauriDesktopWindow()) {
        void openProfilerWindow(activeConnectionId, active.name);
      } else {
        setOpenInline(true);
      }
    };
    window.addEventListener("open-live-profiler", handler);
    return () => window.removeEventListener("open-live-profiler", handler);
  }, [connections, activeConnectionId]);

  if (!openInline) return null;
  const active = connections.find((connection) => connection.id === activeConnectionId);
  if (!activeConnectionId || !active) return null;

  return (
    <ProfilerModal
      connectionId={activeConnectionId}
      connectionName={active.name}
      onClose={() => setOpenInline(false)}
    />
  );
}
