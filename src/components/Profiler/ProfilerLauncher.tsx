/**
 * Mounts the Live Profiler modal on demand. Kept self-contained so it wires in
 * with a single tag in AppGlobalModals: it listens for the global
 * `open-live-profiler` window event (dispatched by the Command Palette) and
 * resolves the active connection from the store — no prop drilling.
 */

import { useEffect, useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { ProfilerModal } from "./ProfilerModal";

export function ProfilerLauncher() {
  const connections = useConnectionStore((state) => state.connections);
  const activeConnectionId = useConnectionStore((state) => state.activeConnectionId);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("open-live-profiler", handler);
    return () => window.removeEventListener("open-live-profiler", handler);
  }, []);

  if (!open) return null;
  const active = connections.find((connection) => connection.id === activeConnectionId);
  if (!activeConnectionId || !active) return null;

  return (
    <ProfilerModal
      connectionId={activeConnectionId}
      connectionName={active.name}
      onClose={() => setOpen(false)}
    />
  );
}
