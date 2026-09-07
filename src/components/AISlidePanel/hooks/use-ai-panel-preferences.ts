import { useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AIProviderConfig } from "../../../types";
import { normalizeAIProviderConfigs } from "../../../utils/ai-provider-registry";
import { markManualProviderOverride } from "../../../stores/aiStore";
import type {
  AIWorkspaceAgentAutonomy,
  AIWorkspaceInteractionMode,
} from "../ai-workspace-types";

interface UseAIPanelPreferencesOptions {
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
  // Fresh config mirror: switches are chained, so each queued switch must read
  // the latest known provider list instead of the closure snapshot.
  const aiConfigsRef = useRef(aiConfigs);
  aiConfigsRef.current = aiConfigs;
  // Latest click wins: a click while another switch is still in flight gets
  // queued and applied afterwards against the already-updated config list.
  const switchChainRef = useRef<Promise<void>>(Promise.resolve());
  const activateProvider = useCallback((providerId: string, model?: string) => {
    // Record the user's intent immediately (even if the save queues behind an
    // in-flight switch/failover): an explicit pick must win over any
    // automatic provider rotation for the current run.
    markManualProviderOverride();
    const run = switchChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const configs = aiConfigsRef.current;
        const target = configs.find((config) => config.id === providerId);
        if (!target) return;
        if (target.is_enabled && target.is_primary && (!model || target.model === model)) return;
        const nextConfigs = normalizeAIProviderConfigs(configs.map((config) => (
          config.id === providerId
            ? { ...config, is_enabled: true, is_primary: true, ...(model ? { model } : {}) }
            : { ...config, is_primary: false }
        )));
        setIsSwitchingProvider(true);
        setError(null);
        try {
          const saved = (await saveAIConfigs(nextConfigs, {}, [])) as
            | { aiConfigs?: AIProviderConfig[] }
            | undefined;
          if (saved?.aiConfigs?.length) aiConfigsRef.current = saved.aiConfigs;
        } catch (errorValue) {
          setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
        } finally {
          setIsSwitchingProvider(false);
        }
      });
    switchChainRef.current = run;
    return run;
  }, [saveAIConfigs, setError, setIsSwitchingProvider]);
  const toggleModelVisibility = useCallback(async (providerId: string, model: string) => {
    const target = aiConfigs.find((config) => config.id === providerId);
    if (!target || !(target.disabled_models ?? []).includes(model)) return;
    const nextConfigs = normalizeAIProviderConfigs(aiConfigs.map((config) => (
      config.id === providerId
        ? { ...config, disabled_models: (config.disabled_models ?? []).filter((entry) => entry !== model) }
        : config
    )));
    setError(null);
    try {
      await saveAIConfigs(nextConfigs, {}, []);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    }
  }, [aiConfigs, saveAIConfigs, setError]);
  return { activateProvider, toggleModelVisibility, openSettings, selectAgentAutonomy, selectInteractionMode };
}
