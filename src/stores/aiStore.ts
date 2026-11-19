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
  type AIResponse,
  type AIUsageStats,
  type CanonicalAgentTurn,
  type CanonicalToolCall,
  type FetchedModel,
  type LocalOllamaSetupResult,
  type LocalOllamaStatus,
} from "../types";
import { buildCanonicalToolPayload } from "../components/AISlidePanel/ai-agent-tool-schema";
import {
  computeAgentRetryDelay,
  DEFAULT_AGENT_RETRY_POLICY,
  type AgentRetryPolicy,
  type AgentRetryWaitInfo,
} from "../components/AISlidePanel/ai-retry-policy";
import { useConnectionStore } from "./connectionStore";
import { getActiveAIProvider, normalizeAIProviderConfigs } from "../utils/ai-provider-registry";
import { AIRequestError, normalizeAIRequestError } from "../utils/ai-request-errors";
import { requestAIFailoverConsent } from "../utils/ai-failover-consent";
import { extractStreamingAgentAnswer } from "../utils/ai-stream-answer";
import { emitAppToast } from "../utils/app-toast";
import { useGlobalErrorStore } from "./globalErrorStore";

const AI_TIMEOUTS = {
  default: 60_000,
  remotePanel: 180_000,
  // Agent steps are single-purpose model calls; 2 minutes is enough for even
  // slow reasoning models.
  remoteAgentPanel: 120_000,
  localOllamaPanel: 600_000,
  localOllamaInline: 120_000,
} as const;

const NO_INLINE_RETRY_POLICY: AgentRetryPolicy = {
  ...DEFAULT_AGENT_RETRY_POLICY,
  maxRetries: 0,
};

/**
 * Bounded model candidates on a single provider:
 * 1. Primary model (`preferredModel` when pinned on active provider, else `config.model`).
 * 2. At most ONE fallback model on the same provider (`config.model` when `preferredModel`
 *    differed, else `config.fast_model`, else the first non-disabled `config.models` entry
 *    distinct from primary). Never walks all catalog models on a provider.
 */
function providerBoundedModels(
  config: AIProviderConfig,
  preferredModel?: string,
): Array<string | undefined> {
  const hidden = new Set(config.disabled_models ?? []);
  const configured = config.model.trim();
  const preferred = preferredModel?.trim() ?? "";
  const primary = preferred || configured;

  const fallbackPool = [
    preferred && configured && configured !== preferred ? configured : "",
    config.fast_model?.trim() ?? "",
    ...(config.models ?? []).map((m) => m.trim()),
  ].filter((candidate) => candidate && candidate !== primary && !hidden.has(candidate));

  const fallback = fallbackPool[0];
  if (!primary && !fallback) {
    return [undefined];
  }
  const out: Array<string | undefined> = [];
  if (primary) out.push(primary);
  if (fallback && !out.includes(fallback)) out.push(fallback);
  return out;
}

/**
 * Providers that recently timed out (hung without answering). They are pushed
 * to the back of — or briefly dropped from — the fallback pool so a hanging
 * endpoint cannot eat another full timeout on the very next agent step.
 */
const PROVIDER_TIMEOUT_RETRY_AFTER_MS = 120_000;
const recentProviderTimeouts = new Map<string, number>();
function markProviderTimeout(providerId: string) {
  const now = Date.now();
  recentProviderTimeouts.set(providerId, now);
  for (const [id, at] of recentProviderTimeouts) {
    if (now - at >= PROVIDER_TIMEOUT_RETRY_AFTER_MS) recentProviderTimeouts.delete(id);
  }
}
function providerPenaltyRank(providerId: string): number {
  const at = recentProviderTimeouts.get(providerId);
  return at === undefined ? 0 : at;
}

