//! Global search over live table data and schema names (roadmap Phase 2C).
//!
//! `search_table_data` runs a LIKE query across a table's text columns with
//! the keyword bound as a prepared parameter (never interpolated into SQL),
//! reusing the per-dialect identifier quoting from `database::safety`.
//! `search_schema` matches table and column names against the live catalog.

use crate::database::capabilities::DriverCapability;
use crate::database::manager::DatabaseManager;
use crate::database::models::{ColumnDetail, DatabaseType, QueryParameter, QueryParameterType};
use crate::database::parameterized_query::{
    compile_parameterized_query, placeholder_style_for_database,
};
use crate::database::safety::{
    quote_bigquery_identifier, quote_cassandra_identifier, quote_clickhouse_identifier,
    quote_mssql_identifier, quote_mysql_identifier, quote_postgres_identifier,
    quote_snowflake_identifier, quote_sqlite_identifier,
};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use tokio::task::JoinSet;

const MAX_SCHEMA_TABLES_SCANNED: usize = 200;
const MAX_SCHEMA_MATCHES: usize = 100;
const MAX_DATA_MATCHES: u64 = 200;
const DEFAULT_DATA_MATCHES: u64 = 50;
const PARALLEL_TABLE_SCANS: usize = 8;

/// Conservative identifier check for values spliced into INFORMATION_SCHEMA
/// metadata queries (they come from the catalog, not free user input, but we
/// still fail closed).
fn is_safe_metadata_identifier(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | ' ' | '-' | '$' | '#'))
}

/// Escape a single-quoted SQL string literal.
fn sql_string_literal(value: &str) -> String {
    format!("N'{}'", value.replace('\'', "''"))
}

