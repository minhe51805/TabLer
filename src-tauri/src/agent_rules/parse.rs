use std::collections::HashMap;

use regex::Regex;

use super::types::{
    AgentRule, CompiledRule, RuleAction, RuleEvent, RuleOrigin, RuleScan, SqlEvent, MAX_PATTERN_LEN,
};
fn parse_frontmatter(contents: &str) -> Result<HashMap<String, String>, String> {
    let normalized = contents
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n");
    let mut lines = normalized.lines();

    let first = lines.next().unwrap_or_default();
    if first.trim() != "---" {
        return Err("missing opening `---` frontmatter fence".to_string());
    }

    let mut fields: HashMap<String, String> = HashMap::new();
    let mut closed = false;

    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
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
    }

    if !closed {
        return Err("missing closing `---` frontmatter fence".to_string());
    }

    Ok(fields)
}

/// Build a rule from a Markdown file. `origin` records where it was read from;
/// `fallback_name` is used when the file omits `name:`.
pub fn parse_rule(
    fallback_name: &str,
    contents: &str,
    origin: RuleOrigin,
) -> Result<AgentRule, String> {
    let fields = parse_frontmatter(contents)?;

    let field = |key: &str| -> Option<String> {
        fields
            .get(key)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };

    let name = field("name").unwrap_or_else(|| fallback_name.to_string());
    if name.is_empty() {
        return Err("rule has an empty name".to_string());
    }

    let description =
        field("description").ok_or_else(|| format!("rule `{name}` has no description"))?;

    let enabled = match field("enabled").as_deref() {
        None => true,
        Some(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "false" | "0" | "no" | "off"
        ),
    };

    let pattern = field("pattern").ok_or_else(|| format!("rule `{name}` has no pattern"))?;
    if pattern.len() > MAX_PATTERN_LEN {
        return Err(format!(
            "rule `{name}` pattern is longer than {MAX_PATTERN_LEN} bytes"
        ));
    }

    Ok(AgentRule {
        name,
        description,
        enabled,
        event: RuleEvent::parse(field("event").as_deref().unwrap_or("pre_write")),
        action: RuleAction::parse(field("action").as_deref().unwrap_or("warn")),
        pattern,
        pattern_not: field("pattern-not"),
        scan: RuleScan::parse(field("scan").as_deref().unwrap_or("skeleton")),
        origin,
    })
}

/// Compile one rule. A rule whose regex does not compile is an **error**, never
/// a skip: an inert guardrail is worse than no guardrail, because callers
/// believe they are protected.
pub fn compile_rule(rule: AgentRule) -> Result<CompiledRule, String> {
    let matcher = Regex::new(&rule.pattern)
        .map_err(|e| format!("rule `{}` has an invalid pattern: {e}", rule.name))?;

    let exception = match rule.pattern_not.as_deref() {
        None => None,
        Some(source) => Some(
            Regex::new(source)
                .map_err(|e| format!("rule `{}` has an invalid pattern-not: {e}", rule.name))?,
        ),
    };

    Ok(CompiledRule {
        rule,
        matcher,
        exception,
    })
}

/// Replace comments and string literals with spaces, so a keyword inside a
/// literal or a comment cannot masquerade as the statement's verb.
pub(crate) fn skeleton(statement: &str) -> String {
    let chars: Vec<char> = statement.chars().collect();
    let mut out = String::with_capacity(statement.len());
    let mut quote: Option<char> = None;
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];

        if let Some(delimiter) = quote {
            if ch == delimiter {
                // `` or '' is an escaped quote inside the literal.
                if i + 1 < chars.len() && chars[i + 1] == delimiter {
                    i += 2;
                    continue;
                }
                quote = None;
            }
            out.push(' ');
            i += 1;
            continue;
        }

        if ch == '\'' || ch == '"' || ch == '`' || ch == '[' {
            // `[...]` is a T-SQL identifier, not a literal: keep its name so a
            // statement starting with a quoted identifier still classifies.
            if ch == '[' {
                out.push(ch);
                i += 1;
                continue;
            }
            quote = Some(ch);
            out.push(' ');
            i += 1;
            continue;
        }

        if ch == '-' && i + 1 < chars.len() && chars[i + 1] == '-' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            out.push('\n');
            continue;
        }

        if ch == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            out.push(' ');
            continue;
        }

        out.push(ch);
        i += 1;
    }

    out
}
/// Leading keyword of a statement, lowercased, with any PostgreSQL/SQL Server
/// noise (`EXPLAIN ANALYZE`, `WITH RECURSIVE`, `SET NOCOUNT ON`) skipped so the
/// verb is the thing that decides the class.
fn leading_keyword(statement: &str) -> String {
    const SKIP: &[&str] = &[
        "recursive",
        "analyze",
        "analyse",
        "verbose",
        "nocount",
        "on",
        "off",
        "only",
    ];

    let words = statement
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty());

    for word in words {
        let lower = word.to_ascii_lowercase();
        if SKIP.contains(&lower.as_str()) {
            continue;
        }
        return lower;
    }

    String::new()
}

