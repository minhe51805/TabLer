//! Recursive-descent parser for the SQL SELECT subset: turns the lexer's token
//! stream into a `SelectStatement` AST, and owns the shared AST types plus the
//! Bson-fragment helpers reused by the command builder.

use super::lexer::Token;
use crate::database::mongodb::MongoDbDriver;
use anyhow::{anyhow, Result};
use mongodb::bson::{doc, Bson, Document};
use serde_json::Value as JsonValue;

/// Words that introduce a new clause; an identifier alias must never swallow them.
const CLAUSE_KEYWORDS: &[&str] = &[
    "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "AS", "ASC", "DESC", "AND",
    "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "UNION", "JOIN", "SELECT", "DISTINCT",
];

pub(super) struct Parser {
    tokens: Vec<Token>,
    position: usize,
}

impl Parser {
    pub(super) fn new(tokens: Vec<Token>) -> Self {
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
            Some(Token::Word(word)) | Some(Token::QuotedIdent(word)) => {
                // `$`-prefixed names are MongoDB operators, not field paths —
                // a quoted "$where" would otherwise smuggle server-side
                // JavaScript into a read-only SELECT.
                if word.starts_with('$') {
                    Err(anyhow!(
                        "field names may not start with '$' (found '{word}')"
                    ))
                } else {
                    Ok(word)
                }
            }
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

pub(super) struct SelectStatement {
    pub(super) distinct: bool,
    pub(super) items: Vec<SelectItem>,
    pub(super) from: String,
    pub(super) where_expr: Option<Expr>,
    pub(super) group_by: Vec<String>,
    pub(super) order_by: Vec<OrderByTerm>,
    pub(super) limit: Option<i64>,
    pub(super) offset: Option<i64>,
}

pub(super) enum SelectItem {
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
pub(super) enum AggregateFunc {
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

pub(super) struct OrderByTerm {
    pub(super) key: String,
    pub(super) descending: bool,
}

pub(super) fn parse_select_statement(parser: &mut Parser) -> Result<SelectStatement> {
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

pub(super) enum Expr {
    Condition(Document),
    And(Vec<Expr>),
    Or(Vec<Expr>),
    Not(Box<Expr>),
}

impl Expr {
    pub(super) fn compile(self) -> Document {
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

pub(super) fn field_ref(path: &str) -> Bson {
    Bson::String(format!("${path}"))
}

pub(super) struct AggregateSpec {
    pub(super) func: AggregateFunc,
    pub(super) path: Option<String>,
    pub(super) output_name: String,
    pub(super) expression_text: String,
}

impl AggregateSpec {
    pub(super) fn accumulator(&self) -> Bson {
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

pub(super) fn aggregate_spec(
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
