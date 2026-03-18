export type AIProviderType = "openai" | "anthropic" | "gemini" | "openrouter" | "ollama" | "custom";

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

export interface AIRequest {
    prompt: string;
    context: string;
    provider_id: string;
    mode: AIRequestMode;
}

export interface AIResponse {
    text: string;
    error?: string | null;
}
