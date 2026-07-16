import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useAppLayoutStore } from "../stores/appLayoutStore";

export type DesktopWindowProfile = "launcher" | "form" | "workspace";

interface DesktopWindowProfileState {
  isConnected: boolean;
  isConnecting: boolean;
  isConnectionFormOpen: boolean;
  suspendProfileSync: boolean;
}

interface UseDesktopWindowOptions extends DesktopWindowProfileState {}

export function resolveDesktopWindowProfile({
  isConnected,
  isConnecting,
  isConnectionFormOpen,
  suspendProfileSync,
}: DesktopWindowProfileState): DesktopWindowProfile | null {
  if (isConnected) return "workspace";
  if (isConnecting || suspendProfileSync) return null;
  return isConnectionFormOpen ? "form" : "launcher";
}

export function isTauriDesktopWindow(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function applyWindowProfile(profile: DesktopWindowProfile): Promise<void> {
  if (!isTauriDesktopWindow()) return;
  await invoke("apply_window_profile", { profile });
}

export function useDesktopWindow(options: UseDesktopWindowOptions) {
  const { isConnected, isConnecting, isConnectionFormOpen, suspendProfileSync } = options;
  const isDesktopWindow = isTauriDesktopWindow();
  const syncGenerationRef = useRef(0);
  const setIsWindowMaximized = useAppLayoutStore((state) => state.setIsWindowMaximized);
  const setIsWindowFocused = useAppLayoutStore((state) => state.setIsWindowFocused);

  const applyDesktopWindowProfile = useCallback(
    (profile: DesktopWindowProfile) => applyWindowProfile(profile),
    [],
  );

  const minimizeWindow = useCallback(() => {
    if (!isDesktopWindow) return;
    void getCurrentWindow().minimize().catch((error) => {
      console.error("Failed to minimize window", error);
    });
  }, [isDesktopWindow]);

  const toggleMaximizeWindow = useCallback(() => {
    if (!isDesktopWindow) return;
    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.toggleMaximize();
        setIsWindowMaximized(await appWindow.isMaximized());
      } catch (error) {
        console.error("Failed to toggle maximize window", error);
      }
    })();
  }, [isDesktopWindow, setIsWindowMaximized]);

  const closeWindow = useCallback(() => {
    if (!isDesktopWindow) return;
    void getCurrentWindow().close().catch((error) => {
      console.error("Failed to close window", error);
    });
  }, [isDesktopWindow]);

  useEffect(() => {
    if (!isDesktopWindow) return;

    const appWindow = getCurrentWindow();
    let isMounted = true;
    let unlistenResized: (() => void) | undefined;
    let unlistenFocusChanged: (() => void) | undefined;

    void Promise.all([appWindow.isMaximized(), appWindow.isFocused()])
      .then(([maximized, focused]) => {
        if (!isMounted) return;
        setIsWindowMaximized(maximized);
        setIsWindowFocused(focused);
      })
      .catch((error) => console.error("Failed to read window state", error));

    void appWindow
      .onResized(async () => {
        if (!isMounted) return;
        setIsWindowMaximized(await appWindow.isMaximized());
      })
      .then((unlisten) => {
        if (isMounted) unlistenResized = unlisten;
        else unlisten();
      });

    void appWindow
      .onFocusChanged(({ payload }) => {
        if (isMounted) setIsWindowFocused(payload);
      })
      .then((unlisten) => {
        if (isMounted) unlistenFocusChanged = unlisten;
        else unlisten();
      });

    return () => {
      isMounted = false;
      unlistenResized?.();
      unlistenFocusChanged?.();
    };
  }, [isDesktopWindow, setIsWindowFocused, setIsWindowMaximized]);

  useEffect(() => {
    if (!isDesktopWindow) return;

    const profile = resolveDesktopWindowProfile({
      isConnected,
      isConnecting,
      isConnectionFormOpen,
      suspendProfileSync,
    });
    if (!profile) return;

    let cancelled = false;
    const generation = ++syncGenerationRef.current;

    void applyDesktopWindowProfile(profile).catch((error) => {
      if (!cancelled && syncGenerationRef.current === generation) {
        console.error("Failed to synchronize desktop window profile", error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    applyDesktopWindowProfile,
    isDesktopWindow,
    isConnected,
    isConnecting,
    isConnectionFormOpen,
    suspendProfileSync,
  ]);

  return {
    isDesktopWindow,
    applyDesktopWindowProfile,
    minimizeWindow,
    toggleMaximizeWindow,
    closeWindow,
  };
}
