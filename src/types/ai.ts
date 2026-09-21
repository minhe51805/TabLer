export type AIProviderType =
  "openai" | "anthropic" | "gemini" | "vertex" | "openrouter" | "ollama" | "custom";
export type AIResponseLanguage = "en" | "vi" | "zh" | "tr" | "ko";
export type AIConversationRole = "user" | "assistant";

/** Optional per-model metadata: context budget and I/O capabilities. */
export interface AIModelSettings {
  context_window?: number | null;
  max_output_tokens?: number | null;
  input_types?: string[];
  output_types?: string[];
}

/**
 * One model returned by a provider's "list models" API, plus any capability
 * metadata that API exposed (mirrors the backend `FetchedModel`). Fields the
 * provider omits are absent so the UI can fall back to its own defaults.
 */
export interface FetchedModel {
  id: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  input_types?: string[];
  /** Per-token USD prices the provider published (OpenRouter-style);
   *  absent when the API does not expose pricing. */
  pricing?: {
    prompt: number;
    completion: number;
    input_cache_read?: number | null;
    input_cache_write?: number | null;
  } | null;
}

export interface AIProviderConfig {
  id: string;
  name: string;
  provider_type: AIProviderType;
  endpoint: string;
  model: string;
  /** Optional cheaper/faster model id on the same provider; trivial intents
   *  (short explains, formatting, general chat) route here when set. */
  fast_model?: string | null;
  /** Explicit API wire format for Custom providers; undefined = auto-detect. */
  api_format?: string | null;
  /** Model catalog; empty = legacy single-model config. */
  models?: string[];
  /** Models hidden from the composer switcher; kept for easy re-enabling. */
  disabled_models?: string[];
  /** Per-model metadata keyed by model id; missing entry = provider defaults. */
  model_settings?: Record<string, AIModelSettings>;
  is_enabled: boolean;
  is_primary?: boolean;
  allow_schema_context: boolean;
  allow_inline_completion: boolean;
}

export interface LocalOllamaStatus {
  supported: boolean;
  autoInstallSupported: boolean;
  platform: string;
  version?: string | null;
  recommendedModel: string;
  endpoint: string;
  isInstalled: boolean;
  isRunning: boolean;
  hasRecommendedModel: boolean;
  hasConfiguredProvider: boolean;
  configuredAsPrimary: boolean;
  configuredProviderId?: string | null;
  executablePath?: string | null;
}

export interface LocalOllamaSetupResult {
  status: LocalOllamaStatus;
  aiConfigs: AIProviderConfig[];
  aiKeyStatus: Record<string, boolean>;
  message: string;
}

export interface LocalOllamaSetupProgressEvent {
  step: string;
  message: string;
  percent: number;
  isEstimated: boolean;
}

export type AIRequestMode = "panel" | "inline";
export type AIRequestIntent =
  "sql" | "explain" | "overview" | "optimize" | "fix-error" | "general" | "agent";

export interface AIConversationMessage {
  role: AIConversationRole;
  content: string;
}

/** A user attachment riding the current request (matches Rust AIRequestAttachment). */
export interface AIRequestAttachment {
  kind: "image" | "text";
  name: string;
  mime_type: string;
  /** base64 image bytes (no data-URL prefix) or text file contents. */
  data: string;
}

export interface AIRequest {
  request_id?: string;
  prompt: string;
  context: string;
  mode: AIRequestMode;
  intent?: AIRequestIntent;
  language?: AIResponseLanguage;
  history?: AIConversationMessage[];
  /** Current-turn image attachments; text files are inlined into `prompt`. */
  attachments?: AIRequestAttachment[];
  /** Panel "Thinking" toggle. `false` forces reasoning off across every
   *  provider (no thinking tokens); `true`/omitted keeps the capability-gated
   *  default so only models that support reasoning actually emit it. */
  enable_thinking?: boolean;
}

export interface AIResponse {
  text: string;
  error?: string | null;
}