function orderedFallbackProviders(
  configs: AIProviderConfig[],
  activeProviderId: string,
): AIProviderConfig[] {
  const enabledFallbacks = configs.filter(
    (candidate) => candidate.is_enabled && candidate.id !== activeProviderId,
  );
  const now = Date.now();
  const healthy = enabledFallbacks.filter((candidate) => {
    const timedOutAt = recentProviderTimeouts.get(candidate.id);
    return timedOutAt === undefined || now - timedOutAt >= PROVIDER_TIMEOUT_RETRY_AFTER_MS;
  });
  const pool = healthy.length > 0 ? healthy : enabledFallbacks;
  return [...pool].sort(
    (left, right) => providerPenaltyRank(left.id) - providerPenaltyRank(right.id),
  );
}

/**
 * Explicit user provider switches win over automatic failover: the panel
 * hook marks the moment of a manual pick, and the agent loop skips
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

export interface AIStreamSession {
  requestId: string;
  phase: "requesting" | "cancelling";
  streamingText: string;
  streamingReasoning: boolean;
  streamingReasoningText: string;
  streamingUsage: Record<string, unknown> | null;
  trackInPanel: boolean;
}

export interface AskAIOptions {
  correlationId?: string;
  unattendedReadOnly?: boolean;
  preferredModel?: string;
  agentTurns?: CanonicalAgentTurn[];
  retryPolicy?: AgentRetryPolicy;
  onRetryWait?: (info: AgentRetryWaitInfo) => void;
  random?: () => number;
  /**
   * When false, background side-calls (e.g. `delegate` sub-queries or post-run
   * learning extraction) keep their own stream session without overwriting the
   * foreground panel's `activeAIRequestId` / `streamingText`.
   */
  trackInPanel?: boolean;
}

export interface AIAgentTurnResult {
  text: string;
  reasoning?: string;
  toolCalls: CanonicalToolCall[];
  thoughtSignature?: string;
  usage?: AIUsageStats;
  modelUsed?: string;
  providerUsed?: string;
}

function createAIRequestId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function getAIRequestTimeout(
  config: AIProviderConfig,
  mode: AIRequestMode,
  intent: AIRequestIntent,
) {
  if (config.provider_type === "ollama") {
    return mode === "inline" ? AI_TIMEOUTS.localOllamaInline : AI_TIMEOUTS.localOllamaPanel;
  }
  if (mode === "panel" && intent === "agent") {
    return AI_TIMEOUTS.remoteAgentPanel;
  }
  if (mode === "panel") {
    return AI_TIMEOUTS.remotePanel;
  }
  return AI_TIMEOUTS.default;
}

const AI_THINKING_STORAGE_KEY = "tabler.ai.workspace.showThinking.v1";

function loadThinkingPreference(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(AI_THINKING_STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function persistThinkingPreference(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AI_THINKING_STORAGE_KEY, String(enabled));
  } catch {
    // Ignore storage write failures (private mode, quota, etc.).
  }
}

export interface AIState {
  aiConfigs: AIProviderConfig[];
  /** Concurrent stream sessions keyed by `requestId` so overlapping calls never clobber one another. */
  activeStreams: Record<string, AIStreamSession>;
  activeAIRequestId: string | null;
  requestPhase: AIRequestPhase;
  streamingText: string;
  streamingReasoning: boolean;
  streamingReasoningText: string;
  streamingUsage: Record<string, unknown> | null;
  isProviderFailingOver: boolean;
  thinkingEnabled: boolean;
  setThinkingEnabled: (enabled: boolean) => void;

