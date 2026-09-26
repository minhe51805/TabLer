use anyhow::{anyhow, Result};

const MAX_FILTER_LEN: usize = 1_000;
type QuoteIdentifierFn = fn(&str) -> Result<String>;

fn validate_identifier_part(value: &str, label: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{label} cannot be empty"));
    }

    if trimmed
        .chars()
        .any(|ch| matches!(ch, '\0' | '\r' | '\n' | '\t'))
    {
        return Err(anyhow!("{label} contains invalid control characters"));
    }

    Ok(trimmed.to_string())
}

fn quote_identifier_with(value: &str, quote_char: char, label: &str) -> Result<String> {
    let identifier = validate_identifier_part(value, label)?;
    let escaped = identifier.replace(quote_char, &format!("{quote_char}{quote_char}"));
    Ok(format!("{quote_char}{escaped}{quote_char}"))
}

fn split_identifier_path(value: &str, max_parts: usize) -> Result<Vec<String>> {
    let parts = value
        .split('.')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| validate_identifier_part(part, "Identifier"))
        .collect::<Result<Vec<_>>>()?;

    if parts.is_empty() {
        return Err(anyhow!("Identifier cannot be empty"));
    }

    if parts.len() > max_parts {
        return Err(anyhow!("Identifier contains too many path segments"));
    }

    Ok(parts)
}

fn split_qualified_name(value: &str) -> Result<Vec<String>> {
    split_identifier_path(value, 2)
}

pub fn quote_postgres_identifier(value: &str) -> Result<String> {
    quote_identifier_with(value, '"', "Identifier")
}

pub fn quote_sqlite_identifier(value: &str) -> Result<String> {
    quote_identifier_with(value, '"', "Identifier")
}

pub fn quote_mysql_identifier(value: &str) -> Result<String> {
    quote_identifier_with(value, '`', "Identifier")
}

pub fn quote_clickhouse_identifier(value: &str) -> Result<String> {
    quote_identifier_with(value, '`', "Identifier")
}

pub fn quote_bigquery_identifier(value: &str) -> Result<String> {
    quote_identifier_with(value, '`', "Identifier")
}

pub fn quote_snowflake_identifier(value: &str) -> Result<String> {
    quote_identifier_with(value, '"', "Identifier")
}

pub fn quote_cassandra_identifier(value: &str) -> Result<String> {
    quote_identifier_with(value, '"', "Identifier")
}

/// Oracle identifiers fold to uppercase when unquoted, so the driver quotes
/// every name it emits AND uppercases it first — a user typing `employees`
/// must hit the stored `EMPLOYEES` object, not a case-sensitive miss.
pub fn quote_oracle_identifier(value: &str) -> Result<String> {
    let identifier = validate_identifier_part(value, "Identifier")?;
    let uppercased = identifier.to_uppercase();
    let escaped = uppercased.replace('"', "\"\"");
    Ok(format!("\"{escaped}\""))
}

pub fn quote_mssql_identifier(value: &str) -> Result<String> {
    let identifier = validate_identifier_part(value, "Identifier")?;
    Ok(format!("[{}]", identifier.replace(']', "]]")))
}

pub fn qualify_postgres_table_name(table: &str, default_schema: &str) -> Result<String> {
    let parts = split_qualified_name(table)?;
    let (schema, table_name) = if parts.len() == 2 {
        (parts[0].clone(), parts[1].clone())
    } else {
        (
            validate_identifier_part(default_schema, "Schema")?,
            parts[0].clone(),
        )
    };

    Ok(format!(
        "{}.{}",
        quote_postgres_identifier(&schema)?,
        quote_postgres_identifier(&table_name)?
    ))
}

pub fn qualify_mysql_table_name(table: &str, database: Option<&str>) -> Result<String> {
    let parts = split_qualified_name(table)?;
    if parts.len() == 2 {
        return Ok(format!(
            "{}.{}",
            quote_mysql_identifier(&parts[0])?,
            quote_mysql_identifier(&parts[1])?
        ));
    }

    if let Some(database) = database {
        return Ok(format!(
            "{}.{}",
            quote_mysql_identifier(database)?,
            quote_mysql_identifier(&parts[0])?
        ));
    }

    quote_mysql_identifier(&parts[0])
}

