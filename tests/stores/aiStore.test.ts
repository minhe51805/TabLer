import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();

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
    useAIStore.setState({ aiConfigs: [], activeAIRequestId: null, requestPhase: "idle" });
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

  it("returns text and reasoning using the agent timeout policy", async () => {
    useAIStore.setState({ aiConfigs: [provider] });
    invokeWithTimeoutMock.mockResolvedValue({ text: "SELECT 1", reasoning: "Simple query" });

    await expect(
      useAIStore
        .getState()
        .askAIWithReasoning("write SQL", "schema", "panel", "agent"),
    ).resolves.toEqual({ text: "SELECT 1", reasoning: "Simple query" });

    expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
      "ask_ai",
      expect.objectContaining({
        request: expect.objectContaining({
          prompt: "write SQL",
          context: "schema",
          mode: "panel",
          intent: "agent",
          request_id: expect.any(String),
        }),
      }),
      360_000,
      "AI request",
      expect.objectContaining({ onTimeout: expect.any(Function) }),
    );
    expect(useAIStore.getState().requestPhase).toBe("idle");
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
    invokeWithTimeoutMock.mockRejectedValue(new Error("AI request timed out after 180s"));
    invokeMutationMock.mockResolvedValue(true);

    const request = useAIStore.getState().askAIWithReasoning(
      "summarize",
      "schema",
      "panel",
      "overview",
    );
    const timeoutOptions = invokeWithTimeoutMock.mock.calls[0][4] as { onTimeout: () => void };
    timeoutOptions.onTimeout();

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
});
