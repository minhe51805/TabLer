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
    Optimize,
    #[serde(rename = "fix-error")]
    FixError,
    General,
    Agent,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AIResponseLanguage {
    En,
    Vi,
    Zh,
    Tr,
    Ko,
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
    pub is_primary: bool,
    #[serde(default)]
    pub allow_schema_context: bool,
    #[serde(default)]
    pub allow_inline_completion: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIRequest {
    #[serde(default)]
    pub request_id: Option<String>,
    /// Optional explicit provider override; when absent the active provider is used.
    /// Powers the frontend failover chain across enabled providers.
    #[serde(default)]
    pub provider_id: Option<String>,
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
    /// Native function-calling tool definitions, already shaped for the target
    /// provider's wire format on the frontend. `None` (the default) keeps the
    /// classic text path with a byte-identical request body, so this field is
    /// inert unless the frontend feature flag opts in.
    #[serde(default)]
    pub tools: Option<serde_json::Value>,
    /// Provider-shaped tool selection hint (`tool_choice` for OpenAI-like and
    /// Anthropic, `tool_config` for Gemini). Ignored when `tools` is `None`.
    #[serde(default)]
    pub tool_choice: Option<serde_json::Value>,
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
        if self
            .request_id
            .as_ref()
            .is_some_and(|request_id| request_id.trim().is_empty() || request_id.len() > 128)
        {
            return Err("Request ID must contain 1 to 128 characters".to_string());
        }

        if self.prompt.trim().is_empty() {
            return Err("Prompt cannot be empty".to_string());
        }

        // Limit prompt size to prevent abuse. Agent controller prompts embed the
        // running tool trace + schema, so they legitimately need more headroom.
        if self.prompt.len() > 80_000 {
            return Err("Prompt is too long (max 80,000 characters)".to_string());
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

        // Native tool definitions are machine-generated on the frontend, so a
        // huge payload signals abuse rather than a legitimate call.
        if let Some(tools) = &self.tools {
            if tools.to_string().len() > 20_000 {
                return Err("Tool definitions are too large (max 20,000 characters)".to_string());
            }
        }

        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIResponse {
    pub text: String,
    /// The model's real reasoning / chain-of-thought, when the provider exposes it
    /// (e.g. OpenAI-compatible `reasoning_content`, or a leading <think>...</think>
    /// block in the content). `None` when the model returns no reasoning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    pub error: Option<String>,
}
