import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AppAboutModal } from "../AppAboutModal";
import { AppPluginManagerModal } from "../AppPluginManagerModal";
import { AppMcpIntegrationsModal } from "../AppMcpIntegrationsModal";
import { AppUserRolesModal } from "../AppUserRolesModal";
import { AppShortcutsModal } from "../AppShortcutsModal";
import { CommandPalette } from "../CommandPalette/CommandPalette";
import { QuickSwitcher } from "../QuickSwitcher/QuickSwitcher";
import { GlobalSearchPanel } from "../GlobalSearch/GlobalSearchPanel";
import { SchemaDiffView } from "../SchemaDiff/SchemaDiffView";
import { ReviewCenter } from "../ReviewCenter/ReviewCenter";
import { ResultDiffModal } from "../ResultDiff/ResultDiffModal";
import { ImportWizard } from "../DataImport/ImportWizard";
import { ThemeCustomizer } from "../ThemeCustomizer/ThemeCustomizer";
import { SafeModeConfirmDialog } from "../SafeMode/SafeModeConfirmDialog";
import { ConfirmDialog } from "../ConfirmDialog";
import { ExportEncryptDialog } from "../ExportEncryptDialog";
import { useConfirmStore, setAppConfirmHostMounted } from "../../stores/confirmStore";
import { useI18n } from "../../i18n";
import { ConnectionExporter, ConnectionImporter } from "../ConnectionExporter";
import { useConnectionStore } from "../../stores/connectionStore";
import { useSqlFavoritesStore } from "../../stores/sql-favorites-store";
import { useQuerySchedulesStore } from "../../stores/query-schedules-store";
import { useUIStore } from "../../stores/uiStore";
import { ConnectionConfig } from "../../types/database";
import { DiagnosticBundleModal } from "../DiagnosticBundleModal";
import { ProfilerLauncher } from "../Profiler";
import { trackUsage, type UsageFeature } from "../../utils/usage-counter";

const AISettingsModal = lazy(() =>
  import("../AISettingsModal").then((module) => ({ default: module.AISettingsModal })),
);

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
  handleImportSqlFile?: () => void;
  handleImportSqlIntoCurrentDatabase?: () => void;
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
  handleImportSqlFile,
  handleImportSqlIntoCurrentDatabase,
  handleOpenThemeCustomizer,
  setShowAISlidePanel,
}: AppGlobalModalsProps) {
  const pendingConfirm = useConfirmStore((state) => state.pending);
  const respondConfirm = useConfirmStore((state) => state.respond);
  const { t } = useI18n();

  useEffect(() => {
    setAppConfirmHostMounted(true);
    return () => setAppConfirmHostMounted(false);
  }, []);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // Local usage counters: count each modal once per open (false → true edge),
  // never per render. Local-only — see utils/usage-counter.
  const prevModalFlags = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const flags: Array<[UsageFeature, boolean]> = [
      ["modal.about", showAboutModal],
      ["modal.aiSettings", showAISettings],
      ["modal.pluginManager", showPluginManager],
      ["modal.mcpIntegrations", showMcpIntegrations],
      ["modal.userRoles", showUserRoleManagement],
      ["modal.shortcuts", showKeyboardShortcutsModal],
      ["modal.themeCustomizer", showThemeCustomizer],
      ["modal.connectionExporter", showConnectionExporter],
      ["modal.connectionImporter", showConnectionImporter],
      ["modal.diagnostics", showDiagnostics],
    ];
    for (const [feature, isOpen] of flags) {
      if (isOpen && !prevModalFlags.current[feature]) trackUsage(feature);
      prevModalFlags.current[feature] = isOpen;
    }
  });

  return (
    <>
      <ProfilerLauncher />
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
      {showDiagnostics && <DiagnosticBundleModal onClose={() => setShowDiagnostics(false)} />}
      {showPluginManager && <AppPluginManagerModal onClose={() => setShowPluginManager(false)} />}
      {showMcpIntegrations && (
        <AppMcpIntegrationsModal
          connections={connections}
          onClose={() => setShowMcpIntegrations(false)}
        />
      )}
      {showUserRoleManagement && activeConnectionId && (
        <AppUserRolesModal
          connection={
            connections.find((connection) => connection.id === activeConnectionId) ?? null
          }
          onClose={() => setShowUserRoleManagement(false)}
        />
      )}
      {showKeyboardShortcutsModal && (
        <AppShortcutsModal onClose={() => setShowKeyboardShortcutsModal(false)} />
      )}
      {showThemeCustomizer && <ThemeCustomizer onClose={() => setShowThemeCustomizer(false)} />}
      <CommandPalette
        onToggleSidebar={handleToggleSidebar}
        onToggleTerminal={() => setShowTerminalPanel((v) => !v)}
        onRunQuery={handleRunActiveQuery}
        onToggleQueryHistory={handleToggleQueryHistory}
        onToggleSQLFavorites={handleToggleSQLFavorites}
        onOpenKeyboardShortcuts={() => setShowKeyboardShortcutsModal(true)}
        onOpenPluginManager={() => setShowPluginManager(true)}
        onOpenSettings={handleOpenThemeCustomizer}
        onOpenAbout={() => setShowAboutModal(true)}
        onOpenSQLFile={handleImportSqlFile}
        onImportSQLFile={handleImportSqlIntoCurrentDatabase}
        onToggleAISlidePanel={(open) => setShowAISlidePanel(open)}
      />
      <QuickSwitcher
        onOpenSavedQuery={(id) => {
          const fav = useSqlFavoritesStore.getState().favorites.find((item) => item.id === id);
          const connectionState = useConnectionStore.getState();
          const targetConnectionId =
            fav?.connectionId || activeConnectionId || connectionState.activeConnectionId;
          if (!fav || !targetConnectionId) return;
          useUIStore.getState().addTab({
            id: `query-${crypto.randomUUID()}`,
            type: "query",
            title: fav.name || "Saved query",
            connectionId: targetConnectionId,
            database: fav.database || connectionState.currentDatabase || undefined,
            content: fav.sql,
          });
        }}
        onConnect={(connectionId) => {
          void useConnectionStore.getState().connectSavedConnection(connectionId);
        }}
      />
      <GlobalSearchPanel />
      <SchemaDiffView />
      <ResultDiffModal />
      <ReviewCenter />
      <ImportWizard />
      <SafeModeConfirmDialog />
      <ConfirmDialog
        isOpen={pendingConfirm !== null}
        title={pendingConfirm?.title ?? ""}
        message={pendingConfirm?.message ?? ""}
        confirmText={pendingConfirm?.confirmText ?? t("common.confirm")}
        cancelText={pendingConfirm?.cancelText ?? t("common.cancel")}
        onConfirm={() => respondConfirm(true)}
        onCancel={() => respondConfirm(false)}
      />
      <ExportEncryptDialog />
      {showConnectionExporter && (
        <ConnectionExporter
          connections={connections}
          onClose={() => setShowConnectionExporter(false)}
        />
      )}
      {showConnectionImporter && (
        <ConnectionImporter
          onImport={() => {
            void useConnectionStore.getState().loadSavedConnections();
            // Bundle imports can also add favorites and schedules.
            void useSqlFavoritesStore.getState().loadFavorites();
            void useQuerySchedulesStore.getState().loadSchedules();
          }}
          onClose={() => setShowConnectionImporter(false)}
        />
      )}
    </>
  );
}
