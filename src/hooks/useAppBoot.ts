import { useEffect } from "react";
import { pushSafeModePolicyToBackend } from "../stores/safeModeStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useConnectionHealthMonitor } from "./useConnectionHealthMonitor";
import { useTabPersistence } from "./useTabPersistence";
import { useDeepLink } from "./useDeepLink";

/**
 * Roadmap Phase 1A: app boot side effects (connection hydration, safe-mode
 * policy push, tab persistence, deep links), extracted from App.tsx.
 */
export function useAppBoot(activeConnectionId: string | null, connectedIds: Set<string>, isDesktopWindow: boolean) {
  useConnectionHealthMonitor();
  const loadSavedConnections = useConnectionStore((state) => state.loadSavedConnections);

  useEffect(() => {
    void loadSavedConnections();
  }, [loadSavedConnections]);

  useEffect(() => {
    pushSafeModePolicyToBackend();
  }, []);

  useTabPersistence(activeConnectionId, connectedIds);

  useDeepLink(isDesktopWindow);
}