/// Keywords that always mean the statement mutates data, schema, or server
/// state. Shared by the leading-keyword match and the EXPLAIN ANALYZE
/// re-classification so both agree on what counts as a write.
pub(crate) fn is_write_keyword(keyword: &str) -> bool {
    matches!(
        keyword,
        "insert"
            | "update"
            | "delete"
            | "truncate"
            | "drop"
            | "alter"
            | "create"
            | "replace"
            | "merge"
            | "grant"
            | "revoke"
            | "comment"
            | "exec"
            | "execute"
            | "call"
            | "vacuum"
            | "reindex"
            | "refresh"
            | "rename"
            | "upsert"
            | "begin"
            | "commit"
            | "rollback"
            | "savepoint"
            | "set"
            | "use"
            | "copy"
            | "load"
            | "import"
            | "analyze"
            | "lock"
            | "unlock"
            | "do"
            | "attach"
            | "detach"
            | "pragma"
    )
}

/// Split a script into individual statements, then classify the whole script.
///
/// The input is reduced to a skeleton first, so a `;` or a `DELETE` inside a
/// string literal cannot split a statement or change its class. Any statement
/// that mutates anything makes the whole script a `Write`: a script is only as
/// safe as its most dangerous statement.
pub fn classify_sql_event(statement: &str) -> SqlEvent {
    let body = skeleton(statement);
    let mut saw_read = false;
    let mut saw_unknown = false;

    for piece in body.split(';') {
        if piece.trim().is_empty() {
            continue;
        }

        let keyword = leading_keyword(piece);
        match keyword.as_str() {
            "explain" => {
                // Mirror canonical_statement_kind: EXPLAIN of a write is a
                // write whether or not ANALYZE is present — a read-only
                // surface must not plan mutations either. Re-classify the
                // wrapped verb past the EXPLAIN option noise.
                let tokens: Vec<String> = piece
                    .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .filter(|w| !w.is_empty())
                    .map(|w| w.to_ascii_lowercase())
                    .collect();
                match tokens
                    .iter()
                    .find(|t| {
                        !matches!(
                            t.as_str(),
                            "explain"
                                | "analyze"
                                | "analyse"
                                | "verbose"
                                | "format"
                                | "buffers"
                                | "wal"
                                | "timing"
                                | "summary"
                                | "memory"
                                | "serialize"
                                | "settings"
                                | "generic_plan"
                                | "true"
                                | "false"
                                | "on"
                                | "off"
                                | "text"
                                | "xml"
                                | "json"
                                | "yaml"
                        )
                    })
                    .map(String::as_str)
                {
                    Some(inner) if is_write_keyword(inner) => return SqlEvent::Write,
                    _ => saw_read = true,
                }
            }
            "select" | "with" | "values" => {
                // SELECT ... INTO creates a table; WITH bodies can carry DML.
                let mutating = piece
                    .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .filter(|w| !w.is_empty())
                    .map(|w| w.to_ascii_lowercase())
                    .any(|w| {
                        matches!(
                            w.as_str(),
                            "into" | "insert" | "update" | "delete" | "merge" | "replace"
                        )
                    });
                if mutating {
                    return SqlEvent::Write;
                }
                saw_read = true;
            }
            "show" | "describe" | "declare" => {
                saw_read = true;
            }
            _ if is_write_keyword(&keyword) => {
                return SqlEvent::Write;
            }
            "" => {}
            _ => saw_unknown = true,
        }
    }

    if saw_unknown && !saw_read {
        SqlEvent::Unknown
    } else if saw_read {
        SqlEvent::Read
    } else {
        SqlEvent::Unknown
    }
}
