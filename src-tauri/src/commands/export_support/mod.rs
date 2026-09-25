//! Export helpers for the `export` command: file naming, SQL/JSON snapshot
//! building, and table ordering. DDL rendering lives in `schema`, DML/value
//! rendering in `rows`; both are re-exported so callers keep one flat surface.

use super::export::{
    DatabaseExportFormat, DatabaseExportSnapshotMeta, ExportTableBundle, SqlExportPayload,
    EXPORT_BATCH_SIZE, EXPORT_BATCH_TIMEOUT, EXPORT_METADATA_TIMEOUT,
};
use crate::database::driver::DatabaseDriver;
use crate::database::models::{DatabaseType, ForeignKeyInfo, TableInfo};
use anyhow::{Context, Result};
use chrono::Utc;
use futures_util::TryStreamExt;
use rfd::FileDialog;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;

mod rows;
mod schema;

// Re-exported so `export` (glob import) reaches the DDL/DML entry points it
// builds SQL dumps from; both are `pub(crate)` in their submodules for this.
pub(super) use rows::build_insert_statement_batch;
// `qualify_name` is also re-exported for `data_export`'s SQL INSERT format,
// which needs the same dialect-aware table reference as SQL dumps.
pub(super) use rows::qualify_name;
pub(super) use schema::build_create_table_statement;
// `ensure_trailing_semicolon` is exercised only by `export`'s unit tests, so
// gate its re-export to keep normal builds free of an unused re-export.
#[cfg(test)]
pub(super) use schema::ensure_trailing_semicolon;

// Helpers used only inside this module; kept private to `export_support`.
use rows::{database_export_postamble, database_export_preamble, row_to_object};
use schema::{build_foreign_key_statements, build_index_statements, normalize_schema_object_sql};

pub(super) fn preferred_export_format(db_type: DatabaseType) -> DatabaseExportFormat {
    match db_type {
        DatabaseType::Redis
        | DatabaseType::MongoDB
        | DatabaseType::OpenSearch
        | DatabaseType::Elasticsearch => DatabaseExportFormat::JsonSnapshot,
        _ => DatabaseExportFormat::Sql,
    }
}