pub fn qualify_mssql_table_name(table: &str, default_schema: &str) -> Result<String> {
    let parts = split_qualified_name(table)?;
    let (schema, table_name) = if parts.len() == 2 {
        (parts[0].clone(), parts[1].clone())
    } else {
        (
            validate_identifier_part(default_schema, "Schema")?,
            parts[0].clone(),
        )
    };

    Ok(format!(
        "{}.{}",
        quote_mssql_identifier(&schema)?,
        quote_mssql_identifier(&table_name)?
    ))
}

pub fn qualify_cassandra_table_name(table: &str, default_keyspace: &str) -> Result<String> {
    let parts = split_qualified_name(table)?;
    let (keyspace, table_name) = if parts.len() == 2 {
        (parts[0].clone(), parts[1].clone())
    } else {
        (
            validate_identifier_part(default_keyspace, "Keyspace")?,
            parts[0].clone(),
        )
    };

    Ok(format!(
        "{}.{}",
        quote_cassandra_identifier(&keyspace)?,
        quote_cassandra_identifier(&table_name)?,
    ))
}

pub fn normalize_order_dir(order_dir: Option<&str>) -> Result<&'static str> {
    match order_dir
        .unwrap_or("ASC")
        .trim()
        .to_ascii_uppercase()
        .as_str()
    {
        "ASC" => Ok("ASC"),
        "DESC" => Ok("DESC"),
        _ => Err(anyhow!("Order direction must be ASC or DESC")),
    }
}

