import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { useAppLayoutStore } from "../stores/appLayoutStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useGlobalErrorStore } from "../stores/globalErrorStore";
import { useModalStore } from "../stores/modalStore";
import {
  RECOVERABLE_CONNECTION_ERROR_DELAY_MS,
  RECOVERABLE_CONNECTION_ERROR_PATTERNS,
  type WindowMenuSectionKey,
} from "../types/app-types";
import { applyWindowProfile, type DesktopWindowProfile } from "./useDesktopWindow";

interface UseRecoverableConnectionErrorOptions {
  error: string | null;
  isConnecting: boolean;
  applyDesktopWindowProfile?: (profile: DesktopWindowProfile) => Promise<void>;
  setShowAIWorkspace: Dispatch<SetStateAction<boolean>>;
  setActiveWindowMenuSection: Dispatch<SetStateAction<WindowMenuSectionKey | null>>;
}

export function isRecoverableConnectionError(error: string | null): boolean {
  if (!error) return false;
  return RECOVERABLE_CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function useRecoverableConnectionError({
  error,
  isConnecting,
  applyDesktopWindowProfile = applyWindowProfile,
  setShowAIWorkspace,
  setActiveWindowMenuSection,
}: UseRecoverableConnectionErrorOptions): boolean {
  const [isDelayActive, setIsDelayActive] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const recoveredErrorRef = useRef<string | null>(null);
  const clearError = useGlobalErrorStore((state) => state.clearError);
  const setConnectionFormIntent = useModalStore((state) => state.setConnectionFormIntent);
  const setShowStartupConnectionManager = useModalStore(
    (state) => state.setShowStartupConnectionManager,
  );
  const setForceLauncherVisible = useAppLayoutStore((state) => state.setForceLauncherVisible);

  useEffect(() => {
    if (!error) {
      if (!isDelayActive) recoveredErrorRef.current = null;
      return;
    }
    if (!isRecoverableConnectionError(error) || isConnecting) return;
    if (isDelayActive || timeoutRef.current !== null || recoveredErrorRef.current === error) return;

    recoveredErrorRef.current = error;
    setForceLauncherVisible(false);
    setIsDelayActive(true);
    timeoutRef.current = window.setTimeout(() => {
      const currentState = useConnectionStore.getState();
      const staleConnectionId = currentState.activeConnectionId;
      if (staleConnectionId) {
        const connectedIds = new Set(currentState.connectedIds);
        connectedIds.delete(staleConnectionId);
        useConnectionStore.setState({
          activeConnectionId: null,
          connectedIds,
          currentDatabase: null,
          databases: [],
          tables: [],
          schemaObjects: [],
        });
      }

      setShowStartupConnectionManager(true);
      setConnectionFormIntent(null);
      setShowAIWorkspace(false);
      setActiveWindowMenuSection(null);
      setForceLauncherVisible(true);
      setIsDelayActive(false);
      recoveredErrorRef.current = null;
      timeoutRef.current = null;
      clearError();
      void applyDesktopWindowProfile("launcher").catch((profileError) => {
        console.error("[WindowProfile] failed to apply launcher profile:", profileError);
      });
    }, RECOVERABLE_CONNECTION_ERROR_DELAY_MS);
  }, [
    applyDesktopWindowProfile,
    clearError,
    error,
    isConnecting,
    isDelayActive,
    setActiveWindowMenuSection,
    setConnectionFormIntent,
    setForceLauncherVisible,
    setShowAIWorkspace,
    setShowStartupConnectionManager,
  ]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  return isDelayActive;
}
