import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeWithTimeout, invokeMutation } from "../utils/tauri-utils";
import { getCurrentAppLanguage, translateLanguage } from "../i18n";
import {
  type AIConversationMessage,
  type AIProviderConfig,
  type AIRequestAttachment,
  type AIRequestIntent,
  type AIRequestMode,
  type LocalOllamaSetupResult,
  type LocalOllamaStatus,
} from "../types";
import { buildNativeToolPayload } from "../components/AISlidePanel/ai-agent-tool-schema";
import { useConnectionStore } from "./connectionStore";
import { getActiveAIProvider, normalizeAIProviderConfigs } from "../utils/ai-provider-registry";
import { AIRequestError, normalizeAIRequestError } from "../utils/ai-request-errors";
import { emitAppToast } from "../utils/app-toast";
import { useGlobalErrorStore } from "./globalErrorStore";

const AI_TIMEOUTS = {
  default: 60_000,
  remotePanel: 180_000,
  remoteAgentPanel: 360_000,
  localOllamaPanel: 600_000,
  localOllamaInline: 120_000,
} as const;

/** Active provider first, then at most this many enabled fallbacks. */
const MAX_PROVIDER_ATTEMPTS = 3;

/**
 * Explicit user provider switches win over automatic failover: the panel
 * hook marks the moment of a manual pick, and the agent retry loop skips
 * auto-promotion when the user chose a provider during the current run.
 */
let manualProviderOverrideAt = 0;
export function markManualProviderOverride() {
  manualProviderOverrideAt = Date.now();
}
export function getManualProviderOverrideAt() {
  return manualProviderOverrideAt;
}

/**
 * All provider-config persistence funnels through one chain, so an automatic
 * failover write and a user switch can never interleave and clobber each
 * other — last queued write wins, in order.
 */
const configSaveChain = { current: Promise.resolve() };
function enqueueConfigSave<T>(task: () => Promise<T>): Promise<T> {
  const run = configSaveChain.current.then(task, task);
  configSaveChain.current = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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
  streamingText: string;
  streamingReasoning: boolean;
  streamingUsage: Record<string, unknown> | null;
  /** True while an automatic provider failover is switching the active provider. */
  isProviderFailingOver: boolean;

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
    history?: AIConversationMessage[],
    attachments?: AIRequestAttachment[]
  ) => Promise<string>;
  askAIWithReasoning: (
    prompt: string,
    context: string,
    mode?: AIRequestMode,
    intent?: AIRequestIntent,
    history?: AIConversationMessage[],
    attachments?: AIRequestAttachment[]
  ) => Promise<{ text: string; reasoning?: string }>;
  /**
   * Promotes the next enabled provider (cyclic list order, skipping the
   * current primary) so a dead or rate-limited endpoint stops being tried
   * first. Persists the switch best-effort. Returns the promoted provider,
   * or `null` when no other provider is enabled.
   */
  promoteNextEnabledProvider: () => AIProviderConfig | null;
}

/**
 * Promotes `next` to the active (primary) provider after `failed` broke a run.
 * Updates the store so the provider selector in the AI panel follows, announces
 * the switch through the global toast region, and persists the choice
 * best-effort so the healthy provider survives an app restart.
 */
function switchActiveProvider(
  configs: AIProviderConfig[],
  next: AIProviderConfig,
  failed: AIProviderConfig,
  set: (partial: Partial<AIState>) => void,
) {
  const normalized = normalizeAIProviderConfigs(
    configs.map((config) => ({ ...config, is_primary: config.id === next.id })),
  );
  // Surface the automatic switch in the panel: the composer model trigger
  // shows the spinner until the (queued) persistence settles.
  set({ aiConfigs: normalized, isProviderFailingOver: true });
  emitAppToast({
    title: translateLanguage(getCurrentAppLanguage(), "ai.toast.providerFailover", {
      failed: failed.name || failed.id,
      next: next.name || next.id,
    }),
    tone: "info",
    durationMs: 8_000,
  });
  // Best-effort persistence: the retried request must not wait on the disk
  // write, and a failed save still leaves the runtime switch in place.
  // Queued behind other config saves so it can never clobber a user pick.
  void enqueueConfigSave(() =>
    invokeMutation<[AIProviderConfig[], Record<string, boolean>]>(
      "save_ai_configs",
      { providers: normalized, apiKeyUpdates: {}, clearedProviderIds: [] },
    ))
    .then(([aiConfigs]) => set({ aiConfigs }))
    .catch((error) => console.warn("[AI] Failed to persist provider failover:", error))
    .finally(() => set({ isProviderFailingOver: false }));
}

