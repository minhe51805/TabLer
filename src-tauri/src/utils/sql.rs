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
    use super::split_sql_statements;
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
}
