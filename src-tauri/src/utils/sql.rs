use serde::Serialize;
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlStatementKind {
    Read,
    Write,
    Schema,
    Session,
    Transaction,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlStatementDecision {
    pub sql: String,
    pub kind: SqlStatementKind,
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSafetyDecision {
    pub statements: Vec<SqlStatementDecision>,
    pub read_only: bool,
    pub has_schema_mutation: bool,
    pub parse_error: Option<String>,
}

fn canonical_statement_kind(statement: &str) -> SqlStatementKind {
    let normalized = statement
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase();
    let first = normalized.split_whitespace().next().unwrap_or_default();
    let tokens = normalized
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    let contains_write = tokens.iter().any(|token| {
        matches!(
            *token,
            "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE" | "COPY"
        )
    });

    match first {
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "VALUES" => SqlStatementKind::Read,
        "EXPLAIN" => {
            if contains_write {
                SqlStatementKind::Write
            } else {
                SqlStatementKind::Read
            }
        }
        "WITH" => {
            if contains_write {
                SqlStatementKind::Write
            } else {
                SqlStatementKind::Read
            }
        }
        "PRAGMA" => {
            if normalized.contains('=') {
                SqlStatementKind::Session
            } else {
                SqlStatementKind::Read
            }
        }
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE" | "COPY" => SqlStatementKind::Write,
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "COMMENT" => SqlStatementKind::Schema,
        "GRANT" | "REVOKE" | "USE" | "ATTACH" | "DETACH" | "SET" | "RESET" => {
            SqlStatementKind::Session
        }
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" => {
            SqlStatementKind::Transaction
        }
        _ => SqlStatementKind::Unknown,
    }
}

/// Parse once at the backend boundary and provide the canonical safety decision used by
/// the editor, AI tools, MCP, timeouts, and schema-cache invalidation.
pub fn classify_sql(sql: &str) -> SqlSafetyDecision {
    let dialect = GenericDialect {};
    match Parser::parse_sql(&dialect, sql) {
        Ok(parsed) if parsed.is_empty() => SqlSafetyDecision {
            statements: Vec::new(),
            read_only: false,
            has_schema_mutation: false,
            parse_error: Some("SQL contains no executable statements.".to_string()),
        },
        Ok(parsed) => {
            let statements = parsed
                .into_iter()
                .map(|statement| {
                    let canonical = statement.to_string();
                    let kind = canonical_statement_kind(&canonical);
                    SqlStatementDecision {
                        sql: canonical,
                        kind,
                        read_only: kind == SqlStatementKind::Read,
                    }
                })
                .collect::<Vec<_>>();
            SqlSafetyDecision {
                read_only: statements.iter().all(|statement| statement.read_only),
                has_schema_mutation: statements
                    .iter()
                    .any(|statement| statement.kind == SqlStatementKind::Schema),
                statements,
                parse_error: None,
            }
        }
        Err(error) => {
            let statements = split_sql_statements(sql)
                .into_iter()
                .filter_map(|statement| {
                    let cleaned = strip_leading_comments(&statement);
                    if cleaned.is_empty() {
                        return None;
                    }
                    Some(SqlStatementDecision {
                        sql: statement,
                        kind: SqlStatementKind::Unknown,
                        read_only: false,
                    })
                })
                .collect();
            SqlSafetyDecision {
                statements,
                read_only: false,
                has_schema_mutation: false,
                parse_error: Some(error.to_string()),
            }
        }
    }
}

fn strip_leading_comments(statement: &str) -> &str {
    let mut remaining = statement.trim_start();
    loop {
        if let Some(after_line_comment) = remaining.strip_prefix("--") {
            let Some((_, next_line)) = after_line_comment.split_once('\n') else {
                return "";
            };
            remaining = next_line.trim_start();
            continue;
        }
        if let Some(after_block_comment) = remaining.strip_prefix("/*") {
            let Some(end) = after_block_comment.find("*/") else {
                return "";
            };
            remaining = after_block_comment[end + 2..].trim_start();
            continue;
        }
        return remaining;
    }
}

fn match_dollar_quote_tag(sql: &str, start: usize) -> Option<String> {
    let rest = sql.get(start..)?;
    if !rest.starts_with('$') {
        return None;
    }

    let mut chars = rest.char_indices();
    chars.next()?;
    let mut end_index = None;

    for (index, ch) in chars {
        if ch == '$' {
            end_index = Some(index);
            break;
        }

        let is_valid = if index == 1 {
            ch == '_' || ch.is_ascii_alphabetic()
        } else {
            ch == '_' || ch.is_ascii_alphanumeric()
        };

        if !is_valid {
            return if rest.starts_with("$$") {
                Some("$$".to_string())
            } else {
                None
            };
        }
    }

    if let Some(end_index) = end_index {
        return Some(rest[..=end_index].to_string());
    }

    if rest.starts_with("$$") {
        Some("$$".to_string())
    } else {
        None
    }
}

pub fn split_sql_statements(sql: &str) -> Vec<String> {
    let text = sql.trim();
    if text.is_empty() {
        return Vec::new();
    }

    if !text.contains(';') {
        return vec![text.to_string()];
    }

    let mut statements = Vec::new();
    let mut current_start = 0usize;
    let mut in_string = false;
    let mut string_char = '\0';
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut dollar_quote_tag: Option<String> = None;
    let len = sql.len();
    let mut index = 0usize;

    while index < len {
        let rest = match sql.get(index..) {
            Some(value) => value,
            None => break,
        };
        let mut chars = rest.chars();
        let Some(ch) = chars.next() else {
            break;
        };
        let ch_len = ch.len_utf8();
        let next = chars.next();
        let next_len = next.map(char::len_utf8).unwrap_or(0);

        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
            }
            index += ch_len;
            continue;
        }

        if in_block_comment {
            if ch == '*' && next == Some('/') {
                in_block_comment = false;
                index += ch_len + next_len;
            } else {
                index += ch_len;
            }
            continue;
        }

        if let Some(tag) = dollar_quote_tag.as_ref() {
            if sql[index..].starts_with(tag) {
                index += tag.len();
                dollar_quote_tag = None;
            } else {
                index += ch_len;
            }
            continue;
        }

        if !in_string && ch == '-' && next == Some('-') {
            in_line_comment = true;
            index += ch_len + next_len;
            continue;
        }

        if !in_string && ch == '/' && next == Some('*') {
            in_block_comment = true;
            index += ch_len + next_len;
            continue;
        }

        if !in_string && ch == '$' {
            if let Some(tag) = match_dollar_quote_tag(sql, index) {
                dollar_quote_tag = Some(tag.clone());
                index += tag.len();
                continue;
            }
        }

        if in_string && ch == '\\' && next.is_some() {
            index += ch_len + next_len;
            continue;
        }

        if matches!(ch, '\'' | '"' | '`') {
            if !in_string {
                in_string = true;
                string_char = ch;
                index += 1;
                continue;
            }

            if ch == string_char {
                if next == Some(string_char) {
                    index += ch_len + next_len;
                } else {
                    in_string = false;
                    string_char = '\0';
                    index += ch_len;
                }
                continue;
            }
        }

        if ch == ';' && !in_string {
            let statement = sql[current_start..index].trim();
            if !statement.is_empty() {
                statements.push(statement.to_string());
            }
            current_start = index + 1;
        }

        index += ch_len;
    }

    let last_statement = sql[current_start..].trim();
    if !last_statement.is_empty() {
        statements.push(last_statement.to_string());
    }

    statements
}

