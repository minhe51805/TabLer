use super::export_support::*;
use crate::database::capabilities::DriverCapability;
use crate::database::driver::DatabaseDriver;
use crate::database::manager::DatabaseManager;
use crate::database::models::{DatabaseType, SchemaObjectInfo, TableInfo, TableStructure};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::fs;
use tauri::State;
use tokio::task;
use tokio::time::Duration;

pub(super) const EXPORT_METADATA_TIMEOUT: Duration = Duration::from_secs(120);
pub(super) const EXPORT_BATCH_TIMEOUT: Duration = Duration::from_secs(300);
pub(super) const EXPORT_BATCH_SIZE: u64 = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseExportResult {
    pub file_path: String,
    pub format: String,
    pub table_count: usize,
    pub row_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DatabaseExportFormat {
    Sql,
    JsonSnapshot,
}

#[derive(Debug, Clone)]
pub(super) struct ExportTableBundle {
    pub(super) info: TableInfo,
    pub(super) identifier: String,
    pub(super) structure: TableStructure,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DatabaseExportSnapshot {
    pub(super) meta: DatabaseExportSnapshotMeta,
    pub(super) schema_objects: Vec<SchemaObjectInfo>,
    pub(super) tables: Vec<DatabaseExportSnapshotTable>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DatabaseExportSnapshotMeta {
    pub(super) exported_at: String,
    pub(super) engine: String,
    pub(super) database: Option<String>,
    pub(super) format: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DatabaseExportSnapshotTable {
    pub(super) name: String,
    pub(super) schema: Option<String>,
    pub(super) table_type: String,
    pub(super) structure: TableStructure,
    pub(super) rows: Vec<JsonMap<String, JsonValue>>,
}

pub(super) struct SqlExportPayload {
    pub(super) content: String,
    pub(super) table_count: usize,
    pub(super) row_count: u64,
}

#[tauri::command]
pub async fn export_database(
    connection_id: String,
    database: Option<String>,
    db_type: DatabaseType,
    connection_name: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<DatabaseExportResult, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::DataExport)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    let driver_ref: &dyn DatabaseDriver = &*driver;

    let requested_database = database
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let resolved_database = requested_database
        .clone()
        .or_else(|| driver_ref.current_database())
        .filter(|value| !value.trim().is_empty());

    let export_format = preferred_export_format(db_type);
    let suggested_name = build_export_filename(
        connection_name.as_deref(),
        resolved_database.as_deref(),
        db_type,
        export_format,
    );
    let target_path = open_export_save_dialog(&suggested_name, export_format)?;

    let (content, table_count, row_count) = match export_format {
        DatabaseExportFormat::Sql => {
            let content = build_sql_export(driver_ref, resolved_database.as_deref(), db_type)
                .await
                .map_err(|error| error.to_string())?;
            (content.content, content.table_count, content.row_count)
        }
        DatabaseExportFormat::JsonSnapshot => {
            let content = build_json_snapshot(driver_ref, resolved_database.as_deref())
                .await
                .map_err(|error| error.to_string())?;
            let row_count = content
                .tables
                .iter()
                .map(|table| table.rows.len() as u64)
                .sum::<u64>();
            let table_count = content.tables.len();
            (
                serde_json::to_string_pretty(&content)
                    .context("Failed to serialize the export snapshot")
                    .map_err(|error| error.to_string())?,
                table_count,
                row_count,
            )
        }
    };

    let target_path_for_write = target_path.clone();
    task::spawn_blocking(move || fs::write(&target_path_for_write, content))
        .await
        .map_err(|_| "Database export write task failed unexpectedly.".to_string())?
        .with_context(|| format!("Failed to write export file '{}'", target_path.display()))
        .map_err(|error| error.to_string())?;

    Ok(DatabaseExportResult {
        file_path: target_path.to_string_lossy().to_string(),
        format: match export_format {
            DatabaseExportFormat::Sql => "sql".to_string(),
            DatabaseExportFormat::JsonSnapshot => "json".to_string(),
        },
        table_count,
        row_count,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_create_table_statement, build_export_filename, build_insert_statement_batch,
        ensure_trailing_semicolon, preferred_export_format, DatabaseExportFormat,
    };
    use crate::database::models::{
        ColumnDetail, ColumnInfo, DatabaseType, ForeignKeyInfo, IndexInfo, TableInfo,
        TableStructure,
    };
    use serde_json::json;

    fn sample_structure() -> TableStructure {
        TableStructure {
            columns: vec![
                ColumnDetail {
                    name: "id".to_string(),
                    data_type: "INTEGER".to_string(),
                    is_nullable: false,
                    is_primary_key: true,
                    default_value: None,
                    extra: None,
                    column_type: Some("INTEGER".to_string()),
                    comment: None,
                },
                ColumnDetail {
                    name: "name".to_string(),
                    data_type: "TEXT".to_string(),
                    is_nullable: false,
                    is_primary_key: false,
                    default_value: Some("'unknown'".to_string()),
                    extra: None,
                    column_type: Some("TEXT".to_string()),
                    comment: None,
                },
            ],
            indexes: vec![IndexInfo {
                name: "idx_people_name".to_string(),
                columns: vec!["name".to_string()],
                is_unique: false,
                index_type: None,
            }],
            foreign_keys: vec![ForeignKeyInfo {
                name: "fk_people_team".to_string(),
                column: "id".to_string(),
                referenced_table: "teams".to_string(),
                referenced_column: "id".to_string(),
                on_update: Some("CASCADE".to_string()),
                on_delete: Some("CASCADE".to_string()),
            }],
            triggers: Vec::new(),
            view_definition: None,
            object_type: Some("TABLE".to_string()),
        }
    }

    #[test]
    fn creates_sqlite_table_with_inline_foreign_key() {
        let table = TableInfo {
            name: "people".to_string(),
            schema: None,
            table_type: "TABLE".to_string(),
            row_count: None,
            engine: None,
            create_date: None,
        };
        let sql =
            build_create_table_statement(DatabaseType::SQLite, &table, &sample_structure(), None)
                .unwrap();

        assert!(sql.contains("CREATE TABLE IF NOT EXISTS"));
        assert!(sql.contains("PRIMARY KEY"));
        assert!(sql.contains("FOREIGN KEY"));
    }

    #[test]
    fn builds_insert_batch_with_escaped_values() {
        let sql = build_insert_statement_batch(
            DatabaseType::PostgreSQL,
            "\"people\"",
            &[
                ColumnInfo {
                    name: "id".to_string(),
                    data_type: "INTEGER".to_string(),
                    is_nullable: false,
                    is_primary_key: true,
                    max_length: None,
                    default_value: None,
                },
                ColumnInfo {
                    name: "name".to_string(),
                    data_type: "TEXT".to_string(),
                    is_nullable: false,
                    is_primary_key: false,
                    max_length: None,
                    default_value: None,
                },
            ],
            &[vec![json!(1), json!("O'Brien")]],
        )
        .unwrap();

        assert!(sql.contains("INSERT INTO"));
        assert!(sql.contains("'O''Brien'"));
    }

    #[test]
    fn ensures_trailing_semicolon_when_missing() {
        assert_eq!(
            ensure_trailing_semicolon("CREATE VIEW demo"),
            "CREATE VIEW demo;"
        );
        assert_eq!(
            ensure_trailing_semicolon("CREATE VIEW demo;"),
            "CREATE VIEW demo;"
        );
    }

    #[test]
    fn builds_export_filename_with_database_first() {
        let filename = build_export_filename(
            Some("Main Workspace"),
            Some("identity-service"),
            DatabaseType::PostgreSQL,
            DatabaseExportFormat::Sql,
        );

        assert!(filename.starts_with("identity-service_"));
        assert!(filename.ends_with(".sql"));
    }

    #[test]
    fn opensearch_exports_a_json_snapshot_instead_of_sql() {
        assert_eq!(
            preferred_export_format(DatabaseType::OpenSearch),
            DatabaseExportFormat::JsonSnapshot
        );
    }
}
