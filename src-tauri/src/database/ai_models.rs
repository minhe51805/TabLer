use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AIProviderType {
    OpenAI,
    Anthropic,
    Gemini,
    Vertex,
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

/// Provider-agnostic tool definition sent from the frontend so the backend can
/// translate into any dialect (OpenAI, Anthropic, Gemini/Vertex, OllamaChat) —
/// including mid-run cross-provider failover — without leaking unsupported keys
/// onto text-only endpoints like `OllamaGenerate`.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct CanonicalToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Provider-agnostic tool invocation returned by the model and replayed in
/// `CanonicalAgentTurn::Assistant`.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct CanonicalToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Normalized token usage breakdown across all AI dialects.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
pub struct AIUsageStats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
}

impl AIUsageStats {
    pub fn is_empty(&self) -> bool {
        self.input_tokens.is_none()
            && self.output_tokens.is_none()
            && self.total_tokens.is_none()
            && self.cache_read_input_tokens.is_none()
            && self.cache_creation_input_tokens.is_none()
    }
}

/// Provider-agnostic multi-turn agent message replayed after the initial user
/// turn (`AIRequest::prompt`) during an active agent loop.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum CanonicalAgentTurn {
    User {
        content: String,
    },
    Assistant {
        #[serde(default)]
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thought_signature: Option<String>,
        #[serde(default)]
        tool_calls: Vec<CanonicalToolCall>,
    },
    ToolResult {
        call_id: String,
        tool_name: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

impl CanonicalAgentTurn {
    pub fn approx_char_len(&self) -> usize {
        match self {
            Self::User { content } => content.len(),
            Self::Assistant {
                text,
                reasoning,
                thought_signature,
                tool_calls,
            } => {
                let calls_len: usize = tool_calls
                    .iter()
                    .map(|call| call.id.len() + call.name.len() + call.arguments.to_string().len())
                    .sum();
                text.len()
                    + reasoning.as_ref().map_or(0, String::len)
                    + thought_signature.as_ref().map_or(0, String::len)
                    + calls_len
            }
            Self::ToolResult {
                call_id,
                tool_name,
                content,
                ..
            } => call_id.len() + tool_name.len() + content.len(),
        }
    }
}

/// A user attachment riding the current request. `kind` is "image" or "text";
/// images carry base64 `data` (no data-URL prefix), text files carry the file
/// contents inline. Field names stay snake_case to match the frontend wire
/// format.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIRequestAttachment {
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub data: String,
}

