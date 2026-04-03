use crate::database::driver::DatabaseDriver;
use crate::database::manager::DatabaseManager;
use crate::database::models::{
    ColumnDetail, ColumnInfo, DatabaseType, ForeignKeyInfo, SchemaObjectInfo, TableInfo,
    TableStructure,
};
use crate::database::safety::{
    quote_bigquery_identifier, quote_cassandra_identifier, quote_clickhouse_identifier,
    quote_mssql_identifier, quote_mysql_identifier, quote_postgres_identifier,
    quote_snowflake_identifier, quote_sqlite_identifier,
};
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rfd::FileDialog;
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use tauri::State;
use tokio::task;
use tokio::time::{timeout, Duration};

const EXPORT_METADATA_TIMEOUT: Duration = Duration::from_secs(120);
const EXPORT_BATCH_TIMEOUT: Duration = Duration::from_secs(300);
const EXPORT_BATCH_SIZE: u64 = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseExportResult {
    pub file_path: String,
    pub format: String,
    pub table_count: usize,
    pub row_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DatabaseExportFormat {
    Sql,
    JsonSnapshot,
}

#[derive(Debug, Clone)]
struct ExportTableBundle {
    info: TableInfo,
    identifier: String,
    structure: TableStructure,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseExportSnapshot {
    meta: DatabaseExportSnapshotMeta,
    schema_objects: Vec<SchemaObjectInfo>,
    tables: Vec<DatabaseExportSnapshotTable>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseExportSnapshotMeta {
    exported_at: String,
    engine: String,
    database: Option<String>,
    format: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseExportSnapshotTable {
    name: String,
    schema: Option<String>,
    table_type: String,
    structure: TableStructure,
    rows: Vec<JsonMap<String, JsonValue>>,
}

struct SqlExportPayload {
    content: String,
    table_count: usize,
    row_count: u64,
}

#[tauri::command]
pub async fn export_database(
    connection_id: String,
    database: Option<String>,
    db_type: DatabaseType,
    connection_name: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<DatabaseExportResult, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    let driver_ref: &dyn DatabaseDriver = &**driver;

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

fn preferred_export_format(db_type: DatabaseType) -> DatabaseExportFormat {
    match db_type {
        DatabaseType::Redis | DatabaseType::MongoDB | DatabaseType::Cassandra => {
            DatabaseExportFormat::JsonSnapshot
        }
        _ => DatabaseExportFormat::Sql,
    }
}

fn open_export_save_dialog(
    suggested_name: &str,
    export_format: DatabaseExportFormat,
) -> Result<PathBuf, String> {
    let starting_dir = dirs::download_dir()
        .or_else(dirs::document_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut dialog = FileDialog::new()
        .set_directory(starting_dir)
        .set_file_name(suggested_name);

    dialog = match export_format {
        DatabaseExportFormat::Sql => dialog.add_filter("SQL dump", &["sql"]),
        DatabaseExportFormat::JsonSnapshot => dialog.add_filter("JSON snapshot", &["json"]),
    };

    dialog
        .save_file()
        .ok_or_else(|| "No file selected.".to_string())
}

fn build_export_filename(
    connection_name: Option<&str>,
    database: Option<&str>,
    db_type: DatabaseType,
    export_format: DatabaseExportFormat,
) -> String {
    let base = database
        .and_then(|value| sanitized_filename_segment(value).filter(|candidate| !candidate.is_empty()))
        .or_else(|| {
            connection_name
                .and_then(sanitized_filename_segment)
                .filter(|candidate| !candidate.is_empty())
        })
        .unwrap_or_else(|| format!("{db_type:?}").to_ascii_lowercase());
    let date = Utc::now().format("%Y-%m-%d");
    let extension = match export_format {
        DatabaseExportFormat::Sql => "sql",
        DatabaseExportFormat::JsonSnapshot => "json",
    };
    format!("{base}_{date}.{extension}")
}

fn sanitized_filename_segment(input: &str) -> Option<String> {
    let candidate = input
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else if matches!(ch, ' ' | '-' | '_' | '.') {
                '-'
            } else {
                '_'
            }
        })
        .collect::<String>();
    let compact = candidate
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    (!compact.is_empty()).then_some(compact)
}

async fn build_sql_export(
    driver: &dyn DatabaseDriver,
    database: Option<&str>,
    db_type: DatabaseType,
) -> Result<SqlExportPayload> {
    let table_bundles = collect_export_tables(driver, database).await?;
    let ordered_tables = order_tables_for_export(&table_bundles);
    let schema_objects = timeout(EXPORT_METADATA_TIMEOUT, driver.list_schema_objects(database))
        .await
        .context("Listing schema objects timed out during export")??;

    let mut output = String::new();
    output.push_str("-- TableR database export\n");
    output.push_str(&format!("-- Engine: {:?}\n", db_type));
    if let Some(database_name) = database.filter(|value| !value.trim().is_empty()) {
        output.push_str(&format!("-- Database: {}\n", database_name.trim()));
    }
    output.push_str(&format!(
        "-- Exported at: {}\n\n",
        Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    ));
    output.push_str(&database_export_preamble(db_type));

    for bundle in &ordered_tables {
        output.push_str(&build_create_table_statement(
            db_type,
            &bundle.info,
            &bundle.structure,
            database,
        )?);
        output.push_str("\n\n");
    }

    let mut total_rows = 0_u64;
    for bundle in &ordered_tables {
        let table_ref = qualify_name(db_type, &bundle.identifier, database)?;
        let mut offset = 0_u64;

        loop {
            let batch = timeout(
                EXPORT_BATCH_TIMEOUT,
                driver.get_table_data(
                    &bundle.identifier,
                    database,
                    offset,
                    EXPORT_BATCH_SIZE,
                    None,
                    None,
                    None,
                ),
            )
            .await
            .with_context(|| format!("Exporting rows from '{}' timed out", bundle.identifier))??;

            if batch.rows.is_empty() {
                break;
            }

            output.push_str(&build_insert_statement_batch(
                db_type,
                &table_ref,
                &batch.columns,
                &batch.rows,
            )?);
            output.push('\n');

            total_rows += batch.rows.len() as u64;
            offset += batch.rows.len() as u64;

            if (batch.rows.len() as u64) < EXPORT_BATCH_SIZE {
                break;
            }
        }
    }

    for bundle in &ordered_tables {
        for statement in build_index_statements(db_type, &bundle.info, &bundle.structure, database)? {
            output.push_str(&statement);
            output.push('\n');
        }

        for statement in
            build_foreign_key_statements(db_type, &bundle.info, &bundle.structure, database)?
        {
            output.push_str(&statement);
            output.push('\n');
        }
    }

    if !schema_objects.is_empty() {
        output.push('\n');
        output.push_str("-- Schema objects\n\n");

        for object in &schema_objects {
            if let Some(statement) = normalize_schema_object_sql(db_type, object, database)? {
                output.push_str(&statement);
                output.push_str("\n\n");
            }
        }
    }

    output.push_str(&database_export_postamble(db_type));

    Ok(SqlExportPayload {
        content: output,
        table_count: ordered_tables.len(),
        row_count: total_rows,
    })
}

async fn build_json_snapshot(
    driver: &dyn DatabaseDriver,
    database: Option<&str>,
) -> Result<DatabaseExportSnapshot> {
    let table_bundles = collect_export_tables(driver, database).await?;
    let schema_objects = timeout(EXPORT_METADATA_TIMEOUT, driver.list_schema_objects(database))
        .await
        .context("Listing schema objects timed out during export")??;
    let engine = driver.driver_name().to_string();

    let mut snapshot_tables = Vec::with_capacity(table_bundles.len());
    for bundle in table_bundles {
        let mut rows = Vec::new();
        let mut offset = 0_u64;

        loop {
            let batch = timeout(
                EXPORT_BATCH_TIMEOUT,
                driver.get_table_data(
                    &bundle.identifier,
                    database,
                    offset,
                    EXPORT_BATCH_SIZE,
                    None,
                    None,
                    None,
                ),
            )
            .await
            .with_context(|| format!("Exporting rows from '{}' timed out", bundle.identifier))??;

            if batch.rows.is_empty() {
                break;
            }

            rows.extend(batch.rows.iter().map(|row| row_to_object(&batch.columns, row)));
            offset += batch.rows.len() as u64;

            if (batch.rows.len() as u64) < EXPORT_BATCH_SIZE {
                break;
            }
        }

        snapshot_tables.push(DatabaseExportSnapshotTable {
            name: bundle.info.name,
            schema: bundle.info.schema,
            table_type: bundle.info.table_type,
            structure: bundle.structure,
            rows,
        });
    }

    Ok(DatabaseExportSnapshot {
        meta: DatabaseExportSnapshotMeta {
            exported_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            engine,
            database: database.map(str::to_string),
            format: "json-snapshot".to_string(),
        },
        schema_objects,
        tables: snapshot_tables,
    })
}

async fn collect_export_tables(
    driver: &dyn DatabaseDriver,
    database: Option<&str>,
) -> Result<Vec<ExportTableBundle>> {
    let tables = timeout(EXPORT_METADATA_TIMEOUT, driver.list_tables(database))
        .await
        .context("Listing tables timed out during export")??;

    let filtered_tables = tables
        .into_iter()
        .filter(is_exportable_table)
        .collect::<Vec<_>>();

    let mut bundles = Vec::with_capacity(filtered_tables.len());
    for table in filtered_tables {
        let identifier = table_identifier(&table);
        let structure = timeout(
            EXPORT_METADATA_TIMEOUT,
            driver.get_table_structure(&identifier, database),
        )
        .await
        .with_context(|| format!("Loading table structure for '{}' timed out", identifier))??;

        bundles.push(ExportTableBundle {
            info: table,
            identifier,
            structure,
        });
    }

    Ok(bundles)
}

fn is_exportable_table(table: &TableInfo) -> bool {
    let normalized = table.table_type.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return true;
    }

    !normalized.contains("view")
}

fn table_identifier(table: &TableInfo) -> String {
    match table
        .schema
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(schema) => format!("{schema}.{}", table.name.trim()),
        None => table.name.trim().to_string(),
    }
}

fn order_tables_for_export<'a>(tables: &'a [ExportTableBundle]) -> Vec<&'a ExportTableBundle> {
    let table_names = tables
        .iter()
        .map(|bundle| bundle.identifier.clone())
        .collect::<BTreeSet<_>>();
    let name_to_index = tables
        .iter()
        .enumerate()
        .map(|(index, bundle)| (bundle.identifier.clone(), index))
        .collect::<BTreeMap<_, _>>();
    let dependency_graph = tables
        .iter()
        .map(|bundle| {
            bundle
                .structure
                .foreign_keys
                .iter()
                .map(|foreign_key| normalize_referenced_table_name(&bundle.info, foreign_key))
                .filter(|dependency| dependency != &bundle.identifier && table_names.contains(dependency))
                .collect::<BTreeSet<_>>()
        })
        .collect::<Vec<_>>();

    let mut in_degree = dependency_graph.iter().map(BTreeSet::len).collect::<Vec<_>>();
    let mut dependents = vec![Vec::<usize>::new(); tables.len()];

    for (table_index, dependencies) in dependency_graph.iter().enumerate() {
        for dependency in dependencies {
            if let Some(dependency_index) = name_to_index.get(dependency) {
                dependents[*dependency_index].push(table_index);
            }
        }
    }

    let mut queue = VecDeque::new();
    for (index, degree) in in_degree.iter().enumerate() {
        if *degree == 0 {
            queue.push_back(index);
        }
    }

    let mut ordered_indices = Vec::with_capacity(tables.len());
    let mut seen = BTreeSet::new();

    while let Some(index) = queue.pop_front() {
        if !seen.insert(index) {
            continue;
        }

        ordered_indices.push(index);
        for dependent_index in &dependents[index] {
            if in_degree[*dependent_index] > 0 {
                in_degree[*dependent_index] -= 1;
                if in_degree[*dependent_index] == 0 {
                    queue.push_back(*dependent_index);
                }
            }
        }
    }

    if ordered_indices.len() != tables.len() {
        for index in 0..tables.len() {
            if seen.insert(index) {
                ordered_indices.push(index);
            }
        }
    }

    ordered_indices
        .into_iter()
        .filter_map(|index| tables.get(index))
        .collect()
}

