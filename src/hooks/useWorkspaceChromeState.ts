import { useDeferredAppSurfaces } from "./useDeferredAppSurfaces";
import { getLastPathSegment } from "../utils/path-utils";
import { getQueryProfile } from "../utils/query-profile";
import type { ConnectionConfig, Tab } from "../types/database";
import type { WorkspaceActivityState } from "../types/app-types";

interface WorkspaceChromeStateInputs {
  isRecoverableErrorDelayActive: boolean;
  isConnecting: boolean;
  connectionFormIntent: "connect" | "bootstrap" | null;
  activeConnectionId: string | null;
  activeConn: ConnectionConfig | undefined;
  connectedIds: Set<string>;
  forceLauncherVisible: boolean;
  showStartupConnectionManager: boolean;
  activeTab: Tab | null;
  workspaceActivityByConnection: Record<string, WorkspaceActivityState>;
  currentDatabase: string | null;
  showAISettings: boolean;
  showAboutModal: boolean;
  showPluginManager: boolean;
  showMcpIntegrations: boolean;
  showUserRoleManagement: boolean;
  showKeyboardShortcutsModal: boolean;
  showThemeCustomizer: boolean;
  showConnectionExporter: boolean;
  showConnectionImporter: boolean;
  isCommandPaletteOpen: boolean;
  isQuickSwitcherOpen: boolean;
  showAISlidePanel: boolean;
  isConnected: boolean;
  tabs: Tab[];
}

/**
 * Roadmap Phase 1A: derived workspace chrome state extracted verbatim from
 * App.tsx (launcher gating, titlebar labels, modal-mount gating).
 */
export function useWorkspaceChromeState(inputs: WorkspaceChromeStateInputs) {
  const {
    isRecoverableErrorDelayActive, isConnecting, connectionFormIntent, activeConnectionId,
    activeConn, connectedIds, forceLauncherVisible, showStartupConnectionManager, activeTab,
    workspaceActivityByConnection, currentDatabase, showAISettings, showAboutModal,
    showPluginManager, showMcpIntegrations, showUserRoleManagement, showKeyboardShortcutsModal,
    showThemeCustomizer, showConnectionExporter, showConnectionImporter, isCommandPaletteOpen,
    isQuickSwitcherOpen, showAISlidePanel, isConnected, tabs,
  } = inputs;

  const shouldForceStartupLauncher =
    !isRecoverableErrorDelayActive &&
    !isConnecting &&
    !connectionFormIntent &&
    (!activeConnectionId || !activeConn || !connectedIds.has(activeConnectionId));
  const showStartupShell =
    forceLauncherVisible ||
    (!isRecoverableErrorDelayActive &&
      (shouldForceStartupLauncher ||
        (!isConnected && !isConnecting && (showStartupConnectionManager || !!connectionFormIntent))));
  const isMetricsWorkspace = activeTab?.type === "metrics";
  const activeWorkspaceActivity =
    activeConnectionId ? workspaceActivityByConnection[activeConnectionId] ?? null : null;
  const activeQueryProfile = getQueryProfile(activeConn?.db_type);
  const supportsSqlFileActions = !!(activeConnectionId && activeConn && activeQueryProfile.surface === "sql");
  const queryTabCount = tabs.filter(
    (tab) => tab.type === "query" && tab.connectionId === activeConnectionId,
  ).length;
  const activeDatabaseLabel =
    activeConn?.db_type === "sqlite" ? getLastPathSegment(currentDatabase) : currentDatabase || "";
  const titlebarContextTitle = `${activeConn?.name || activeConn?.host || ""}${
    currentDatabase ? ` / ${currentDatabase}` : ""
  }`;
  const titlebarContextLabel = `${activeConn?.name || activeConn?.host || ""}${
    activeDatabaseLabel ? ` / ${activeDatabaseLabel}` : ""
  }`;
  const shouldMountGlobalModalsNow =
    showAISettings ||
    showAboutModal ||
    showPluginManager ||
    showMcpIntegrations ||
    showUserRoleManagement ||
    showKeyboardShortcutsModal ||
    showThemeCustomizer ||
    showConnectionExporter ||
    showConnectionImporter ||
    isCommandPaletteOpen ||
    isQuickSwitcherOpen;
  const {
    hasMountedAIWorkspace: hasMountedAISlidePanel,
    hasMountedGlobalModals,
  } = useDeferredAppSurfaces(showAISlidePanel, shouldMountGlobalModalsNow);
  const shouldRenderGlobalModals = hasMountedGlobalModals || shouldMountGlobalModalsNow;

  return {
    shouldForceStartupLauncher, showStartupShell, isMetricsWorkspace, activeWorkspaceActivity,
    activeQueryProfile, supportsSqlFileActions, queryTabCount, activeDatabaseLabel,
    titlebarContextTitle, titlebarContextLabel, shouldMountGlobalModalsNow,
    hasMountedAISlidePanel, hasMountedGlobalModals, shouldRenderGlobalModals,
  };
}