/// Optional per-model metadata: context budget and I/O capabilities, keyed by
/// model id on `AIProviderConfig::model_settings`. Absent = provider defaults.
/// Field names stay snake_case to match the frontend wire format.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(default)]
pub struct AIModelSettings {
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub input_types: Vec<String>,
    pub output_types: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: AIProviderType,
    pub endpoint: String,
    pub model: String,
    /// Optional cheaper/faster model id on this provider; trivial intents
    /// (short explains, formatting, general chat) route here when set.
    #[serde(default)]
    pub fast_model: Option<String>,
    pub is_enabled: bool,
    #[serde(default)]
    pub is_primary: bool,
    #[serde(default)]
    pub allow_schema_context: bool,
    #[serde(default)]
    pub allow_inline_completion: bool,
    /// Explicit API wire format for Custom providers ("chat-completions",
    /// "ollama-chat", "ollama-generate"). `None`/"auto" keeps URL sniffing.
    #[serde(default)]
    pub api_format: Option<String>,
    /// Model catalog offered by this provider. Empty = legacy single-model
    /// config, where `model` alone is the truth.
    #[serde(default)]
    pub models: Vec<String>,
    /// Models hidden from the composer switcher. They stay editable here in
    /// storage so they can be re-enabled without retyping the ID.
    #[serde(default)]
    pub disabled_models: Vec<String>,
    /// Per-model metadata keyed by model id (context window, output budget,
    /// I/O capability chips). Missing entry = provider defaults.
    #[serde(default)]
    pub model_settings: HashMap<String, AIModelSettings>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIRequest {
    #[serde(default)]
    pub request_id: Option<String>,
    /// Optional explicit provider override; when absent the active provider is used.
    /// Powers the frontend failover chain across enabled providers.
    #[serde(default)]
    pub provider_id: Option<String>,
    /// Optional per-request model override; when absent the provider's
    /// configured model is used. Powers the model-level tier of the frontend
    /// failover chain (try the provider's other models before leaving it).
    #[serde(default)]
    pub model: Option<String>,
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
    /// User attachments for the current turn (images become multimodal parts;
    /// text-file contents are already inlined into `prompt` by the frontend).
    /// Empty keeps the classic text path byte-identical.
    #[serde(default)]
    pub attachments: Vec<AIRequestAttachment>,
    /// Provider-agnostic native tool definitions translated per-dialect in Rust
    /// (supports cross-provider mid-run failover and text-only `OllamaGenerate`
    /// fallback).
    #[serde(default)]
    pub canonical_tools: Option<Vec<CanonicalToolSpec>>,
    /// Enables Anthropic's native `memory_20250818` tool when targeting Claude;
    /// automatically ignored on non-Anthropic wire dialects.
    #[serde(default)]
    pub allow_native_memory_tool: bool,
    /// Structured multi-turn agent steps (`assistant`, `tool_result`, `user`)
    /// replayed after the initial prompt turn.
    #[serde(default)]
    pub agent_turns: Vec<CanonicalAgentTurn>,
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
    /// Per-request thinking/reasoning gate driven by the panel "Thinking" toggle.
    /// `None` keeps the capability-gated default (reasoning on for models that
    /// support it); `Some(false)` forces it off across every provider so the run
    /// spends no thinking tokens; `Some(true)` is the explicit opt-in (still
    /// capability-gated, never forced onto a model that would 400).
    #[serde(default)]
    pub enable_thinking: Option<bool>,
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
        // All caps below are the single source of truth in `crate::config` and
        // are mirrored to the frontend (tech-debt audit D1); the cross-language
        // contract test fails the build if the two sides ever drift.
        if self.prompt.len() > crate::config::AI_MAX_PROMPT_CHARS {
            return Err("Prompt is too long (max 80,000 characters)".to_string());
        }

        // Limit context size
        if self.context.len() > crate::config::AI_MAX_CONTEXT_CHARS {
            return Err("Context is too long (max 50,000 characters)".to_string());
        }

        if self.history.len() > crate::config::AI_MAX_HISTORY_MESSAGES {
            return Err("Conversation history is too long (max 12 messages)".to_string());
        }

        let history_chars = self
            .history
            .iter()
            .map(|message| message.content.len())
            .sum::<usize>();
        if history_chars > crate::config::AI_MAX_HISTORY_CHARS {
            return Err("Conversation history is too large (max 24,000 characters)".to_string());
        }

        // Native tool definitions are machine-generated on the frontend, so a
        // huge payload signals abuse rather than a legitimate call.
        if let Some(tools) = &self.tools {
            if tools.to_string().len() > crate::config::AI_MAX_TOOLS_CHARS {
                return Err("Tool definitions are too large (max 40,000 characters)".to_string());
            }
        }
        if let Some(canonical_tools) = &self.canonical_tools {
            let serialized_len = serde_json::to_string(canonical_tools)
                .map(|raw| raw.len())
                .unwrap_or(usize::MAX);
            if serialized_len > crate::config::AI_MAX_TOOLS_CHARS {
                return Err("Tool definitions are too large (max 40,000 characters)".to_string());
            }
        }

        if self.agent_turns.len() > crate::config::AI_MAX_AGENT_TURNS {
            return Err("Agent turn transcript is too long (max 64 turns)".to_string());
        }
        let agent_turn_chars = self
            .agent_turns
            .iter()
            .map(CanonicalAgentTurn::approx_char_len)
            .sum::<usize>();
        if agent_turn_chars > crate::config::AI_MAX_AGENT_TURNS_CHARS {
            return Err("Agent turn transcript is too large (max 160,000 characters)".to_string());
        }

        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AIResponse {
    pub text: String,
    /// The model's real reasoning / chain-of-thought, when the provider exposes it
    /// (e.g. OpenAI-compatible `reasoning_content`, or a leading <think>...</think>
    /// block in the content). `None` when the model returns no reasoning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// Native tool calls returned by the model in canonical provider-agnostic form.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<CanonicalToolCall>,
    /// Provider signature associated with extended thinking (`thoughtSignature` on
    /// Gemini 2.5/3, `thinking.signature` on Anthropic Claude 3.7/4) so subsequent
    /// turns can echo it back faithfully.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
    /// Normalized token usage breakdown when reported by the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<AIUsageStats>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_agent_turns_roundtrip_wire_format_and_validate_caps() {
        let turns = vec![
            CanonicalAgentTurn::Assistant {
                text: "Checking users and orders".to_string(),
                reasoning: Some("Need schema for both tables.".to_string()),
                thought_signature: Some("sig-123".to_string()),
                tool_calls: vec![
                    CanonicalToolCall {
                        id: "call_1".to_string(),
                        name: "describe_table".to_string(),
                        arguments: json!({ "table": "users" }),
                    },
                    CanonicalToolCall {
                        id: "call_2".to_string(),
                        name: "describe_table".to_string(),
                        arguments: json!({ "table": "orders" }),
                    },
                ],
            },
            CanonicalAgentTurn::ToolResult {
                call_id: "call_1".to_string(),
                tool_name: "describe_table".to_string(),
                content: "id INT, email TEXT".to_string(),
                is_error: false,
            },
        ];

        let serialized = serde_json::to_value(&turns).expect("turns serialize");
        assert_eq!(serialized[0]["role"], "assistant");
        assert_eq!(serialized[0]["tool_calls"].as_array().unwrap().len(), 2);
        assert_eq!(serialized[1]["role"], "tool_result");

        let decoded: Vec<CanonicalAgentTurn> =
            serde_json::from_value(serialized).expect("turns deserialize");
        assert_eq!(decoded, turns);
    }
}
