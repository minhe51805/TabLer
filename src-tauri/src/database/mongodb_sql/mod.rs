//! SQL → MongoDB translation for the command-surface query editor.
//!
//! MongoDB connections normally speak shell syntax (`db.users.find({})`), but
//! users and SQL-shaped tooling naturally type `SELECT` statements into the
//! query tab. Instead of rejecting them with "MongoDB commands must start with
//! db.", the driver translates a practical `SELECT` subset into
//! find/aggregate/count commands and answers every other SQL statement with an
//! actionable error pointing at the shell equivalent.

use super::mongodb::MongoQueryCommand;
use anyhow::{anyhow, Result};

mod builder;
mod lexer;
mod parser;

use builder::build_command;
use lexer::tokenize;
use parser::{parse_select_statement, Parser};

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
