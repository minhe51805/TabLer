export type AIProviderType = "openai" | "anthropic" | "gemini" | "openrouter" | "ollama" | "custom";
export type AIResponseLanguage = "en" | "vi" | "zh" | "tr" | "ko";
export type AIConversationRole = "user" | "assistant";

export interface AIProviderConfig {
    id: string;
    name: string;
    provider_type: AIProviderType;
    endpoint: string;
    model: string;
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
export type AIRequestIntent = "sql" | "explain" | "overview" | "optimize" | "fix-error" | "general" | "agent";

export interface AIConversationMessage {
    role: AIConversationRole;
    content: string;
}

export interface AIRequest {
    request_id?: string;
    prompt: string;
    context: string;
    mode: AIRequestMode;
    intent?: AIRequestIntent;
    language?: AIResponseLanguage;
    history?: AIConversationMessage[];
}

export interface AIResponse {
    text: string;
    error?: string | null;
}
