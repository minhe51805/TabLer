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
                    // An exponent marker ('1e5', '1e+5', '1e-5') only counts when
                    // digits (optionally signed) follow — otherwise the 'e'
                    // starts the next word, e.g. `1enabled`.
                    let is_exponent_marker = (current == 'e' || current == 'E')
                        && previous.is_ascii_digit()
                        && chars.get(index + 1).is_some_and(|&next| {
                            next.is_ascii_digit()
                                || ((next == '+' || next == '-')
                                    && chars.get(index + 2).is_some_and(|d| d.is_ascii_digit()))
                        });
                    if current.is_ascii_digit()
                        || current == '.'
                        || is_exponent_sign
                        || is_exponent_marker
                    {
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

#[cfg(test)]
mod tests {
    use super::{tokenize, Token};

    fn kinds(tokens: &[Token]) -> Vec<&'static str> {
        tokens
            .iter()
            .map(|token| match token {
                Token::Word(_) => "word",
                Token::String(_) => "string",
                Token::QuotedIdent(_) => "quoted",
                Token::Number(_) => "number",
                Token::Symbol(_) => "symbol",
            })
            .collect()
    }

    #[test]
    fn doubled_quotes_collapse_into_a_literal_quote() {
        let tokens = tokenize("'it''s'").unwrap();
        match &tokens[..] {
            [Token::String(value)] => assert_eq!(value, "it's"),
            other => panic!("expected one string token, got {other:?}"),
        }
        let tokens = tokenize("`we``ird`").unwrap();
        match &tokens[..] {
            [Token::QuotedIdent(value)] => assert_eq!(value, "we`ird"),
            other => panic!("expected one quoted ident, got {other:?}"),
        }
    }

    #[test]
    fn unterminated_quotes_are_an_error() {
        assert!(tokenize("'never closed").is_err());
        assert!(tokenize("\"never closed").is_err());
    }

    #[test]
    fn exponents_stay_inside_the_number_token() {
        for sql in ["1e5", "2.5E-3", "10e+4", "7e0"] {
            let tokens = tokenize(sql).unwrap();
            match &tokens[..] {
                [Token::Number(text)] => assert_eq!(text, sql),
                other => panic!("'{sql}' should tokenize as one number, got {other:?}"),
            }
        }
        // A digit followed by a word is not an exponent.
        let tokens = tokenize("1enabled").unwrap();
        assert_eq!(kinds(&tokens), vec!["number", "word"]);
    }

    #[test]
    fn dollar_words_scan_only_mid_word_and_bare_dollar_is_rejected() {
        // `a$b` is one word token (legal mid-identifier in Mongo field names);
        // a LEADING `$` is not word-start, so `$where` never tokenizes.
        let tokens = tokenize("profile.email user$1 a$b").unwrap();
        match &tokens[..] {
            [Token::Word(a), Token::Word(b), Token::Word(c)] => {
                assert_eq!(a, "profile.email");
                assert_eq!(b, "user$1");
                assert_eq!(c, "a$b");
            }
            other => panic!("expected three words, got {other:?}"),
        }
        assert!(tokenize("$where").is_err());
    }

    #[test]
    fn two_char_operators_bind_tighter_than_single_chars() {
        let tokens = tokenize(">= <= <> != = < >").unwrap();
        let symbols: Vec<&str> = tokens
            .iter()
            .map(|token| match token {
                Token::Symbol(s) => s.as_str(),
                other => panic!("expected symbol, got {other:?}"),
            })
            .collect();
        assert_eq!(symbols, vec![">=", "<=", "<>", "!=", "=", "<", ">"]);
    }

    #[test]
    fn unexpected_characters_are_rejected() {
        assert!(tokenize("age ~ 3").is_err());
        assert!(tokenize("@var").is_err());
    }
}
