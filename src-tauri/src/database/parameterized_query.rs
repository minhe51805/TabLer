use super::models::QueryParameter;
use anyhow::{anyhow, Result};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaceholderStyle {
    QuestionMark,
    DollarNumber,
    AtNumber,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledParameterizedQuery {
    pub sql: String,
    pub parameters: Vec<QueryParameter>,
}

pub fn compile_parameterized_query(
    sql: &str,
    parameters: &[QueryParameter],
    style: PlaceholderStyle,
) -> Result<CompiledParameterizedQuery> {
    let parameter_by_name = parameters
        .iter()
        .map(|parameter| (parameter.name.as_str(), parameter))
        .collect::<HashMap<_, _>>();
    let chars = sql.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(sql.len());
    let mut ordered_parameters = Vec::new();
    let mut index = 0;
    let mut state = ScanState::Normal;
    let mut dollar_quote_delimiter: Option<String> = None;

    while index < chars.len() {
        if let Some(delimiter) = dollar_quote_delimiter.as_deref() {
            let delimiter_chars = delimiter.chars().collect::<Vec<_>>();
            if chars[index..].starts_with(&delimiter_chars) {
                output.push_str(delimiter);
                index += delimiter_chars.len();
                dollar_quote_delimiter = None;
            } else {
                output.push(chars[index]);
                index += 1;
            }
            continue;
        }
        let current = chars[index];
        match state {
            ScanState::Normal => {
                if current == '-' && chars.get(index + 1) == Some(&'-') {
                    output.push_str("--");
                    index += 2;
                    state = ScanState::LineComment;
                    continue;
                }
                if current == '/' && chars.get(index + 1) == Some(&'*') {
                    output.push_str("/*");
                    index += 2;
                    state = ScanState::BlockComment;
                    continue;
                }
                if current == '\'' {
                    output.push(current);
                    index += 1;
                    state = ScanState::SingleQuote;
                    continue;
                }
                if current == '"' {
                    output.push(current);
                    index += 1;
                    state = ScanState::DoubleQuote;
                    continue;
                }
                if current == '`' {
                    output.push(current);
                    index += 1;
                    state = ScanState::BacktickQuote;
                    continue;
                }
                if current == ':' && chars.get(index + 1) == Some(&':') {
                    output.push_str("::");
                    index += 2;
                    continue;
                }
                if current == '$' {
                    let (_, next_index) = read_identifier(&chars, index + 1);
                    if chars.get(next_index) == Some(&'$') {
                        let delimiter = chars[index..=next_index].iter().collect::<String>();
                        output.push_str(&delimiter);
                        index = next_index + 1;
                        dollar_quote_delimiter = Some(delimiter);
                        continue;
                    }
                }
                if matches!(current, ':' | '$' | '@')
                    && is_identifier_start(chars.get(index + 1).copied())
                    && !(current == '$' && chars.get(index + 1).is_some_and(char::is_ascii_digit))
                {
                    let (name, next_index) = read_identifier(&chars, index + 1);
                    let parameter = parameter_by_name.get(name.as_str()).ok_or_else(|| {
                        anyhow!("No value was supplied for SQL parameter '{name}'.")
                    })?;
                    ordered_parameters.push((*parameter).clone());
                    output.push_str(&placeholder(style, ordered_parameters.len()));
                    index = next_index;
                    continue;
                }
                output.push(current);
                index += 1;
            }
            ScanState::LineComment => {
                output.push(current);
                index += 1;
                if current == '\n' {
                    state = ScanState::Normal;
                }
            }
            ScanState::BlockComment => {
                output.push(current);
                if current == '*' && chars.get(index + 1) == Some(&'/') {
                    output.push('/');
                    index += 2;
                    state = ScanState::Normal;
                } else {
                    index += 1;
                }
            }
            ScanState::SingleQuote => {
                output.push(current);
                if current == '\'' && chars.get(index + 1) == Some(&'\'') {
                    output.push('\'');
                    index += 2;
                } else {
                    index += 1;
                    if current == '\'' {
                        state = ScanState::Normal;
                    }
                }
            }
            ScanState::DoubleQuote => {
                output.push(current);
                if current == '"' && chars.get(index + 1) == Some(&'"') {
                    output.push('"');
                    index += 2;
                } else {
                    index += 1;
                    if current == '"' {
                        state = ScanState::Normal;
                    }
                }
            }
            ScanState::BacktickQuote => {
                output.push(current);
                index += 1;
                if current == '`' {
                    state = ScanState::Normal;
                }
            }
        }
    }

    if ordered_parameters.is_empty() {
        return Err(anyhow!(
            "No named SQL parameters were found outside literals and comments."
        ));
    }
    Ok(CompiledParameterizedQuery {
        sql: output,
        parameters: ordered_parameters,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Normal,
    LineComment,
    BlockComment,
    SingleQuote,
    DoubleQuote,
    BacktickQuote,
}

fn is_identifier_start(value: Option<char>) -> bool {
    value.is_some_and(|value| value == '_' || value.is_ascii_alphabetic())
}

fn read_identifier(chars: &[char], start: usize) -> (String, usize) {
    let mut end = start;
    while chars
        .get(end)
        .is_some_and(|value| *value == '_' || value.is_ascii_alphanumeric())
    {
        end += 1;
    }
    (chars[start..end].iter().collect(), end)
}

fn placeholder(style: PlaceholderStyle, position: usize) -> String {
    match style {
        PlaceholderStyle::QuestionMark => "?".to_string(),
        PlaceholderStyle::DollarNumber => format!("${position}"),
        PlaceholderStyle::AtNumber => format!("@P{position}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{compile_parameterized_query, PlaceholderStyle};
    use crate::database::models::{QueryParameter, QueryParameterType};
    use serde_json::json;

    fn parameter(name: &str) -> QueryParameter {
        QueryParameter {
            name: name.to_string(),
            value: json!(name),
            data_type: QueryParameterType::Text,
        }
    }

    #[test]
    fn compiles_named_parameters_without_touching_literals_comments_or_casts() {
        let compiled = compile_parameterized_query(
            "SELECT :name::text, '$ignored', \"$ignored\" -- :ignored\nWHERE id = $id /* @ignored */",
            &[parameter("name"), parameter("id")],
            PlaceholderStyle::DollarNumber,
        )
        .unwrap();
        assert_eq!(
            compiled.sql,
            "SELECT $1::text, '$ignored', \"$ignored\" -- :ignored\nWHERE id = $2 /* @ignored */"
        );
        assert_eq!(compiled.parameters.len(), 2);
    }

    #[test]
    fn repeats_a_binding_for_every_placeholder_occurrence() {
        let compiled = compile_parameterized_query(
            "SELECT * FROM events WHERE owner = :owner OR reviewer = :owner",
            &[parameter("owner")],
            PlaceholderStyle::QuestionMark,
        )
        .unwrap();
        assert_eq!(
            compiled.sql,
            "SELECT * FROM events WHERE owner = ? OR reviewer = ?"
        );
        assert_eq!(compiled.parameters.len(), 2);
    }

    #[test]
    fn ignores_postgres_dollar_quoted_bodies() {
        let compiled = compile_parameterized_query(
            "SELECT $body$ :ignored $body$, :included",
            &[parameter("included")],
            PlaceholderStyle::DollarNumber,
        )
        .unwrap();
        assert_eq!(compiled.sql, "SELECT $body$ :ignored $body$, $1");
    }
}