fn normalize_referenced_table_name(table: &TableInfo, foreign_key: &ForeignKeyInfo) -> String {
    let referenced = foreign_key.referenced_table.trim();
    if referenced.contains('.') {
        referenced.to_string()
    } else if let Some(schema) = table
        .schema
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        format!("{schema}.{referenced}")
    } else {
        referenced.to_string()
    }
}

fn build_create_table_statement(
    db_type: DatabaseType,
    table: &TableInfo,
    structure: &TableStructure,
    database: Option<&str>,
) -> Result<String> {
    let table_ref = qualify_name(db_type, &table_identifier(table), database)?;
    let mut definitions = structure
        .columns
        .iter()
        .map(|column| build_column_definition(db_type, column))
        .collect::<Result<Vec<_>>>()?;

    let primary_keys = structure
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| quote_identifier_for(db_type, &column.name))
        .collect::<Result<Vec<_>>>()?;

    if !primary_keys.is_empty() {
        definitions.push(format!("  PRIMARY KEY ({})", primary_keys.join(", ")));
    }

    if should_inline_foreign_keys(db_type) {
        for foreign_key in &structure.foreign_keys {
            definitions.push(build_inline_foreign_key_clause(db_type, table, foreign_key, database)?);
        }
    }

    Ok(format!(
        "CREATE TABLE IF NOT EXISTS {table_ref} (\n{}\n);",
        definitions.join(",\n")
    ))
}

