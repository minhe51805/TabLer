import type { AIProviderConfig, AIProviderType } from "../types/ai";

export interface AIProviderDefinition {
  type: AIProviderType;
  label: string;
  requiresApiKey: boolean;
  isLocalByDefault: boolean;
  getDefaultEndpoint: (model: string) => string;
  endpointPlaceholder?: string;
}

export const AI_PROVIDER_TYPES = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "ollama",
  "custom",
] as const satisfies readonly AIProviderType[];

export const AI_PROVIDER_REGISTRY: Record<AIProviderType, AIProviderDefinition> = {
  openai: {
    type: "openai",
    label: "OpenAI",
    requiresApiKey: true,
    isLocalByDefault: false,
    getDefaultEndpoint: () => "https://api.openai.com/v1/chat/completions",
  },
  anthropic: {
    type: "anthropic",
    label: "Claude",
    requiresApiKey: true,
    isLocalByDefault: false,
    getDefaultEndpoint: () => "https://api.anthropic.com/v1/messages",
  },
  gemini: {
    type: "gemini",
    label: "Gemini",
    requiresApiKey: true,
    isLocalByDefault: false,
    getDefaultEndpoint: (model) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${model.trim() || "{model}"}:generateContent`,
  },
  openrouter: {
    type: "openrouter",
    label: "OpenRouter",
    requiresApiKey: true,
    isLocalByDefault: false,
    getDefaultEndpoint: () => "https://openrouter.ai/api/v1/chat/completions",
  },
  ollama: {
    type: "ollama",
    label: "Ollama",
    requiresApiKey: false,
    isLocalByDefault: true,
    getDefaultEndpoint: () => "http://localhost:11434/v1/chat/completions",
  },
  custom: {
    type: "custom",
    label: "Custom",
    requiresApiKey: true,
    isLocalByDefault: false,
    getDefaultEndpoint: () => "",
    endpointPlaceholder: "https://api.yourdomain.com/v1/chat/completions",
  },
};

export function getAIProviderDefinition(providerType: AIProviderType) {
  return AI_PROVIDER_REGISTRY[providerType];
}

export function formatAIProviderTypeLabel(providerType: AIProviderType) {
  return getAIProviderDefinition(providerType).label;
}

export function getDefaultAIProviderEndpoint(
  config: Pick<AIProviderConfig, "provider_type" | "model">,
) {
  return getAIProviderDefinition(config.provider_type).getDefaultEndpoint(config.model);
}

export function getAIProviderEndpointFieldCopy(
  config: Pick<AIProviderConfig, "provider_type" | "model">,
) {
  const definition = getAIProviderDefinition(config.provider_type);
  const placeholder = definition.endpointPlaceholder ?? definition.getDefaultEndpoint(config.model);

  if (config.provider_type === "custom") {
    return {
      label: "Custom URL",
      hint: "Required for custom providers. TableR will send an OpenAI-compatible chat request to this URL.",
      placeholder,
    };
  }

  if (config.provider_type === "ollama") {
    return {
      label: "Custom URL",
      hint: "Optional. Leave blank to use the local Ollama default endpoint.",
      placeholder,
    };
  }

  return {
    label: "Custom URL",
    hint: "Optional. Leave blank to use the provider's default endpoint.",
    placeholder,
  };
}

export function normalizeAIProviderConfigs(configs: AIProviderConfig[]) {
  const normalized = configs.map((config) => ({
    ...config,
    is_enabled: config.is_enabled ?? true,
    is_primary: config.is_primary ?? false,
    allow_schema_context: config.allow_schema_context ?? false,
    allow_inline_completion: config.allow_inline_completion ?? false,
  }));

  const primaryIndex = normalized.findIndex((config) => config.is_enabled && config.is_primary);
  const enabledIndex = normalized.findIndex((config) => config.is_enabled);
  const activeIndex = primaryIndex >= 0 ? primaryIndex : enabledIndex;

  return normalized.map((config, index) => ({
    ...config,
    is_primary: activeIndex >= 0 ? index === activeIndex : false,
  }));
}

export function getActiveAIProvider(configs: AIProviderConfig[]) {
  return configs.find((config) => config.is_enabled && config.is_primary)
    ?? configs.find((config) => config.is_enabled);
}

export function isLocalAIProviderEndpoint(endpoint: string) {
  if (!endpoint.trim()) return false;

  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return (
      host === "localhost"
      || host === "127.0.0.1"
      || host === "::1"
      || host === "[::1]"
      || host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function isLocalAIProvider(config: AIProviderConfig | null | undefined) {
  if (!config) return false;
  return getAIProviderDefinition(config.provider_type).isLocalByDefault
    || isLocalAIProviderEndpoint(config.endpoint);
}
