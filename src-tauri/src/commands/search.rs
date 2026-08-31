//! Global search over live table data and schema names (roadmap Phase 2C).
//!
//! `search_table_data` runs a LIKE query across a table's text columns with
//! the keyword bound as a prepared parameter (never interpolated into SQL),
//! reusing the per-dialect identifier quoting from `database::safety`.
//! `search_schema` matches table and column names against the live catalog.

use crate::database::capabilities::DriverCapability;
use crate::database::manager::DatabaseManager;
use crate::database::models::{DatabaseType, QueryParameter, QueryParameterType};
use crate::database::parameterized_query::{
    compile_parameterized_query, placeholder_style_for_database,
};
use crate::database::safety::{
    quote_bigquery_identifier, quote_cassandra_identifier, quote_clickhouse_identifier,
    quote_mssql_identifier, quote_mysql_identifier, quote_postgres_identifier,
    quote_snowflake_identifier, quote_sqlite_identifier,
};
use serde::Serialize;
use tauri::State;

const MAX_SCHEMA_TABLES_SCANNED: usize = 200;
const MAX_SCHEMA_MATCHES: usize = 100;
const MAX_DATA_MATCHES: u64 = 200;
const DEFAULT_DATA_MATCHES: u64 = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSearchMatch {
    pub table: String,
    pub schema: Option<String>,
    pub column: Option<String>,
    /// `"table"` or `"column"`.
    pub match_type: String,
}

/// Quotes a possibly schema-qualified identifier for the engine dialect.
pub fn quote_qualified_identifier(
    database_type: DatabaseType,
    qualified: &str,
) -> anyhow::Result<String> {
    let quote_one = |part: &str| match database_type {
        DatabaseType::PostgreSQL
        | DatabaseType::CockroachDB
        | DatabaseType::Greenplum
        | DatabaseType::Redshift
        | DatabaseType::Vertica => quote_postgres_identifier(part),
        DatabaseType::MySQL | DatabaseType::MariaDB => quote_mysql_identifier(part),
        DatabaseType::MSSQL => quote_mssql_identifier(part),
        DatabaseType::SQLite
        | DatabaseType::DuckDB
        | DatabaseType::LibSQL
        | DatabaseType::CloudflareD1 => quote_sqlite_identifier(part),
        DatabaseType::ClickHouse => quote_clickhouse_identifier(part),
        DatabaseType::BigQuery => quote_bigquery_identifier(part),
        DatabaseType::Snowflake => quote_snowflake_identifier(part),
        DatabaseType::Cassandra => quote_cassandra_identifier(part),
        other => Err(anyhow::anyhow!(
            "Global search does not support this engine ({other:?})"
        )),
    };
    let parts: anyhow::Result<Vec<String>> = qualified
        .split('.')
        .filter(|p| !p.is_empty())
        .map(quote_one)
        .collect();
    Ok(parts?.join("."))
}

/// Escapes LIKE wildcards so the keyword matches literally.
pub fn escape_like_pattern(value: &str, escape_char: char) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch == escape_char || ch == '%' || ch == '_' {
            escaped.push(escape_char);
        }
        escaped.push(ch);
    }
    escaped
}

/// SQL text of the ESCAPE clause; MySQL treats `\` as a string-literal escape,
/// so it must be doubled inside the literal.
pub fn like_escape_clause(database_type: DatabaseType) -> &'static str {
    match database_type {
        DatabaseType::MySQL | DatabaseType::MariaDB => "ESCAPE '\\\\'",
        _ => "ESCAPE '\\'",
    }
}

/// True when a column's type can be compared with LIKE. PostgreSQL rejects
/// `integer LIKE ...`, so non-text columns are excluded up front.
pub fn is_text_like_column(data_type: &str) -> bool {
    let normalized = data_type.to_lowercase();
    ["char", "text", "clob", "uuid", "citext", "name", "enum"]
        .iter()
        .any(|needle| normalized.contains(needle))
}

