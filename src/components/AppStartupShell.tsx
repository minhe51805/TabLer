import { Suspense, type ReactNode } from "react";
import { StartupConnectionManager } from "./StartupConnectionManager";
import { TitleBarWindowControls } from "./TitleBarWindowControls";

interface AppStartupShellProps {
  connectionFormIntent: "connect" | "bootstrap" | undefined;
  showStartupConnectionManager: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  isWindowMaximized: boolean;
  connectionFormElement: ReactNode;
  onNewConnection: () => void;
  onOpenDatabaseFile: () => void;
  onMinimizeWindow: () => void;
  onToggleMaximizeWindow: () => void;
  onCloseWindow: () => void;
  globalToastMarkup: ReactNode;
}

export function AppStartupShell({
  connectionFormIntent,
  showStartupConnectionManager,
  isConnected,
  isConnecting,
  isWindowMaximized,
  connectionFormElement,
  onNewConnection,
  onOpenDatabaseFile,
  onMinimizeWindow,
  onToggleMaximizeWindow,
  onCloseWindow,
  globalToastMarkup,
}: AppStartupShellProps) {
  return (
    <div className="app-root startup-shell-active">
      {connectionFormIntent && (
        <Suspense fallback={null}>{connectionFormElement}</Suspense>
      )}

      {showStartupConnectionManager && !isConnected && !isConnecting && !connectionFormIntent && (
        <StartupConnectionManager
          onNewConnection={onNewConnection}
          onOpenDatabaseFile={onOpenDatabaseFile}
          windowControls={
            <TitleBarWindowControls
              isWindowMaximized={isWindowMaximized}
              onMinimize={onMinimizeWindow}
              onToggleMaximize={onToggleMaximizeWindow}
              onClose={onCloseWindow}
            />
          }
        />
      )}
      {globalToastMarkup}
    </div>
  );
}