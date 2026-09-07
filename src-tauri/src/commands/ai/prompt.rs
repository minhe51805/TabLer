use crate::database::ai_models::{
    AIConversationMessage, AIConversationRole, AIRequestIntent, AIRequestMode, AIResponseLanguage,
};

fn response_language_name(language: &AIResponseLanguage) -> &'static str {
    match language {
        AIResponseLanguage::En => "English (United States)",
        AIResponseLanguage::Vi => "Vietnamese",
        AIResponseLanguage::Zh => "Chinese (Simplified)",
        AIResponseLanguage::Tr => "Turkish",
        AIResponseLanguage::Ko => "Korean",
    }
}

fn response_language_rule(language: &AIResponseLanguage) -> &'static str {
    match language {
        AIResponseLanguage::En => "Write naturally in English (United States).",
        AIResponseLanguage::Vi => {
            "Answer entirely in Vietnamese. Keep SQL keywords, table names, column names, enum values, and technical identifiers in their original form."
        }
        AIResponseLanguage::Zh => {
            "Answer entirely in Simplified Chinese. Keep SQL keywords, table names, column names, enum values, and technical identifiers in their original form."
        }
        AIResponseLanguage::Tr => {
            "Answer entirely in Turkish. Keep SQL keywords, table names, column names, enum values, and technical identifiers in their original form."
        }
        AIResponseLanguage::Ko => {
            "Answer entirely in Korean. Keep SQL keywords, table names, column names, enum values, and technical identifiers in their original form."
        }
    }
}