  loadAIConfigs: () => Promise<{
    aiConfigs: AIProviderConfig[];
    aiKeyStatus: Record<string, boolean>;
  }>;
  saveAIConfigs: (
    configs: AIProviderConfig[],
    apiKeyUpdates: Record<string, string>,
    clearedProviderIds: string[],
  ) => Promise<{
    aiConfigs: AIProviderConfig[];
    aiKeyStatus: Record<string, boolean>;
  }>;
  listProviderModels: (providerId: string) => Promise<FetchedModel[]>;
  getLocalOllamaStatus: () => Promise<LocalOllamaStatus>;
  setupLocalOllama: () => Promise<LocalOllamaSetupResult>;
  cancelAIRequest: (requestId?: string) => Promise<boolean>;
  askAI: (
    prompt: string,
    context: string,
    mode?: AIRequestMode,
    intent?: AIRequestIntent,
    history?: AIConversationMessage[],
    attachments?: AIRequestAttachment[],
    options?: AskAIOptions,
  ) => Promise<string>;
  askAIWithReasoning: (
    prompt: string,
    context: string,
    mode?: AIRequestMode,
    intent?: AIRequestIntent,
    history?: AIConversationMessage[],
    attachments?: AIRequestAttachment[],
    options?: AskAIOptions,
  ) => Promise<{ text: string; reasoning?: string; modelUsed?: string }>;
  askAIAgentTurn: (
    prompt: string,
    context: string,
    history?: AIConversationMessage[],
    attachments?: AIRequestAttachment[],
    options?: AskAIOptions,
  ) => Promise<AIAgentTurnResult>;
  promoteNextEnabledProvider: () => AIProviderConfig | null;
  restoreProvider: (providerId: string) => void;
}

function switchActiveProvider(
  configs: AIProviderConfig[],
  next: AIProviderConfig,
  failed: AIProviderConfig,
  set: (partial: Partial<AIState>) => void,
) {
  const normalized = normalizeAIProviderConfigs(
    configs.map((config) => ({ ...config, is_primary: config.id === next.id })),
  );
  set({ aiConfigs: normalized, isProviderFailingOver: true });
  emitAppToast({
    title: translateLanguage(getCurrentAppLanguage(), "ai.toast.providerFailover", {
      failed: failed.name || failed.id,
      next: next.name || next.id,
    }),
    tone: "info",
    durationMs: 8_000,
  });
  void enqueueConfigSave(() =>
    invokeMutation<[AIProviderConfig[], Record<string, boolean>]>("save_ai_configs", {
      providers: normalized,
      apiKeyUpdates: {},
      clearedProviderIds: [],
    }),
  )
    .then(([aiConfigs]) => set({ aiConfigs }))
    .catch((error) => console.warn("[AI] Failed to persist provider failover:", error))
    .finally(() => set({ isProviderFailingOver: false }));
}

/** True when an error must abort the ENTIRE coordinator without trying any more models or providers. */
function isHardTerminalError(error: AIRequestError): boolean {
  if (error.code === "cancelled") return true;
  if (error.backendCode === "rate-limited") return true;
  if (error.backendCode === "ai-bad-request") return true;
  if (!error.retryable && error.backendCode !== "ai-auth") return true;
  return false;
}

/** True when an error must stop the CURRENT provider immediately (no retries or alternate models on it). */
function shouldAbortProviderImmediately(error: AIRequestError): boolean {
  return error.backendCode === "ai-auth" || isHardTerminalError(error);
}

