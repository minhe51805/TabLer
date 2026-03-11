use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AIProviderType {
    OpenAI,
    Anthropic,
    Gemini,
    OpenRouter,
    Ollama,
    Custom,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: AIProviderType,
    pub endpoint: String,
    pub model: String,
    pub is_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIRequest {
    pub prompt: String,
    pub context: String, // DB schema context
    pub provider_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIResponse {
    pub text: String,
    pub error: Option<String>,
}
