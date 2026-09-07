import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";

import { useWorkspaceShellSync } from "@/hooks/useWorkspaceShellSync";
import { useAppLayoutStore } from "@/stores/appLayoutStore";
import { useModalStore } from "@/stores/modalStore";
import type { WindowMenuSectionKey } from "@/types/app-types";

describe("useWorkspaceShellSync", () => {
  beforeEach(() => {
    useAppLayoutStore.setState({ forceLauncherVisible: true, leftPanel: "database" });
    useModalStore.setState({
      connectionFormIntent: "connect",
      showStartupConnectionManager: true,
    });
  });

  it("moves a connected metrics session into the workspace shell", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const [, setShowAIWorkspace] = useState(true);
      const [, setActiveWindowMenuSection] = useState<WindowMenuSectionKey | null>("file");
      useWorkspaceShellSync({
        activeConnectionId: "one",
        connectedIds: new Set(["one"]),
        isConnecting: false,
        isConnected: true,
        isConnectionFormOpen: true,
        isRecoveryDelayActive: false,
        activeTabType: "metrics",
        setShowAIWorkspace,
        setActiveWindowMenuSection,
      });
      return null;
    }

    act(() => root.render(<Harness />));

    expect(useModalStore.getState()).toMatchObject({
      connectionFormIntent: null,
      showStartupConnectionManager: false,
    });
    expect(useAppLayoutStore.getState()).toMatchObject({
      forceLauncherVisible: false,
      leftPanel: "metrics",
    });
    act(() => root.unmount());
  });
});