/// Cross-database table listing (MSSQL only) — `[db].sys.tables`.
#[tauri::command]
pub async fn list_tables_in(
    connection_id: String,
    database: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<String>, String> {
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    if database_type != DatabaseType::MSSQL {
        return Err("Cross-database listing is only available for SQL Server.".to_string());
    }
    if !is_safe_metadata_identifier(&database) {
        return Err("Invalid database name.".to_string());
    }
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    let dbq = quote_mssql_identifier(&database).map_err(|error| error.to_string())?;
    let sql = format!(
        "SELECT s.name AS schema_name, t.name AS table_name \
         FROM {dbq}.sys.tables t \
         JOIN {dbq}.sys.schemas s ON s.schema_id = t.schema_id \
         ORDER BY s.name, t.name"
    );
    let result = driver
        .execute_query(&sql)
        .await
        .map_err(|error| error.to_string())?;
    let schema_idx = result
        .columns
        .iter()
        .position(|c| c.name == "schema_name")
        .unwrap_or(0);
    let name_idx = result
        .columns
        .iter()
        .position(|c| c.name == "table_name")
        .unwrap_or(1);
    let mut tables = Vec::new();
    for row in result.rows {
        let schema = row
            .get(schema_idx)
            .and_then(|v| v.as_str())
            .unwrap_or("dbo");
        let name = row.get(name_idx).and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        tables.push(format!("{schema}.{name}"));
    }
    Ok(tables)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSearchMatch {
    pub table: String,
    pub schema: Option<String>,
    pub column: Option<String>,
    /// `"table"` or `"column"`.
    pub match_type: String,
}

/// One table's data matches for the cross-table search (`search_table_data_multi`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiTableDataMatch {
    pub table: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// True when adding this table's rows would exceed the global row cap.
    pub truncated: bool,
    /// Execution error for this table, when the sweep query itself failed.
    pub error: Option<String>,
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

/// Fetch searchable text columns for `table`, optionally scoped to another
/// database on the same SQL Server instance (3-part naming). Falls back to the
/// driver preview for the current context when no scope is given.
pub(crate) async fn fetch_searchable_text_columns(
    driver: &std::sync::Arc<dyn crate::database::driver::DatabaseDriver>,
    database_type: DatabaseType,
    table: &str,
    db_prefix: &str,
) -> Vec<ColumnDetail> {
    if database_type == DatabaseType::MSSQL && !db_prefix.is_empty() {
        let (schema_part, name_part) = match table.split_once('.') {
            Some((s, n)) => (s.to_string(), n.to_string()),
            None => ("dbo".to_string(), table.to_string()),
        };
        if !is_safe_metadata_identifier(&schema_part) || !is_safe_metadata_identifier(&name_part) {
            return Vec::new();
        }
        let meta_sql = format!(
            "SELECT COLUMN_NAME, DATA_TYPE FROM {db_prefix}INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
            sql_string_literal(&schema_part),
            sql_string_literal(&name_part),
        );
        return match driver.execute_query(&meta_sql).await {
            Ok(meta) => {
                let name_idx = meta
                    .columns
                    .iter()
                    .position(|c| c.name == "COLUMN_NAME")
                    .unwrap_or(0);
                let type_idx = meta
                    .columns
                    .iter()
                    .position(|c| c.name == "DATA_TYPE")
                    .unwrap_or(1);
                meta.rows
                    .iter()
                    .filter_map(|row| {
                        let name = row.get(name_idx).and_then(|v| v.as_str())?.to_string();
                        let data_type = row.get(type_idx).and_then(|v| v.as_str())?.to_string();
                        Some(ColumnDetail {
                            name,
                            data_type,
                            is_nullable: true,
                            is_primary_key: false,
                            default_value: None,
                            extra: None,
                            column_type: None,
                            comment: None,
                        })
                    })
                    .collect()
            }
            Err(_) => Vec::new(),
        };
    }
    driver
        .get_table_columns_preview(table, None)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|column| is_text_like_column(&column.data_type))
        .collect()
}

#[tauri::command]
pub async fn search_table_data_multi(
    connection_id: String,
    tables: Vec<String>,
    keyword: String,
    limit: Option<u64>,
    database: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<MultiTableDataMatch>, String> {
    let needle = keyword.trim().to_string();
    if needle.is_empty() {
        return Err("Global data search requires a non-empty keyword.".to_string());
    }
    let per_table_limit = limit.unwrap_or(DEFAULT_DATA_MATCHES).min(MAX_DATA_MATCHES);
    let total_cap = 200u64;

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

    // MSSQL-only cross-database scope: prefix every object with [db].
    let scope_db = database
        .filter(|db| database_type == DatabaseType::MSSQL && is_safe_metadata_identifier(db));
    let db_prefix = match &scope_db {
        Some(db) => quote_mssql_identifier(db)
            .map(|q| format!("{q}."))
            .unwrap_or_default(),
        None => String::new(),
    };
    let db_prefix_for_tasks = std::sync::Arc::new(db_prefix);

    let tables: Vec<String> = {
        let mut list = tables;
        list.truncate(MAX_SCHEMA_TABLES_SCANNED);
        list
    };
    let semaphore = Arc::new(tokio::sync::Semaphore::new(PARALLEL_TABLE_SCANS));
    let escape_clause = like_escape_clause(database_type);
    let _ = db_prefix; // consumed via Arc in parallel tasks

    // Phase 1 (parallel): resolve searchable text columns per table. Tables
    // without text columns or with a failing preview are simply skipped.
    let mut phase1: JoinSet<(String, Vec<ColumnDetail>)> = JoinSet::new();
    for table in &tables {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        let driver = Arc::clone(&driver);
        let table = table.clone();
        let db_prefix_arc = std::sync::Arc::clone(&db_prefix_for_tasks);
        phase1.spawn(async move {
            let _permit = permit;
            let text_columns =
                fetch_searchable_text_columns(&driver, database_type, &table, &db_prefix_arc).await;
            (table, text_columns)
        });
    }
    let mut searchable: Vec<(String, Vec<ColumnDetail>)> = Vec::new();
    while let Some(joined) = phase1.join_next().await {
        if let Ok((table, text_columns)) = joined {
            if !text_columns.is_empty() {
                searchable.push((table, text_columns));
            }
        }
    }
    // Keep catalog order for stable, predictable results.
    searchable.sort_by(|a, b| {
        let ia = tables.iter().position(|t| t == &a.0).unwrap_or(usize::MAX);
        let ib = tables.iter().position(|t| t == &b.0).unwrap_or(usize::MAX);
        ia.cmp(&ib)
    });

    // Phase 2 (parallel): run the parameterized LIKE sweep per searchable table.
    let mut phase2: JoinSet<(usize, Option<MultiTableDataMatch>)> = JoinSet::new();
    for (index, (table, text_columns)) in searchable.iter().enumerate() {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        let driver = Arc::clone(&driver);
        let table = table.clone();
        let db_prefix_arc = std::sync::Arc::clone(&db_prefix_for_tasks);
        let column_names: Vec<String> = text_columns.iter().map(|c| c.name.clone()).collect();
        let needle = needle.clone();
        let escape_clause = escape_clause.to_string();
        phase2.spawn(async move {
            let _permit = permit;
            let db_prefix = std::sync::Arc::clone(&db_prefix_arc);
            let quoted_table = match quote_qualified_identifier(database_type, &table) {
                Ok(quoted) => format!("{db_prefix}{quoted}"),
                Err(error) => {
                    return (
                        index,
                        Some(MultiTableDataMatch {
                            table,
                            columns: column_names,
                            rows: Vec::new(),
                            truncated: false,
                            error: Some(error.to_string()),
                        }),
                    );
                }
            };
            let predicate = column_names
                .iter()
                .filter_map(|name| {
                    quote_qualified_identifier(database_type, name)
                        .ok()
                        .map(|quoted| format!("{quoted} LIKE :keyword {escape_clause}"))
                })
                .collect::<Vec<String>>()
                .join(" OR ");
            if predicate.is_empty() {
                return (index, None);
            }
            let sql = if database_type == DatabaseType::MSSQL {
                format!("SELECT TOP ({per_table_limit}) * FROM {quoted_table} WHERE {predicate}")
            } else {
                format!("SELECT * FROM {quoted_table} WHERE {predicate} LIMIT {per_table_limit}")
            };
            let style = placeholder_style_for_database(database_type);
            let parameters = vec![QueryParameter {
                name: "keyword".to_string(),
                value: serde_json::Value::String(escape_like_pattern(&needle, '\\')),
                data_type: QueryParameterType::Text,
            }];
            let compiled = match compile_parameterized_query(&sql, &parameters, style) {
                Ok(c) => c,
                Err(_) => return (index, None),
            };
            let result = match driver
                .execute_parameterized_query(&compiled.sql, &compiled.parameters)
                .await
            {
                Ok(result) => result,
                Err(error) => {
                    return (
                        index,
                        Some(MultiTableDataMatch {
                            table,
                            columns: column_names,
                            rows: Vec::new(),
                            truncated: false,
                            error: Some(error.to_string()),
                        }),
                    );
                }
            };
            if result.rows.is_empty() {
                return (index, None);
            }
            (
                index,
                Some(MultiTableDataMatch {
                    table,
                    columns: column_names,
                    rows: result.rows,
                    truncated: false,
                    error: None,
                }),
            )
        });
    }

    let mut slots: Vec<Option<MultiTableDataMatch>> = vec![None; searchable.len()];
    let mut total_rows = 0u64;
    while let Some(joined) = phase2.join_next().await {
        let Ok((index, match_result)) = joined else {
            continue;
        };
        let Some(match_result) = match_result else {
            continue;
        };
        if total_rows + match_result.rows.len() as u64 > total_cap {
            // Keep the group header but mark it capped instead of dropping rows
            // over budget.
            slots[index] = Some(MultiTableDataMatch {
                truncated: true,
                rows: Vec::new(),
                ..match_result
            });
            continue;
        }
        total_rows += match_result.rows.len() as u64;
        slots[index] = Some(match_result);
    }
    Ok(slots.into_iter().flatten().collect())
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
    // A table with no text columns simply has nothing to match — return an
    // empty result instead of an error so the UI stays consistent with the
    // multi-table sweep (which silently skips such tables).
    if text_columns.is_empty() {
        return Ok(crate::database::models::QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: 0,
            execution_time_ms: 0,
            query: String::new(),
            sandboxed: false,
            truncated: false,
        });
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
