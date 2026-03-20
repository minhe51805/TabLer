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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AIRequestMode {
    Panel,
    Inline,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: AIProviderType,
    pub endpoint: String,
    pub model: String,
    pub is_enabled: bool,
    #[serde(default)]
    pub allow_schema_context: bool,
    #[serde(default)]
    pub allow_inline_completion: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIRequest {
    pub prompt: String,
    pub context: String, // DB schema context
    #[serde(default = "default_ai_request_mode")]
    pub mode: AIRequestMode,
}

fn default_ai_request_mode() -> AIRequestMode {
    AIRequestMode::Panel
}

impl AIRequest {
    /// Validate AI request before processing
    pub fn validate(&self) -> Result<(), String> {
        if self.prompt.trim().is_empty() {
            return Err("Prompt cannot be empty".to_string());
        }

        // Limit prompt size to prevent abuse (max 10KB)
        if self.prompt.len() > 10_000 {
            return Err("Prompt is too long (max 10,000 characters)".to_string());
        }

        // Limit context size
        if self.context.len() > 50_000 {
            return Err("Context is too long (max 50,000 characters)".to_string());
        }

        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIResponse {
    pub text: String,
    pub error: Option<String>,
}