pub(super) fn open_export_save_dialog(
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

pub(super) fn build_export_filename(
    connection_name: Option<&str>,
    database: Option<&str>,
    db_type: DatabaseType,
    export_format: DatabaseExportFormat,
) -> String {
    let base = database
        .and_then(|value| {
            sanitized_filename_segment(value).filter(|candidate| !candidate.is_empty())
        })
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

pub(super) fn sanitized_filename_segment(input: &str) -> Option<String> {
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

pub(super) async fn build_sql_export(
    driver: &dyn DatabaseDriver,
    database: Option<&str>,
    db_type: DatabaseType,
) -> Result<SqlExportPayload> {
    let table_bundles = collect_export_tables(driver, database).await?;
    let ordered_tables = order_tables_for_export(&table_bundles);
    let schema_objects = timeout(
        EXPORT_METADATA_TIMEOUT,
        driver.list_schema_objects(database),
    )
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
    if db_type == DatabaseType::MSSQL && !ordered_tables.is_empty() {
        // Snapshot restore replaces existing rows; suspend FK checks per table
        // (3-part names, so this works regardless of connection context).
        output.push_str("-- Snapshot restore: suspend constraint checks while rows are replaced\n");
        for bundle in &ordered_tables {
            let table_ref = qualify_name(db_type, &bundle.identifier, database)?;
            output.push_str(&format!(
                "ALTER TABLE {table_ref} NOCHECK CONSTRAINT ALL;\n"
            ));
        }
        output.push('\n');
    }
    for bundle in &ordered_tables {
        let table_ref = qualify_name(db_type, &bundle.identifier, database)?;
        if db_type == DatabaseType::MSSQL {
            output.push_str(&format!("DELETE FROM {table_ref};\n"));
            // Restore must re-insert the original identity values (error 544
            // otherwise). IDENTITY_INSERT is session-scoped: OFF for every
            // table up front keeps the ONs from shadowing each other.
            output.push_str(&format!("SET IDENTITY_INSERT {table_ref} ON;\n"));
        }
        // Page over a stable ORDER BY (PK, else first column) so offset
        // paging cannot skip or duplicate rows under concurrent writes.
        // Drivers with native deterministic paging (Cassandra page state,
        // OpenSearch scroll, Redis scans) get None and keep their order.
        let order_by = stable_export_order_column(db_type, bundle);
        let mut batches = driver.export_table_rows(
            &bundle.identifier,
            database,
            EXPORT_BATCH_SIZE,
            order_by.as_deref(),
            None,
            None,
        );
        while let Some(batch) = timeout(EXPORT_BATCH_TIMEOUT, batches.try_next())
            .await
            .with_context(|| format!("Exporting rows from '{}' timed out", bundle.identifier))?
            .with_context(|| format!("Exporting rows from '{}' failed", bundle.identifier))?
        {
            if batch.rows.is_empty() {
                continue;
            }

            output.push_str(&build_insert_statement_batch(
                db_type,
                &table_ref,
                &batch.columns,
                &batch.rows,
            )?);
            output.push('\n');

            total_rows += batch.rows.len() as u64;
        }
        if db_type == DatabaseType::MSSQL {
            output.push_str(&format!("SET IDENTITY_INSERT {table_ref} OFF;\n"));
        }
    }

    for bundle in &ordered_tables {
        for statement in build_index_statements(db_type, &bundle.info, &bundle.structure, database)?
        {
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

    if db_type == DatabaseType::MSSQL && !ordered_tables.is_empty() {
        output.push('\n');
        for bundle in ordered_tables.iter().rev() {
            let table_ref = qualify_name(db_type, &bundle.identifier, database)?;
            output.push_str(&format!(
                "ALTER TABLE {table_ref} WITH CHECK CHECK CONSTRAINT ALL;\n"
            ));
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

/// Streams a JSON snapshot straight to `target`: each table's rows are
/// serialized batch-by-batch so the whole database is never materialized in
/// one Vec. Returns `(table_count, row_count)`.
pub(super) async fn stream_json_snapshot(
    driver: &dyn DatabaseDriver,
    database: Option<&str>,
    db_type: DatabaseType,
    target: &Path,
) -> Result<(usize, u64)> {
    let table_bundles = collect_export_tables(driver, database).await?;
    let schema_objects = timeout(
        EXPORT_METADATA_TIMEOUT,
        driver.list_schema_objects(database),
    )
    .await
    .context("Listing schema objects timed out during export")??;
    let meta = DatabaseExportSnapshotMeta {
        exported_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        engine: driver.driver_name().to_string(),
        database: database.map(str::to_string),
        format: "json-snapshot".to_string(),
    };

    let mut file = tokio::fs::File::create(target)
        .await
        .context("Failed to create the export file")?;

    let mut chunk = Vec::new();
    serde_json::to_writer(
        &mut chunk,
        &serde_json::json!({ "meta": meta, "schemaObjects": schema_objects }),
    )
    .context("Failed to serialize the export snapshot")?;
    // `json!` produces a complete object; strip the closing brace so the
    // tables array can be appended incrementally.
    chunk.pop();
    chunk.extend_from_slice(b",\"tables\":[");
    file.write_all(&chunk)
        .await
        .context("Failed to write the export file")?;

    let mut row_count = 0_u64;
    for (table_index, bundle) in table_bundles.iter().enumerate() {
        chunk.clear();
        if table_index > 0 {
            chunk.push(b',');
        }
        serde_json::to_writer(
            &mut chunk,
            &serde_json::json!({
                "name": &bundle.info.name,
                "schema": &bundle.info.schema,
                "tableType": &bundle.info.table_type,
                "structure": &bundle.structure,
            }),
        )
        .context("Failed to serialize the export snapshot")?;
        chunk.pop();
        chunk.extend_from_slice(b",\"rows\":[");
        file.write_all(&chunk)
            .await
            .context("Failed to write the export file")?;

        let order_by = stable_export_order_column(db_type, bundle);
        let mut batches = driver.export_table_rows(
            &bundle.identifier,
            database,
            EXPORT_BATCH_SIZE,
            order_by.as_deref(),
            None,
            None,
        );
        let mut first_row = true;
        while let Some(batch) = timeout(EXPORT_BATCH_TIMEOUT, batches.try_next())
            .await
            .with_context(|| format!("Exporting rows from '{}' timed out", bundle.identifier))?
            .with_context(|| format!("Exporting rows from '{}' failed", bundle.identifier))?
        {
            chunk.clear();
            for row in &batch.rows {
                if !first_row {
                    chunk.push(b',');
                }
                first_row = false;
                serde_json::to_writer(&mut chunk, &row_to_object(&batch.columns, row))
                    .context("Failed to serialize the export snapshot")?;
            }
            row_count += batch.rows.len() as u64;
            file.write_all(&chunk)
                .await
                .context("Failed to write the export file")?;
        }
        file.write_all(b"]}")
            .await
            .context("Failed to write the export file")?;
    }

    file.write_all(b"]}")
        .await
        .context("Failed to write the export file")?;
    file.flush()
        .await
        .context("Failed to finish the export file")?;
    Ok((table_bundles.len(), row_count))
}

/// Column an unordered export should page over: the primary key when the
/// table has one, else the first column. Engines whose export stream is
/// already deterministic (Cassandra page state, OpenSearch scroll, Redis
/// keyspace scans) return None and keep their native order.
fn stable_export_order_column(db_type: DatabaseType, bundle: &ExportTableBundle) -> Option<String> {
    match db_type {
        DatabaseType::MongoDB => Some("_id".to_string()),
        DatabaseType::Cassandra | DatabaseType::OpenSearch | DatabaseType::Redis => None,
        _ => bundle
            .structure
            .columns
            .iter()
            .find(|column| column.is_primary_key)
            .or_else(|| bundle.structure.columns.first())
            .map(|column| column.name.clone()),
    }
}

pub(super) async fn collect_export_tables(
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

pub(super) fn is_exportable_table(table: &TableInfo) -> bool {
    let normalized = table.table_type.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return true;
    }

    !normalized.contains("view")
}

pub(super) fn table_identifier(table: &TableInfo) -> String {
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

pub(super) fn order_tables_for_export(tables: &[ExportTableBundle]) -> Vec<&ExportTableBundle> {
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
                .filter(|dependency| {
                    dependency != &bundle.identifier && table_names.contains(dependency)
                })
                .collect::<BTreeSet<_>>()
        })
        .collect::<Vec<_>>();

    let mut in_degree = dependency_graph
        .iter()
        .map(BTreeSet::len)
        .collect::<Vec<_>>();
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

pub(super) fn normalize_referenced_table_name(
    table: &TableInfo,
    foreign_key: &ForeignKeyInfo,
) -> String {
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
