import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();
const listenMock = vi.fn();
let streamListener: ((event: { payload: Record<string, unknown> }) => void) | undefined;

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

import { useAIStore } from "@/stores/aiStore";
import { useGlobalErrorStore } from "@/stores/globalErrorStore";
import type { AIProviderConfig } from "@/types";

const provider: AIProviderConfig = {
  id: "provider-1",
  name: "OpenAI",
  provider_type: "openai",
  endpoint: "https://api.openai.com",
  model: "gpt-test",
  is_enabled: true,
  is_primary: true,
  allow_schema_context: true,
  allow_inline_completion: true,
};

describe("aiStore", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    invokeWithTimeoutMock.mockReset();
    listenMock.mockReset();
    streamListener = undefined;
    listenMock.mockImplementation(async (_eventName, listener) => {
      streamListener = listener;
      return vi.fn();
    });
    useAIStore.setState({
      aiConfigs: [],
      activeAIRequestId: null,
      requestPhase: "idle",
      streamingText: "",
      streamingReasoning: false,
      streamingUsage: null,
    });
    useGlobalErrorStore.getState().clearError();
  });

  it("loads provider configs and key status", async () => {
    invokeWithTimeoutMock.mockResolvedValue([[provider], { "provider-1": true }]);

    await expect(useAIStore.getState().loadAIConfigs()).resolves.toEqual({
      aiConfigs: [provider],
      aiKeyStatus: { "provider-1": true },
    });
    expect(useAIStore.getState().aiConfigs).toEqual([provider]);
  });

  it("collects non-streaming agent responses using the agent timeout policy (native tool calling)", async () => {
    useAIStore.setState({ aiConfigs: [provider] });
    invokeWithTimeoutMock.mockImplementation(async (command) => {
      if (command === "load_ai_configs") {
        return [[provider], { "provider-1": true }];
      }
      // Native tool calling rides the non-streaming path.
      return { text: "SELECT 1", reasoning: "private" };
    });

    await expect(
      useAIStore
        .getState()
        .askAIWithReasoning("write SQL", "schema", "panel", "agent"),
    ).resolves.toEqual({ text: "SELECT 1", reasoning: "private" });

    expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
      "ask_ai",
      expect.objectContaining({
        request: expect.objectContaining({
          prompt: "write SQL",
          context: "schema",
          mode: "panel",
          intent: "agent",
          request_id: expect.any(String),
          tools: expect.any(Array),
          tool_choice: "auto",
        }),
      }),
      120_000,
      "AI request",
      expect.objectContaining({ onTimeout: expect.any(Function) }),
    );
    expect(useAIStore.getState().requestPhase).toBe("idle");
    expect(useAIStore.getState().streamingText).toBe("");
    // Native tool calling rides the non-streaming path: no stream subscription.
    expect(listenMock).not.toHaveBeenCalledWith("ai-stream-event", expect.any(Function));
    expect(streamListener).toBeUndefined();
  });

  it("cancels the active provider request", async () => {
    useAIStore.setState({
      aiConfigs: [provider],
      activeAIRequestId: "request-1",
      requestPhase: "requesting",
    });
    invokeMutationMock.mockResolvedValue(true);

    await expect(useAIStore.getState().cancelAIRequest()).resolves.toBe(true);

    expect(invokeMutationMock).toHaveBeenCalledWith("cancel_ai_request", {
      requestId: "request-1",
    });
    expect(useAIStore.getState().requestPhase).toBe("cancelling");
  });

  it("classifies timeout failures and asks Tauri to cancel the request", async () => {
    useAIStore.setState({ aiConfigs: [provider] });
    let rejectRequest: ((error: Error) => void) | undefined;
    invokeWithTimeoutMock.mockImplementation(
      () => new Promise((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );
    invokeMutationMock.mockResolvedValue(true);

    const request = useAIStore.getState().askAIWithReasoning(
      "summarize",
      "schema",
      "panel",
      "overview",
    );
    await vi.waitFor(() => expect(invokeWithTimeoutMock).toHaveBeenCalledOnce());
    const timeoutOptions = invokeWithTimeoutMock.mock.calls[0][4] as { onTimeout: () => void };
    timeoutOptions.onTimeout();
    rejectRequest?.(new Error("AI request timed out after 180s"));

    await expect(request).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(invokeMutationMock).toHaveBeenCalledWith("cancel_ai_request", {
      requestId: expect.any(String),
    });
  });

  it("updates provider configs after local Ollama setup", async () => {
    const ollamaProvider = { ...provider, id: "ollama", provider_type: "ollama" as const };
    const result = {
      aiConfigs: [ollamaProvider],
      aiKeyStatus: {},
      message: "Ready",
      status: {
        supported: true,
        autoInstallSupported: true,
        platform: "windows",
        recommendedModel: "qwen",
        endpoint: "http://localhost:11434",
        isInstalled: true,
        isRunning: true,
        hasRecommendedModel: true,
        hasConfiguredProvider: true,
        configuredAsPrimary: true,
      },
    };
    invokeMutationMock.mockResolvedValue(result);

    await expect(useAIStore.getState().setupLocalOllama()).resolves.toEqual(result);
    expect(useAIStore.getState().aiConfigs).toEqual([ollamaProvider]);
  });

  it("reports configuration failures through the global error store", async () => {
    invokeWithTimeoutMock.mockRejectedValue(new Error("backend unavailable"));

    await expect(useAIStore.getState().loadAIConfigs()).rejects.toThrow(
      "backend unavailable",
    );
    expect(useGlobalErrorStore.getState().error).toContain(
      "Failed to load AI configs",
    );
  });

  it("promotes the next enabled provider cyclically or returns null when alone", () => {
    const second: AIProviderConfig = {
      ...provider,
      id: "provider-2",
      name: "Claude",
      provider_type: "anthropic",
      is_primary: false,
    };
    const third: AIProviderConfig = {
      ...provider,
      id: "provider-3",
      name: "Gemini",
      provider_type: "gemini",
      is_primary: false,
    };
    invokeMutationMock.mockImplementation(async (command: string, args?: { providers?: AIProviderConfig[] }) => {
      if (command === "save_ai_configs") return [args?.providers ?? [], {}];
      return null;
    });
    useAIStore.setState({ aiConfigs: [provider, second, third] });

    const promoted = useAIStore.getState().promoteNextEnabledProvider();
    expect(promoted?.id).toBe("provider-2");
    expect(useAIStore.getState().aiConfigs.find((c) => c.id === "provider-2")?.is_primary).toBe(true);

    // A second promotion walks past the new primary to the next enabled one.
    const again = useAIStore.getState().promoteNextEnabledProvider();
    expect(again?.id).toBe("provider-3");

    // A lone provider has nowhere to go.
    useAIStore.setState({ aiConfigs: [provider] });
    expect(useAIStore.getState().promoteNextEnabledProvider()).toBeNull();
  });

  it("fails over to the next enabled provider for the retry without moving the primary", async () => {
    const fallback: AIProviderConfig = {
      ...provider,
      id: "provider-2",
      name: "Claude",
      provider_type: "anthropic",
      is_primary: false,
    };
    useAIStore.setState({ aiConfigs: [provider, fallback] });
    invokeMutationMock.mockImplementation(async (command: string) => {
      if (command === "cancel_ai_request") return true;
      return null;
    });
    let streamAttempts = 0;
    invokeWithTimeoutMock.mockImplementation(async (command: string, args?: {
      request?: { provider_id?: string | null };
    }) => {
      if (command === "ask_ai_stream") {
        streamAttempts += 1;
        if (streamAttempts === 1) {
          throw new Error("HTTP 429 Too Many Requests: rate limit exceeded");
        }
        failoverProviderIds.push(args?.request?.provider_id ?? null);
        return undefined;
      }
      return null;
    });
    const failoverProviderIds: Array<string | null> = [];

    await expect(
      useAIStore.getState().askAI("prompt", "context", "panel", "sql"),
    ).resolves.toBe("");

    // The retry went to the next enabled provider...
    expect(streamAttempts).toBe(2);
    expect(failoverProviderIds).toEqual(["provider-2"]);
    // ...but the configured primary is deliberately left untouched: the single
    // visible promotion is owned by the agent run, not by every transport
    // retry, so the selector never flip-flops between providers.
    const configs = useAIStore.getState().aiConfigs;
    expect(configs.find((config) => config.id === "provider-1")?.is_primary).toBe(true);
    expect(configs.find((config) => config.id === "provider-2")?.is_primary).toBe(false);
    expect(invokeMutationMock).not.toHaveBeenCalledWith(
      "save_ai_configs",
      expect.anything(),
    );
  });

  it("walks every enabled model of every enabled provider in the failover chain", async () => {
    const multiModelProvider: AIProviderConfig = {
      ...provider,
      models: ["gpt-test", "gpt-alt"],
    };
    const second: AIProviderConfig = {
      ...provider,
      id: "provider-2",
      name: "Claude",
      provider_type: "anthropic",
      model: "claude-test",
      is_primary: false,
    };
    const third: AIProviderConfig = {
      ...provider,
      id: "provider-3",
      name: "Gemini",
      provider_type: "gemini",
      model: "gem-a",
      models: ["gem-a", "gem-b"],
      // Hidden models stay out of the chain, mirroring the composer switcher.
      disabled_models: ["gem-b"],
      is_primary: false,
    };
    const fourth: AIProviderConfig = {
      ...provider,
      id: "provider-4",
      name: "Llama",
      model: "llama-test",
      is_primary: false,
    };
    useAIStore.setState({ aiConfigs: [multiModelProvider, second, third, fourth] });
    invokeMutationMock.mockImplementation(async (command: string) => {
      if (command === "cancel_ai_request") return true;
      return null;
    });
    const chainStops: Array<{ providerId: string | null; model: string | null }> = [];
    invokeWithTimeoutMock.mockImplementation(async (command: string, args?: {
      request?: { provider_id?: string | null; model?: string | null };
    }) => {
      if (command === "ask_ai_stream") {
        chainStops.push({
          providerId: args?.request?.provider_id ?? null,
          model: args?.request?.model ?? null,
        });
        throw new Error("HTTP 503 Service Unavailable");
      }
      return null;
    });

    // Every stop in the chain fails, so the run exhausts the full chain and
    // surfaces the last error instead of silently giving up early.
    await expect(
      useAIStore.getState().askAI("prompt", "context", "panel", "sql"),
    ).rejects.toThrow();

    // Active provider's configured model first, then its other models, then
    // the remaining enabled providers in order — including the fourth one,
    // which the old 3-attempt cap never reached.
    expect(chainStops).toEqual([
      { providerId: "provider-1", model: "gpt-test" },
      { providerId: "provider-1", model: "gpt-alt" },
      { providerId: "provider-2", model: "claude-test" },
      { providerId: "provider-3", model: "gem-a" },
      { providerId: "provider-4", model: "llama-test" },
    ]);
  });
});
