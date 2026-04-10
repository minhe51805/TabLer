import { lazy, Suspense } from "react";
import { AppAboutModal } from "../AppAboutModal";
import { AppPluginManagerModal } from "../AppPluginManagerModal";
import { AppShortcutsModal } from "../AppShortcutsModal";
import { CommandPalette } from "../CommandPalette/CommandPalette";
import { QuickSwitcher } from "../QuickSwitcher/QuickSwitcher";
import { ThemeCustomizer } from "../ThemeCustomizer/ThemeCustomizer";
import { SafeModeConfirmDialog } from "../SafeMode/SafeModeConfirmDialog";
import { ConnectionExporter, ConnectionImporter } from "../ConnectionExporter";
import { useAppStore } from "../../stores/appStore";
import { ConnectionConfig } from "../../types/database";

const AISettingsModal = lazy(() => import("../AISettingsModal").then((module) => ({ default: module.AISettingsModal })));

export interface AppGlobalModalsProps {
  showAISettings: boolean;
  setShowAISettings: (show: boolean) => void;
  showAboutModal: boolean;
  setShowAboutModal: (show: boolean) => void;
  showPluginManager: boolean;
  setShowPluginManager: (show: boolean) => void;
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
  showKeyboardShortcutsModal,
  setShowKeyboardShortcutsModal,
  showThemeCustomizer,
  setShowThemeCustomizer,
  showConnectionExporter,
  setShowConnectionExporter,
  showConnectionImporter,
  setShowConnectionImporter,
  
  connections,
  handleToggleSidebar,
  setShowTerminalPanel,
  handleRunActiveQuery,
  handleToggleQueryHistory,
  handleToggleSQLFavorites,
  handleOpenThemeCustomizer,
  setShowAISlidePanel,
}: AppGlobalModalsProps) {

  return (
    <>
      {showAISettings && (
        <Suspense fallback={null}>
          <AISettingsModal onClose={() => setShowAISettings(false)} />
        </Suspense>
      )}
      {showAboutModal && (
        <AppAboutModal onClose={() => setShowAboutModal(false)} />
      )}
      {showPluginManager && (
        <AppPluginManagerModal onClose={() => setShowPluginManager(false)} />
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
            void useAppStore.getState().loadSavedConnections();
          }}
          onClose={() => setShowConnectionImporter(false)}
        />
      )}
    </>
  );
}
