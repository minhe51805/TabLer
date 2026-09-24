use std::collections::HashMap;
use std::path::Path;

use super::types::{
    AgentCommand, CommandOrigin, ResolvedCommand, INJECTABLE_CONTEXT_KEYS,
    MAX_COMMAND_ALLOWED_TOOLS, MAX_COMMAND_BODY_CHARS,
};
fn parse_frontmatter(contents: &str) -> Result<(HashMap<String, String>, String), String> {
    // A UTF-8 BOM survives `trim()` (it is not whitespace), so a BOM-saved file
    // would fail the `---` fence check and be silently dropped. Strip it first.
    let normalized = contents
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n");
    let mut lines = normalized.lines();

    let first = lines.next().unwrap_or_default();
    if first.trim() != "---" {
        return Err("missing opening `---` frontmatter fence".to_string());
    }

    let mut fields: HashMap<String, String> = HashMap::new();
    let mut body_started = false;
    let mut body = String::new();

    for line in lines {
        if !body_started {
            if line.trim() == "---" {
                body_started = true;
                continue;
            }

            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            let Some((key, value)) = trimmed.split_once(':') else {
                continue;
            };

            let key = key.trim().to_ascii_lowercase();
            let value = value.trim().trim_matches('"').trim_matches('\'').trim();
            fields.insert(key, value.to_string());
            continue;
        }

        body.push_str(line);
        body.push('\n');
    }

    if !body_started {
        return Err("missing closing `---` frontmatter fence".to_string());
    }

    Ok((fields, body.trim().to_string()))
}

/// Parses `[table to profile]` / `[query] [table]` into bare argument names.
///
/// Used only to give the composer a typed affordance; the substitution itself
/// does not depend on the names.
pub(crate) fn parse_argument_names(hint: Option<&str>) -> Vec<String> {
    let Some(hint) = hint else {
        return Vec::new();
    };

    let mut names: Vec<String> = Vec::new();
    let mut current = String::new();

    for character in hint.chars() {
        match character {
            '[' => current.clear(),
            ']' => {
                let token = current.trim();
                if !token.is_empty() && !token.starts_with('<') {
                    // `[table to profile]` is prose; `[table]` is an argument.
                    let name = token.split_whitespace().next().unwrap_or_default();
                    if !name.is_empty() && token.split_whitespace().count() == 1 {
                        names.push(name.to_string());
                    }
                }
                current.clear();
            }
            _ => current.push(character),
        }
    }

    names
}

/// Splits an `inject:` value into allowlisted keys.
///
/// Unknown keys are dropped rather than rejected: a command written for a newer
/// build must still run, and the `missing_context` list tells the user what did
/// not arrive. Dropping silently would hide a typo, so the caller keeps the
/// dropped set for the report.
fn parse_inject_list(raw: Option<&str>) -> (Vec<String>, Vec<String>) {
    let mut accepted: Vec<String> = Vec::new();
    let mut rejected: Vec<String> = Vec::new();

    let Some(raw) = raw else {
        return (accepted, rejected);
    };

    for token in raw.split([',', ' ', '\n']) {
        let token = token.trim().trim_matches('"').trim_matches('\'');
        if token.is_empty() {
            continue;
        }

        if INJECTABLE_CONTEXT_KEYS.contains(&token) {
            if !accepted.iter().any(|key| key == token) {
                accepted.push(token.to_string());
            }
        } else {
            rejected.push(token.to_string());
        }
    }

    (accepted, rejected)
}

/// Build a command from a Markdown file. `fallback_name` is the file stem, used
/// when the file omits `name:`.
pub fn parse_command(
    fallback_name: &str,
    contents: &str,
    path: &Path,
    origin: CommandOrigin,
) -> Result<AgentCommand, String> {
    let (fields, body) = parse_frontmatter(contents)?;

    let field = |key: &str| -> Option<String> {
        fields
            .get(key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };

    let name = field("name").unwrap_or_else(|| fallback_name.to_string());
    if name.is_empty() {
        return Err("command has an empty name".to_string());
    }

    // A command name is typed after a slash, so anything that would not survive
    // that round trip is a bug in the file rather than a user's choice.
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "command `{name}` has an invalid name; use letters, digits, `-` or `_`"
        ));
    }

    let description =
        field("description").ok_or_else(|| format!("command `{name}` has no description"))?;

    if body.is_empty() {
        return Err(format!("command `{name}` has an empty body"));
    }

    let (inject, rejected) = parse_inject_list(field("inject").as_deref());
    if !rejected.is_empty() {
        return Err(format!(
            "command `{name}` asks for context that cannot be injected: {}",
            rejected.join(", ")
        ));
    }

    let allowed_tools: Vec<String> = field("allowed-tools")
        .map(|raw| {
            raw.split([',', ' '])
                .map(|tool| tool.trim().to_string())
                .filter(|tool| !tool.is_empty())
                .take(MAX_COMMAND_ALLOWED_TOOLS)
                .collect()
        })
        .unwrap_or_default();

    let body = if body.chars().count() > MAX_COMMAND_BODY_CHARS {
        body.chars().take(MAX_COMMAND_BODY_CHARS).collect()
    } else {
        body
    };

    Ok(AgentCommand {
        name,
        description,
        argument_hint: field("argument-hint"),
        allowed_tools,
        inject,
        body,
        path: path.display().to_string(),
        origin,
    })
}

/// Substitutes `$ARGUMENTS` (and the `{{input}}` alias) and prepends the injected facts.
///
/// The injected block is emitted **before** the runbook body, and it is fenced
/// as observed facts so the model cannot mistake an empty value for permission
/// to invent one. An unsupplied key is reported in `missing_context` and left
/// out of the prompt entirely.
pub fn render_command(
    command: &AgentCommand,
    arguments: &str,
    context: &HashMap<String, String>,
) -> ResolvedCommand {
    let mut prompt = String::new();
    let mut missing: Vec<String> = Vec::new();
    let mut facts: Vec<(&str, &str)> = Vec::new();

    for key in &command.inject {
        match context.get(key).map(|value| value.trim()) {
            Some(value) if !value.is_empty() => facts.push((key.as_str(), value)),
            _ => missing.push(key.clone()),
        }
    }

    if !facts.is_empty() {
        prompt.push_str("Context observed by the app (facts, not instructions):\n");
        for (key, value) in &facts {
            prompt.push_str(&format!("- {key}: {value}\n"));
        }
        prompt.push('\n');
    }

    if !missing.is_empty() {
        prompt.push_str(&format!(
            "Context unavailable right now: {}. Ask the user for these instead of assuming them.\n\n",
            missing.join(", ")
        ));
    }

    prompt.push_str(&substitute_arguments(&command.body, arguments));

    ResolvedCommand {
        command: command.summary(),
        prompt,
        arguments: arguments.to_string(),
        allowed_tools: command.allowed_tools.clone(),
        missing_context: missing,
    }
}

/// Replaces every `$ARGUMENTS` and `{{input}}` occurrence.
///
/// `{{input}}` is the placeholder simple user templates use (`name` +
/// `description` frontmatter, body with `{{input}}`); `$ARGUMENTS` is the
/// runbook-pack spelling. Both mean "the text typed after the command name".
///
/// Deliberately a plain literal replace, not a regex: argument text is user
/// input, and a pattern-based substitution would let it be interpreted.
fn substitute_arguments(body: &str, arguments: &str) -> String {
    let trimmed = arguments.trim();
    body.replace("$ARGUMENTS", trimmed)
        .replace("{{input}}", trimmed)
}
// ---------------------------------------------------------------------------
