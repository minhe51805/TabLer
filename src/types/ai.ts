export type AIProviderType = "openai" | "anthropic" | "gemini" | "openrouter" | "ollama" | "custom";
export type AIResponseLanguage = "en" | "vi" | "zh";
export type AIConversationRole = "user" | "assistant";

export interface AIProviderConfig {
    id: string;
    name: string;
    provider_type: AIProviderType;
    endpoint: string;
    model: string;
    is_enabled: boolean;
    allow_schema_context: boolean;
    allow_inline_completion: boolean;
}

export type AIRequestMode = "panel" | "inline";
export type AIRequestIntent = "sql" | "explain" | "overview";

export interface AIConversationMessage {
    role: AIConversationRole;
    content: string;
}

export interface AIRequest {
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