fn build_column_definition(db_type: DatabaseType, column: &ColumnDetail) -> Result<String> {
    let mut parts = vec![
        quote_identifier_for(db_type, &column.name)?,
        normalized_column_type(column),
    ];

    if let Some(default_value) = column
        .default_value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("DEFAULT {default_value}"));
    }

    if column.is_primary_key || !column.is_nullable {
        parts.push("NOT NULL".to_string());
    }

    if let Some(extra) = column
        .extra
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "-")
    {
        parts.push(extra.to_string());
    }

    Ok(format!("  {}", parts.join(" ")))
}

fn normalized_column_type(column: &ColumnDetail) -> String {
    column
        .column_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| column.data_type.trim())
        .to_string()
}

fn should_inline_foreign_keys(db_type: DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::SQLite
            | DatabaseType::DuckDB
            | DatabaseType::LibSQL
            | DatabaseType::CloudflareD1
    )
}

fn build_inline_foreign_key_clause(
    db_type: DatabaseType,
    table: &TableInfo,
    foreign_key: &ForeignKeyInfo,
    database: Option<&str>,
) -> Result<String> {
    let mut statement = format!(
        "  FOREIGN KEY ({}) REFERENCES {} ({})",
        quote_identifier_for(db_type, &foreign_key.column)?,
        qualify_name(
            db_type,
            &normalize_referenced_table_name(table, foreign_key),
            database,
        )?,
        quote_identifier_for(db_type, &foreign_key.referenced_column)?,
    );

    if let Some(on_update) = foreign_key
        .on_update
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        statement.push_str(&format!(" ON UPDATE {on_update}"));
    }

    if let Some(on_delete) = foreign_key
        .on_delete
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        statement.push_str(&format!(" ON DELETE {on_delete}"));
    }

    Ok(statement)
}