#[tauri::command]
pub async fn search_schema(
    connection_id: String,
    keyword: String,
    limit: Option<usize>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<SchemaSearchMatch>, String> {
    let needle = keyword.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let max = limit.unwrap_or(MAX_SCHEMA_MATCHES).min(MAX_SCHEMA_MATCHES);
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    let tables = driver
        .list_tables(None)
        .await
        .map_err(|error| error.to_string())?;

    let mut matches: Vec<SchemaSearchMatch> = Vec::new();
    for table in tables.iter().take(MAX_SCHEMA_TABLES_SCANNED) {
        if matches.len() >= max {
            break;
        }
        if table.name.to_lowercase().contains(&needle) {
            matches.push(SchemaSearchMatch {
                table: table.name.clone(),
                schema: table.schema.clone(),
                column: None,
                match_type: "table".to_string(),
            });
        }
        let columns = match driver.get_table_columns_preview(&table.name, None).await {
            Ok(columns) => columns,
            Err(_) => continue,
        };
        for column in columns {
            if matches.len() >= max {
                break;
            }
            if column.name.to_lowercase().contains(&needle) {
                matches.push(SchemaSearchMatch {
                    table: table.name.clone(),
                    schema: table.schema.clone(),
                    column: Some(column.name),
                    match_type: "column".to_string(),
                });
            }
        }
    }
    matches.truncate(max);
    Ok(matches)
}

#[tauri::command]
pub async fn search_table_data(
    connection_id: String,
    table: String,
    keyword: String,
    limit: Option<u64>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<crate::database::models::QueryResult, String> {
    let needle = keyword.trim();
    if needle.is_empty() {
        return Err("Global data search requires a non-empty keyword.".to_string());
    }
    let row_limit = limit.unwrap_or(DEFAULT_DATA_MATCHES).min(MAX_DATA_MATCHES);

    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    db_manager
        .require_capability(&connection_id, DriverCapability::PreparedParameters)
        .await
        .map_err(|error| error.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;

    let columns = driver
        .get_table_columns_preview(&table, None)
        .await
        .map_err(|error| error.to_string())?;
    let text_columns: Vec<&crate::database::models::ColumnDetail> = columns
        .iter()
        .filter(|column| is_text_like_column(&column.data_type))
        .collect();
    if text_columns.is_empty() {
        return Err(
            "This table has no text columns to search; data search matches text values only."
                .to_string(),
        );
    }

    let quoted_table =
        quote_qualified_identifier(database_type, &table).map_err(|error| error.to_string())?;
    let escape_clause = like_escape_clause(database_type);
    let predicate = text_columns
        .iter()
        .map(|column| {
            quote_qualified_identifier(database_type, &column.name)
                .map(|quoted| format!("{quoted} LIKE :keyword {escape_clause}"))
        })
        .collect::<anyhow::Result<Vec<String>>>()
        .map_err(|error| error.to_string())?
        .join(" OR ");
    let sql = if database_type == DatabaseType::MSSQL {
        format!("SELECT TOP ({row_limit}) * FROM {quoted_table} WHERE {predicate}")
    } else {
        format!("SELECT * FROM {quoted_table} WHERE {predicate} LIMIT {row_limit}")
    };

    let style = placeholder_style_for_database(database_type);
    let parameters = vec![QueryParameter {
        name: "keyword".to_string(),
        value: serde_json::Value::String(escape_like_pattern(needle, '\\')),
        data_type: QueryParameterType::Text,
    }];
    let compiled =
        compile_parameterized_query(&sql, &parameters, style).map_err(|error| error.to_string())?;
    driver
        .execute_parameterized_query(&compiled.sql, &compiled.parameters)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{escape_like_pattern, is_text_like_column, quote_qualified_identifier};
    use crate::database::models::DatabaseType;

    #[test]
    fn quotes_schema_qualified_identifiers_per_dialect() {
        assert_eq!(
            quote_qualified_identifier(DatabaseType::MSSQL, "dbo.users").unwrap(),
            "[dbo].[users]"
        );
        assert_eq!(
            quote_qualified_identifier(DatabaseType::MySQL, "shop.orders").unwrap(),
            "`shop`.`orders`"
        );
        assert_eq!(
            quote_qualified_identifier(DatabaseType::PostgreSQL, "public.users").unwrap(),
            "\"public\".\"users\""
        );
        assert!(quote_qualified_identifier(DatabaseType::Redis, "x").is_err());
    }

    #[test]
    fn escapes_like_wildcards_but_keeps_literal_text() {
        assert_eq!(escape_like_pattern("100%_done", '\\'), "100\\%\\_done");
        assert_eq!(escape_like_pattern("plain text", '\\'), "plain text");
    }

    #[test]
    fn only_text_columns_are_like_searchable() {
        assert!(is_text_like_column("varchar(255)"));
        assert!(is_text_like_column("TEXT"));
        assert!(is_text_like_column("uuid"));
        assert!(!is_text_like_column("integer"));
        assert!(!is_text_like_column("timestamp with time zone"));
    }
}
