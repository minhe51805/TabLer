//! SQL → MongoDB translation for the command-surface query editor.
//!
//! MongoDB connections normally speak shell syntax (`db.users.find({})`), but
//! users and SQL-shaped tooling naturally type `SELECT` statements into the
//! query tab. Instead of rejecting them with "MongoDB commands must start with
//! db.", the driver translates a practical `SELECT` subset into
//! find/aggregate/count commands and answers every other SQL statement with an
//! actionable error pointing at the shell equivalent.

use super::mongodb::{MongoDbDriver, MongoQueryCommand};
use super::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, Result};
use mongodb::bson::{doc, Bson, Document};
use serde_json::Value as JsonValue;

/// Decides whether the input is SQL-shaped and translates it. Returns `None`
/// for anything that is not a recognizable SQL statement so the Mongo shell
/// parser stays in charge (or reports the usual "must start with db." error).
pub(super) fn translate_sql_statement(input: &str) -> Option<Result<MongoQueryCommand>> {
    let first_word = input
        .trim_start()
        .split(|ch: char| ch.is_whitespace() || ch == '(')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match first_word.as_str() {
        "select" => Some(translate_select(input)),
        "insert" => Some(Err(anyhow!(
            "SQL INSERT is not supported on MongoDB connections. Use Mongo shell syntax: db.<collection>.insertOne({{...}}) or db.<collection>.insertMany([...])."
        ))),
        "update" => Some(Err(anyhow!(
            "SQL UPDATE is not supported on MongoDB connections. Use Mongo shell syntax: db.<collection>.updateOne({{...}}, {{...}}) or db.<collection>.updateMany({{...}}, {{...}})."
        ))),
        "delete" => Some(Err(anyhow!(
            "SQL DELETE is not supported on MongoDB connections. Use Mongo shell syntax: db.<collection>.deleteOne({{...}}) or db.<collection>.deleteMany({{...}})."
        ))),
        "create" | "alter" | "drop" | "truncate" => Some(Err(anyhow!(
            "SQL DDL is not supported on MongoDB connections. Collections are created implicitly on first insert, or with db.createCollection('<name>')."
        ))),
        _ => None,
    }
}

fn translate_select(input: &str) -> Result<MongoQueryCommand> {
    translate_select_inner(input).map_err(|error| {
        anyhow!(
            "SQL SELECT could not be translated to MongoDB: {error}. Use Mongo shell syntax (for example db.<collection>.find({{}})) instead."
        )
    })
}

fn translate_select_inner(input: &str) -> Result<MongoQueryCommand> {
    let tokens = tokenize(input)?;
    let mut parser = Parser::new(tokens);
    let statement = parse_select_statement(&mut parser)?;
    build_command(statement)
}

