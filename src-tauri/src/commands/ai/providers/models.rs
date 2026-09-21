use super::super::endpoints::ModelsListShape;
use super::super::{FetchedModel, FetchedModelPricing};

/// Extracts the models from a provider's "list models" response, along with any
/// capability metadata (context window, output budget, input modalities) the
/// API advertised so the settings modal can auto-fill them instead of forcing
/// manual entry. The envelope differs per dialect (`shape`), so the caller
/// resolves that first via `resolve_models_list_endpoint`. Duplicate ids and
/// blanks are dropped while preserving the provider's own ordering.
pub(crate) fn parse_models_list_response(
    shape: ModelsListShape,
    value: &serde_json::Value,
) -> Vec<FetchedModel> {
    let raw: Vec<FetchedModel> = match shape {
        ModelsListShape::OpenAiData => value
            .get("data")
            .and_then(|data| data.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(parse_openai_model_entry)
                    .collect()
            })
            .unwrap_or_default(),
        ModelsListShape::OllamaTags => value
            .get("models")
            .and_then(|models| models.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.get("name").and_then(|name| name.as_str()))
                    .map(|name| FetchedModel {
                        id: name.to_string(),
                        context_window: None,
                        max_output_tokens: None,
                        input_types: Vec::new(),
                        pricing: None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        ModelsListShape::GeminiModels => value
            .get("models")
            .and_then(|models| models.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| supports_generate_content(entry))
                    .filter_map(parse_gemini_model_entry)
                    .collect()
            })
            .unwrap_or_default(),
    };

    let mut seen = std::collections::HashSet::new();
    raw.into_iter()
        .map(|mut model| {
            model.id = model.id.trim().to_string();
            model
        })
        .filter(|model| !model.id.is_empty())
        .filter(|model| seen.insert(model.id.clone()))
        .collect()
}

/// Reads a token-count field a provider may send as an integer or a stringified
/// number, checking each candidate key in order. Non-positive or unparseable
/// values are treated as absent so a bogus `0` never overrides a real default.
fn model_capacity(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let field = value.get(*key)?;
        let count = field.as_u64().or_else(|| {
            field
                .as_str()
                .and_then(|raw| raw.trim().parse::<u64>().ok())
        })?;
        (count > 0).then_some(count)
    })
}

/// Builds a `FetchedModel` from an OpenAI-style `/v1/models` entry. Plain OpenAI
/// only exposes `id`, but OpenRouter enriches each entry with a `context_length`,
/// a `top_provider` budget, and `architecture.input_modalities`, so those are
/// harvested when present to pre-fill the model's capabilities.
fn parse_openai_model_entry(entry: &serde_json::Value) -> Option<FetchedModel> {
    let id = entry.get("id").and_then(|id| id.as_str())?.to_string();
    let top_provider = entry.get("top_provider");
    let context_window =
        model_capacity(entry, &["context_length", "context_window"]).or_else(|| {
            top_provider.and_then(|tp| model_capacity(tp, &["context_length", "context_window"]))
        });
    let max_output_tokens = top_provider
        .and_then(|tp| model_capacity(tp, &["max_completion_tokens", "max_output_tokens"]))
        .or_else(|| model_capacity(entry, &["max_completion_tokens", "max_output_tokens"]));
    let input_types = entry
        .get("architecture")
        .and_then(|arch| arch.get("input_modalities"))
        .and_then(|modalities| modalities.as_array())
        .map(|modalities| {
            modalities
                .iter()
                .filter_map(|modality| modality.as_str())
                .map(|modality| modality.to_string())
                .collect()
        })
        .unwrap_or_default();
    Some(FetchedModel {
        id,
        context_window,
        max_output_tokens,
        input_types,
        pricing: parse_model_pricing(entry),
    })
}

/// Builds a `FetchedModel` from a Gemini `/v1beta/models` entry, stripping the
/// `models/` name prefix and reading the `inputTokenLimit` / `outputTokenLimit`
/// budgets Gemini advertises per model.
fn parse_gemini_model_entry(entry: &serde_json::Value) -> Option<FetchedModel> {
    let name = entry.get("name").and_then(|name| name.as_str())?;
    let id = name.strip_prefix("models/").unwrap_or(name).to_string();
    Some(FetchedModel {
        id,
        context_window: model_capacity(entry, &["inputTokenLimit"]),
        max_output_tokens: model_capacity(entry, &["outputTokenLimit"]),
        input_types: Vec::new(),
        pricing: None,
    })
}

/// Reads OpenRouter-style `pricing.*` fields (stringified USD per token).
/// Returns `None` when the provider publishes no pricing block so the picker
/// can distinguish "unknown price" from "free" (all-zero).
fn parse_model_pricing(entry: &serde_json::Value) -> Option<FetchedModelPricing> {
    let pricing = entry.get("pricing")?;
    let read = |key: &str| -> Option<f64> {
        pricing.get(key).and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| v.as_f64())
        })
    };
    let prompt = read("prompt")?;
    let completion = read("completion")?;
    Some(FetchedModelPricing {
        prompt,
        completion,
        input_cache_read: read("input_cache_read"),
        input_cache_write: read("input_cache_write"),
    })
}

/// Gemini lists embeddings and legacy models alongside chat models; keep only
/// those advertising `generateContent` (the dialect TableR speaks). Missing
/// metadata is treated as capable so a schema change never silently drops
/// every model.
fn supports_generate_content(entry: &serde_json::Value) -> bool {
    match entry
        .get("supportedGenerationMethods")
        .and_then(|methods| methods.as_array())
    {
        Some(methods) => methods
            .iter()
            .any(|method| method.as_str() == Some("generateContent")),
        None => true,
    }
}