#[cfg(test)]
mod tests {
    use super::{classify_sql, split_sql_statements, SqlStatementKind};
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct SqlSplitterFixture {
        name: String,
        sql: String,
        expected: Vec<String>,
    }

    #[test]
    fn sql_splitter_contract() {
        let fixtures: Vec<SqlSplitterFixture> = serde_json::from_str(include_str!(
            "../../../fixtures/sql_statement_splitter_cases.json"
        ))
        .expect("shared SQL splitter fixtures should parse");

        for fixture in fixtures {
            let actual = split_sql_statements(&fixture.sql);
            assert_eq!(
                actual, fixture.expected,
                "split_sql_statements mismatch for fixture {}",
                fixture.name
            );
        }
    }

    #[test]
    fn classifier_handles_comments_ctes_and_multiple_statements() {
        let decision = classify_sql(
            "-- inspect\nWITH visible AS (SELECT * FROM users) SELECT * FROM visible; SELECT 2",
        );
        assert!(decision.parse_error.is_none());
        assert!(decision.read_only);
        assert_eq!(decision.statements.len(), 2);
    }

    #[test]
    fn classifier_rejects_mutating_ctes_as_read_only() {
        let decision =
            classify_sql("WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed");
        assert!(!decision.read_only);
        assert_eq!(decision.statements[0].kind, SqlStatementKind::Write);
    }

    #[test]
    fn classifier_distinguishes_schema_and_transaction_sql() {
        let schema = classify_sql("ALTER TABLE users ADD COLUMN active BOOLEAN");
        assert!(schema.has_schema_mutation);
        assert_eq!(schema.statements[0].kind, SqlStatementKind::Schema);

        let transaction = classify_sql("BEGIN; SELECT 1; COMMIT");
        assert!(!transaction.read_only);
        assert_eq!(
            transaction.statements[0].kind,
            SqlStatementKind::Transaction
        );
    }

    #[test]
    fn classifier_does_not_treat_comment_only_sql_as_read_only() {
        let decision = classify_sql("-- nothing to execute");
        assert!(!decision.read_only);
        assert!(decision.statements.is_empty());
        assert!(decision.parse_error.is_some());
    }
}
