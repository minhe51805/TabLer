//! SQL DML rendering for exports: INSERT batches, value/string rendering,
//! row-to-object conversion, identifier quoting, and engine preamble/postamble.

use crate::database::capabilities::is_sqlite_family;
use crate::database::models::{ColumnInfo, DatabaseType};
use crate::database::safety::{
    quote_bigquery_identifier, quote_cassandra_identifier, quote_clickhouse_identifier,
    quote_mssql_identifier, quote_mysql_identifier, quote_postgres_identifier,
    quote_snowflake_identifier, quote_sqlite_identifier,
};
use anyhow::{anyhow, Result};
use serde_json::{Map as JsonMap, Value as JsonValue};

pub(crate) fn build_insert_statement_batch(
    db_type: DatabaseType,
    table_ref: &str,
    columns: &[ColumnInfo],
    rows: &[Vec<JsonValue>],
) -> Result<String> {
    if columns.is_empty() || rows.is_empty() {
        return Ok(String::new());
    }

    let column_list = columns
        .iter()
        .map(|column| quote_identifier_for(db_type, &column.name))
        .collect::<Result<Vec<_>>>()?;
    let row_values = rows
        .iter()
        .map(|row| {
            let rendered_values = columns
                .iter()
                .enumerate()
                .map(|(index, column)| render_sql_value(row.get(index), db_type, column))
                .collect::<Vec<_>>();
            format!("({})", rendered_values.join(", "))
        })
        .collect::<Vec<_>>();

    Ok(format!(
        "INSERT INTO {table_ref} ({}) VALUES\n  {};",
        column_list.join(", "),
        row_values.join(",\n  "),
    ))
}

pub(super) fn render_sql_value(
    value: Option<&JsonValue>,
    db_type: DatabaseType,
    column: &ColumnInfo,
) -> String {
    match value.unwrap_or(&JsonValue::Null) {
        JsonValue::Null => "NULL".to_string(),
        JsonValue::Bool(value) => match db_type {
            DatabaseType::MSSQL => {
                if *value {
                    "1".to_string()
                } else {
                    "0".to_string()
                }
            }
            _ => {
                if *value {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                }
            }
        },
        JsonValue::Number(value) => value.to_string(),
        JsonValue::String(value) => render_sql_string(value, db_type, column),
        JsonValue::Array(_) | JsonValue::Object(_) => render_sql_string(
            &value.unwrap_or(&JsonValue::Null).to_string(),
            db_type,
            column,
        ),
    }
}

pub(super) fn render_sql_string(
    value: &str,
    db_type: DatabaseType,
    _column: &ColumnInfo,
) -> String {
    let escaped = format!("'{}'", value.replace('\'', "''"));
    // MSSQL: without the N prefix, a string literal is converted to the
    // server's default codepage (windows-1252), silently destroying any
    // Unicode (Vietnamese) characters. The N prefix keeps it NVARCHAR.
    if db_type == DatabaseType::MSSQL {
        format!("N{escaped}")
    } else {
        escaped
    }
}

pub(super) fn row_to_object(
    columns: &[ColumnInfo],
    row: &[JsonValue],
) -> JsonMap<String, JsonValue> {
    let mut object = JsonMap::new();
    for (index, column) in columns.iter().enumerate() {
        object.insert(
            column.name.clone(),
            row.get(index).cloned().unwrap_or(JsonValue::Null),
        );
    }
    object
}

pub(crate) fn qualify_name(
    db_type: DatabaseType,
    raw_identifier: &str,
    database: Option<&str>,
) -> Result<String> {
    let mut parts = raw_identifier
        .split('.')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    if parts.is_empty() {
        return Err(anyhow!("Identifier cannot be empty"));
    }

    if matches!(db_type, DatabaseType::MySQL | DatabaseType::MariaDB) && parts.len() == 1 {
        if let Some(database_name) = database.map(str::trim).filter(|value| !value.is_empty()) {
            parts.insert(0, database_name.to_string());
        }
    }

    parts
        .iter()
        .map(|part| quote_identifier_for(db_type, part))
        .collect::<Result<Vec<_>>>()
        .map(|quoted| quoted.join("."))
}

pub(super) fn quote_identifier_for(db_type: DatabaseType, value: &str) -> Result<String> {
    match db_type {
        DatabaseType::MySQL | DatabaseType::MariaDB => quote_mysql_identifier(value),
        DatabaseType::ClickHouse => quote_clickhouse_identifier(value),
        DatabaseType::BigQuery => quote_bigquery_identifier(value),
        DatabaseType::Cassandra => quote_cassandra_identifier(value),
        DatabaseType::Snowflake => quote_snowflake_identifier(value),
        DatabaseType::MSSQL => quote_mssql_identifier(value),
        DatabaseType::SQLite
        | DatabaseType::DuckDB
        | DatabaseType::LibSQL
        | DatabaseType::CloudflareD1 => quote_sqlite_identifier(value),
        _ => quote_postgres_identifier(value),
    }
}

pub(super) fn database_export_preamble(db_type: DatabaseType) -> String {
    // D8: sqlite-family membership comes from `is_sqlite_family` (single source).
    if matches!(db_type, DatabaseType::MySQL | DatabaseType::MariaDB) {
        "SET FOREIGN_KEY_CHECKS=0;\n\n".to_string()
    } else if is_sqlite_family(db_type) {
        "PRAGMA foreign_keys = OFF;\n\n".to_string()
    } else {
        String::new()
    }
}

pub(super) fn database_export_postamble(db_type: DatabaseType) -> String {
    // D8: sqlite-family membership comes from `is_sqlite_family` (single source).
    if matches!(db_type, DatabaseType::MySQL | DatabaseType::MariaDB) {
        "\nSET FOREIGN_KEY_CHECKS=1;\n".to_string()
    } else if is_sqlite_family(db_type) {
        "\nPRAGMA foreign_keys = ON;\n".to_string()
    } else {
        String::new()
    }
}
