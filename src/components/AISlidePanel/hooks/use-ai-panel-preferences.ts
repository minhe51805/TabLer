import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AIProviderConfig } from "../../../types";
import { normalizeAIProviderConfigs } from "../../../utils/ai-provider-registry";
import type {
  AIWorkspaceAgentAutonomy,
  AIWorkspaceInteractionMode,
} from "../ai-workspace-types";

interface UseAIPanelPreferencesOptions {
  activeProvider?: AIProviderConfig;
  aiConfigs: AIProviderConfig[];
  currentWorkspaceKey: string;
  saveAIConfigs: (configs: AIProviderConfig[], settings: Record<string, string>, deletedIds: string[]) => Promise<unknown>;
  setError: (message: string | null) => void;
  setIsHistoryOpen: Dispatch<SetStateAction<boolean>>;
  setIsSwitchingProvider: Dispatch<SetStateAction<boolean>>;
  setWorkspaceAgentAutonomy: Dispatch<SetStateAction<Record<string, AIWorkspaceAgentAutonomy>>>;
  setWorkspaceInteractionModes: Dispatch<SetStateAction<Record<string, AIWorkspaceInteractionMode>>>;
}

export function useAIPanelPreferences(options: UseAIPanelPreferencesOptions) {
  const {
    activeProvider,
    aiConfigs,
    currentWorkspaceKey,
    saveAIConfigs,
    setError,
    setIsHistoryOpen,
    setIsSwitchingProvider,
    setWorkspaceAgentAutonomy,
    setWorkspaceInteractionModes,
  } = options;
  const selectInteractionMode = useCallback((mode: AIWorkspaceInteractionMode) => {
    setWorkspaceInteractionModes((current) => ({ ...current, [currentWorkspaceKey]: mode }));
  }, [currentWorkspaceKey, setWorkspaceInteractionModes]);
  const selectAgentAutonomy = useCallback((autonomy: AIWorkspaceAgentAutonomy) => {
    setWorkspaceAgentAutonomy((current) => ({ ...current, [currentWorkspaceKey]: autonomy }));
  }, [currentWorkspaceKey, setWorkspaceAgentAutonomy]);
  const openSettings = useCallback(() => {
    setIsHistoryOpen(false);
    window.dispatchEvent(new CustomEvent("open-ai-settings"));
  }, [setIsHistoryOpen]);
  const activateProvider = useCallback(async (providerId: string) => {
    const target = aiConfigs.find((config) => config.id === providerId);
    if (!target || (target.id === activeProvider?.id && target.is_enabled && target.is_primary)) return;
    const nextConfigs = normalizeAIProviderConfigs(aiConfigs.map((config) => (
      config.id === providerId
        ? { ...config, is_enabled: true, is_primary: true }
        : { ...config, is_primary: false }
    )));
    setIsSwitchingProvider(true);
    setError(null);
    try {
      await saveAIConfigs(nextConfigs, {}, []);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setIsSwitchingProvider(false);
    }
  }, [activeProvider?.id, aiConfigs, saveAIConfigs, setError, setIsSwitchingProvider]);
  return { activateProvider, openSettings, selectAgentAutonomy, selectInteractionMode };
}
