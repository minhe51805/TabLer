import { create } from "zustand";
import { invokeWithTimeout, invokeMutation } from "../utils/tauri-utils";
import { getCurrentAppLanguage } from "../i18n";
import { getActiveAIProvider, type AIConversationMessage, type AIProviderConfig, type AIRequestIntent, type AIRequestMode } from "../types";

const AI_TIMEOUTS = {
  default: 60_000,
  remotePanel: 180_000,
  remoteAgentPanel: 360_000,
  localOllamaPanel: 600_000,
  localOllamaInline: 120_000,
} as const;

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

interface AIState {
  aiConfigs: AIProviderConfig[];

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
  askAI: (
    prompt: string,
    context: string,
    mode?: AIRequestMode,
    intent?: AIRequestIntent,
    history?: AIConversationMessage[]
  ) => Promise<string>;
}

export const useAIStore = create<AIState>((set, get) => ({
  aiConfigs: [],

  loadAIConfigs: async () => {
    try {
      const [aiConfigs, aiKeyStatus] = await invokeWithTimeout<
        [AIProviderConfig[], Record<string, boolean>]
      >("get_ai_configs", {}, 15_000, "Loading AI settings");
      set({ aiConfigs });
      return { aiConfigs, aiKeyStatus };
    } catch (e) {
      console.error("Failed to load AI configs:", e);
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
      console.error("Failed to save AI configs:", e);
      throw e;
    }
  },

  askAI: async (prompt: string, context: string, mode = "panel", intent = "sql", history = []) => {
    const config = getActiveAIProvider(get().aiConfigs);
    if (!config) throw new Error("AI Provider not found");
    const timeoutMs = getAIRequestTimeout(config, mode, intent);
    const resp = await invokeWithTimeout<{ text: string; error?: string }>(
      "ask_ai",
      { request: { prompt, context, mode, intent, language: getCurrentAppLanguage(), history } },
      timeoutMs,
      "AI request"
    );
    if (resp.error) throw new Error(resp.error);
    return resp.text;
  },
}));