export const useAIStore = create<AIState>((set, get) => ({
  aiConfigs: [],
  activeAIRequestId: null,
  requestPhase: "idle",
  streamingText: "",
  streamingReasoning: false,
  streamingUsage: null,
  isProviderFailingOver: false,

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
      const [aiConfigs, aiKeyStatus] = await enqueueConfigSave(() =>
        invokeMutation<[AIProviderConfig[], Record<string, boolean>]>(
          "save_ai_configs",
          { providers: configs, apiKeyUpdates, clearedProviderIds },
        ));
      set({ aiConfigs });
      return { aiConfigs, aiKeyStatus };
    } catch (e) {
      useGlobalErrorStore.getState().setError(`Failed to save AI configs: ${e}`);
      throw e;
    }
  },

  promoteNextEnabledProvider: () => {
    const configs = get().aiConfigs;
    const active = getActiveAIProvider(configs);
    if (!active) return null;
    const activeIndex = configs.findIndex((config) => config.id === active.id);
    // Cyclic scan starting after the current primary, so repeated calls walk
    // through every enabled provider instead of flipping between two.
    const rotated = [
      ...configs.slice(activeIndex + 1),
      ...configs.slice(0, activeIndex + 1),
    ];
    const next = rotated.find(
      (config) => config.is_enabled && config.id !== active.id,
    );
    if (!next) return null;
    switchActiveProvider(configs, next, active, set);
    return next;
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
    attachments,
  ) => {
    const activeConfig = getActiveAIProvider(get().aiConfigs);
    if (!activeConfig) {
      throw new AIRequestError(
        "provider",
        "No AI provider is enabled. Open AI Settings and select a provider before retrying.",
      );
    }

    // Failover chain: the active provider first, then the next enabled
    // providers, so one rate-limited or broken endpoint no longer kills a run.
    const fallbackConfigs = get()
      .aiConfigs
      .filter((candidate) => candidate.is_enabled && candidate.id !== activeConfig.id)
      .slice(0, MAX_PROVIDER_ATTEMPTS - 1);
    const chain: Array<{ config: AIProviderConfig; providerId?: string }> = [
      { config: activeConfig },
      ...fallbackConfigs.map((config) => ({ config, providerId: config.id })),
    ];

    let lastError: unknown;
    for (const [index, attempt] of chain.entries()) {
      const config = attempt.config;
      const timeoutMs = getAIRequestTimeout(config, mode, intent);
      const requestId = createAIRequestId();
      // Native function-calling (off by default) rides the non-streaming path so
      // the full tool_call JSON can be parsed at once; a null payload keeps the
      // classic streaming text path exactly as before.
      const connectionState = useConnectionStore.getState();
      const engineKey = connectionState.connections.find(
        (connection) => connection.id === connectionState.activeConnectionId,
      )?.db_type;
      const nativeToolPayload = buildNativeToolPayload(config.provider_type, intent, engineKey);
      set({
        activeAIRequestId: requestId,
        requestPhase: "requesting",
        streamingText: "",
        streamingReasoning: false,
        streamingUsage: null,
      });

      let unlisten: UnlistenFn | undefined;
      try {
        if (mode === "panel" && !nativeToolPayload) {
          let streamedText = "";
          unlisten = await listen<{
            requestId: string;
            kind: "text_delta" | "reasoning_delta" | "usage" | "error" | "done";
            text?: string;
            usage?: Record<string, unknown>;
          }>("ai-stream-event", (event) => {
            const payload = event.payload;
            if (payload.requestId !== requestId || get().activeAIRequestId !== requestId) return;
            if (payload.kind === "text_delta" && payload.text) {
              streamedText += payload.text;
              if (intent !== "agent") set({ streamingText: streamedText });
            } else if (payload.kind === "reasoning_delta") {
              set({ streamingReasoning: true });
            } else if (payload.kind === "usage" && payload.usage) {
              set({ streamingUsage: payload.usage });
            }
          });
          await invokeWithTimeout<void>(
            "ask_ai_stream",
            {
              request: {
                request_id: requestId,
                provider_id: attempt.providerId ?? null,
                prompt,
                context,
                mode,
                intent,
                language: getCurrentAppLanguage(),
                history,
                attachments: attachments && attachments.length > 0 ? attachments : undefined,
              },
            },
            timeoutMs,
            "AI request",
            {
              onTimeout: () =>
                invokeMutation<boolean>("cancel_ai_request", { requestId }).catch(() => false),
            },
          );
          return { text: streamedText };
        }

        const resp = await invokeWithTimeout<{ text: string; reasoning?: string; error?: string }>(
          "ask_ai",
          {
            request: {
              request_id: requestId,
              provider_id: attempt.providerId ?? null,
              prompt,
              context,
              mode,
              intent,
              language: getCurrentAppLanguage(),
              history,
              attachments: attachments && attachments.length > 0 ? attachments : undefined,
              ...(nativeToolPayload
                ? {
                    tools: nativeToolPayload.tools,
                    tool_choice: nativeToolPayload.tool_choice,
                  }
                : {}),
            },
          },
          timeoutMs,
          "AI request",
          {
            onTimeout: () =>
              invokeMutation<boolean>("cancel_ai_request", { requestId }).catch(() => false),
          },
        );
        if (resp.error) throw new Error(resp.error);
        return { text: resp.text, reasoning: resp.reasoning };
      } catch (errorValue) {
        lastError = errorValue;
        const requestError = normalizeAIRequestError(errorValue);
        if (requestError.code === "cancelled") throw requestError;
        const canFailOver = requestError.code === "timeout" || requestError.code === "provider";
        if (!canFailOver || index === chain.length - 1) throw requestError;
        // Stop the superseded backend request before switching endpoints.
        void invokeMutation<boolean>("cancel_ai_request", { requestId }).catch(() => false);
        // Deliberately no primary change here: the request-level chain tries
        // the remaining providers silently, and the single visible promotion
        // is owned by the agent hook (promoteNextEnabledProvider) so the
        // selector moves exactly once per run instead of flip-flopping.
        console.warn(
          `[AI] Provider "${config.name || config.id}" failed (${requestError.code}); failing over to the next enabled provider.`,
        );
      } finally {
        unlisten?.();
        if (get().activeAIRequestId === requestId) {
          set({
            activeAIRequestId: null,
            requestPhase: "idle",
            streamingReasoning: false,
          });
        }
      }
    }
    throw normalizeAIRequestError(lastError);
  },

  askAI: async (prompt, context, mode = "panel", intent = "sql", history = [], attachments) => {
    const response = await get().askAIWithReasoning(prompt, context, mode, intent, history, attachments);
    return response.text;
  },
}));
