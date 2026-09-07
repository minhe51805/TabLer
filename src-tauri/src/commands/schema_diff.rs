//! Schema diff & migration generation (roadmap Phase 2A).
//!
//! `compare_schemas` walks both connections' catalogs (tables + columns) and
//! produces an ordered diff; `generate_migration_script` turns that diff into
//! dialect-aware DDL (CREATE/ALTER/DROP). Types are carried verbatim from the
//! connection they were read from — cross-engine type mapping is surfaced to
//! the user in the generated script header rather than guessed silently.

use crate::database::manager::DatabaseManager;
use crate::database::models::{ColumnDetail, DatabaseType};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

const DEFAULT_MAX_TABLES: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnChange {
    pub name: String,
    /// `"added" | "removed" | "modified"`.
    pub change: String,
    pub source_type: Option<String>,
    pub target_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDiff {
    pub table: String,
    pub schema: Option<String>,
    /// `"added" | "removed" | "modified"`.
    pub change: String,
    pub columns: Vec<ColumnChange>,
    /// Full column list of the side where the table exists (target for added,
    /// source for removed, source side for modified).
    pub source_columns: Vec<ColumnDetail>,
    pub target_columns: Vec<ColumnDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffSummary {
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
    pub unchanged: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffResult {
    pub summary: SchemaDiffSummary,
    pub tables: Vec<TableDiff>,
}

fn qualified_name(table: &crate::database::models::TableInfo) -> String {
    match &table.schema {
        Some(schema) if !schema.is_empty() => format!("{}.{}", schema, table.name),
        _ => table.name.clone(),
    }
}

/// Compares column lists and returns per-column changes for common tables.
pub fn diff_columns(source: &[ColumnDetail], target: &[ColumnDetail]) -> Vec<ColumnChange> {
    let source_by_name: HashMap<&str, &ColumnDetail> =
        source.iter().map(|c| (c.name.as_str(), c)).collect();
    let target_by_name: HashMap<&str, &ColumnDetail> =
        target.iter().map(|c| (c.name.as_str(), c)).collect();

    let mut changes = Vec::new();
    for column in source {
        if !target_by_name.contains_key(column.name.as_str()) {
            changes.push(ColumnChange {
                name: column.name.clone(),
                change: "removed".to_string(),
                source_type: Some(column.data_type.clone()),
                target_type: None,
            });
        }
    }
    for column in target {
        match source_by_name.get(column.name.as_str()) {
            None => changes.push(ColumnChange {
                name: column.name.clone(),
                change: "added".to_string(),
                source_type: None,
                target_type: Some(column.data_type.clone()),
            }),
            Some(existing) => {
                if existing.data_type != column.data_type
                    || existing.is_nullable != column.is_nullable
                    || existing.is_primary_key != column.is_primary_key
                {
                    changes.push(ColumnChange {
                        name: column.name.clone(),
                        change: "modified".to_string(),
                        source_type: Some(existing.data_type.clone()),
                        target_type: Some(column.data_type.clone()),
                    });
                }
            }
        }
    }
    changes
}

#[tauri::command]
pub async fn compare_schemas(
    connection_a: String,
    connection_b: String,
    database_a: Option<String>,
    database_b: Option<String>,
    max_tables: Option<usize>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<SchemaDiffResult, String> {
    let driver_a = db_manager
        .get_driver(&connection_a)
        .await
        .map_err(|error| error.to_string())?;
    let driver_b = db_manager
        .get_driver(&connection_b)
        .await
        .map_err(|error| error.to_string())?;

    let cap = max_tables.unwrap_or(DEFAULT_MAX_TABLES).min(1_000);
    let tables_a = driver_a
        .list_tables(database_a.as_deref())
        .await
        .map_err(|error| error.to_string())?;
    let tables_b = driver_b
        .list_tables(database_b.as_deref())
        .await
        .map_err(|error| error.to_string())?;

    let mut source_by_name: HashMap<String, crate::database::models::TableInfo> = HashMap::new();
    for table in tables_a.iter().take(cap) {
        source_by_name.insert(qualified_name(table), table.clone());
    }

    let mut tables: Vec<TableDiff> = Vec::new();
    let mut added = 0usize;
    let mut removed = 0usize;
    let mut modified = 0usize;
    let mut unchanged = 0usize;
    let mut truncated = false;
    let mut common_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    for table in tables_b.iter().take(cap) {
        if tables.len() >= cap {
            truncated = true;
            break;
        }
        let name = qualified_name(table);
        match source_by_name.get(&name) {
            None => {
                added += 1;
                let target_columns = driver_b
                    .get_table_columns_preview(&table.name, database_b.as_deref())
                    .await
                    .unwrap_or_default();
                tables.push(TableDiff {
                    table: table.name.clone(),
                    schema: table.schema.clone(),
                    change: "added".to_string(),
                    columns: target_columns
                        .iter()
                        .map(|column| ColumnChange {
                            name: column.name.clone(),
                            change: "added".to_string(),
                            source_type: None,
                            target_type: Some(column.data_type.clone()),
                        })
                        .collect(),
                    source_columns: Vec::new(),
                    target_columns,
                });
            }
            Some(source_table) => {
                common_names.insert(name);
                let source_columns = driver_a
                    .get_table_columns_preview(&source_table.name, database_a.as_deref())
                    .await
                    .unwrap_or_default();
                let target_columns = driver_b
                    .get_table_columns_preview(&table.name, database_b.as_deref())
                    .await
                    .unwrap_or_default();
                let columns = diff_columns(&source_columns, &target_columns);
                if columns.is_empty() {
                    unchanged += 1;
                } else {
                    modified += 1;
                    tables.push(TableDiff {
                        table: table.name.clone(),
                        schema: table.schema.clone(),
                        change: "modified".to_string(),
                        columns,
                        source_columns,
                        target_columns,
                    });
                }
            }
        }
    }
    for table in tables_a.iter().take(cap) {
        let name = qualified_name(table);
        if common_names.contains(&name) {
            continue;
        }
        removed += 1;
        if tables.len() >= cap {
            truncated = true;
            break;
        }
        let source_columns = driver_a
            .get_table_columns_preview(&table.name, database_a.as_deref())
            .await
            .unwrap_or_default();
        tables.push(TableDiff {
            table: table.name.clone(),
            schema: table.schema.clone(),
            change: "removed".to_string(),
            columns: source_columns
                .iter()
                .map(|column| ColumnChange {
                    name: column.name.clone(),
                    change: "removed".to_string(),
                    source_type: Some(column.data_type.clone()),
                    target_type: None,
                })
                .collect(),
            source_columns,
            target_columns: Vec::new(),
        });
    }

    Ok(SchemaDiffResult {
        summary: SchemaDiffSummary {
            added,
            removed,
            modified,
            unchanged,
            truncated,
        },
        tables,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationOptions {
    /// Target engine key, e.g. `"postgresql"`, `"mysql"`, `"mssql"`, `"sqlite"`.
    pub dialect: String,
    /// Include `DROP TABLE` for removed tables (default false — destructive).
    #[serde(default)]
    pub include_drops: bool,
}

pub(crate) fn parse_dialect(dialect: &str) -> anyhow::Result<DatabaseType> {
    let parsed = match dialect.trim().to_lowercase().as_str() {
        "postgresql" | "postgres" => DatabaseType::PostgreSQL,
        "cockroachdb" | "cockroach" => DatabaseType::CockroachDB,
        "greenplum" => DatabaseType::Greenplum,
        "redshift" => DatabaseType::Redshift,
        "vertica" => DatabaseType::Vertica,
        "mysql" => DatabaseType::MySQL,
        "mariadb" => DatabaseType::MariaDB,
        "mssql" | "sqlserver" => DatabaseType::MSSQL,
        "sqlite" => DatabaseType::SQLite,
        "duckdb" => DatabaseType::DuckDB,
        "libsql" => DatabaseType::LibSQL,
        "cloudflare_d1" | "cloudflared1" => DatabaseType::CloudflareD1,
        "clickhouse" => DatabaseType::ClickHouse,
        "snowflake" => DatabaseType::Snowflake,
        "bigquery" => DatabaseType::BigQuery,
        "cassandra" => DatabaseType::Cassandra,
        other => return Err(anyhow::anyhow!("Unsupported migration dialect: {other}")),
    };
    Ok(parsed)
}

fn alter_column_clause(
    dialect: DatabaseType,
    table_sql: &str,
    name_sql: &str,
    column: &ColumnDetail,
) -> Option<String> {
    let type_sql = &column.data_type;
    let null_sql = if column.is_nullable { "" } else { " NOT NULL" };
    match dialect {
        DatabaseType::MySQL | DatabaseType::MariaDB => Some(format!(
            "ALTER TABLE {table_sql} MODIFY COLUMN {name_sql} {type_sql}{null_sql};"
        )),
        DatabaseType::PostgreSQL
        | DatabaseType::CockroachDB
        | DatabaseType::Greenplum
        | DatabaseType::Redshift => Some(format!(
            "ALTER TABLE {table_sql} ALTER COLUMN {name_sql} TYPE {type_sql};"
        )),
        DatabaseType::MSSQL => Some(format!(
            "ALTER TABLE {table_sql} ALTER COLUMN {name_sql} {type_sql}{null_sql};"
        )),
        DatabaseType::SQLite
        | DatabaseType::DuckDB
        | DatabaseType::LibSQL
        | DatabaseType::CloudflareD1 => Some(format!(
            "-- NOTE: this engine does not support ALTER COLUMN; recreate the table to change {name_sql}."
        )),
        _ => None,
    }
}

fn create_table_statement(
    dialect: DatabaseType,
    table_sql: &str,
    columns: &[ColumnDetail],
) -> anyhow::Result<String> {
    use crate::commands::search::quote_qualified_identifier;
    let defs: anyhow::Result<Vec<String>> = columns
        .iter()
        .map(|column| {
            let name_sql = quote_qualified_identifier(dialect, &column.name)?;
            let mut parts = vec![name_sql, column.data_type.clone()];
            if column.is_primary_key {
                parts.push("PRIMARY KEY".to_string());
            } else if !column.is_nullable {
                parts.push("NOT NULL".to_string());
            }
            if let Some(default) = &column.default_value {
                if !default.trim().is_empty() {
                    parts.push(format!("DEFAULT {default}"));
                }
            }
            Ok(parts.join(" "))
        })
        .collect();
    Ok(format!(
        "CREATE TABLE {table_sql} (\n  {},\n);\n",
        defs?.join(",\n  ")
    ))
}

/// Generates DDL applying the diff to the source connection so it matches the
/// target. Types are copied verbatim from the target-side column definitions.
pub fn build_migration_script(
    diff: &SchemaDiffResult,
    dialect: DatabaseType,
    include_drops: bool,
) -> anyhow::Result<String> {
    use crate::commands::search::quote_qualified_identifier;
    let mut script = String::from(
        "-- Generated by TableR Schema Diff.\n\
         -- WARNING: review before running. Column types are copied verbatim from\n\
         -- the target connection; cross-engine types may need manual adjustment.\n\n",
    );

    for table in &diff.tables {
        let qualified = match &table.schema {
            Some(schema) if !schema.is_empty() => format!("{}.{}", schema, table.table),
            _ => table.table.clone(),
        };
        let table_sql = quote_qualified_identifier(dialect, &qualified)?;
        match table.change.as_str() {
            "added" => {
                script.push_str(&create_table_statement(
                    dialect,
                    &table_sql,
                    &table.target_columns,
                )?);
                script.push('\n');
            }
            "removed" => {
                if include_drops {
                    script.push_str(&format!("DROP TABLE {table_sql};\n\n"));
                } else {
                    script.push_str(&format!(
                        "-- Skipped DROP TABLE {table_sql} (includeDrops is off).\n\n"
                    ));
                }
            }
            "modified" => {
                for change in &table.columns {
                    let name_sql = quote_qualified_identifier(dialect, &change.name)?;
                    match change.change.as_str() {
                        "added" => {
                            if let Some(column) =
                                table.target_columns.iter().find(|c| c.name == change.name)
                            {
                                let null_sql = if column.is_nullable { "" } else { " NOT NULL" };
                                let default_sql = column
                                    .default_value
                                    .as_deref()
                                    .filter(|value| !value.trim().is_empty())
                                    .map(|value| format!(" DEFAULT {value}"))
                                    .unwrap_or_default();
                                script.push_str(&format!(
                                    "ALTER TABLE {table_sql} ADD COLUMN {name_sql} {}{null_sql}{default_sql};\n",
                                    column.data_type
                                ));
                            }
                        }
                        "removed" => {
                            script.push_str(&format!(
                                "ALTER TABLE {table_sql} DROP COLUMN {name_sql};\n"
                            ));
                        }
                        "modified" => {
                            if let Some(column) =
                                table.target_columns.iter().find(|c| c.name == change.name)
                            {
                                if let Some(statement) =
                                    alter_column_clause(dialect, &table_sql, &name_sql, column)
                                {
                                    script.push_str(&statement);
                                    script.push('\n');
                                }
                            }
                        }
                        _ => {}
                    }
                }
                script.push('\n');
            }
            _ => {}
        }
    }
    Ok(script)
}

#[tauri::command]
pub async fn generate_migration_script(
    diff: SchemaDiffResult,
    options: MigrationOptions,
) -> Result<String, String> {
    let dialect = parse_dialect(&options.dialect).map_err(|error| error.to_string())?;
    build_migration_script(&diff, dialect, options.include_drops).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        build_migration_script, diff_columns, SchemaDiffResult, SchemaDiffSummary, TableDiff,
    };
    use crate::database::models::{ColumnDetail, DatabaseType};

    fn column(name: &str, data_type: &str, nullable: bool, pk: bool) -> ColumnDetail {
        ColumnDetail {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: nullable,
            is_primary_key: pk,
            default_value: None,
            extra: None,
            column_type: None,
            comment: None,
        }
    }

    #[test]
    fn diff_columns_reports_added_removed_and_modified() {
        let source = vec![
            column("id", "int", false, true),
            column("old_col", "text", true, false),
        ];
        let target = vec![
            column("id", "bigint", false, true),
            column("new_col", "text", true, false),
        ];
        let changes = diff_columns(&source, &target);
        let by_name: std::collections::HashMap<String, String> = changes
            .iter()
            .map(|change| (change.name.clone(), change.change.clone()))
            .collect();
        assert_eq!(by_name.get("old_col").unwrap(), "removed");
        assert_eq!(by_name.get("new_col").unwrap(), "added");
        assert_eq!(by_name.get("id").unwrap(), "modified");
    }

    #[test]
    fn identical_columns_produce_no_changes() {
        let source = vec![column("id", "int", false, true)];
        assert!(diff_columns(&source, &source).is_empty());
    }

    fn diff_with(added: Option<&str>, removed: Option<&str>) -> SchemaDiffResult {
        let mut tables = Vec::new();
        if let Some(name) = added {
            tables.push(TableDiff {
                table: name.to_string(),
                schema: Some("public".to_string()),
                change: "added".to_string(),
                columns: Vec::new(),
                source_columns: Vec::new(),
                target_columns: vec![column("id", "int", false, true)],
            });
        }
        if let Some(name) = removed {
            tables.push(TableDiff {
                table: name.to_string(),
                schema: Some("public".to_string()),
                change: "removed".to_string(),
                columns: Vec::new(),
                source_columns: vec![column("id", "int", false, true)],
                target_columns: Vec::new(),
            });
        }
        SchemaDiffResult {
            summary: SchemaDiffSummary {
                added: usize::from(added.is_some()),
                removed: usize::from(removed.is_some()),
                modified: 0,
                unchanged: 0,
                truncated: false,
            },
            tables,
        }
    }

    #[test]
    fn migration_script_creates_added_tables_and_gates_drops() {
        let diff = diff_with(Some("new_table"), Some("old_table"));
        let keep = build_migration_script(&diff, DatabaseType::PostgreSQL, false).unwrap();
        assert!(keep.contains("CREATE TABLE \"public\".\"new_table\""));
        assert!(keep.contains("Skipped DROP TABLE"));
        assert!(!keep.contains("DROP TABLE \"public\".\"old_table\";"));

        let drop = build_migration_script(&diff, DatabaseType::PostgreSQL, true).unwrap();
        assert!(drop.contains("DROP TABLE \"public\".\"old_table\";"));
    }
}
