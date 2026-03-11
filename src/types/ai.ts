export type AIProviderType = "openai" | "anthropic" | "gemini" | "openrouter" | "ollama" | "custom";

export interface AIProviderConfig {
    id: string;
    name: string;
    provider_type: AIProviderType;
    endpoint: string;
    model: string;
    is_enabled: boolean;
}

export interface AIRequest {
    prompt: string;
    context: string;
    provider_id: string;
}

export interface AIResponse {
    text: string;
    error?: string | null;
}