fn build_index_statements(
    db_type: DatabaseType,
    table: &TableInfo,
    structure: &TableStructure,
    database: Option<&str>,
) -> Result<Vec<String>> {
    let table_ref = qualify_name(db_type, &table_identifier(table), database)?;
    let primary_key_columns = structure
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.name.as_str())
        .collect::<BTreeSet<_>>();
    let mut statements = Vec::new();

    for index in &structure.indexes {
        let normalized_name = index.name.trim();
        if normalized_name.is_empty() || normalized_name.eq_ignore_ascii_case("PRIMARY") {
            continue;
        }

        let index_columns = index
            .columns
            .iter()
            .map(|column| column.as_str())
            .collect::<BTreeSet<_>>();
        if !primary_key_columns.is_empty() && index_columns == primary_key_columns {
            continue;
        }

        let columns = index
            .columns
            .iter()
            .map(|column| quote_identifier_for(db_type, column))
            .collect::<Result<Vec<_>>>()?;

        if columns.is_empty() {
            continue;
        }

        statements.push(format!(
            "CREATE {}INDEX {} ON {} ({});",
            if index.is_unique { "UNIQUE " } else { "" },
            quote_identifier_for(db_type, normalized_name)?,
            table_ref,
            columns.join(", ")
        ));
    }

    Ok(statements)
}

fn build_foreign_key_statements(
    db_type: DatabaseType,
    table: &TableInfo,
    structure: &TableStructure,
    database: Option<&str>,
) -> Result<Vec<String>> {
    if should_inline_foreign_keys(db_type) || !supports_alter_foreign_keys(db_type) {
        return Ok(Vec::new());
    }

    let table_ref = qualify_name(db_type, &table_identifier(table), database)?;
    let mut statements = Vec::new();

    for foreign_key in &structure.foreign_keys {
        let constraint_name = foreign_key
            .name
            .trim()
            .split('.')
            .next_back()
            .unwrap_or("fk_exported");
        let mut statement = format!(
            "ALTER TABLE {table_ref} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
            quote_identifier_for(db_type, constraint_name)?,
            quote_identifier_for(db_type, &foreign_key.column)?,
            qualify_name(
                db_type,
                &normalize_referenced_table_name(table, foreign_key),
                database,
            )?,
            quote_identifier_for(db_type, &foreign_key.referenced_column)?,
        );

        if let Some(on_update) = foreign_key
            .on_update
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            statement.push_str(&format!(" ON UPDATE {on_update}"));
        }

        if let Some(on_delete) = foreign_key
            .on_delete
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            statement.push_str(&format!(" ON DELETE {on_delete}"));
        }

        statement.push(';');
        statements.push(statement);
    }

    Ok(statements)
}

