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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AIRequestIntent {
    Sql,
    Explain,
    Overview,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AIResponseLanguage {
    En,
    Vi,
    Zh,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AIConversationRole {
    User,
    Assistant,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIConversationMessage {
    pub role: AIConversationRole,
    pub content: String,
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
    #[serde(default = "default_ai_request_intent")]
    pub intent: AIRequestIntent,
    #[serde(default = "default_ai_response_language")]
    pub language: AIResponseLanguage,
    #[serde(default)]
    pub history: Vec<AIConversationMessage>,
}

fn default_ai_request_mode() -> AIRequestMode {
    AIRequestMode::Panel
}

fn default_ai_request_intent() -> AIRequestIntent {
    AIRequestIntent::Sql
}

fn default_ai_response_language() -> AIResponseLanguage {
    AIResponseLanguage::En
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

        if self.history.len() > 12 {
            return Err("Conversation history is too long (max 12 messages)".to_string());
        }

        let history_chars = self
            .history
            .iter()
            .map(|message| message.content.len())
            .sum::<usize>();
        if history_chars > 24_000 {
            return Err("Conversation history is too large (max 24,000 characters)".to_string());
        }

        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIResponse {
    pub text: String,
    pub error: Option<String>,
}