#[derive(Debug, Clone)]
enum Token {
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

fn tokenize(input: &str) -> Result<Vec<Token>> {
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

/// Words that introduce a new clause; an identifier alias must never swallow them.
const CLAUSE_KEYWORDS: &[&str] = &[
    "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "AS", "ASC", "DESC", "AND",
    "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "UNION", "JOIN", "SELECT", "DISTINCT",
];

struct Parser {
    tokens: Vec<Token>,
    position: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self {
            tokens,
            position: 0,
        }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn peek_next_symbol(&self, symbol: &str) -> bool {
        matches!(
            self.tokens.get(self.position + 1),
            Some(Token::Symbol(value)) if value == symbol
        )
    }

    fn advance(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.position).cloned();
        if token.is_some() {
            self.position += 1;
        }
        token
    }

    fn eat_keyword(&mut self, keyword: &str) -> bool {
        if matches!(self.peek(), Some(Token::Word(word)) if word.eq_ignore_ascii_case(keyword)) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn expect_keyword(&mut self, keyword: &str) -> Result<()> {
        if self.eat_keyword(keyword) {
            Ok(())
        } else {
            Err(anyhow!("expected keyword {keyword}"))
        }
    }

    fn eat_symbol(&mut self, symbol: &str) -> bool {
        if matches!(self.peek(), Some(Token::Symbol(value)) if value == symbol) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn expect_symbol(&mut self, symbol: &str) -> Result<()> {
        if self.eat_symbol(symbol) {
            Ok(())
        } else {
            Err(anyhow!("expected '{symbol}'"))
        }
    }

    fn expect_field_path(&mut self) -> Result<String> {
        match self.advance() {
            Some(Token::Word(word)) | Some(Token::QuotedIdent(word)) => Ok(word),
            Some(token) => Err(anyhow!("expected a field name, found {token:?}")),
            None => Err(anyhow!("expected a field name")),
        }
    }

    fn expect_identifier(&mut self) -> Result<String> {
        match self.advance() {
            Some(Token::Word(word)) | Some(Token::QuotedIdent(word)) => Ok(word),
            Some(token) => Err(anyhow!("expected an identifier, found {token:?}")),
            None => Err(anyhow!("expected an identifier")),
        }
    }

    fn expect_integer(&mut self) -> Result<i64> {
        match self.advance() {
            Some(Token::Number(text)) => text
                .parse::<i64>()
                .map_err(|_| anyhow!("expected an integer, found '{text}'")),
            Some(token) => Err(anyhow!("expected an integer, found {token:?}")),
            None => Err(anyhow!("expected an integer")),
        }
    }

    fn at_end(&self) -> bool {
        self.position >= self.tokens.len()
    }
}

struct SelectStatement {
    distinct: bool,
    items: Vec<SelectItem>,
    from: String,
    where_expr: Option<Expr>,
    group_by: Vec<String>,
    order_by: Vec<OrderByTerm>,
    limit: Option<i64>,
    offset: Option<i64>,
}

enum SelectItem {
    Star,
    Column {
        path: String,
        alias: Option<String>,
    },
    Aggregate {
        func: AggregateFunc,
        path: Option<String>,
        alias: Option<String>,
    },
}

#[derive(Clone, Copy, PartialEq)]
enum AggregateFunc {
    Count,
    Sum,
    Avg,
    Min,
    Max,
}

impl AggregateFunc {
    fn from_name(name: &str) -> Option<Self> {
        match name.to_ascii_uppercase().as_str() {
            "COUNT" => Some(Self::Count),
            "SUM" => Some(Self::Sum),
            "AVG" => Some(Self::Avg),
            "MIN" => Some(Self::Min),
            "MAX" => Some(Self::Max),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Count => "count",
            Self::Sum => "sum",
            Self::Avg => "avg",
            Self::Min => "min",
            Self::Max => "max",
        }
    }

    fn accumulator_operator(self) -> &'static str {
        match self {
            Self::Sum => "$sum",
            Self::Avg => "$avg",
            Self::Min => "$min",
            Self::Max => "$max",
            Self::Count => "$sum",
        }
    }
}

struct OrderByTerm {
    key: String,
    descending: bool,
}

fn parse_select_statement(parser: &mut Parser) -> Result<SelectStatement> {
    parser.expect_keyword("SELECT")?;
    let distinct = parser.eat_keyword("DISTINCT");

    let mut items = Vec::new();
    loop {
        items.push(parse_select_item(parser)?);
        if !parser.eat_symbol(",") {
            break;
        }
    }

    parser.expect_keyword("FROM")?;
    let from = parser.expect_field_path()?;

    let where_expr = if parser.eat_keyword("WHERE") {
        Some(parse_expr(parser)?)
    } else {
        None
    };

    let mut group_by = Vec::new();
    if parser.eat_keyword("GROUP") {
        parser.expect_keyword("BY")?;
        loop {
            group_by.push(parser.expect_field_path()?);
            if !parser.eat_symbol(",") {
                break;
            }
        }
    }
    if parser.eat_keyword("HAVING") {
        return Err(anyhow!(
            "HAVING is not supported; write the filter as a $match stage with db.<collection>.aggregate([...])"
        ));
    }

    let mut order_by = Vec::new();
    if parser.eat_keyword("ORDER") {
        parser.expect_keyword("BY")?;
        loop {
            let key = parser.expect_field_path()?;
            let descending = if parser.eat_keyword("DESC") {
                true
            } else {
                parser.eat_keyword("ASC");
                false
            };
            order_by.push(OrderByTerm { key, descending });
            if !parser.eat_symbol(",") {
                break;
            }
        }
    }

    let mut limit = None;
    let mut offset = None;
    if parser.eat_keyword("LIMIT") {
        let first = parser.expect_integer()?;
        if parser.eat_keyword("OFFSET") {
            limit = Some(first);
            offset = Some(parser.expect_integer()?);
        } else if parser.eat_symbol(",") {
            // MySQL-style `LIMIT <offset>, <count>`.
            offset = Some(first);
            limit = Some(parser.expect_integer()?);
        } else {
            limit = Some(first);
        }
    } else if parser.eat_keyword("OFFSET") {
        offset = Some(parser.expect_integer()?);
    }

    if !parser.at_end() {
        return Err(anyhow!(
            "unexpected input after the end of the statement (only one SQL statement is supported per run)"
        ));
    }

    Ok(SelectStatement {
        distinct,
        items,
        from,
        where_expr,
        group_by,
        order_by,
        limit,
        offset,
    })
}

fn parse_select_item(parser: &mut Parser) -> Result<SelectItem> {
    if parser.eat_symbol("*") {
        return Ok(SelectItem::Star);
    }

    // Aggregate call? A function word immediately followed by '('.
    let aggregate = match parser.peek() {
        Some(Token::Word(word)) if parser.peek_next_symbol("(") => AggregateFunc::from_name(word),
        _ => None,
    };
    if let Some(func) = aggregate {
        parser.advance();
        parser.advance();
        let path = if func == AggregateFunc::Count && parser.eat_symbol("*") {
            None
        } else {
            Some(parser.expect_field_path()?)
        };
        parser.expect_symbol(")")?;
        let alias = read_optional_alias(parser)?;
        return Ok(SelectItem::Aggregate { func, path, alias });
    }

    let path = parser.expect_field_path()?;
    let alias = read_optional_alias(parser)?;
    Ok(SelectItem::Column { path, alias })
}

fn read_optional_alias(parser: &mut Parser) -> Result<Option<String>> {
    if parser.eat_keyword("AS") {
        return Ok(Some(parser.expect_identifier()?));
    }
    // SQL allows an implicit alias (`SELECT name full_name FROM ...`), but a
    // clause keyword such as FROM must never be mistaken for one.
    if matches!(parser.peek(), Some(Token::Word(word)) if !CLAUSE_KEYWORDS.iter().any(|keyword| word.eq_ignore_ascii_case(keyword)))
        || matches!(parser.peek(), Some(Token::QuotedIdent(_)))
    {
        return Ok(Some(parser.expect_identifier()?));
    }
    Ok(None)
}

enum Expr {
    Condition(Document),
    And(Vec<Expr>),
    Or(Vec<Expr>),
    Not(Box<Expr>),
}

impl Expr {
    fn compile(self) -> Document {
        match self {
            Self::Condition(document) => document,
            Self::Not(inner) => doc! { "$nor": [Bson::Document(inner.compile())] },
            Self::And(terms) => {
                if terms.len() == 1 {
                    return terms.into_iter().next().expect("non-empty terms").compile();
                }
                let compiled: Vec<Bson> = terms
                    .into_iter()
                    .map(|term| Bson::Document(term.compile()))
                    .collect();
                doc! { "$and": compiled }
            }
            Self::Or(terms) => {
                if terms.len() == 1 {
                    return terms.into_iter().next().expect("non-empty terms").compile();
                }
                let compiled: Vec<Bson> = terms
                    .into_iter()
                    .map(|term| Bson::Document(term.compile()))
                    .collect();
                doc! { "$or": compiled }
            }
        }
    }
}

fn parse_expr(parser: &mut Parser) -> Result<Expr> {
    let mut terms = vec![parse_and_term(parser)?];
    while parser.eat_keyword("OR") {
        terms.push(parse_and_term(parser)?);
    }
    Ok(if terms.len() == 1 {
        terms.pop().expect("non-empty terms")
    } else {
        Expr::Or(terms)
    })
}

fn parse_and_term(parser: &mut Parser) -> Result<Expr> {
    let mut terms = vec![parse_not_term(parser)?];
    while parser.eat_keyword("AND") {
        terms.push(parse_not_term(parser)?);
    }
    Ok(if terms.len() == 1 {
        terms.pop().expect("non-empty terms")
    } else {
        Expr::And(terms)
    })
}

fn parse_not_term(parser: &mut Parser) -> Result<Expr> {
    if parser.eat_keyword("NOT") {
        return Ok(Expr::Not(Box::new(parse_not_term(parser)?)));
    }
    if parser.eat_symbol("(") {
        let expr = parse_expr(parser)?;
        parser.expect_symbol(")")?;
        return Ok(expr);
    }
    parse_comparison(parser)
}

fn parse_comparison(parser: &mut Parser) -> Result<Expr> {
    let field = parser.expect_field_path()?;

    if parser.eat_keyword("IS") {
        let negated = parser.eat_keyword("NOT");
        parser.expect_keyword("NULL")?;
        let value = if negated {
            Bson::Document(doc! { "$ne": Bson::Null })
        } else {
            Bson::Null
        };
        return Ok(Expr::Condition(field_condition(field, value)));
    }

    let negated = parser.eat_keyword("NOT");

    if parser.eat_keyword("IN") {
        parser.expect_symbol("(")?;
        let mut values = Vec::new();
        loop {
            values.push(parse_value(parser)?);
            if !parser.eat_symbol(",") {
                break;
            }
        }
        parser.expect_symbol(")")?;
        if values.is_empty() {
            return Err(anyhow!("IN requires at least one value"));
        }
        let mut operator = Document::new();
        operator.insert(if negated { "$nin" } else { "$in" }, Bson::Array(values));
        return Ok(Expr::Condition(field_condition(
            field,
            Bson::Document(operator),
        )));
    }

    if parser.eat_keyword("LIKE") {
        let pattern = match parser.advance() {
            Some(Token::String(value)) | Some(Token::QuotedIdent(value)) => value,
            Some(token) => return Err(anyhow!("LIKE requires a string pattern, found {token:?}")),
            None => return Err(anyhow!("LIKE requires a string pattern")),
        };
        let regex = like_to_regex(&pattern);
        let operator = if negated {
            doc! { "$not": { "$regex": regex, "$options": "i" } }
        } else {
            doc! { "$regex": regex, "$options": "i" }
        };
        return Ok(Expr::Condition(field_condition(
            field,
            Bson::Document(operator),
        )));
    }

    if parser.eat_keyword("BETWEEN") {
        let start = parse_value(parser)?;
        parser.expect_keyword("AND")?;
        let end = parse_value(parser)?;
        let range = doc! { "$gte": start, "$lte": end };
        let operator = if negated {
            doc! { "$not": range }
        } else {
            range
        };
        return Ok(Expr::Condition(field_condition(
            field,
            Bson::Document(operator),
        )));
    }

    if negated {
        return Err(anyhow!("expected IN, LIKE or BETWEEN after NOT"));
    }

    let operator = match parser.advance() {
        Some(Token::Symbol(symbol)) => symbol,
        Some(token) => return Err(anyhow!("expected a comparison operator, found {token:?}")),
        None => return Err(anyhow!("expected a comparison operator")),
    };

    let value = parse_value(parser)?;
    let condition_value = match operator.as_str() {
        "=" => value,
        "!=" | "<>" => Bson::Document(doc! { "$ne": value }),
        ">" => Bson::Document(doc! { "$gt": value }),
        ">=" => Bson::Document(doc! { "$gte": value }),
        "<" => Bson::Document(doc! { "$lt": value }),
        "<=" => Bson::Document(doc! { "$lte": value }),
        other => return Err(anyhow!("unsupported comparison operator '{other}'")),
    };
    Ok(Expr::Condition(field_condition(field, condition_value)))
}

fn parse_value(parser: &mut Parser) -> Result<Bson> {
    match parser.advance() {
        Some(Token::Number(text)) => number_to_bson(&text),
        // Reuses the shared conversion so literal values follow the same
        // 24-hex → ObjectId coercion as every other filter path in the driver.
        Some(Token::String(value)) => MongoDbDriver::json_value_to_bson(JsonValue::String(value)),
        Some(Token::QuotedIdent(value)) => Ok(Bson::String(value)),
        Some(Token::Word(word)) => match word.to_ascii_uppercase().as_str() {
            "TRUE" => Ok(Bson::Boolean(true)),
            "FALSE" => Ok(Bson::Boolean(false)),
            "NULL" => Ok(Bson::Null),
            other => Err(anyhow!("unsupported value '{other}'")),
        },
        Some(Token::Symbol(symbol)) if symbol == "-" => {
            let text = match parser.advance() {
                Some(Token::Number(text)) => text,
                _ => return Err(anyhow!("expected a number after '-'")),
            };
            number_to_bson(&format!("-{text}"))
        }
        Some(token) => Err(anyhow!("unsupported value {token:?}")),
        None => Err(anyhow!("expected a value")),
    }
}

fn number_to_bson(text: &str) -> Result<Bson> {
    if let Ok(int_value) = text.parse::<i64>() {
        return Ok(Bson::Int64(int_value));
    }
    let float_value = text
        .parse::<f64>()
        .map_err(|_| anyhow!("invalid number '{text}'"))?;
    Ok(Bson::Double(float_value))
}

/// Converts a SQL LIKE pattern into an anchored case-insensitive regex:
/// `%` → `.*`, `_` → `.`, everything else escaped literally.
fn like_to_regex(pattern: &str) -> String {
    let mut regex = String::from("^");
    for ch in pattern.chars() {
        match ch {
            '%' => regex.push_str(".*"),
            '_' => regex.push('.'),
            metachar if "\\.+*?()|[]{}^$".contains(metachar) => {
                regex.push('\\');
                regex.push(metachar);
            }
            plain => regex.push(plain),
        }
    }
    regex.push('$');
    regex
}

fn field_condition(field: String, value: Bson) -> Document {
    let mut condition = Document::new();
    condition.insert(field, value);
    condition
}

fn field_ref(path: &str) -> Bson {
    Bson::String(format!("${path}"))
}

struct AggregateSpec {
    func: AggregateFunc,
    path: Option<String>,
    output_name: String,
    expression_text: String,
}

impl AggregateSpec {
    fn accumulator(&self) -> Bson {
        match self.func {
            AggregateFunc::Count => match self.path.as_deref() {
                None => Bson::Document(field_accumulator("$sum", None)),
                Some(path) => Bson::Document(doc! {
                    "$sum": {
                        "$cond": [
                            { "$ne": [field_ref(path), Bson::Null] },
                            1,
                            0,
                        ],
                    },
                }),
            },
            func => Bson::Document(field_accumulator(
                func.accumulator_operator(),
                self.path.as_deref(),
            )),
        }
    }
}

fn aggregate_spec(
    func: AggregateFunc,
    path: Option<String>,
    alias: Option<String>,
) -> AggregateSpec {
    let default_name = match path.as_deref() {
        None => func.name().to_string(),
        Some(path) => format!("{}_{}", func.name(), path.replace('.', "_")),
    };
    let expression_text = match path.as_deref() {
        None => format!("{}(*)", func.name()),
        Some(path) => format!("{}({})", func.name(), path),
    };
    AggregateSpec {
        output_name: alias.unwrap_or(default_name),
        expression_text,
        func,
        path,
    }
}

fn field_accumulator(operator: &str, path: Option<&str>) -> Document {
    let mut accumulator = Document::new();
    accumulator.insert(operator, path.map(field_ref).unwrap_or(Bson::Int32(1)));
    accumulator
}

fn build_command(statement: SelectStatement) -> Result<MongoQueryCommand> {
    let SelectStatement {
        distinct,
        items,
        from,
        where_expr,
        group_by,
        order_by,
        limit,
        offset,
    } = statement;

    if items.iter().any(|item| matches!(item, SelectItem::Star)) && items.len() > 1 {
        return Err(anyhow!("'*' cannot be combined with other select items"));
    }

    let star = items.iter().any(|item| matches!(item, SelectItem::Star));
    let columns: Vec<(String, Option<String>)> = items
        .iter()
        .filter_map(|item| match item {
            SelectItem::Column { path, alias } => Some((path.clone(), alias.clone())),
            _ => None,
        })
        .collect();
    let has_alias = columns.iter().any(|(_, alias)| alias.is_some());
    let aggregates: Vec<AggregateSpec> = items
        .iter()
        .filter_map(|item| match item {
            SelectItem::Aggregate { func, path, alias } => {
                Some(aggregate_spec(*func, path.clone(), alias.clone()))
            }
            _ => None,
        })
        .collect();

    if !group_by.is_empty() {
        if distinct {
            return Err(anyhow!("DISTINCT combined with GROUP BY is not supported"));
        }
        if star {
            return Err(anyhow!(
                "'*' is not supported with GROUP BY; list the grouped columns explicitly"
            ));
        }
        return build_group_by(
            from, &columns, aggregates, &group_by, where_expr, &order_by, limit, offset,
        );
    }

    if !aggregates.is_empty() {
        if distinct {
            return Err(anyhow!(
                "DISTINCT combined with aggregate functions is not supported"
            ));
        }
        if star {
            return Err(anyhow!("'*' cannot be combined with aggregate functions"));
        }
        if !columns.is_empty() {
            return Err(anyhow!(
                "mixing plain columns with aggregate functions requires GROUP BY"
            ));
        }
        if aggregates.len() == 1
            && aggregates[0].func == AggregateFunc::Count
            && aggregates[0].path.is_none()
        {
            // `SELECT COUNT(*) FROM ...` — sort/limit are no-ops for a single
            // scalar row, so the dedicated count command is enough.
            return Ok(MongoQueryCommand::CountDocuments {
                collection: from,
                filter: compile_where(where_expr),
            });
        }
        return build_whole_collection_aggregate(
            from, aggregates, where_expr, &order_by, limit, offset,
        );
    }

    if distinct {
        if star {
            return Err(anyhow!(
                "SELECT DISTINCT * is not supported; list the columns explicitly"
            ));
        }
        let distinct_columns: Vec<String> = columns.into_iter().map(|(path, _)| path).collect();
        return build_distinct(from, distinct_columns, where_expr, &order_by, limit, offset);
    }

    if has_alias {
        let projection_items: Vec<(String, String)> = columns
            .iter()
            .map(|(path, alias)| (alias.clone().unwrap_or_else(|| path.clone()), path.clone()))
            .collect();
        return build_alias_projection(
            from,
            projection_items,
            where_expr,
            &order_by,
            limit,
            offset,
        );
    }

    let projection = if star {
        None
    } else {
        let mut projection = Document::new();
        for (path, _) in &columns {
            projection.insert(path.clone(), Bson::Int32(1));
        }
        // SQL semantics: only the requested columns come back, so exclude _id
        // unless the query asked for it explicitly.
        if !columns
            .iter()
            .any(|(path, _)| path.eq_ignore_ascii_case("_id"))
        {
            projection.insert("_id", Bson::Int32(0));
        }
        Some(projection)
    };

    Ok(MongoQueryCommand::Find {
        collection: from,
        filter: compile_where(where_expr),
        projection,
        sort: build_plain_sort(&order_by)?,
        limit,
        skip: offset.map(|value| value.max(0) as u64),
    })
}

fn compile_where(where_expr: Option<Expr>) -> Document {
    where_expr.map(Expr::compile).unwrap_or_default()
}

fn build_plain_sort(order_by: &[OrderByTerm]) -> Result<Option<Document>> {
    if order_by.is_empty() {
        return Ok(None);
    }
    let mut sort = Document::new();
    for term in order_by {
        sort.insert(
            term.key.clone(),
            Bson::Int32(if term.descending { -1 } else { 1 }),
        );
    }
    Ok(Some(sort))
}

/// ORDER BY on aggregate-shaped results can only reference output fields, so
/// each term is resolved against the known output names.
fn build_resolved_sort(
    order_by: &[OrderByTerm],
    output_names: &[String],
) -> Result<Option<Document>> {
    if order_by.is_empty() {
        return Ok(None);
    }
    let mut sort = Document::new();
    for term in order_by {
        let resolved = output_names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(&term.key))
            .ok_or_else(|| {
                anyhow!(
                    "ORDER BY '{}' must reference an output column or aggregate alias",
                    term.key
                )
            })?;
        sort.insert(
            resolved.clone(),
            Bson::Int32(if term.descending { -1 } else { 1 }),
        );
    }
    Ok(Some(sort))
}

fn push_sort_skip_limit(
    pipeline: &mut Vec<Document>,
    sort: Option<Document>,
    limit: Option<i64>,
    offset: Option<i64>,
) {
    if let Some(sort) = sort {
        pipeline.push(doc! { "$sort": sort });
    }
    if let Some(offset) = offset.filter(|value| *value > 0) {
        pipeline.push(doc! { "$skip": Bson::Int64(offset) });
    }
    if let Some(limit) = limit {
        let capped = limit.clamp(1, MAX_QUERY_RESULT_ROWS as i64);
        pipeline.push(doc! { "$limit": Bson::Int64(capped) });
    }
}

#[allow(clippy::too_many_arguments)]
fn build_group_by(
    collection: String,
    columns: &[(String, Option<String>)],
    aggregates: Vec<AggregateSpec>,
    group_by: &[String],
    where_expr: Option<Expr>,
    order_by: &[OrderByTerm],
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MongoQueryCommand> {
    for (path, _) in columns {
        let grouped = group_by
            .iter()
            .any(|group| group.eq_ignore_ascii_case(path));
        if !grouped {
            return Err(anyhow!(
                "column '{path}' must appear in GROUP BY or be used in an aggregate function"
            ));
        }
    }

    let mut group_id = Document::new();
    for group in group_by {
        group_id.insert(group.clone(), field_ref(group));
    }
    let mut group_stage = Document::new();
    group_stage.insert("_id", Bson::Document(group_id));
    for aggregate in &aggregates {
        group_stage.insert(aggregate.output_name.clone(), aggregate.accumulator());
    }

    let mut pipeline = Vec::new();
    if let Some(where_expr) = where_expr {
        pipeline.push(doc! { "$match": where_expr.compile() });
    }
    pipeline.push(doc! { "$group": group_stage });

    let mut project_stage = Document::new();
    for group in group_by {
        project_stage.insert(group.clone(), Bson::String(format!("$_id.{group}")));
    }
    for aggregate in &aggregates {
        project_stage.insert(aggregate.output_name.clone(), Bson::Int32(1));
    }
    project_stage.insert("_id", Bson::Int32(0));
    pipeline.push(doc! { "$project": project_stage });

    let mut output_names: Vec<String> = group_by.to_vec();
    output_names.extend(aggregates.iter().map(|a| a.output_name.clone()));
    let sort = build_resolved_sort(order_by, &output_names)?;
    push_sort_skip_limit(&mut pipeline, sort, limit, offset);

    Ok(MongoQueryCommand::Aggregate {
        collection,
        pipeline,
    })
}

fn build_whole_collection_aggregate(
    collection: String,
    aggregates: Vec<AggregateSpec>,
    where_expr: Option<Expr>,
    order_by: &[OrderByTerm],
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MongoQueryCommand> {
    let mut group_stage = Document::new();
    group_stage.insert("_id", Bson::Null);
    for aggregate in &aggregates {
        group_stage.insert(aggregate.output_name.clone(), aggregate.accumulator());
    }

    let mut pipeline = Vec::new();
    if let Some(where_expr) = where_expr {
        pipeline.push(doc! { "$match": where_expr.compile() });
    }
    pipeline.push(doc! { "$group": group_stage });

    let output_names: Vec<String> = aggregates
        .iter()
        .flat_map(|a| [a.output_name.clone(), a.expression_text.clone()])
        .collect();
    let sort = build_resolved_sort(order_by, &output_names)?;
    push_sort_skip_limit(&mut pipeline, sort, limit, offset);

    Ok(MongoQueryCommand::Aggregate {
        collection,
        pipeline,
    })
}

fn build_distinct(
    collection: String,
    columns: Vec<String>,
    where_expr: Option<Expr>,
    order_by: &[OrderByTerm],
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MongoQueryCommand> {
    if columns.is_empty() {
        return Err(anyhow!("SELECT DISTINCT requires a column list"));
    }

    let mut group_id = Document::new();
    for column in &columns {
        group_id.insert(column.clone(), field_ref(column));
    }

    let mut pipeline = Vec::new();
    if let Some(where_expr) = where_expr {
        pipeline.push(doc! { "$match": where_expr.compile() });
    }
    let mut group_stage = Document::new();
    group_stage.insert("_id", Bson::Document(group_id));
    pipeline.push(doc! { "$group": group_stage });

    let mut project_stage = Document::new();
    for column in &columns {
        project_stage.insert(column.clone(), Bson::String(format!("$_id.{column}")));
    }
    project_stage.insert("_id", Bson::Int32(0));
    pipeline.push(doc! { "$project": project_stage });

    let sort = build_resolved_sort(order_by, &columns)?;
    push_sort_skip_limit(&mut pipeline, sort, limit, offset);

    Ok(MongoQueryCommand::Aggregate {
        collection,
        pipeline,
    })
}

fn build_alias_projection(
    collection: String,
    projection_items: Vec<(String, String)>,
    where_expr: Option<Expr>,
    order_by: &[OrderByTerm],
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MongoQueryCommand> {
    // find() projections cannot rename fields, so aliased selects are served
    // by a $project aggregate stage instead.
    let mut project_stage = Document::new();
    for (output_name, path) in &projection_items {
        if output_name == path {
            project_stage.insert(output_name.clone(), Bson::Int32(1));
        } else {
            project_stage.insert(output_name.clone(), field_ref(path));
        }
    }
    project_stage.insert("_id", Bson::Int32(0));

    let mut pipeline = Vec::new();
    if let Some(where_expr) = where_expr {
        pipeline.push(doc! { "$match": where_expr.compile() });
    }
    pipeline.push(doc! { "$project": project_stage });

    let output_names: Vec<String> = projection_items
        .into_iter()
        .flat_map(|(output, path)| [output, path])
        .collect();
    let sort = build_resolved_sort(order_by, &output_names)?;
    push_sort_skip_limit(&mut pipeline, sort, limit, offset);

    Ok(MongoQueryCommand::Aggregate {
        collection,
        pipeline,
    })
}
