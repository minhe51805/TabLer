import { useEffect, type Dispatch, type SetStateAction } from "react";

import { useAppLayoutStore } from "../stores/appLayoutStore";
import { useModalStore } from "../stores/modalStore";
import type { WindowMenuSectionKey } from "../types/app-types";

interface UseWorkspaceShellSyncOptions {
  activeConnectionId: string | null;
  connectedIds: Set<string>;
  isConnecting: boolean;
  isConnected: boolean;
  isConnectionFormOpen: boolean;
  isRecoveryDelayActive: boolean;
  activeTabType?: string;
  setShowAIWorkspace: Dispatch<SetStateAction<boolean>>;
  setActiveWindowMenuSection: Dispatch<SetStateAction<WindowMenuSectionKey | null>>;
}

export function useWorkspaceShellSync({
  activeConnectionId,
  connectedIds,
  isConnecting,
  isConnected,
  isConnectionFormOpen,
  isRecoveryDelayActive,
  activeTabType,
  setShowAIWorkspace,
  setActiveWindowMenuSection,
}: UseWorkspaceShellSyncOptions) {
  const setConnectionFormIntent = useModalStore((state) => state.setConnectionFormIntent);
  const setShowStartupConnectionManager = useModalStore(
    (state) => state.setShowStartupConnectionManager,
  );
  const setForceLauncherVisible = useAppLayoutStore((state) => state.setForceLauncherVisible);
  const setLeftPanel = useAppLayoutStore((state) => state.setLeftPanel);

  useEffect(() => {
    setLeftPanel("database");
  }, [activeConnectionId, connectedIds, isConnecting, setLeftPanel]);

  useEffect(() => {
    if (!activeConnectionId || (!connectedIds.has(activeConnectionId) && !isConnecting)) return;
    setForceLauncherVisible(false);
    setShowStartupConnectionManager(false);
    setConnectionFormIntent(null);
  }, [
    activeConnectionId,
    connectedIds,
    isConnecting,
    setConnectionFormIntent,
    setForceLauncherVisible,
    setShowStartupConnectionManager,
  ]);

  useEffect(() => {
    if (isConnected || isConnecting || isConnectionFormOpen || isRecoveryDelayActive) return;
    setShowStartupConnectionManager(true);
    setShowAIWorkspace(false);
    setActiveWindowMenuSection(null);
  }, [
    isConnected,
    isConnecting,
    isConnectionFormOpen,
    isRecoveryDelayActive,
    setActiveWindowMenuSection,
    setShowAIWorkspace,
    setShowStartupConnectionManager,
  ]);

  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;
    if (activeTabType === "metrics") {
      setLeftPanel("metrics");
      return;
    }
    setLeftPanel((current) => (current === "metrics" ? "database" : current));
  }, [activeConnectionId, activeTabType, connectedIds, setLeftPanel]);
}
