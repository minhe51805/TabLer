import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();
const listenMock = vi.fn();
const streamListeners: Array<(event: { payload: Record<string, unknown> }) => void> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

import { useAIStore } from "@/stores/aiStore";
import { useGlobalErrorStore } from "@/stores/globalErrorStore";
import { setAIFailoverConsent } from "@/utils/ai-failover-consent";
import { TauriCommandError } from "@/utils/tauri-error";
import type { AIConversationMessage, AIProviderConfig, CanonicalAgentTurn } from "@/types";

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

function emitStreamEvent(payload: Record<string, unknown>) {
  for (const listener of [...streamListeners]) {
    listener({ payload });
  }
}

describe("aiStore", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    invokeWithTimeoutMock.mockReset();
    listenMock.mockReset();
    streamListeners.length = 0;
    window.localStorage.removeItem("tabler.ai.failoverConsent");
    listenMock.mockImplementation(async (_eventName, listener) => {
      streamListeners.push(listener);
      return vi.fn(() => {
        const idx = streamListeners.indexOf(listener);
        if (idx >= 0) streamListeners.splice(idx, 1);
      });
    });
    useAIStore.setState({
      aiConfigs: [],
      activeStreams: {},
      activeAIRequestId: null,
      requestPhase: "idle",
      streamingText: "",
      streamingReasoning: false,
      streamingReasoningText: "",
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

  it("fetches provider models (with capability metadata) via list_provider_models", async () => {
    const fetched = [
      {
        id: "gpt-4o",
        context_window: 128000,
        max_output_tokens: 16384,
        input_types: ["text", "image"],
      },
      { id: "gpt-4o-mini" },
    ];
    invokeWithTimeoutMock.mockResolvedValue(fetched);

    await expect(useAIStore.getState().listProviderModels("provider-1")).resolves.toEqual(fetched);

    expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
      "list_provider_models",
      { providerId: "provider-1" },
      expect.any(Number),
      expect.any(String),
    );
  });

  it("streams agent responses with canonical_tools and structured AIResponse over ask_ai_stream", async () => {
    useAIStore.setState({ aiConfigs: [provider] });
    invokeWithTimeoutMock.mockImplementation(
      async (command: string, args?: { request?: { request_id?: string } }) => {
        if (command === "ask_ai_stream") {
          const requestId = args?.request?.request_id;
          emitStreamEvent({
            requestId,
            kind: "text_delta",
            text: '{"action":"finish","args":{"response":"SEL',
          });
          emitStreamEvent({
            requestId,
            kind: "text_delta",
            text: 'ECT 1"},"message":""}',
          });
          return {
            text: '{"action":"finish","args":{"response":"SELECT 1"},"message":""}',
            reasoning: "Checked schema.",
            tool_calls: [
              {
                id: "call_1",
                name: "finish",
                arguments: { response: "SELECT 1" },
              },
            ],
            thought_signature: "sig-test",
            usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
          };
        }
        return null;
      },
    );

    const turn = await useAIStore.getState().askAIAgentTurn("write SQL", "schema", [], undefined, {
      retryPolicy: {
        maxRetries: 0,
        initialDelayMs: 10,
        maxDelayMs: 50,
        jitterRatio: 0,
        maxRetryWaitMs: 50,
        retryableCodes: ["timeout", "provider"],
      },
    });

    expect(turn).toEqual({
      text: '{"action":"finish","args":{"response":"SELECT 1"},"message":""}',
      reasoning: "Checked schema.",
      toolCalls: [{ id: "call_1", name: "finish", arguments: { response: "SELECT 1" } }],
      thoughtSignature: "sig-test",
      usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
      modelUsed: "gpt-test",
      providerUsed: "provider-1",
    });

    expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
      "ask_ai_stream",
      expect.objectContaining({
        request: expect.objectContaining({
          prompt: "write SQL",
          context: "schema",
          mode: "panel",
          intent: "agent",
          request_id: expect.any(String),
          canonical_tools: expect.any(Array),
          allow_native_memory_tool: true,
        }),
      }),
      120_000,
      "AI request",
      expect.objectContaining({ onTimeout: expect.any(Function) }),
    );
    expect(useAIStore.getState().requestPhase).toBe("idle");
    expect(useAIStore.getState().streamingText).toBe("SELECT 1");
  });

  it("isolates concurrent stream sessions so a background helper never clobbers foreground streaming", async () => {
    useAIStore.setState({ aiConfigs: [provider] });
    let resolveForeground: (() => void) | undefined;
    let foregroundReqId: string | undefined;

    invokeWithTimeoutMock.mockImplementation(
      async (command: string, args?: { request?: { request_id?: string; prompt?: string } }) => {
        if (command !== "ask_ai_stream") return null;
        const reqId = args?.request?.request_id ?? "";
        if (args?.request?.prompt === "foreground") {
          foregroundReqId = reqId;
          emitStreamEvent({ requestId: reqId, kind: "text_delta", text: "Hello " });
          await new Promise<void>((resolve) => {
            resolveForeground = resolve;
          });
          emitStreamEvent({ requestId: reqId, kind: "text_delta", text: "world!" });
          return undefined;
        }
        // Background helper call (`trackInPanel: false`)
        emitStreamEvent({ requestId: reqId, kind: "text_delta", text: "helper answer" });
        return { text: "helper answer", tool_calls: [] };
      },
    );

    const foregroundPromise = useAIStore
      .getState()
      .askAIWithReasoning("foreground", "ctx", "panel", "general");

    await vi.waitFor(() => expect(foregroundReqId).toBeDefined());
    expect(useAIStore.getState().activeAIRequestId).toBe(foregroundReqId);

    const bgText = await useAIStore
      .getState()
      .askAI("background", "ctx", "panel", "general", [], undefined, { trackInPanel: false });
    expect(bgText).toBe("helper answer");

    // Foreground activeAIRequestId and streamingText remain intact after background call finishes!
    expect(useAIStore.getState().activeAIRequestId).toBe(foregroundReqId);
    expect(useAIStore.getState().streamingText).toBe("Hello ");

    resolveForeground?.();
    const fgResult = await foregroundPromise;
    expect(fgResult.text).toBe("Hello world!");
    expect(useAIStore.getState().streamingText).toBe("Hello world!");
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
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    invokeMutationMock.mockResolvedValue(true);

    const request = useAIStore
      .getState()
      .askAIWithReasoning("summarize", "schema", "panel", "overview");
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

    await expect(useAIStore.getState().loadAIConfigs()).rejects.toThrow("backend unavailable");
    expect(useGlobalErrorStore.getState().error).toContain("Failed to load AI configs");
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
    invokeMutationMock.mockImplementation(
      async (command: string, args?: { providers?: AIProviderConfig[] }) => {
        if (command === "save_ai_configs") return [args?.providers ?? [], {}];
        return null;
      },
    );
    useAIStore.setState({ aiConfigs: [provider, second, third] });

    const promoted = useAIStore.getState().promoteNextEnabledProvider();
    expect(promoted?.id).toBe("provider-2");
    expect(useAIStore.getState().aiConfigs.find((c) => c.id === "provider-2")?.is_primary).toBe(
      true,
    );

    const again = useAIStore.getState().promoteNextEnabledProvider();
    expect(again?.id).toBe("provider-3");

    useAIStore.setState({ aiConfigs: [provider] });
    expect(useAIStore.getState().promoteNextEnabledProvider()).toBeNull();
  });

  it("gates cross-provider failover on SEC-T04 consent (declined stays on primary; approved switches)", async () => {
    const fallback: AIProviderConfig = {
      ...provider,
      id: "provider-2",
      name: "Claude",
      provider_type: "anthropic",
      is_primary: false,
    };
    useAIStore.setState({ aiConfigs: [provider, fallback] });
    invokeMutationMock.mockResolvedValue(true);

    const seenProvidersWhenDeclined: Array<string | null> = [];
    setAIFailoverConsent("declined");
    invokeWithTimeoutMock.mockImplementation(
      async (command: string, args?: { request?: { provider_id?: string | null } }) => {
        if (command === "ask_ai_stream") {
          seenProvidersWhenDeclined.push(args?.request?.provider_id ?? null);
          throw new Error("HTTP 429 Too Many Requests: rate limit exceeded");
        }
        return null;
      },
    );

    await expect(useAIStore.getState().askAI("prompt", "context", "panel", "sql")).rejects.toThrow(
      /429/,
    );
    expect(seenProvidersWhenDeclined).toEqual(["provider-1"]);

    // Now approve consent: cross-provider failover succeeds without flipping is_primary.
    setAIFailoverConsent("approved");
    let streamAttempts = 0;
    const failoverProviderIds: Array<string | null> = [];
    invokeWithTimeoutMock.mockImplementation(
      async (command: string, args?: { request?: { provider_id?: string | null } }) => {
        if (command === "ask_ai_stream") {
          streamAttempts += 1;
          if (streamAttempts === 1) {
            throw new Error("HTTP 429 Too Many Requests: rate limit exceeded");
          }
          failoverProviderIds.push(args?.request?.provider_id ?? null);
          return undefined;
        }
        return null;
      },
    );

    await expect(useAIStore.getState().askAI("prompt", "context", "panel", "sql")).resolves.toBe(
      "",
    );
    expect(streamAttempts).toBe(2);
    expect(failoverProviderIds).toEqual(["provider-2"]);
    expect(useAIStore.getState().aiConfigs.find((c) => c.id === "provider-1")?.is_primary).toBe(
      true,
    );
  });

  it("bounds per-provider model fallback to primary + at most 1 fallback model (never walking full catalog)", async () => {
    setAIFailoverConsent("approved");
    const multiModelProvider: AIProviderConfig = {
      ...provider,
      models: ["gpt-test", "gpt-alt-1", "gpt-alt-2", "gpt-alt-3", "gpt-alt-4"],
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
      disabled_models: ["gem-b"],
      is_primary: false,
    };
    useAIStore.setState({ aiConfigs: [multiModelProvider, second, third] });
    invokeMutationMock.mockResolvedValue(true);

    const chainStops: Array<{ providerId: string | null; model: string | null }> = [];
    invokeWithTimeoutMock.mockImplementation(
      async (
        command: string,
        args?: { request?: { provider_id?: string | null; model?: string | null } },
      ) => {
        if (command === "ask_ai_stream") {
          chainStops.push({
            providerId: args?.request?.provider_id ?? null,
            model: args?.request?.model ?? null,
          });
          throw new Error("HTTP 503 Service Unavailable");
        }
        return null;
      },
    );

    await expect(
      useAIStore.getState().askAI("prompt", "context", "panel", "sql"),
    ).rejects.toThrow();

    // gpt-alt-2..4 are NOT walked! Only primary + 1 fallback on provider-1, then provider-2, provider-3.
    expect(chainStops).toEqual([
      { providerId: "provider-1", model: "gpt-test" },
      { providerId: "provider-1", model: "gpt-alt-1" },
      { providerId: "provider-2", model: "claude-test" },
      { providerId: "provider-3", model: "gem-a" },
    ]);
  });

  it("aborts current provider immediately on ai-auth (401/403) and aborts entire run on rate-limited or ai-bad-request", async () => {
    setAIFailoverConsent("approved");
    const multiModelPrimary: AIProviderConfig = {
      ...provider,
      models: ["gpt-test", "gpt-alt-1"],
    };
    const backup: AIProviderConfig = {
      ...provider,
      id: "provider-2",
      name: "Claude",
      provider_type: "anthropic",
      model: "claude-test",
      is_primary: false,
    };
    useAIStore.setState({ aiConfigs: [multiModelPrimary, backup] });
    invokeMutationMock.mockResolvedValue(true);

    // 1. ai-auth skips gpt-alt-1 on provider-1 and jumps straight to provider-2.
    const authStops: Array<{ providerId: string | null; model: string | null }> = [];
    invokeWithTimeoutMock.mockImplementation(
      async (
        command: string,
        args?: { request?: { provider_id?: string | null; model?: string | null } },
      ) => {
        if (command === "ask_ai_stream") {
          const pid = args?.request?.provider_id ?? null;
          authStops.push({ providerId: pid, model: args?.request?.model ?? null });
          if (pid === "provider-1") {
            throw new TauriCommandError({
              code: "ai-auth",
              message: "401 Invalid API key",
              retryable: false,
            });
          }
          return { text: "from backup", tool_calls: [] };
        }
        return null;
      },
    );

    await expect(useAIStore.getState().askAI("hi", "ctx", "panel", "general")).resolves.toBe(
      "from backup",
    );
    expect(authStops).toEqual([
      { providerId: "provider-1", model: "gpt-test" },
      { providerId: "provider-2", model: "claude-test" },
    ]);

    // 2. Local TableR `rate-limited` aborts immediately after 1 call without failing over.
    const localLimiterStops: string[] = [];
    invokeWithTimeoutMock.mockImplementation(
      async (command: string, args?: { request?: { provider_id?: string | null } }) => {
        if (command === "ask_ai_stream") {
          localLimiterStops.push(args?.request?.provider_id ?? "");
          throw new TauriCommandError({
            code: "rate-limited",
            message: "Too many AI requests in a short window.",
            retryable: true,
          });
        }
        return null;
      },
    );
    await expect(
      useAIStore.getState().askAI("hi", "ctx", "panel", "general"),
    ).rejects.toMatchObject({ backendCode: "rate-limited" });
    expect(localLimiterStops).toEqual(["provider-1"]);
  });

  it("forwards conversation history and canonical agent_turns unchanged across provider failover", async () => {
    setAIFailoverConsent("approved");
    const second: AIProviderConfig = {
      ...provider,
      id: "provider-2",
      name: "Claude",
      provider_type: "anthropic",
      model: "claude-test",
      is_primary: false,
    };
    useAIStore.setState({ aiConfigs: [provider, second] });

    const history: AIConversationMessage[] = [
      { role: "user", content: "What tables exist?" },
      { role: "assistant", content: "users, orders." },
    ];
    const agentTurns: CanonicalAgentTurn[] = [
      {
        role: "assistant",
        text: "Checking users schema",
        tool_calls: [{ id: "call_1", name: "describe_table", arguments: { table: "users" } }],
      },
      {
        role: "tool_result",
        call_id: "call_1",
        tool_name: "describe_table",
        content: "T=users|C:id:int!pk",
      },
    ];

    invokeMutationMock.mockResolvedValue(true);
    const seenPayloads: Array<{
      providerId: string | null;
      history: unknown;
      agentTurns: unknown;
    }> = [];
    invokeWithTimeoutMock.mockImplementation(
      async (
        command: string,
        args?: {
          request?: { provider_id?: string | null; history?: unknown; agent_turns?: unknown };
        },
      ) => {
        if (command === "ask_ai_stream") {
          seenPayloads.push({
            providerId: args?.request?.provider_id ?? null,
            history: args?.request?.history,
            agentTurns: args?.request?.agent_turns,
          });
          throw new Error("HTTP 503 Service Unavailable");
        }
        return null;
      },
    );

    await expect(
      useAIStore.getState().askAIAgentTurn("inspect orders", "context", history, undefined, {
        agentTurns,
        retryPolicy: {
          maxRetries: 0,
          initialDelayMs: 10,
          maxDelayMs: 50,
          jitterRatio: 0,
          maxRetryWaitMs: 50,
          retryableCodes: ["timeout", "provider"],
        },
      }),
    ).rejects.toThrow();

    expect(seenPayloads).toEqual([
      { providerId: "provider-1", history, agentTurns },
      { providerId: "provider-2", history, agentTurns },
    ]);
  });
});