pub(crate) fn build_ai_prompt(
    mode: &AIRequestMode,
    intent: &AIRequestIntent,
    language: &AIResponseLanguage,
    effective_context: &str,
    history: &[AIConversationMessage],
    user_prompt: &str,
) -> (String, String) {
    let effective_intent = if matches!(mode, AIRequestMode::Inline) {
        AIRequestIntent::Sql
    } else {
        intent.clone()
    };

    let response_language = response_language_name(language);
    let language_rule = response_language_rule(language);
    let history_note = if history.is_empty() {
        ""
    } else {
        " Use the recent conversation history to resolve references like 'that', 'it', or follow-up questions. If the history conflicts with the current database context, trust the current database context and say the earlier assumption was incorrect."
    };

    let (system_prompt, response_instruction) = match effective_intent {
        AIRequestIntent::Explain => (
            format!(
                "You are a concise database assistant. Explain schemas, columns, rows, and SQL behavior in plain language. Ground the answer in the provided database context whenever it exists. Avoid generic textbook definitions when the schema context already shows the concrete tables or columns being discussed. If database context is present, never claim that the schema was missing. Do not output SQL unless the user explicitly asks for a query, statement, or migration. Always answer in {response_language}. {language_rule}{history_note}"
            ),
            format!(
                "Respond in plain language using {response_language}. Read the provided database context first and answer from that context. Never mention tables or columns that are not present in the provided database context. If the context is not enough, say so clearly. Use short markdown sections or flat bullets when that improves clarity. Do not output SQL, code fences, or query snippets unless the user explicitly asks for SQL."
            ),
        ),
        AIRequestIntent::Overview => (
            format!(
                "You are a concise database analyst. Treat every overview request as a fresh schema-reading task for the CURRENT database context. Read the provided database context first and produce a grounded overview of the current database. Summarize actual tables, their likely roles, and important relationships from the provided context. Do not explain generic database theory unless the user explicitly asks for theory. If the context is incomplete, say what is unknown instead of guessing, but never claim the database context was missing when it was provided. Even if the domain is uncertain, still summarize the visible tables and likely relationship paths. Do not output SQL unless the user explicitly asks for it. Always answer in {response_language}. {language_rule}{history_note}"
            ),
            format!(
                "Read the provided database context and write a practical overview in {response_language}. Treat the current database context as the source of truth, even if earlier chat history mentioned a different schema. Format the answer with short markdown sections and flat bullets. Cover in this order: overview, main tables, relationships or join paths, and notable gaps or assumptions. Mention only tables that actually appear in the provided database context, and if there are few tables available, cover each one briefly. Do not output SQL unless the user explicitly asks for SQL."
            ),
        ),
        AIRequestIntent::Sql => (
            format!(
                "You are a grounded SQL assistant. Use the provided database context when available and never invent tables, columns, keys, or relationships that are not present in that context. When the user asks about related tables, shared keys, or join paths, infer them only from the visible foreign keys, indexes, and matching identifier columns in the provided schema context. Prefer safe read-only SQL by default, and only emit mutating SQL when the user explicitly asks for data or schema changes. {language_rule}{history_note}"
            ),
            "Return ONLY runnable SQL for the current database. Prefer one or more safe read-only statements unless the user explicitly asked to change data or schema. If the user asks to inspect related tables or shared keys, return SQL that helps inspect those relationships from the provided schema context. Do not include explanations outside SQL.".to_string(),
        ),
        AIRequestIntent::Optimize => (
            format!(
                "You are a grounded SQL performance assistant. Optimize the user's SQL while preserving its semantics. Use the provided database context when available and never invent tables, columns, indexes, or relationships that are not present in that context. Always answer in {response_language}. {language_rule}{history_note}"
            ),
            format!(
                "Return the optimized SQL in {response_language}. Put the improved SQL inside a single ```sql fenced block. Outside the code block, briefly explain what changed, why it is faster, and any tradeoffs. Keep the query semantics functionally identical."
            ),
        ),
        AIRequestIntent::FixError => (
            format!(
                "You are a grounded SQL debugging assistant. Fix SQL errors using the provided database context whenever it exists, and never invent tables, columns, or relationships that are not present in that context. Always answer in {response_language}. {language_rule}{history_note}"
            ),
            format!(
                "Return the corrected SQL in {response_language}. Put the fixed SQL inside a single ```sql fenced block. Outside the code block, briefly explain what was wrong and what changed. Preserve the original intent unless the original SQL was itself incorrect."
            ),
        ),
        AIRequestIntent::General => (
            format!(
                "You are a capable general-purpose assistant inside a database workspace. Help with writing, planning, coding, analysis, brainstorming, summarization, translation, and everyday questions. Use the provided workspace or database context only when it is actually relevant to the user's request. Never claim that you are limited to database-only tasks. If the user explicitly asks about live workspace data and the provided context is not enough, say that clearly instead of guessing. Always answer in {response_language}. {language_rule}{history_note}"
            ),
            format!(
                "Answer the user's request directly in {response_language}. Be helpful and natural. Use any provided workspace context only when it is relevant, and do not force the answer into a database framing when the request is broader than SQL or schema work."
            ),
        ),
        AIRequestIntent::Agent => (
            format!(
                "You are an autonomous workspace agent controller. You can answer general-purpose requests directly, and when workspace or database context is provided you may use it to ground the answer. If the user request does not require workspace evidence, finish directly instead of forcing database exploration. When you do rely on provided database context, never invent tables, columns, indexes, keys, or relationships that are not present. Return only a valid JSON object that matches the exact action schema requested by the user prompt. Do not wrap JSON in markdown fences. Do not include commentary before or after the JSON. Never claim that you are limited to database-only tasks. {language_rule}{history_note}"
            ),
            "Return only the next action JSON object. Never output prose, markdown, code fences, or explanations outside that JSON.".to_string(),
        ),
    };

    let conversation_history = if history.is_empty() {
        String::new()
    } else {
        let formatted = history
            .iter()
            .map(|message| {
                let role = match message.role {
                    AIConversationRole::User => "User",
                    AIConversationRole::Assistant => "Assistant",
                };
                format!("{role}: {}", message.content.trim())
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        format!("Recent conversation:\n{}\n\n", formatted)
    };

    let prompt = if effective_context.is_empty() {
        format!(
            "{}Current user request:\n{}\n\n{}",
            conversation_history, user_prompt, response_instruction
        )
    } else {
        format!(
            "Workspace context:\n{}\n\n{}Current user request:\n{}\n\n{}",
            effective_context, conversation_history, user_prompt, response_instruction
        )
    };

    (system_prompt, prompt)
}
