import { create } from "zustand";
import { invokeWithTimeout, invokeMutation } from "../utils/tauri-utils";
import { getCurrentAppLanguage } from "../i18n";
import {
  type AIConversationMessage,
  type AIProviderConfig,
  type AIRequestIntent,
  type AIRequestMode,
  type LocalOllamaSetupResult,
  type LocalOllamaStatus,
} from "../types";
import { getActiveAIProvider } from "../utils/ai-provider-registry";
import { AIRequestError, normalizeAIRequestError } from "../utils/ai-request-errors";
import { useGlobalErrorStore } from "./globalErrorStore";

const AI_TIMEOUTS = {
  default: 60_000,
  remotePanel: 180_000,
  remoteAgentPanel: 360_000,
  localOllamaPanel: 600_000,
  localOllamaInline: 120_000,
} as const;

export type AIRequestPhase = "idle" | "requesting" | "cancelling";

function createAIRequestId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getAIRequestTimeout(config: AIProviderConfig, mode: AIRequestMode, intent: AIRequestIntent) {
  if (config.provider_type === "ollama") {
    return mode === "inline"
      ? AI_TIMEOUTS.localOllamaInline
      : AI_TIMEOUTS.localOllamaPanel;
  }

  if (mode === "panel" && intent === "agent") {
    return AI_TIMEOUTS.remoteAgentPanel;
  }

  if (mode === "panel") {
    return AI_TIMEOUTS.remotePanel;
  }

  return AI_TIMEOUTS.default;
}

export interface AIState {
  aiConfigs: AIProviderConfig[];
  activeAIRequestId: string | null;
  requestPhase: AIRequestPhase;

  loadAIConfigs: () => Promise<{
    aiConfigs: AIProviderConfig[];
    aiKeyStatus: Record<string, boolean>;
  }>;
  saveAIConfigs: (
    configs: AIProviderConfig[],
    apiKeyUpdates: Record<string, string>,
    clearedProviderIds: string[]
  ) => Promise<{
    aiConfigs: AIProviderConfig[];
    aiKeyStatus: Record<string, boolean>;
  }>;
  getLocalOllamaStatus: () => Promise<LocalOllamaStatus>;
  setupLocalOllama: () => Promise<LocalOllamaSetupResult>;
  cancelAIRequest: () => Promise<boolean>;
  askAI: (
    prompt: string,
    context: string,
    mode?: AIRequestMode,
    intent?: AIRequestIntent,
    history?: AIConversationMessage[]
  ) => Promise<string>;
  askAIWithReasoning: (
    prompt: string,
    context: string,
    mode?: AIRequestMode,
    intent?: AIRequestIntent,
    history?: AIConversationMessage[]
  ) => Promise<{ text: string; reasoning?: string }>;
}

export const useAIStore = create<AIState>((set, get) => ({
  aiConfigs: [],
  activeAIRequestId: null,
  requestPhase: "idle",

  loadAIConfigs: async () => {
    try {
      const [aiConfigs, aiKeyStatus] = await invokeWithTimeout<
        [AIProviderConfig[], Record<string, boolean>]
      >("get_ai_configs", {}, 15_000, "Loading AI settings");
      set({ aiConfigs });
      return { aiConfigs, aiKeyStatus };
    } catch (e) {
      useGlobalErrorStore.getState().setError(`Failed to load AI configs: ${e}`);
      throw e;
    }
  },

  saveAIConfigs: async (configs, apiKeyUpdates, clearedProviderIds) => {
    try {
      const [aiConfigs, aiKeyStatus] = await invokeMutation<
        [AIProviderConfig[], Record<string, boolean>]
      >("save_ai_configs", { providers: configs, apiKeyUpdates, clearedProviderIds });
      set({ aiConfigs });
      return { aiConfigs, aiKeyStatus };
    } catch (e) {
      useGlobalErrorStore.getState().setError(`Failed to save AI configs: ${e}`);
      throw e;
    }
  },

  getLocalOllamaStatus: async () => {
    try {
      return await invokeWithTimeout<LocalOllamaStatus>(
        "get_local_ollama_status",
        {},
        15_000,
        "Loading local Ollama status",
      );
    } catch (error) {
      useGlobalErrorStore
        .getState()
        .setError(`Failed to load local Ollama status: ${error}`);
      throw error;
    }
  },

  setupLocalOllama: async () => {
    try {
      const result = await invokeMutation<LocalOllamaSetupResult>("setup_local_ollama", {});
      set({ aiConfigs: result.aiConfigs });
      useGlobalErrorStore.getState().clearError();
      return result;
    } catch (error) {
      useGlobalErrorStore.getState().setError(`Failed to set up local Ollama: ${error}`);
      throw error;
    }
  },

  cancelAIRequest: async () => {
    const requestId = get().activeAIRequestId;
    if (!requestId) return false;

    set({ requestPhase: "cancelling" });
    try {
      return await invokeMutation<boolean>("cancel_ai_request", { requestId });
    } catch {
      return false;
    }
  },

  askAIWithReasoning: async (
    prompt: string,
    context: string,
    mode = "panel",
    intent = "sql",
    history = [],
  ) => {
    const config = getActiveAIProvider(get().aiConfigs);
    if (!config) {
      throw new AIRequestError(
        "provider",
        "No AI provider is enabled. Open AI Settings and select a provider before retrying.",
      );
    }
    const timeoutMs = getAIRequestTimeout(config, mode, intent);
    const requestId = createAIRequestId();
    set({ activeAIRequestId: requestId, requestPhase: "requesting" });

    try {
      const resp = await invokeWithTimeout<{ text: string; reasoning?: string; error?: string }>(
        "ask_ai",
        {
          request: {
            request_id: requestId,
            prompt,
            context,
            mode,
            intent,
            language: getCurrentAppLanguage(),
            history,
          },
        },
        timeoutMs,
        "AI request",
        {
          onTimeout: () => {
            void invokeMutation<boolean>("cancel_ai_request", { requestId }).catch(() => false);
          },
        },
      );
      if (resp.error) throw new Error(resp.error);
      return { text: resp.text, reasoning: resp.reasoning };
    } catch (errorValue) {
      throw normalizeAIRequestError(errorValue);
    } finally {
      if (get().activeAIRequestId === requestId) {
        set({ activeAIRequestId: null, requestPhase: "idle" });
      }
    }
  },

  askAI: async (prompt, context, mode = "panel", intent = "sql", history = []) => {
    const response = await get().askAIWithReasoning(prompt, context, mode, intent, history);
    return response.text;
  },
}));
