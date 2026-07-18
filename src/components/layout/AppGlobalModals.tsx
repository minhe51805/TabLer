import { lazy, Suspense, useState } from "react";
import { AppAboutModal } from "../AppAboutModal";
import { AppPluginManagerModal } from "../AppPluginManagerModal";
import { AppMcpIntegrationsModal } from "../AppMcpIntegrationsModal";
import { AppUserRolesModal } from "../AppUserRolesModal";
import { AppShortcutsModal } from "../AppShortcutsModal";
import { CommandPalette } from "../CommandPalette/CommandPalette";
import { QuickSwitcher } from "../QuickSwitcher/QuickSwitcher";
import { ThemeCustomizer } from "../ThemeCustomizer/ThemeCustomizer";
import { SafeModeConfirmDialog } from "../SafeMode/SafeModeConfirmDialog";
import { ConnectionExporter, ConnectionImporter } from "../ConnectionExporter";
import { useConnectionStore } from "../../stores/connectionStore";
import { ConnectionConfig } from "../../types/database";
import { DiagnosticBundleModal } from "../DiagnosticBundleModal";

const AISettingsModal = lazy(() => import("../AISettingsModal").then((module) => ({ default: module.AISettingsModal })));

export interface AppGlobalModalsProps {
  showAISettings: boolean;
  setShowAISettings: (show: boolean) => void;
  showAboutModal: boolean;
  setShowAboutModal: (show: boolean) => void;
  showPluginManager: boolean;
  setShowPluginManager: (show: boolean) => void;
  showMcpIntegrations: boolean;
  setShowMcpIntegrations: (show: boolean) => void;
  showUserRoleManagement: boolean;
  setShowUserRoleManagement: (show: boolean) => void;
  showKeyboardShortcutsModal: boolean;
  setShowKeyboardShortcutsModal: (show: boolean) => void;
  showThemeCustomizer: boolean;
  setShowThemeCustomizer: (show: boolean) => void;
  showConnectionExporter: boolean;
  setShowConnectionExporter: (show: boolean) => void;
  showConnectionImporter: boolean;
  setShowConnectionImporter: (show: boolean) => void;
  
  // Dependencies needed by command palette and others
  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  handleToggleSidebar: () => void;
  setShowTerminalPanel: (update: (v: boolean) => boolean) => void;
  handleRunActiveQuery: () => void;
  handleToggleQueryHistory: () => void;
  handleToggleSQLFavorites: () => void;
  handleOpenThemeCustomizer: () => void;
  setShowAISlidePanel: (show: boolean) => void;
}

export function AppGlobalModals({
  showAISettings,
  setShowAISettings,
  showAboutModal,
  setShowAboutModal,
  showPluginManager,
  setShowPluginManager,
  showMcpIntegrations,
  setShowMcpIntegrations,
  showUserRoleManagement,
  setShowUserRoleManagement,
  showKeyboardShortcutsModal,
  setShowKeyboardShortcutsModal,
  showThemeCustomizer,
  setShowThemeCustomizer,
  showConnectionExporter,
  setShowConnectionExporter,
  showConnectionImporter,
  setShowConnectionImporter,
  
  connections,
  activeConnectionId,
  handleToggleSidebar,
  setShowTerminalPanel,
  handleRunActiveQuery,
  handleToggleQueryHistory,
  handleToggleSQLFavorites,
  handleOpenThemeCustomizer,
  setShowAISlidePanel,
}: AppGlobalModalsProps) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  return (
    <>
      {showAISettings && (
        <Suspense fallback={null}>
          <AISettingsModal onClose={() => setShowAISettings(false)} />
        </Suspense>
      )}
      {showAboutModal && (
        <AppAboutModal
          onClose={() => setShowAboutModal(false)}
          onOpenDiagnostics={() => setShowDiagnostics(true)}
        />
      )}
      {showDiagnostics && (
        <DiagnosticBundleModal onClose={() => setShowDiagnostics(false)} />
      )}
      {showPluginManager && (
        <AppPluginManagerModal onClose={() => setShowPluginManager(false)} />
      )}
      {showMcpIntegrations && (
        <AppMcpIntegrationsModal
          connections={connections}
          onClose={() => setShowMcpIntegrations(false)}
        />
      )}
      {showUserRoleManagement && activeConnectionId && (
        <AppUserRolesModal
          connection={connections.find((connection) => connection.id === activeConnectionId) ?? null}
          onClose={() => setShowUserRoleManagement(false)}
        />
      )}
      {showKeyboardShortcutsModal && (
        <AppShortcutsModal onClose={() => setShowKeyboardShortcutsModal(false)} />
      )}
      {showThemeCustomizer && (
        <ThemeCustomizer onClose={() => setShowThemeCustomizer(false)} />
      )}
      <CommandPalette
        onToggleSidebar={handleToggleSidebar}
        onToggleTerminal={() => setShowTerminalPanel((v) => !v)}
        onRunQuery={handleRunActiveQuery}
        onFormatSQL={() => window.dispatchEvent(new CustomEvent("format-sql-palette"))}
        onFocusSQL={() => window.dispatchEvent(new CustomEvent("focus-sql-editor-palette"))}
        onFocusResults={() => window.dispatchEvent(new CustomEvent("focus-results-palette"))}
        onToggleQueryHistory={handleToggleQueryHistory}
        onToggleSQLFavorites={handleToggleSQLFavorites}
        onOpenKeyboardShortcuts={() => setShowKeyboardShortcutsModal(true)}
        onOpenPluginManager={() => setShowPluginManager(true)}
        onOpenSettings={handleOpenThemeCustomizer}
        onOpenAbout={() => setShowAboutModal(true)}
        onOpenSQLFile={() => window.dispatchEvent(new CustomEvent("open-sql-file-palette"))}
        onImportSQLFile={() => window.dispatchEvent(new CustomEvent("import-sql-file-palette"))}
        onClearAIHistory={() => window.dispatchEvent(new CustomEvent("clear-ai-history-palette"))}
        onToggleAISlidePanel={(open) => setShowAISlidePanel(open)}
      />
      <QuickSwitcher
        onOpenSavedQuery={(id) => {
          window.dispatchEvent(new CustomEvent("open-saved-query-switcher", { detail: { id } }));
        }}
        onConnect={(connectionId) => {
          window.dispatchEvent(new CustomEvent("connect-switcher", { detail: { connectionId } }));
        }}
      />
      <SafeModeConfirmDialog />
      {showConnectionExporter && (
        <ConnectionExporter
          connections={connections}
          onClose={() => setShowConnectionExporter(false)}
        />
      )}
      {showConnectionImporter && (
        <ConnectionImporter
          onImport={(_imported) => {
            void useConnectionStore.getState().loadSavedConnections();
          }}
          onClose={() => setShowConnectionImporter(false)}
        />
      )}
    </>
  );
}
