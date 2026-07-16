import { describe, expect, it } from "vitest";
import type { AIProviderConfig, AIProviderType } from "@/types";
import {
  AI_PROVIDER_REGISTRY,
  AI_PROVIDER_TYPES,
  formatAIProviderTypeLabel,
  getActiveAIProvider,
  getAIProviderEndpointFieldCopy,
  getDefaultAIProviderEndpoint,
  isLocalAIProvider,
  isLocalAIProviderEndpoint,
  normalizeAIProviderConfigs,
} from "@/utils/ai-provider-registry";

function provider(
  id: string,
  overrides: Partial<AIProviderConfig> = {},
): AIProviderConfig {
  return {
    id,
    name: id,
    provider_type: "openai",
    endpoint: "",
    model: "test-model",
    is_enabled: true,
    is_primary: false,
    allow_schema_context: false,
    allow_inline_completion: false,
    ...overrides,
  };
}

describe("AI provider registry", () => {
  it("defines every provider type exactly once", () => {
    expect(Object.keys(AI_PROVIDER_REGISTRY).sort()).toEqual([...AI_PROVIDER_TYPES].sort());
    expect(new Set(AI_PROVIDER_TYPES).size).toBe(AI_PROVIDER_TYPES.length);
  });

  it.each<[AIProviderType, string, string]>([
    ["openai", "OpenAI", "https://api.openai.com/v1/chat/completions"],
    ["anthropic", "Claude", "https://api.anthropic.com/v1/messages"],
    ["gemini", "Gemini", "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"],
    ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1/chat/completions"],
    ["ollama", "Ollama", "http://localhost:11434/v1/chat/completions"],
    ["custom", "Custom", ""],
  ])("matches the %s provider contract", (providerType, label, endpoint) => {
    expect(formatAIProviderTypeLabel(providerType)).toBe(label);
    expect(getDefaultAIProviderEndpoint({
      provider_type: providerType,
      model: providerType === "gemini" ? "gemini-test" : "test-model",
    })).toBe(endpoint);
  });

  it("normalizes legacy flags and elects one enabled primary provider", () => {
    const configs = normalizeAIProviderConfigs([
      provider("disabled-primary", { is_enabled: false, is_primary: true }),
      provider("first-enabled", {
        is_primary: undefined,
        allow_schema_context: undefined as unknown as boolean,
        allow_inline_completion: undefined as unknown as boolean,
      }),
      provider("second-enabled"),
    ]);

    expect(configs.map((config) => config.is_primary)).toEqual([false, true, false]);
    expect(configs[1]).toMatchObject({
      allow_schema_context: false,
      allow_inline_completion: false,
    });
    expect(getActiveAIProvider(configs)?.id).toBe("first-enabled");
  });

  it("preserves the first valid primary and clears duplicate primaries", () => {
    const configs = normalizeAIProviderConfigs([
      provider("first", { is_primary: true }),
      provider("second", { is_primary: true }),
    ]);

    expect(configs.map((config) => config.is_primary)).toEqual([true, false]);
  });

  it("recognizes local providers without treating malformed URLs as local", () => {
    expect(isLocalAIProvider(provider("ollama", { provider_type: "ollama" }))).toBe(true);
    expect(isLocalAIProviderEndpoint("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalAIProviderEndpoint("http://[::1]:11434/v1")).toBe(true);
    expect(isLocalAIProviderEndpoint("http://model-server.local/v1")).toBe(true);
    expect(isLocalAIProviderEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isLocalAIProviderEndpoint("not a url")).toBe(false);
  });

  it("keeps the custom endpoint required while providing a useful placeholder", () => {
    expect(getAIProviderEndpointFieldCopy({
      provider_type: "custom",
      model: "custom-model",
    })).toEqual(expect.objectContaining({
      placeholder: "https://api.yourdomain.com/v1/chat/completions",
      hint: expect.stringContaining("Required"),
    }));
  });
});
