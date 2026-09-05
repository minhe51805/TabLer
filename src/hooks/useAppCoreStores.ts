import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "../stores/connectionStore";
import { useGlobalErrorStore } from "../stores/globalErrorStore";
import { useUIStore } from "../stores/uiStore";
import { useModalStore } from "../stores/modalStore";
import { useAppLayoutStore } from "../stores/appLayoutStore";

/**
 * Roadmap Phase 1A: the App-level store selector bundles, extracted verbatim
 * from App.tsx so the component stays a thin composition root.
 */
export function useAppCoreStores() {
  const {
    activeConnectionId,
    connectedIds,
    connections,
    currentDatabase,
    isConnecting,
    loadSavedConnections,
    fetchDatabases,
    fetchTables,
    fetchSchemaObjects,
  } = useConnectionStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      connectedIds: state.connectedIds,
      connections: state.connections,
      currentDatabase: state.currentDatabase,
      isConnecting: state.isConnecting,
      loadSavedConnections: state.loadSavedConnections,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
      fetchSchemaObjects: state.fetchSchemaObjects,
    }))
  );
  const { error, clearError, setError } = useGlobalErrorStore(
    useShallow((state) => ({
      error: state.error,
      clearError: state.clearError,
      setError: state.setError,
    })),
  );
  const { tabs, activeTabId, addTab, setActiveTab } = useUIStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      addTab: state.addTab,
      setActiveTab: state.setActiveTab,
    })),
  );

  const {
    connectionFormIntent,
    showStartupConnectionManager,
    showAISettings, setShowAISettings,
    showAboutModal, setShowAboutModal,
    showPluginManager, setShowPluginManager,
    showMcpIntegrations, setShowMcpIntegrations,
    showUserRoleManagement, setShowUserRoleManagement,
    showKeyboardShortcutsModal, setShowKeyboardShortcutsModal,
    showThemeCustomizer, setShowThemeCustomizer,
    showConnectionExporter, setShowConnectionExporter,
    showConnectionImporter, setShowConnectionImporter
  } = useModalStore();

  const {
    setShowTerminalPanel,
    showQueryHistory, setShowQueryHistory,
    showSQLFavorites, setShowSQLFavorites,
    showRowInspector,
    rowInspectorData,
    isSidebarCollapsed,
    sidebarWidth, setSidebarWidth,
    isWindowMaximized,
    forceLauncherVisible
  } = useAppLayoutStore();
  return {
    connection: { activeConnectionId, connectedIds, connections, currentDatabase, isConnecting, loadSavedConnections, fetchDatabases, fetchTables, fetchSchemaObjects },
    errors: { error, clearError, setError },
    ui: { tabs, activeTabId, addTab, setActiveTab },
    modals: { connectionFormIntent, showStartupConnectionManager, showAISettings, setShowAISettings, showAboutModal, setShowAboutModal, showPluginManager, setShowPluginManager, showMcpIntegrations, setShowMcpIntegrations, showUserRoleManagement, setShowUserRoleManagement, showKeyboardShortcutsModal, setShowKeyboardShortcutsModal, showThemeCustomizer, setShowThemeCustomizer, showConnectionExporter, setShowConnectionExporter, showConnectionImporter, setShowConnectionImporter },
    layout: { setShowTerminalPanel, showQueryHistory, setShowQueryHistory, showSQLFavorites, setShowSQLFavorites, showRowInspector, rowInspectorData, isSidebarCollapsed, sidebarWidth, setSidebarWidth, isWindowMaximized, forceLauncherVisible },
  };
}