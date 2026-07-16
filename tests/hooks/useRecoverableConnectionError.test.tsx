import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isRecoverableConnectionError,
  useRecoverableConnectionError,
} from "@/hooks/useRecoverableConnectionError";
import { useAppLayoutStore } from "@/stores/appLayoutStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useGlobalErrorStore } from "@/stores/globalErrorStore";
import { useModalStore } from "@/stores/modalStore";
import { RECOVERABLE_CONNECTION_ERROR_DELAY_MS } from "@/types/app-types";
import type { WindowMenuSectionKey } from "@/types/app-types";

describe("useRecoverableConnectionError", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useConnectionStore.setState({
      activeConnectionId: "one",
      connectedIds: new Set(["one"]),
      currentDatabase: "app",
      databases: [{ name: "app" }],
      tables: [{ name: "users", table_type: "table" }],
      schemaObjects: [],
    });
    useGlobalErrorStore.setState({ error: "Please connect first" });
    useModalStore.setState({
      connectionFormIntent: "connect",
      showStartupConnectionManager: false,
    });
    useAppLayoutStore.setState({ forceLauncherVisible: false });
  });

  afterEach(() => vi.useRealTimers());

  it("matches only recoverable connection errors", () => {
    expect(isRecoverableConnectionError("Please connect first")).toBe(true);
    expect(isRecoverableConnectionError("Syntax error")).toBe(false);
  });

  it("clears stale connection state and returns to the launcher", async () => {
    const applyDesktopWindowProfile = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const error = useGlobalErrorStore((state) => state.error);
      const [, setShowAIWorkspace] = useState(true);
      const [, setActiveWindowMenuSection] = useState<WindowMenuSectionKey | null>("file");
      const isDelayActive = useRecoverableConnectionError({
        error,
        isConnecting: false,
        applyDesktopWindowProfile,
        setShowAIWorkspace,
        setActiveWindowMenuSection,
      });
      return <output>{String(isDelayActive)}</output>;
    }

    act(() => root.render(<Harness />));
    expect(container.textContent).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECOVERABLE_CONNECTION_ERROR_DELAY_MS);
    });

    expect(useConnectionStore.getState()).toMatchObject({
      activeConnectionId: null,
      currentDatabase: null,
      databases: [],
      tables: [],
    });
    expect(useModalStore.getState()).toMatchObject({
      connectionFormIntent: null,
      showStartupConnectionManager: true,
    });
    expect(useAppLayoutStore.getState().forceLauncherVisible).toBe(true);
    expect(useGlobalErrorStore.getState().error).toBeNull();
    expect(applyDesktopWindowProfile).toHaveBeenCalledWith("launcher");
    act(() => root.unmount());
  });
});
