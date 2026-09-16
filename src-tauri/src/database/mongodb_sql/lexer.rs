//! SQL lexer for the MongoDB SELECT translator: scans raw SQL text into a flat
//! token stream (`Token`) that the parser consumes.

use anyhow::{anyhow, Result};

#[derive(Debug, Clone)]
pub(super) enum Token {
    /// Bare word: identifier (possibly dotted, e.g. `profile.email`) or keyword.
    Word(String),
    /// Single-quoted SQL string literal ('active').
    String(String),
    /// Double-quoted or backtick-quoted identifier ("name", `status`).
    QuotedIdent(String),
    /// Numeric literal, kept as text for int/float classification.
    Number(String),
    /// Operator or punctuation: `=`, `>=`, `(`, `,`, `*`, ...
    Symbol(String),
}

pub(super) fn tokenize(input: &str) -> Result<Vec<Token>> {
    let chars: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        if ch.is_whitespace() {
            index += 1;
            continue;
        }
        match ch {
            '\'' => {
                let (value, next_index) = read_quoted(&chars, index, '\'')?;
                tokens.push(Token::String(value));
                index = next_index;
            }
            '"' | '`' => {
                let (value, next_index) = read_quoted(&chars, index, ch)?;
                tokens.push(Token::QuotedIdent(value));
                index = next_index;
            }
            ch if ch.is_ascii_digit() => {
                let start = index;
                index += 1;
                while index < chars.len() {
                    let current = chars[index];
                    let previous = chars[index - 1];
                    let is_exponent_sign =
                        (current == '+' || current == '-') && (previous == 'e' || previous == 'E');
                    if current.is_ascii_digit() || current == '.' || is_exponent_sign {
                        index += 1;
                    } else {
                        break;
                    }
                }
                tokens.push(Token::Number(chars[start..index].iter().collect()));
            }
            ch if ch.is_ascii_alphabetic() || ch == '_' => {
                let start = index;
                index += 1;
                while index < chars.len() {
                    let current = chars[index];
                    if current.is_ascii_alphanumeric()
                        || current == '_'
                        || current == '$'
                        || current == '.'
                    {
                        index += 1;
                    } else {
                        break;
                    }
                }
                tokens.push(Token::Word(chars[start..index].iter().collect()));
            }
            _ => {
                let two: String = chars[index..(index + 2).min(chars.len())].iter().collect();
                let symbol = if matches!(two.as_str(), ">=" | "<=" | "<>" | "!=") {
                    index += 2;
                    two
                } else if matches!(
                    ch,
                    '=' | '<' | '>' | '(' | ')' | ',' | '*' | ';' | '+' | '-' | '/'
                ) {
                    index += 1;
                    ch.to_string()
                } else {
                    return Err(anyhow!("unexpected character '{ch}'"));
                };
                tokens.push(Token::Symbol(symbol));
            }
        }
    }

    Ok(tokens)
}

/// Reads a quoted region starting at `open_index` (which points at the quote).
/// A doubled quote collapses into a single literal quote character.
fn read_quoted(chars: &[char], open_index: usize, quote: char) -> Result<(String, usize)> {
    let mut value = String::new();
    let mut index = open_index + 1;
    loop {
        match chars.get(index) {
            None => return Err(anyhow!("unterminated quoted text")),
            Some(&current) if current == quote => {
                if chars.get(index + 1) == Some(&quote) {
                    value.push(quote);
                    index += 2;
                } else {
                    return Ok((value, index + 1));
                }
            }
            Some(&current) => {
                value.push(current);
                index += 1;
            }
        }
    }
}