export const useAIStore = create<AIState>((set, get) => {
  const executeTurnCoordinator = async (
    prompt: string,
    context: string,
    mode: AIRequestMode = "panel",
    intent: AIRequestIntent = "sql",
    history: AIConversationMessage[] = [],
    attachments?: AIRequestAttachment[],
    options?: AskAIOptions,
  ): Promise<AIAgentTurnResult> => {
    const activeConfig = getActiveAIProvider(get().aiConfigs);
    if (!activeConfig) {
      throw new AIRequestError(
        "provider",
        "No AI provider is enabled. Open AI Settings and select a provider before retrying.",
      );
    }

    const fallbackProviders = orderedFallbackProviders(get().aiConfigs, activeConfig.id);
    const providerGroups: Array<{
      config: AIProviderConfig;
      models: Array<string | undefined>;
      isFallbackProvider: boolean;
    }> = [
      {
        config: activeConfig,
        models: providerBoundedModels(activeConfig, options?.preferredModel),
        isFallbackProvider: false,
      },
      ...fallbackProviders.map((config) => ({
        config,
        models: providerBoundedModels(config),
        isFallbackProvider: true,
      })),
    ];

    const totalChainStops = providerGroups.reduce((acc, g) => acc + g.models.length, 0);
    const primaryRetryPolicy = options?.retryPolicy ?? NO_INLINE_RETRY_POLICY;
    const random = options?.random ?? Math.random;
    const trackInPanel = options?.trackInPanel !== false;

    const connectionState = useConnectionStore.getState();
    const engineKey = connectionState.connections.find(
      (connection) => connection.id === connectionState.activeConnectionId,
    )?.db_type;
    const canonicalToolPayload = buildCanonicalToolPayload(intent, engineKey, {
      unattendedReadOnly: options?.unattendedReadOnly === true,
    });

    let lastError: unknown;
    let lastPartialText: string | undefined;
    let attemptCounter = 0;
    let crossProviderConsentChecked = false;
    let crossProviderConsentApproved = false;

    const runSingleTransportCall = async (
      config: AIProviderConfig,
      model: string | undefined,
    ): Promise<AIAgentTurnResult> => {
      const timeoutMs = getAIRequestTimeout(config, mode, intent);
      const requestId = createAIRequestId();
      const session: AIStreamSession = {
        requestId,
        phase: "requesting",
        streamingText: "",
        streamingReasoning: false,
        streamingReasoningText: "",
        streamingUsage: null,
        trackInPanel,
      };
      set((state) => ({
        activeStreams: { ...state.activeStreams, [requestId]: session },
        ...(trackInPanel
          ? {
              activeAIRequestId: requestId,
              requestPhase: "requesting" as const,
              streamingText: "",
              streamingReasoning: false,
              streamingReasoningText: "",
              streamingUsage: null,
            }
          : {}),
      }));

      let unlisten: UnlistenFn | undefined;
      let streamedText = "";
      let streamedReasoning = "";
      let latestStreamUsage: Record<string, unknown> | null = null;

      const requestPayload = {
        request_id: requestId,
        provider_id: config.id ?? null,
        model: model ?? null,
        prompt,
        context,
        mode,
        intent,
        language: getCurrentAppLanguage(),
        history,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        enable_thinking: get().thinkingEnabled,
        ...(canonicalToolPayload
          ? {
              canonical_tools: canonicalToolPayload.canonicalTools,
              allow_native_memory_tool: canonicalToolPayload.allowNativeMemoryTool,
            }
          : {}),
        ...(options?.agentTurns && options.agentTurns.length > 0
          ? { agent_turns: options.agentTurns }
          : {}),
      };

      try {
        if (mode === "panel") {
          unlisten = await listen<{
            requestId: string;
            kind: "text_delta" | "reasoning_delta" | "usage" | "error" | "done";
            text?: string;
            usage?: Record<string, unknown>;
          }>("ai-stream-event", (event) => {
            const payload = event.payload;
            if (payload.requestId !== requestId || !get().activeStreams[requestId]) return;

            if (payload.kind === "text_delta" && payload.text) {
              streamedText += payload.text;
              const visibleText =
                intent === "agent"
                  ? (extractStreamingAgentAnswer(streamedText) ?? "")
                  : streamedText;
              set((state) => {
                const current = state.activeStreams[requestId];
                if (!current) return state;
                const nextSession: AIStreamSession = {
                  ...current,
                  streamingText: visibleText || current.streamingText,
                };
                const isForeground = trackInPanel && state.activeAIRequestId === requestId;
                return {
                  activeStreams: { ...state.activeStreams, [requestId]: nextSession },
                  ...(isForeground && visibleText ? { streamingText: visibleText } : {}),
                };
              });
            } else if (payload.kind === "reasoning_delta") {
              if (payload.text) {
                streamedReasoning += payload.text;
              }
              set((state) => {
                const current = state.activeStreams[requestId];
                if (!current) return state;
                const nextSession: AIStreamSession = {
                  ...current,
                  streamingReasoning: true,
                  streamingReasoningText: streamedReasoning,
                };
                const isForeground = trackInPanel && state.activeAIRequestId === requestId;
                return {
                  activeStreams: { ...state.activeStreams, [requestId]: nextSession },
                  ...(isForeground
                    ? {
                        streamingReasoning: true,
                        streamingReasoningText: streamedReasoning,
                      }
                    : {}),
                };
              });
            } else if (payload.kind === "usage" && payload.usage) {
              latestStreamUsage = payload.usage;
              set((state) => {
                const current = state.activeStreams[requestId];
                if (!current) return state;
                const nextSession: AIStreamSession = {
                  ...current,
                  streamingUsage: payload.usage ?? null,
                };
                const isForeground = trackInPanel && state.activeAIRequestId === requestId;
                return {
                  activeStreams: { ...state.activeStreams, [requestId]: nextSession },
                  ...(isForeground ? { streamingUsage: payload.usage ?? null } : {}),
                };
              });
            }
          });

          const streamResp = await invokeWithTimeout<AIResponse | undefined>(
            "ask_ai_stream",
            { request: requestPayload },
            timeoutMs,
            "AI request",
            {
              onTimeout: () =>
                invokeMutation<boolean>("cancel_ai_request", { requestId }).catch((error) => {
                  console.warn("[AI] Failed to cancel timed-out request:", error);
                  return false;
                }),
            },
          );
          if (streamResp?.error) {
            throw new Error(streamResp.error);
          }

          const finalText =
            streamResp && typeof streamResp.text === "string" && streamResp.text.length > 0
              ? streamResp.text
              : streamedText;
          const finalReasoning = streamResp?.reasoning || streamedReasoning || undefined;
          const finalToolCalls = streamResp?.tool_calls ?? [];
          const finalThoughtSignature = streamResp?.thought_signature ?? undefined;
          const finalUsage =
            streamResp?.usage ?? (latestStreamUsage as AIUsageStats | null) ?? undefined;

          return {
            text: finalText,
            reasoning: finalReasoning,
            toolCalls: finalToolCalls,
            thoughtSignature: finalThoughtSignature,
            usage: finalUsage,
            modelUsed: model ?? config.model ?? undefined,
            providerUsed: config.id,
          };
        }

        const resp = await invokeWithTimeout<AIResponse>(
          "ask_ai",
          { request: requestPayload },
          timeoutMs,
          "AI request",
          {
            onTimeout: () =>
              invokeMutation<boolean>("cancel_ai_request", { requestId }).catch((error) => {
                console.warn("[AI] Failed to cancel timed-out request:", error);
                return false;
              }),
          },
        );
        if (resp.error) throw new Error(resp.error);
        return {
          text: resp.text,
          reasoning: resp.reasoning,
          toolCalls: resp.tool_calls ?? [],
          thoughtSignature: resp.thought_signature ?? undefined,
          usage: resp.usage ?? undefined,
          modelUsed: model ?? config.model ?? undefined,
          providerUsed: config.id,
        };
      } catch (errorValue) {
        const requestError = normalizeAIRequestError(errorValue);
        if (streamedText.trim()) {
          lastPartialText = streamedText;
          (requestError as AIRequestError & { partialText?: string }).partialText = streamedText;
        }
        if (requestError.code === "timeout") {
          markProviderTimeout(config.id);
        }
        // Best-effort cancel of superseded backend request when failing over.
        if (!isHardTerminalError(requestError)) {
          void invokeMutation<boolean>("cancel_ai_request", { requestId }).catch((error) => {
            console.warn("[AI] Failed to cancel superseded request:", error);
          });
        }
        throw requestError;
      } finally {
        unlisten?.();
        set((state) => {
          const nextStreams = { ...state.activeStreams };
          delete nextStreams[requestId];
          if (!trackInPanel || state.activeAIRequestId !== requestId) {
            return { activeStreams: nextStreams };
          }
          const remainingForeground = Object.values(nextStreams).filter((s) => s.trackInPanel);
          const nextForeground = remainingForeground[remainingForeground.length - 1];
          return {
            activeStreams: nextStreams,
            activeAIRequestId: nextForeground?.requestId ?? null,
            requestPhase: nextForeground?.phase ?? "idle",
            streamingReasoning: nextForeground?.streamingReasoning ?? false,
            streamingReasoningText: nextForeground?.streamingReasoningText ?? "",
          };
        });
      }
    };

    for (const group of providerGroups) {
      if (group.isFallbackProvider) {
        // SEC-T04: Never cross to another provider without explicit consent.
        // Unattended scheduled runs auto-deny cross-provider failover unless the
        // user previously persisted approval, because no human can answer a modal.
        if (!crossProviderConsentChecked) {
          crossProviderConsentChecked = true;
          crossProviderConsentApproved = options?.unattendedReadOnly
            ? false
            : await requestAIFailoverConsent();
        }
        if (!crossProviderConsentApproved) {
          break;
        }
      }

      for (let modelIndex = 0; modelIndex < group.models.length; modelIndex += 1) {
        const model = group.models[modelIndex];
        attemptCounter += 1;
        const modelRetryPolicy =
          !group.isFallbackProvider && modelIndex === 0
            ? primaryRetryPolicy
            : NO_INLINE_RETRY_POLICY;

        let abortCurrentProvider = false;
        for (let retry = 0; retry <= modelRetryPolicy.maxRetries; retry += 1) {
          try {
            return await runSingleTransportCall(group.config, model);
          } catch (errorValue) {
            lastError = errorValue;
            const requestError = normalizeAIRequestError(errorValue);

            if (isHardTerminalError(requestError)) {
              throw requestError;
            }
            if (shouldAbortProviderImmediately(requestError)) {
              abortCurrentProvider = true;
              break;
            }
            if (!modelRetryPolicy.retryableCodes.includes(requestError.code)) {
              abortCurrentProvider = true;
              break;
            }
            if (retry >= modelRetryPolicy.maxRetries) {
              break;
            }

            const rateLimited =
              requestError.backendCode === "ai-rate-limited" ||
              /rate limit|429|quota|too many requests/i.test(requestError.message);
            const delayMs = computeAgentRetryDelay({
              retry: retry + 1,
              policy: modelRetryPolicy,
              rateLimited,
              providerRetryAfterMs: requestError.providerRetryAfterMs,
              random,
            });
            if (delayMs === null) {
              break;
            }
            options?.onRetryWait?.({
              delayMs,
              reason: rateLimited ? "rate-limit" : "transient",
              retryAfterMs: requestError.providerRetryAfterMs,
              retry: retry + 1,
              maxRetries: modelRetryPolicy.maxRetries,
            });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }

        const latestNormalized = normalizeAIRequestError(lastError);
        const hasMoreModelsInProvider =
          !abortCurrentProvider && modelIndex + 1 < group.models.length;
        const hasMoreProviders =
          fallbackProviders.length > 0 &&
          (!crossProviderConsentChecked || crossProviderConsentApproved);

        if (hasMoreModelsInProvider || hasMoreProviders) {
          window.dispatchEvent(
            new CustomEvent("ai-provider-chain-failover", {
              detail: {
                failedProvider: group.config.name.trim() || group.config.id,
                failedModel: model ?? null,
                reason: latestNormalized.code,
                attempt: attemptCounter,
                total: totalChainStops,
                ...(options?.correlationId ? { correlationId: options.correlationId } : {}),
              },
            }),
          );
          console.warn(
            `[AI] Provider "${group.config.name || group.config.id}"${model ? ` (model ${model})` : ""} failed (${latestNormalized.code}); evaluating bounded fallback.`,
          );
        }

        if (abortCurrentProvider) {
          break;
        }
      }
    }

    const finalError = normalizeAIRequestError(lastError);
    if (lastPartialText) {
      (finalError as AIRequestError & { partialText?: string }).partialText = lastPartialText;
    }
    throw finalError;
  };

  return {
    aiConfigs: [],
    activeStreams: {},
    activeAIRequestId: null,
    requestPhase: "idle",
    streamingText: "",
    streamingReasoning: false,
    streamingReasoningText: "",
    streamingUsage: null,
    isProviderFailingOver: false,
    thinkingEnabled: loadThinkingPreference(),

    setThinkingEnabled: (enabled) => {
      persistThinkingPreference(enabled);
      set({ thinkingEnabled: enabled });
    },

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
          invokeMutation<[AIProviderConfig[], Record<string, boolean>]>("save_ai_configs", {
            providers: configs,
            apiKeyUpdates,
            clearedProviderIds,
          }),
        );
        set({ aiConfigs });
        return { aiConfigs, aiKeyStatus };
      } catch (e) {
        useGlobalErrorStore.getState().setError(`Failed to save AI configs: ${e}`);
        throw e;
      }
    },

    listProviderModels: async (providerId) =>
      invokeWithTimeout<FetchedModel[]>(
        "list_provider_models",
        { providerId },
        30_000,
        "Fetching provider models",
      ),

    promoteNextEnabledProvider: () => {
      const configs = get().aiConfigs;
      const active = getActiveAIProvider(configs);
      if (!active) return null;
      const activeIndex = configs.findIndex((config) => config.id === active.id);
      const rotated = [...configs.slice(activeIndex + 1), ...configs.slice(0, activeIndex + 1)];
      const next = rotated.find((config) => config.is_enabled && config.id !== active.id);
      if (!next) return null;
      switchActiveProvider(configs, next, active, set);
      return next;
    },

    restoreProvider: (providerId) => {
      const configs = get().aiConfigs;
      const target = configs.find((config) => config.id === providerId);
      if (!target || !target.is_enabled || target.is_primary) return;
      const normalized = normalizeAIProviderConfigs(
        configs.map((config) => ({ ...config, is_primary: config.id === providerId })),
      );
      set({ aiConfigs: normalized });
      void enqueueConfigSave(() =>
        invokeMutation<[AIProviderConfig[], Record<string, boolean>]>("save_ai_configs", {
          providers: normalized,
          apiKeyUpdates: {},
          clearedProviderIds: [],
        }),
      )
        .then(([aiConfigs]) => set({ aiConfigs }))
        .catch((error) => console.warn("[AI] Failed to persist provider restore:", error));
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
        useGlobalErrorStore.getState().setError(`Failed to load local Ollama status: ${error}`);
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

    cancelAIRequest: async (targetRequestId) => {
      const requestId = targetRequestId ?? get().activeAIRequestId;
      if (!requestId) return false;

      set((state) => {
        const existing = state.activeStreams[requestId];
        const nextStreams = existing
          ? {
              ...state.activeStreams,
              [requestId]: { ...existing, phase: "cancelling" as const },
            }
          : state.activeStreams;
        return {
          activeStreams: nextStreams,
          ...(state.activeAIRequestId === requestId ? { requestPhase: "cancelling" as const } : {}),
        };
      });
      try {
        return await invokeMutation<boolean>("cancel_ai_request", { requestId });
      } catch {
        return false;
      }
    },

    askAIWithReasoning: async (
      prompt,
      context,
      mode = "panel",
      intent = "sql",
      history = [],
      attachments,
      options,
    ) => {
      const result = await executeTurnCoordinator(
        prompt,
        context,
        mode,
        intent,
        history,
        attachments,
        options,
      );
      return {
        text: result.text,
        reasoning: result.reasoning,
        modelUsed: result.modelUsed,
      };
    },

    askAIAgentTurn: async (prompt, context, history = [], attachments, options) =>
      executeTurnCoordinator(prompt, context, "panel", "agent", history, attachments, {
        retryPolicy: DEFAULT_AGENT_RETRY_POLICY,
        ...options,
      }),

    askAI: async (
      prompt,
      context,
      mode = "panel",
      intent = "sql",
      history = [],
      attachments,
      options,
    ) => {
      const response = await executeTurnCoordinator(
        prompt,
        context,
        mode,
        intent,
        history,
        attachments,
        options,
      );
      return response.text;
    },
  };
});