pub fn quote_postgres_order_by(column: &str) -> Result<String> {
    let parts = split_qualified_name(column)?;
    Ok(parts
        .iter()
        .map(|part| quote_postgres_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

pub fn quote_mysql_order_by(column: &str) -> Result<String> {
    let parts = split_qualified_name(column)?;
    Ok(parts
        .iter()
        .map(|part| quote_mysql_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

pub fn quote_clickhouse_order_by(column: &str) -> Result<String> {
    let parts = split_qualified_name(column)?;
    Ok(parts
        .iter()
        .map(|part| quote_clickhouse_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

pub fn quote_bigquery_order_by(column: &str) -> Result<String> {
    let parts = split_identifier_path(column, 16)?;
    Ok(parts
        .iter()
        .map(|part| quote_bigquery_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

pub fn quote_snowflake_order_by(column: &str) -> Result<String> {
    let parts = split_qualified_name(column)?;
    Ok(parts
        .iter()
        .map(|part| quote_snowflake_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

pub fn quote_cassandra_order_by(column: &str) -> Result<String> {
    let parts = split_qualified_name(column)?;
    Ok(parts
        .iter()
        .map(|part| quote_cassandra_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

pub fn quote_mssql_order_by(column: &str) -> Result<String> {
    let parts = split_qualified_name(column)?;
    Ok(parts
        .iter()
        .map(|part| quote_mssql_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

pub fn quote_sqlite_order_by(column: &str) -> Result<String> {
    let parts = split_qualified_name(column)?;
    Ok(parts
        .iter()
        .map(|part| quote_sqlite_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

pub fn quote_oracle_order_by(column: &str) -> Result<String> {
    let parts = split_qualified_name(column)?;
    Ok(parts
        .iter()
        .map(|part| quote_oracle_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

struct FilterParser<'a> {
    input: &'a str,
    position: usize,
    quote_identifier: QuoteIdentifierFn,
    allow_ilike: bool,
}

impl<'a> FilterParser<'a> {
    fn new(input: &'a str, quote_identifier: QuoteIdentifierFn, allow_ilike: bool) -> Self {
        Self {
            input,
            position: 0,
            quote_identifier,
            allow_ilike,
        }
    }

    fn parse(mut self) -> Result<String> {
        let mut output = String::new();
        output.push_str(&self.parse_condition()?);

        loop {
            self.skip_whitespace();
            if self.is_eof() {
                break;
            }

            if self.consume_keyword("AND") {
                output.push_str(" AND ");
            } else if self.consume_keyword("OR") {
                output.push_str(" OR ");
            } else {
                return Err(anyhow!("Only AND/OR connectors are allowed in filters"));
            }

            output.push_str(&self.parse_condition()?);
        }

        Ok(output)
    }

    fn parse_condition(&mut self) -> Result<String> {
        self.skip_whitespace();
        let identifier = self.parse_identifier()?;
        self.skip_whitespace();
        let operator = self.parse_operator()?;
        self.skip_whitespace();

        let mut output = String::new();
        output.push_str(&(self.quote_identifier)(&identifier)?);
        output.push(' ');
        output.push_str(operator);

        match operator {
            "IS NULL" | "IS NOT NULL" => Ok(output),
            "IS TRUE" | "IS FALSE" | "IS NOT TRUE" | "IS NOT FALSE" => Ok(output),
            "IS" | "IS NOT" => {
                output.push(' ');
                output.push_str(&self.parse_is_literal()?);
                Ok(output)
            }
            _ => {
                output.push(' ');
                output.push_str(&self.parse_literal()?);
                Ok(output)
            }
        }
    }

    fn parse_identifier(&mut self) -> Result<String> {
        let start = self.position;
        let mut last_was_dot = false;

        while let Some(ch) = self.peek_char() {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                self.position += ch.len_utf8();
                last_was_dot = false;
            } else if ch == '.' {
                if self.position == start || last_was_dot {
                    return Err(anyhow!("Invalid identifier in filter clause"));
                }
                self.position += 1;
                last_was_dot = true;
            } else {
                break;
            }
        }

        if self.position == start || last_was_dot {
            return Err(anyhow!("Invalid identifier in filter clause"));
        }

        Ok(self.input[start..self.position].to_string())
    }

    fn parse_operator(&mut self) -> Result<&'static str> {
        if self.consume_keyword("IS") {
            self.skip_whitespace();
            if self.consume_keyword("NOT") {
                self.skip_whitespace();
                if self.consume_keyword("NULL") {
                    return Ok("IS NOT NULL");
                }
                if self.consume_keyword("TRUE") {
                    return Ok("IS NOT TRUE");
                }
                if self.consume_keyword("FALSE") {
                    return Ok("IS NOT FALSE");
                }
                return Ok("IS NOT");
            }

            if self.consume_keyword("NULL") {
                return Ok("IS NULL");
            }
            if self.consume_keyword("TRUE") {
                return Ok("IS TRUE");
            }
            if self.consume_keyword("FALSE") {
                return Ok("IS FALSE");
            }
            return Ok("IS");
        }

        if self.allow_ilike && self.consume_keyword("ILIKE") {
            return Ok("ILIKE");
        }
        if self.consume_keyword("LIKE") {
            return Ok("LIKE");
        }
        if self.consume_symbol(">=") {
            return Ok(">=");
        }
        if self.consume_symbol("<=") {
            return Ok("<=");
        }
        if self.consume_symbol("!=") {
            return Ok("!=");
        }
        if self.consume_symbol("<>") {
            return Ok("<>");
        }
        if self.consume_symbol("=") {
            return Ok("=");
        }
        if self.consume_symbol(">") {
            return Ok(">");
        }
        if self.consume_symbol("<") {
            return Ok("<");
        }

        Err(anyhow!("Unsupported operator in filter clause"))
    }

    fn parse_is_literal(&mut self) -> Result<String> {
        if self.consume_keyword("NULL") {
            return Ok("NULL".to_string());
        }
        if self.consume_keyword("TRUE") {
            return Ok("TRUE".to_string());
        }
        if self.consume_keyword("FALSE") {
            return Ok("FALSE".to_string());
        }

        Err(anyhow!("IS / IS NOT only support NULL, TRUE, or FALSE"))
    }

    fn parse_literal(&mut self) -> Result<String> {
        if self.peek_char() == Some('\'') {
            return self.parse_string_literal();
        }
        if self.consume_keyword("NULL") {
            return Ok("NULL".to_string());
        }
        if self.consume_keyword("TRUE") {
            return Ok("TRUE".to_string());
        }
        if self.consume_keyword("FALSE") {
            return Ok("FALSE".to_string());
        }

        self.parse_numeric_literal()
    }

    fn parse_numeric_literal(&mut self) -> Result<String> {
        let start = self.position;

        if matches!(self.peek_char(), Some('+') | Some('-')) {
            self.position += 1;
        }

        let mut saw_digit = false;
        while matches!(self.peek_char(), Some(ch) if ch.is_ascii_digit()) {
            self.position += 1;
            saw_digit = true;
        }

        if self.peek_char() == Some('.') {
            self.position += 1;
            while matches!(self.peek_char(), Some(ch) if ch.is_ascii_digit()) {
                self.position += 1;
                saw_digit = true;
            }
        }

        if !saw_digit {
            return Err(anyhow!("Expected a literal value in filter clause"));
        }

        let literal = &self.input[start..self.position];
        if literal.ends_with('.') {
            return Err(anyhow!("Invalid numeric literal in filter clause"));
        }

        Ok(literal.to_string())
    }

    fn parse_string_literal(&mut self) -> Result<String> {
        let mut output = String::from("'");
        self.expect_char('\'')?;

        loop {
            let Some(ch) = self.peek_char() else {
                return Err(anyhow!("Unterminated string literal in filter clause"));
            };

            self.position += ch.len_utf8();
            output.push(ch);

            if ch == '\'' {
                if self.peek_char() == Some('\'') {
                    self.position += 1;
                    output.push('\'');
                    continue;
                }
                break;
            }
        }

        Ok(output)
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek_char(), Some(ch) if ch.is_whitespace()) {
            self.position += 1;
        }
    }

    fn consume_keyword(&mut self, keyword: &str) -> bool {
        let end = self.position + keyword.len();
        if end > self.input.len() {
            return false;
        }

        let candidate = &self.input[self.position..end];
        if !candidate.eq_ignore_ascii_case(keyword) {
            return false;
        }

        if matches!(self.peek_after(end), Some(ch) if ch.is_ascii_alphanumeric() || ch == '_') {
            return false;
        }

        self.position = end;
        true
    }

    fn consume_symbol(&mut self, symbol: &str) -> bool {
        if self.input[self.position..].starts_with(symbol) {
            self.position += symbol.len();
            return true;
        }
        false
    }

    fn expect_char(&mut self, expected: char) -> Result<()> {
        match self.peek_char() {
            Some(ch) if ch == expected => {
                self.position += ch.len_utf8();
                Ok(())
            }
            _ => Err(anyhow!("Expected '{expected}'")),
        }
    }

    fn peek_char(&self) -> Option<char> {
        self.input[self.position..].chars().next()
    }

    fn peek_after(&self, index: usize) -> Option<char> {
        self.input.get(index..)?.chars().next()
    }

    fn is_eof(&self) -> bool {
        self.position >= self.input.len()
    }
}

fn sanitize_filter_clause_with(
    filter: Option<&str>,
    quote_identifier: QuoteIdentifierFn,
    allow_ilike: bool,
) -> Result<Option<String>> {
    let Some(filter) = filter else {
        return Ok(None);
    };

    let trimmed = filter.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if trimmed.len() > MAX_FILTER_LEN {
        return Err(anyhow!("Filter clause is too long"));
    }

    let lower = trimmed.to_ascii_lowercase();
    if trimmed.contains(';')
        || lower.contains("--")
        || lower.contains("/*")
        || lower.contains("*/")
        || trimmed.contains('\0')
    {
        return Err(anyhow!(
            "Filter clause contains disallowed multi-statement or comment syntax"
        ));
    }

    Ok(Some(
        FilterParser::new(trimmed, quote_identifier, allow_ilike).parse()?,
    ))
}

pub fn sanitize_postgres_filter_clause(filter: Option<&str>) -> Result<Option<String>> {
    sanitize_filter_clause_with(filter, quote_postgres_order_by, true)
}

pub fn sanitize_mysql_filter_clause(filter: Option<&str>) -> Result<Option<String>> {
    sanitize_filter_clause_with(filter, quote_mysql_order_by, false)
}

pub fn sanitize_clickhouse_filter_clause(filter: Option<&str>) -> Result<Option<String>> {
    sanitize_filter_clause_with(filter, quote_clickhouse_order_by, false)
}

pub fn sanitize_bigquery_filter_clause(filter: Option<&str>) -> Result<Option<String>> {
    sanitize_filter_clause_with(filter, quote_bigquery_order_by, false)
}

pub fn sanitize_snowflake_filter_clause(filter: Option<&str>) -> Result<Option<String>> {
    sanitize_filter_clause_with(filter, quote_snowflake_order_by, false)
}

pub fn sanitize_cassandra_filter_clause(filter: Option<&str>) -> Result<Option<String>> {
    sanitize_filter_clause_with(filter, quote_cassandra_order_by, false)
}

pub fn sanitize_mssql_filter_clause(filter: Option<&str>) -> Result<Option<String>> {
    sanitize_filter_clause_with(filter, quote_mssql_order_by, false)
}

pub fn sanitize_sqlite_filter_clause(filter: Option<&str>) -> Result<Option<String>> {
    sanitize_filter_clause_with(filter, quote_sqlite_order_by, false)
}

pub fn sanitize_oracle_filter_clause(filter: Option<&str>) -> Result<Option<String>> {
    sanitize_filter_clause_with(filter, quote_oracle_order_by, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_quoting_escapes_the_dialect_quote_char() {
        assert_eq!(
            quote_postgres_identifier("we\"ird").unwrap(),
            "\"we\"\"ird\""
        );
        assert_eq!(quote_mysql_identifier("we`ird").unwrap(), "`we``ird`");
        assert_eq!(quote_clickhouse_identifier("we`ird").unwrap(), "`we``ird`");
        assert_eq!(quote_mssql_identifier("we]ird").unwrap(), "[we]]ird]");
        // Oracle folds unquoted names, so the driver uppercases before quoting.
        assert_eq!(
            quote_oracle_identifier("employees").unwrap(),
            "\"EMPLOYEES\""
        );
    }

    #[test]
    fn identifiers_reject_empty_and_control_characters() {
        for result in [
            quote_postgres_identifier("   "),
            quote_mysql_identifier("a\0b"),
            quote_mssql_identifier("line\nbreak"),
            quote_snowflake_identifier("tab\tname"),
        ] {
            assert!(result.is_err(), "identifier must be rejected: {result:?}");
        }
    }

    #[test]
    fn qualified_names_quote_each_segment_and_cap_depth() {
        assert_eq!(
            qualify_postgres_table_name("public.orders", "dbo").unwrap(),
            "\"public\".\"orders\""
        );
        assert_eq!(
            qualify_postgres_table_name("orders", "app").unwrap(),
            "\"app\".\"orders\""
        );
        assert_eq!(
            qualify_mysql_table_name("orders", Some("shop")).unwrap(),
            "`shop`.`orders`"
        );
        assert_eq!(
            qualify_mysql_table_name("orders", None).unwrap(),
            "`orders`"
        );
        assert_eq!(
            qualify_mssql_table_name("dbo.users", "guest").unwrap(),
            "[dbo].[users]"
        );
        assert_eq!(
            qualify_cassandra_table_name("users", "ks").unwrap(),
            "\"ks\".\"users\""
        );
        // Three segments exceed the two-part schema.table contract everywhere
        // that uses split_qualified_name.
        assert!(qualify_postgres_table_name("a.b.c", "dbo").is_err());
        assert!(quote_postgres_order_by("a.b.c").is_err());
    }

    #[test]
    fn bigquery_order_by_allows_deep_paths_but_caps_them() {
        assert_eq!(quote_bigquery_order_by("ds.t.c").unwrap(), "`ds`.`t`.`c`");
        let deep = (0..17)
            .map(|i| format!("s{i}"))
            .collect::<Vec<_>>()
            .join(".");
        assert!(quote_bigquery_order_by(&deep).is_err());
        let at_cap = (0..16)
            .map(|i| format!("s{i}"))
            .collect::<Vec<_>>()
            .join(".");
        assert!(quote_bigquery_order_by(&at_cap).is_ok());
    }

    #[test]
    fn normalize_order_dir_accepts_only_asc_desc() {
        assert_eq!(normalize_order_dir(None).unwrap(), "ASC");
        assert_eq!(normalize_order_dir(Some(" desc ")).unwrap(), "DESC");
        for bad in ["DESC; DROP TABLE t", "random", "ascending", ""] {
            assert!(normalize_order_dir(Some(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn empty_and_missing_filters_pass_through_as_none() {
        assert_eq!(sanitize_postgres_filter_clause(None).unwrap(), None);
        assert_eq!(sanitize_postgres_filter_clause(Some("   ")).unwrap(), None);
    }

    #[test]
    fn filters_render_dialect_quoted_conditions() {
        assert_eq!(
            sanitize_postgres_filter_clause(Some("age >= 18 AND name = 'O''Neil'")).unwrap(),
            Some("\"age\" >= 18 AND \"name\" = 'O''Neil'".to_string())
        );
        assert_eq!(
            sanitize_mysql_filter_clause(Some("status = 'x' OR total < 5")).unwrap(),
            Some("`status` = 'x' OR `total` < 5".to_string())
        );
        // Dotted identifiers quote per segment.
        assert_eq!(
            sanitize_mssql_filter_clause(Some("orders.total > 5")).unwrap(),
            Some("[orders].[total] > 5".to_string())
        );
    }

    #[test]
    fn filter_injection_payloads_are_rejected() {
        for payload in [
            "1=1; DROP TABLE users",
            "age = 1; SELECT 1",
            "age = 1 --",
            "age = 1 /* comment",
            "age = 1 */",
            "x = 'a\0b'",
            "a = 1 UNION SELECT password",
            "a = 1) OR (1 = 1",
            "a = 1 OR 1=1; --",
            "true",
        ] {
            assert!(
                sanitize_postgres_filter_clause(Some(payload)).is_err(),
                "payload slipped through postgres filter: {payload:?}"
            );
            assert!(
                sanitize_mysql_filter_clause(Some(payload)).is_err(),
                "payload slipped through mysql filter: {payload:?}"
            );
        }
    }

    #[test]
    fn filter_operators_and_literals_stay_in_the_safe_subset() {
        assert_eq!(
            sanitize_postgres_filter_clause(Some("deleted IS NULL")).unwrap(),
            Some("\"deleted\" IS NULL".to_string())
        );
        assert_eq!(
            sanitize_postgres_filter_clause(Some("active IS NOT TRUE")).unwrap(),
            Some("\"active\" IS NOT TRUE".to_string())
        );
        assert_eq!(
            sanitize_postgres_filter_clause(Some("balance <= -1.5")).unwrap(),
            Some("\"balance\" <= -1.5".to_string())
        );
        assert_eq!(
            sanitize_postgres_filter_clause(Some("note != 'it''s'")).unwrap(),
            Some("\"note\" != 'it''s'".to_string())
        );
        // Anything outside the approved grammar must not reach the database.
        for bad in [
            "a IN (1, 2)",
            "a BETWEEN 1 AND 2",
            "a IS 'y'",
            "a = 'unterminated",
            "a = 5.",
            "a =",
            "= 1",
            "a ~~ 'x'",
            "(a = 1)",
        ] {
            assert!(
                sanitize_postgres_filter_clause(Some(bad)).is_err(),
                "unsupported filter slipped through: {bad:?}"
            );
        }
    }

    #[test]
    fn ilike_is_gated_per_dialect() {
        assert_eq!(
            sanitize_postgres_filter_clause(Some("name ILIKE 'jo%'")).unwrap(),
            Some("\"name\" ILIKE 'jo%'".to_string())
        );
        // MySQL/SQLite have no ILIKE — the parser must not emit it there.
        assert!(sanitize_mysql_filter_clause(Some("name ILIKE 'jo%'")).is_err());
        assert!(sanitize_sqlite_filter_clause(Some("name ILIKE 'jo%'")).is_err());
        // LIKE stays available everywhere.
        assert_eq!(
            sanitize_mysql_filter_clause(Some("name LIKE 'jo%'")).unwrap(),
            Some("`name` LIKE 'jo%'".to_string())
        );
    }

    #[test]
    fn overlong_filters_are_rejected() {
        let over = format!("a = '{}'", "x".repeat(MAX_FILTER_LEN));
        assert!(sanitize_postgres_filter_clause(Some(&over)).is_err());
        let at_cap = format!("a = '{}'", "x".repeat(MAX_FILTER_LEN - "a = ''".len()));
        assert!(sanitize_postgres_filter_clause(Some(&at_cap)).is_ok());
    }
}