fn supports_alter_foreign_keys(db_type: DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::MySQL
            | DatabaseType::MariaDB
            | DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Vertica
            | DatabaseType::MSSQL
    )
}

fn normalize_schema_object_sql(
    db_type: DatabaseType,
    object: &SchemaObjectInfo,
    database: Option<&str>,
) -> Result<Option<String>> {
    let qualified_name = match object
        .schema
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(schema) => format!("{schema}.{}", object.name.trim()),
        None => object.name.trim().to_string(),
    };
    let object_ref = qualify_name(db_type, &qualified_name, database)?;
    let raw_definition = object.definition.as_deref().map(str::trim).unwrap_or_default();

    if raw_definition.is_empty() {
        return Ok(Some(format!("-- {} {}", object.object_type, object_ref)));
    }

    let uppercase_head = raw_definition
        .chars()
        .take(24)
        .collect::<String>()
        .to_ascii_uppercase();

    if uppercase_head.starts_with("CREATE ") {
        return Ok(Some(ensure_trailing_semicolon(raw_definition)));
    }

    if object.object_type.eq_ignore_ascii_case("VIEW") {
        return Ok(Some(format!(
            "CREATE VIEW {object_ref} AS\n{};",
            raw_definition.trim_end_matches(';').trim()
        )));
    }

    Ok(Some(format!(
        "-- {} {}\n{}",
        object.object_type,
        object_ref,
        ensure_trailing_semicolon(raw_definition)
    )))
}

fn ensure_trailing_semicolon(statement: &str) -> String {
    let trimmed = statement.trim();
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{trimmed};")
    }
}

fn build_insert_statement_batch(
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

fn render_sql_value(value: Option<&JsonValue>, db_type: DatabaseType, column: &ColumnInfo) -> String {
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
        JsonValue::String(value) => render_sql_string(value, column),
        JsonValue::Array(_) | JsonValue::Object(_) => {
            render_sql_string(&value.unwrap_or(&JsonValue::Null).to_string(), column)
        }
    }
}

fn render_sql_string(value: &str, _column: &ColumnInfo) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn row_to_object(columns: &[ColumnInfo], row: &[JsonValue]) -> JsonMap<String, JsonValue> {
    let mut object = JsonMap::new();
    for (index, column) in columns.iter().enumerate() {
        object.insert(
            column.name.clone(),
            row.get(index).cloned().unwrap_or(JsonValue::Null),
        );
    }
    object
}

fn qualify_name(db_type: DatabaseType, raw_identifier: &str, database: Option<&str>) -> Result<String> {
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

fn quote_identifier_for(db_type: DatabaseType, value: &str) -> Result<String> {
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

fn database_export_preamble(db_type: DatabaseType) -> String {
    match db_type {
        DatabaseType::MySQL | DatabaseType::MariaDB => "SET FOREIGN_KEY_CHECKS=0;\n\n".to_string(),
        DatabaseType::SQLite
        | DatabaseType::DuckDB
        | DatabaseType::LibSQL
        | DatabaseType::CloudflareD1 => "PRAGMA foreign_keys = OFF;\n\n".to_string(),
        _ => String::new(),
    }
}

fn database_export_postamble(db_type: DatabaseType) -> String {
    match db_type {
        DatabaseType::MySQL | DatabaseType::MariaDB => "\nSET FOREIGN_KEY_CHECKS=1;\n".to_string(),
        DatabaseType::SQLite
        | DatabaseType::DuckDB
        | DatabaseType::LibSQL
        | DatabaseType::CloudflareD1 => "\nPRAGMA foreign_keys = ON;\n".to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_create_table_statement, build_export_filename, build_insert_statement_batch,
        ensure_trailing_semicolon, DatabaseExportFormat,
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
        };
        let sql = build_create_table_statement(
            DatabaseType::SQLite,
            &table,
            &sample_structure(),
            None,
        )
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
        assert_eq!(ensure_trailing_semicolon("CREATE VIEW demo"), "CREATE VIEW demo;");
        assert_eq!(ensure_trailing_semicolon("CREATE VIEW demo;"), "CREATE VIEW demo;");
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
}
