use super::export_support::{
    build_insert_statement_batch, encrypt_export_file, qualify_name, temporary_export_path,
};
use crate::database::capabilities::DriverCapability;
use crate::database::manager::DatabaseManager;
use crate::database::models::{DatabaseType, QueryResult};
use futures_util::TryStreamExt;
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

const EXPORT_BATCH_SIZE: u64 = 1_000;
const EXPORT_BATCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Table export formats the streaming exporter understands. `Parquet` is only
/// constructible when the `parquet-export` cargo feature is compiled in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TableExportFormat {
    Csv,
    Tsv,
    Json,
    Jsonl,
    Sql,
    Xlsx,
    Xml,
    Html,
    Markdown,
    #[cfg(feature = "parquet-export")]
    Parquet,
}

impl TableExportFormat {
    /// Parses the `format` string sent by the frontend. An unknown value fails
    /// with the full list; `parquet` without the cargo feature fails with a
    /// dedicated message the UI can surface verbatim.
    fn parse(format: &str) -> Result<Self, String> {
        match format {
            "csv" => Ok(Self::Csv),
            "tsv" => Ok(Self::Tsv),
            "json" => Ok(Self::Json),
            "jsonl" => Ok(Self::Jsonl),
            "sql" => Ok(Self::Sql),
            "xlsx" => Ok(Self::Xlsx),
            "xml" => Ok(Self::Xml),
            "html" => Ok(Self::Html),
            "markdown" => Ok(Self::Markdown),
            #[cfg(feature = "parquet-export")]
            "parquet" => Ok(Self::Parquet),
            #[cfg(not(feature = "parquet-export"))]
            "parquet" => Err("Parquet export is not compiled into this build.".to_string()),
            _ => Err(format!(
                "Unsupported table export format '{format}'. Supported formats: {}.",
                compiled_export_formats()
                    .iter()
                    .map(|format| format.id)
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Tsv => "tsv",
            Self::Json => "json",
            Self::Jsonl => "jsonl",
            Self::Sql => "sql",
            Self::Xlsx => "xlsx",
            Self::Xml => "xml",
            Self::Html => "html",
            Self::Markdown => "markdown",
            #[cfg(feature = "parquet-export")]
            Self::Parquet => "parquet",
        }
    }

    /// File extension offered in the save dialog and used for bulk-export
    /// filenames. `markdown` writes `.md`, the conventional extension.
    fn extension(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            _ => self.id(),
        }
    }

    /// Human-facing filter name for the native save dialog.
    fn dialog_label(self) -> &'static str {
        match self {
            Self::Csv => "CSV",
            Self::Tsv => "TSV",
            Self::Json => "JSON",
            Self::Jsonl => "JSON Lines",
            Self::Sql => "SQL",
            Self::Xlsx => "Excel Workbook",
            Self::Xml => "XML",
            Self::Html => "HTML",
            Self::Markdown => "Markdown",
            #[cfg(feature = "parquet-export")]
            Self::Parquet => "Parquet",
        }
    }
}

/// One export format compiled into this build, as reported to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFormatInfo {
    /// Stable format id accepted by `export_table_data` /
    /// `export_tables_to_directory` (`csv`, `jsonl`, `sql`, `parquet`, …).
    id: &'static str,
    /// Default file extension for the save dialog / bulk-export filename.
    extension: &'static str,
    /// Human-facing label for pickers and file dialogs.
    label: &'static str,
}

fn compiled_export_formats() -> Vec<ExportFormatInfo> {
    const FORMATS: &[TableExportFormat] = &[
        TableExportFormat::Csv,
        TableExportFormat::Tsv,
        TableExportFormat::Json,
        TableExportFormat::Jsonl,
        TableExportFormat::Sql,
        TableExportFormat::Xlsx,
        TableExportFormat::Xml,
        TableExportFormat::Html,
        TableExportFormat::Markdown,
        #[cfg(feature = "parquet-export")]
        TableExportFormat::Parquet,
    ];
    FORMATS
        .iter()
        .map(|format| ExportFormatInfo {
            id: format.id(),
            extension: format.extension(),
            label: format.dialog_label(),
        })
        .collect()
}

/// Lists the table-export formats compiled into this build so the frontend can
/// populate its format picker (and hide `parquet` when the feature is off).
#[tauri::command]
pub fn get_export_formats() -> Vec<ExportFormatInfo> {
    compiled_export_formats()
}

#[derive(Default)]
pub struct TableExportCancellationState {
    exports: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl TableExportCancellationState {
    fn start(&self, operation_id: &str) -> Result<Arc<AtomicBool>, String> {
        if operation_id.trim().is_empty() {
            return Err("Export operation identifier is required.".to_string());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        self.exports
            .lock()
            .map_err(|_| "Export cancellation state is unavailable.".to_string())?
            .insert(operation_id.to_string(), cancelled.clone());
        Ok(cancelled)
    }

    fn finish(&self, operation_id: &str) {
        if let Ok(mut exports) = self.exports.lock() {
            exports.remove(operation_id);
        }
    }

    fn cancel(&self, operation_id: &str) -> bool {
        let Ok(exports) = self.exports.lock() else {
            return false;
        };
        let Some(cancelled) = exports.get(operation_id) else {
            return false;
        };
        cancelled.store(true, Ordering::Relaxed);
        true
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataExportRequest {
    table: String,
    database: Option<String>,
    format: String,
    order_by: Option<String>,
    order_dir: Option<String>,
    filter: Option<String>,
    /// When true, an existing destination file is replaced. When false/absent
    /// and the picked path exists, the command fails with
    /// `TABLER_EXPORT_FILE_EXISTS` so the UI can show an overwrite-confirm
    /// dialog and retry with this flag set.
    #[serde(default)]
    overwrite: bool,
    /// Optional AES-256-GCM envelope password. When set, the finished export
    /// bytes are encrypted and written to `<chosen>.texp`; `None` writes the
    /// plaintext format exactly as before.
    encrypt_password: Option<String>,
}

/// Error prefix the frontend matches to trigger its overwrite-confirm flow.
pub const EXPORT_FILE_EXISTS_CODE: &str = "TABLER_EXPORT_FILE_EXISTS";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataExportResult {
    file_path: String,
    format: String,
    row_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkTableExportRequest {
    /// Qualified or bare table names to export, in selection order.
    tables: Vec<String>,
    database: Option<String>,
    format: String,
    /// Directory the frontend picked once for the whole batch.
    directory: String,
    /// Optional AES-256-GCM envelope password applied to every written file
    /// (each lands as `<table>.<ext>.texp` inside `directory`).
    encrypt_password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkTableExportFailure {
    table: String,
    error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkTableExportResult {
    /// One entry per successfully written file.
    exported: Vec<TableDataExportResult>,
    /// Tables that failed; the batch continues past individual failures.
    failed: Vec<BulkTableExportFailure>,
    cancelled: bool,
}

/// Bulk export: streams every selected table into one chosen directory using
/// the same batching/serialization path as `export_table_data`, but skips the
/// per-file save dialog. Existing files are never overwritten — a `-N` suffix
/// is appended instead, matching the single-export "pick a new name" rule.
#[tauri::command]
pub async fn export_tables_to_directory(
    connection_id: String,
    request: BulkTableExportRequest,
    operation_id: String,
    app: AppHandle,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, TableExportCancellationState>,
) -> Result<BulkTableExportResult, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::DataExport)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let format = TableExportFormat::parse(&request.format)?;
    if let Some(password) = request.encrypt_password.as_deref() {
        crate::commands::export_crypto::validate_export_password(password)?;
    }
    // Encrypted files land as `<table>.<ext>.texp` so the inner format stays
    // visible in the name.
    let extension = if request.encrypt_password.is_some() {
        format!("{}.texp", format.extension())
    } else {
        format.extension().to_string()
    };
    // SQL export needs the engine's identifier-quoting dialect.
    let db_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    if request.tables.is_empty() {
        return Err("Select at least one table to export.".to_string());
    }
    let directory = PathBuf::from(request.directory.trim());
    if !directory.is_dir() {
        return Err("Choose an existing directory for the bulk export.".to_string());
    }

    let cancelled = cancellation_state.start(&operation_id)?;
    let mut exported = Vec::new();
    let mut failed = Vec::new();
    let mut was_cancelled = false;

    for table in &request.tables {
        if cancelled.load(Ordering::Relaxed) {
            was_cancelled = true;
            break;
        }
        let target_path = unique_export_path(&directory, table, &extension);
        let temporary_path = temporary_export_path(&target_path);
        let table_request = TableDataExportRequest {
            table: table.clone(),
            database: request.database.clone(),
            format: format.id().to_string(),
            order_by: None,
            order_dir: None,
            filter: None,
            // unique_export_path already picked a non-clobbering name.
            overwrite: true,
            encrypt_password: request.encrypt_password.clone(),
        };
        let result = stream_table_export(TableExportJob {
            driver: &*driver,
            request: &table_request,
            format,
            db_type,
            temporary_path: &temporary_path,
            operation_id: &operation_id,
            app: &app,
            cancelled: cancelled.clone(),
        })
        .await;
        match result {
            Ok(row_count) => {
                let published = match table_request.encrypt_password.as_deref() {
                    Some(password) => {
                        let source = temporary_path.clone();
                        let destination = target_path.clone();
                        let password = password.to_string();
                        tokio::task::spawn_blocking(move || {
                            encrypt_export_file(&source, &destination, &password, "table")
                        })
                        .await
                        .map_err(|_| "Export encryption task failed unexpectedly.".to_string())
                        .and_then(|result| result)
                    }
                    None => tokio::fs::rename(&temporary_path, &target_path)
                        .await
                        .map_err(|e| format!("Failed to publish completed export: {e}")),
                };
                match published {
                    Ok(()) => exported.push(TableDataExportResult {
                        file_path: target_path.to_string_lossy().to_string(),
                        format: format.id().to_string(),
                        row_count,
                    }),
                    Err(error) => {
                        let _ = tokio::fs::remove_file(&temporary_path).await;
                        failed.push(BulkTableExportFailure {
                            table: table.clone(),
                            error,
                        });
                    }
                }
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(&temporary_path).await;
                if cancelled.load(Ordering::Relaxed) {
                    was_cancelled = true;
                    break;
                }
                failed.push(BulkTableExportFailure {
                    table: table.clone(),
                    error,
                });
            }
        }
    }

    cancellation_state.finish(&operation_id);
    Ok(BulkTableExportResult {
        exported,
        failed,
        cancelled: was_cancelled,
    })
}

/// Pick a non-clobbering filename inside `directory` for one exported table.
fn unique_export_path(directory: &Path, table: &str, extension: &str) -> PathBuf {
    let base = safe_filename(table);
    for attempt in 0_u32..1000 {
        let file_name = if attempt == 0 {
            format!("{base}.{extension}")
        } else {
            format!("{base}-{attempt}.{extension}")
        };
        let candidate = directory.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    // Practically unreachable; fall back to a uuid-suffixed name.
    directory.join(format!("{base}-{}.{}", Uuid::new_v4(), extension))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableExportProgress {
    operation_id: String,
    exported_rows: u64,
    /// 1-based index of the batch just written, so the UI can show progress
    /// even before the first row count is meaningful.
    batch: u64,
}

#[tauri::command]
pub async fn export_table_data(
    connection_id: String,
    request: TableDataExportRequest,
    operation_id: String,
    app: AppHandle,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, TableExportCancellationState>,
) -> Result<TableDataExportResult, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::DataExport)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let format = TableExportFormat::parse(&request.format)?;
    if let Some(password) = request.encrypt_password.as_deref() {
        crate::commands::export_crypto::validate_export_password(password)?;
    }
    // SQL export needs the engine's identifier-quoting dialect.
    let db_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let suggested_name = if request.encrypt_password.is_some() {
        format!(
            "{}.{}.texp",
            safe_filename(&request.table),
            format.extension()
        )
    } else {
        format!("{}.{}", safe_filename(&request.table), format.extension())
    };
    let target_path = FileDialog::new()
        .set_file_name(suggested_name)
        .add_filter(format.dialog_label(), &[format.extension()])
        .save_file()
        .ok_or_else(|| "No export destination selected.".to_string())?;
    // Encrypted output is written to `<chosen>.texp`; the overwrite check and
    // temp-file placement both target that final path.
    let target_path = crate::commands::export_crypto::encrypted_export_path(&target_path);
    if target_path.exists() && !request.overwrite {
        return Err(format!(
            "{EXPORT_FILE_EXISTS_CODE}: '{}' already exists. Confirm overwrite to replace it.",
            target_path.display()
        ));
    }
    let temporary_path = temporary_export_path(&target_path);
    let cancelled = cancellation_state.start(&operation_id)?;
    let result = stream_table_export(TableExportJob {
        driver: &*driver,
        request: &request,
        format,
        db_type,
        temporary_path: &temporary_path,
        operation_id: &operation_id,
        app: &app,
        cancelled,
    })
    .await;
    cancellation_state.finish(&operation_id);

    match result {
        Ok(row_count) => {
            match request.encrypt_password.as_deref() {
                Some(password) => {
                    let source = temporary_path.clone();
                    let destination = target_path.clone();
                    let password = password.to_string();
                    tokio::task::spawn_blocking(move || {
                        encrypt_export_file(&source, &destination, &password, "table")
                    })
                    .await
                    .map_err(|_| "Export encryption task failed unexpectedly.".to_string())
                    .and_then(|result| result)?;
                }
                None => {
                    tokio::fs::rename(&temporary_path, &target_path)
                        .await
                        .map_err(|e| format!("Failed to publish completed export: {e}"))?;
                }
            }
            Ok(TableDataExportResult {
                file_path: target_path.to_string_lossy().to_string(),
                format: format.id().to_string(),
                row_count,
            })
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary_path).await;
            Err(error)
        }
    }
}

#[tauri::command]
pub fn cancel_table_export(
    operation_id: String,
    cancellation_state: State<'_, TableExportCancellationState>,
) -> bool {
    cancellation_state.cancel(&operation_id)
}

/// Everything one streaming table export needs — grouped so the export loop
/// signature stays readable as formats and options accrete.
struct TableExportJob<'a> {
    driver: &'a dyn crate::database::driver::DatabaseDriver,
    request: &'a TableDataExportRequest,
    format: TableExportFormat,
    db_type: DatabaseType,
    temporary_path: &'a Path,
    operation_id: &'a str,
    app: &'a AppHandle,
    cancelled: Arc<AtomicBool>,
}

async fn stream_table_export(job: TableExportJob<'_>) -> Result<u64, String> {
    let TableExportJob {
        driver,
        request,
        format,
        db_type,
        temporary_path,
        operation_id,
        app,
        cancelled,
    } = job;
    let mut file = tokio::fs::File::create(temporary_path)
        .await
        .map_err(|e| format!("Failed to create temporary export file: {e}"))?;
    let mut serializer = build_export_serializer(format, request, db_type)?;
    let mut exported_rows = 0_u64;
    let mut batch_index = 0_u64;
    // Unordered offset paging can skip or duplicate rows under concurrent
    // writes, so exports always page over a stable ORDER BY: the caller's
    // sort column, else the primary key, else the first column — for drivers
    // whose paging honours ORDER BY (SQL engines + MongoDB's sort). Drivers
    // with their own deterministic paging (Cassandra page state, OpenSearch
    // scroll, Redis keyspace scans) keep their native order.
    let order_by = match request.order_by.as_deref() {
        Some(order_by) => Some(order_by.to_string()),
        None => stable_export_order_column(driver, request).await,
    };
    let mut batches = driver.export_table_rows(
        &request.table,
        request.database.as_deref(),
        EXPORT_BATCH_SIZE,
        order_by.as_deref(),
        request.order_dir.as_deref(),
        request.filter.as_deref(),
    );

    while let Some(batch) = timeout(EXPORT_BATCH_TIMEOUT, batches.try_next())
        .await
        .map_err(|_| "Loading the next export batch timed out after 5 minutes.".to_string())?
        .map_err(|e| e.to_string())?
    {
        if cancelled.load(Ordering::Relaxed) {
            return Err("Table export cancelled; incomplete output was removed.".to_string());
        }
        if batch.rows.is_empty() {
            continue;
        }
        let bytes = serializer.serialize_batch(&batch)?;
        if !bytes.is_empty() {
            file.write_all(&bytes)
                .await
                .map_err(|e| format!("Failed to write export batch: {e}"))?;
        }
        exported_rows += batch.rows.len() as u64;
        batch_index += 1;
        let _ = app.emit(
            "table-export-progress",
            TableExportProgress {
                operation_id: operation_id.to_string(),
                exported_rows,
                batch: batch_index,
            },
        );
    }
    // Container formats (JSON array, XML/HTML documents, xlsx/parquet files)
    // emit their trailer — or, for the buffered binary formats, the whole
    // file — once the row stream ends.
    let trailer = serializer.finish()?;
    if !trailer.is_empty() {
        file.write_all(&trailer)
            .await
            .map_err(|e| format!("Failed to write export trailer: {e}"))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush export file: {e}"))?;
    file.sync_all()
        .await
        .map_err(|e| format!("Failed to sync export file: {e}"))?;
    Ok(exported_rows)
}

/// Per-format serializer driven by `stream_table_export`: `serialize_batch`
/// turns each row batch into bytes (or buffers them for the binary formats),
/// `finish` emits whatever the format needs after the last row — a closing
/// tag/array bracket, or the whole file for xlsx/parquet, which cannot be
/// written incrementally to an arbitrary byte sink.
trait TableExportSerializer: Send {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String>;
    fn finish(&mut self) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
}

fn build_export_serializer(
    format: TableExportFormat,
    request: &TableDataExportRequest,
    db_type: DatabaseType,
) -> Result<Box<dyn TableExportSerializer>, String> {
    match format {
        TableExportFormat::Csv => Ok(Box::new(CsvSerializer::default())),
        TableExportFormat::Tsv => Ok(Box::new(DelimitedSerializer::tsv())),
        TableExportFormat::Json => Ok(Box::new(JsonArraySerializer::default())),
        TableExportFormat::Jsonl => Ok(Box::new(JsonlSerializer)),
        TableExportFormat::Sql => Ok(Box::new(SqlSerializer::new(request, db_type)?)),
        TableExportFormat::Xlsx => Ok(Box::new(XlsxSerializer::new(request))),
        TableExportFormat::Xml => Ok(Box::new(XmlSerializer::default())),
        TableExportFormat::Html => Ok(Box::new(HtmlSerializer::default())),
        TableExportFormat::Markdown => Ok(Box::new(MarkdownSerializer::default())),
        #[cfg(feature = "parquet-export")]
        TableExportFormat::Parquet => Ok(Box::new(ParquetSerializer::default())),
    }
}

/// CSV serializer: header row on the first batch, then RFC 4180 rows.
#[derive(Default)]
struct CsvSerializer {
    wrote_header: bool,
}

impl TableExportSerializer for CsvSerializer {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String> {
        let bytes = serialize_csv_batch(batch, !self.wrote_header)?;
        self.wrote_header = true;
        Ok(bytes)
    }
}

/// JSON Lines serializer: one compact object per row, no framing.
struct JsonlSerializer;

impl TableExportSerializer for JsonlSerializer {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String> {
        serialize_jsonl_batch(batch)
    }
}

/// Pretty JSON array: `[` on the first batch, one indented object per row,
/// `]` on finish. An empty export still produces a valid `[]` document.
#[derive(Default)]
struct JsonArraySerializer {
    wrote_rows: bool,
}

impl TableExportSerializer for JsonArraySerializer {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String> {
        let mut output = Vec::new();
        if !self.wrote_rows {
            output.extend_from_slice(b"[\n");
        }
        for row in &batch.rows {
            if self.wrote_rows {
                output.extend_from_slice(b",\n");
            }
            let object = row_to_json_object(&batch.columns, row);
            let pretty = serde_json::to_string_pretty(&object)
                .map_err(|e| format!("Failed to serialize JSON row: {e}"))?;
            for (index, line) in pretty.lines().enumerate() {
                if index > 0 {
                    output.push(b'\n');
                }
                output.extend_from_slice(b"  ");
                output.extend_from_slice(line.as_bytes());
            }
            self.wrote_rows = true;
        }
        Ok(output)
    }

    fn finish(&mut self) -> Result<Vec<u8>, String> {
        Ok(if self.wrote_rows {
            b"\n]\n".to_vec()
        } else {
            b"[]\n".to_vec()
        })
    }
}

/// SQL serializer: one `INSERT INTO <table> (<cols>) VALUES (...);` per row,
/// with identifiers quoted and literals escaped for the connection's dialect
/// via the shared `export_support` rendering helpers.
struct SqlSerializer {
    table_ref: String,
    db_type: DatabaseType,
}

impl SqlSerializer {
    fn new(request: &TableDataExportRequest, db_type: DatabaseType) -> Result<Self, String> {
        let table_ref = qualify_name(db_type, &request.table, request.database.as_deref())
            .map_err(|e| e.to_string())?;
        Ok(Self { table_ref, db_type })
    }
}

impl TableExportSerializer for SqlSerializer {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String> {
        let mut output = String::new();
        for row in &batch.rows {
            let statement = build_insert_statement_batch(
                self.db_type,
                &self.table_ref,
                &batch.columns,
                std::slice::from_ref(row),
            )
            .map_err(|e| e.to_string())?;
            output.push_str(&statement);
            output.push('\n');
        }
        Ok(output.into_bytes())
    }
}

/// XML serializer mirroring the frontend `buildXmlContent` shape: a
/// `<results>` document where each row is a `<row>` element, column names are
/// sanitized to valid XML element names, and NULL cells carry `xsi:nil`.
#[derive(Default)]
struct XmlSerializer {
    element_names: Option<Vec<String>>,
}

impl TableExportSerializer for XmlSerializer {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String> {
        let mut output = String::new();
        if self.element_names.is_none() {
            self.element_names = Some(resolve_xml_names(
                &batch
                    .columns
                    .iter()
                    .map(|c| c.name.clone())
                    .collect::<Vec<_>>(),
            ));
            output.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
            output.push_str("<results xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\n");
        }
        let names = self.element_names.as_deref().unwrap_or(&[]);
        for row in &batch.rows {
            output.push_str("  <row>\n");
            for (index, name) in names.iter().enumerate() {
                match row.get(index) {
                    None | Some(JsonValue::Null) => {
                        output.push_str(&format!("    <{name} xsi:nil=\"true\"/>\n"));
                    }
                    Some(value) => {
                        output.push_str(&format!(
                            "    <{name}>{}</{name}>\n",
                            xml_escape(&xml_cell_text(value))
                        ));
                    }
                }
            }
            output.push_str("  </row>\n");
        }
        Ok(output.into_bytes())
    }

    fn finish(&mut self) -> Result<Vec<u8>, String> {
        if self.element_names.is_some() {
            Ok(b"</results>\n".to_vec())
        } else {
            // No batches ever arrived — still emit a well-formed empty document.
            Ok(b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<results xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\n</results>\n".to_vec())
        }
    }
}

/// HTML serializer: a bare `<table>` document with a `<th>` header row and one
/// `<tr>` per data row; NULL cells render empty.
#[derive(Default)]
struct HtmlSerializer {
    wrote_header: bool,
}

impl TableExportSerializer for HtmlSerializer {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String> {
        let mut output = String::new();
        if !self.wrote_header {
            output.push_str("<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"></head>\n<body>\n<table>\n<thead>\n<tr>");
            for column in &batch.columns {
                output.push_str(&format!("<th>{}</th>", html_escape(&column.name)));
            }
            output.push_str("</tr>\n</thead>\n<tbody>\n");
            self.wrote_header = true;
        }
        for row in &batch.rows {
            output.push_str("<tr>");
            for index in 0..batch.columns.len() {
                let text = match row.get(index) {
                    None | Some(JsonValue::Null) => String::new(),
                    Some(value) => xml_cell_text(value),
                };
                output.push_str(&format!("<td>{}</td>", html_escape(&text)));
            }
            output.push_str("</tr>\n");
        }
        Ok(output.into_bytes())
    }

    fn finish(&mut self) -> Result<Vec<u8>, String> {
        if self.wrote_header {
            Ok(b"</tbody>\n</table>\n</body>\n</html>\n".to_vec())
        } else {
            Ok(b"<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"></head>\n<body>\n<table>\n</table>\n</body>\n</html>\n".to_vec())
        }
    }
}

/// Markdown serializer: a GitHub-flavored table — header + separator on the
/// first batch, then one `| a | b |` line per row. Pipes are escaped and line
/// breaks collapse to spaces so every row stays on one line; NULL renders
/// empty, matching the frontend `buildMarkdownTableContent`.
#[derive(Default)]
struct MarkdownSerializer {
    wrote_header: bool,
}

impl TableExportSerializer for MarkdownSerializer {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String> {
        let mut output = String::new();
        if !self.wrote_header {
            output.push_str(&format!(
                "| {} |\n| {} |\n",
                batch
                    .columns
                    .iter()
                    .map(|column| markdown_escape(&column.name))
                    .collect::<Vec<_>>()
                    .join(" | "),
                batch
                    .columns
                    .iter()
                    .map(|_| "---")
                    .collect::<Vec<_>>()
                    .join(" | "),
            ));
            self.wrote_header = true;
        }
        for row in &batch.rows {
            output.push_str("| ");
            for index in 0..batch.columns.len() {
                if index > 0 {
                    output.push_str(" | ");
                }
                match row.get(index) {
                    None | Some(JsonValue::Null) => {}
                    Some(value) => output.push_str(&markdown_escape(&xml_cell_text(value))),
                }
            }
            output.push_str(" |\n");
        }
        Ok(output.into_bytes())
    }
}

/// XLSX serializer backed by `rust_xlsxwriter`. The crate keeps the worksheet
/// in memory until the workbook is saved, so rows stream into the worksheet
/// per batch and `finish` writes the whole `.xlsx` byte payload at once —
/// peak memory is the workbook, not the raw row stream.
struct XlsxSerializer {
    workbook: rust_xlsxwriter::Workbook,
    worksheet: rust_xlsxwriter::Worksheet,
    header_format: rust_xlsxwriter::Format,
    next_row: u32,
    wrote_header: bool,
}

impl XlsxSerializer {
    fn new(request: &TableDataExportRequest) -> Self {
        Self {
            workbook: rust_xlsxwriter::Workbook::new(),
            worksheet: {
                let mut worksheet = rust_xlsxwriter::Worksheet::new();
                worksheet.set_name(sanitize_sheet_name(&request.table)).ok();
                worksheet
            },
            header_format: rust_xlsxwriter::Format::new().set_bold(),
            next_row: 0,
            wrote_header: false,
        }
    }
}

impl TableExportSerializer for XlsxSerializer {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String> {
        if !self.wrote_header {
            for (index, column) in batch.columns.iter().enumerate() {
                self.worksheet
                    .write_with_format(
                        self.next_row,
                        index as u16,
                        column.name.as_str(),
                        &self.header_format,
                    )
                    .map_err(|e| format!("Failed to write xlsx header: {e}"))?;
            }
            self.next_row += 1;
            self.wrote_header = true;
        }
        for row in &batch.rows {
            for (index, value) in row.iter().enumerate() {
                let column = index as u16;
                let result = match value {
                    JsonValue::Null => self.worksheet.write_string(self.next_row, column, ""),
                    JsonValue::Bool(value) => {
                        self.worksheet.write_boolean(self.next_row, column, *value)
                    }
                    JsonValue::Number(value) => self.worksheet.write_number(
                        self.next_row,
                        column,
                        value.as_f64().unwrap_or_default(),
                    ),
                    JsonValue::String(value) => {
                        self.worksheet.write_string(self.next_row, column, value)
                    }
                    JsonValue::Array(_) | JsonValue::Object(_) => {
                        self.worksheet
                            .write_string(self.next_row, column, value.to_string())
                    }
                };
                result.map_err(|e| format!("Failed to write xlsx cell: {e}"))?;
            }
            self.next_row += 1;
        }
        // Rows live inside the worksheet; nothing is emitted per batch.
        Ok(Vec::new())
    }

    fn finish(&mut self) -> Result<Vec<u8>, String> {
        self.workbook.push_worksheet(std::mem::replace(
            &mut self.worksheet,
            rust_xlsxwriter::Worksheet::new(),
        ));
        self.workbook
            .save_to_buffer()
            .map_err(|e| format!("Failed to finalize xlsx export: {e}"))
    }
}

/// Parquet serializer: infers an Arrow schema from the first batch (declared
/// column types first, sampled values as fallback), then writes each batch as
/// a row group. The writer buffers into a `Vec<u8>` — parquet needs a seekable
/// footer, so the whole file is emitted by `finish`.
#[cfg(feature = "parquet-export")]
#[derive(Default)]
struct ParquetSerializer {
    writer: Option<parquet::arrow::ArrowWriter<Vec<u8>>>,
    schema: Option<Arc<arrow::datatypes::Schema>>,
}

#[cfg(feature = "parquet-export")]
impl TableExportSerializer for ParquetSerializer {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String> {
        if self.writer.is_none() {
            let schema = Arc::new(infer_arrow_schema(batch));
            let writer = parquet::arrow::ArrowWriter::try_new(Vec::new(), schema.clone(), None)
                .map_err(|e| format!("Failed to initialize parquet writer: {e}"))?;
            self.writer = Some(writer);
            self.schema = Some(schema);
        }
        let schema = self.schema.clone().expect("schema set with writer");
        let record_batch = build_record_batch(batch, &schema)?;
        self.writer
            .as_mut()
            .expect("writer initialized")
            .write(&record_batch)
            .map_err(|e| format!("Failed to write parquet row group: {e}"))?;
        Ok(Vec::new())
    }

    fn finish(&mut self) -> Result<Vec<u8>, String> {
        let Some(writer) = self.writer.take() else {
            // Zero rows: no batch ever arrived, so no schema was inferred —
            // a truly empty export produces an empty file.
            return Ok(Vec::new());
        };
        // `into_inner` closes the writer (writes the footer) and returns the
        // underlying buffer.
        writer
            .into_inner()
            .map_err(|e| format!("Failed to finalize parquet export: {e}"))
    }
}

/// Infers the Arrow schema for a parquet export. Declared column types win;
/// when a type string is unrecognized the first non-null value in the batch
/// decides, and untyped all-NULL columns fall back to Utf8 so no data is lost.
#[cfg(feature = "parquet-export")]
fn infer_arrow_schema(batch: &QueryResult) -> arrow::datatypes::Schema {
    use arrow::datatypes::{DataType, Field};
    let fields = batch
        .columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let data_type = declared_arrow_type(&column.data_type)
                .or_else(|| {
                    batch.rows.iter().find_map(|row| match row.get(index) {
                        Some(JsonValue::Bool(_)) => Some(DataType::Boolean),
                        Some(JsonValue::Number(number)) if number.is_i64() || number.is_u64() => {
                            Some(DataType::Int64)
                        }
                        Some(JsonValue::Number(_)) => Some(DataType::Float64),
                        Some(JsonValue::String(_)) => Some(DataType::Utf8),
                        _ => None,
                    })
                })
                .unwrap_or(DataType::Utf8);
            Field::new(&column.name, data_type, true)
        })
        .collect::<Vec<_>>();
    arrow::datatypes::Schema::new(fields)
}

/// Maps a declared column type string to an Arrow type. Matching is
/// conservative — only unambiguous base names map to a non-Utf8 type so exotic
/// types (`interval`, `point`, …) degrade to strings instead of failing.
#[cfg(feature = "parquet-export")]
fn declared_arrow_type(declared: &str) -> Option<arrow::datatypes::DataType> {
    use arrow::datatypes::DataType;
    let normalized = declared
        .trim()
        .to_lowercase()
        .split(['(', ' ', ','])
        .next()
        .unwrap_or("")
        .to_string();
    match normalized.as_str() {
        "int" | "integer" | "bigint" | "smallint" | "tinyint" | "mediumint" | "int2" | "int4"
        | "int8" | "int16" | "int32" | "int64" | "serial" | "bigserial" | "smallserial" => {
            Some(DataType::Int64)
        }
        "float" | "float4" | "float8" | "double" | "real" | "decimal" | "numeric" | "money"
        | "number" => Some(DataType::Float64),
        "bool" | "boolean" => Some(DataType::Boolean),
        _ => None,
    }
}

/// Converts one `QueryResult` batch into an Arrow `RecordBatch` under the
/// inferred schema. Values that do not fit the inferred column type are
/// stringified into Utf8 columns or fail with a clear error — never silently
/// dropped.
#[cfg(feature = "parquet-export")]
fn build_record_batch(
    batch: &QueryResult,
    schema: &Arc<arrow::datatypes::Schema>,
) -> Result<arrow::array::RecordBatch, String> {
    use arrow::array::{ArrayRef, BooleanBuilder, Float64Builder, Int64Builder, StringBuilder};
    use arrow::datatypes::DataType;

    let mut arrays: Vec<ArrayRef> = Vec::with_capacity(batch.columns.len());
    for (index, field) in schema.fields().iter().enumerate() {
        let column_name = field.name().as_str();
        match field.data_type() {
            DataType::Boolean => {
                let mut builder = BooleanBuilder::with_capacity(batch.rows.len());
                for row in &batch.rows {
                    match row.get(index) {
                        None | Some(JsonValue::Null) => builder.append_null(),
                        Some(JsonValue::Bool(value)) => builder.append_value(*value),
                        Some(other) => {
                            return Err(format!(
                                "Parquet export: column '{column_name}' expects a boolean but found {other}."
                            ));
                        }
                    }
                }
                arrays.push(Arc::new(builder.finish()));
            }
            DataType::Int64 => {
                let mut builder = Int64Builder::with_capacity(batch.rows.len());
                for row in &batch.rows {
                    match row.get(index) {
                        None | Some(JsonValue::Null) => builder.append_null(),
                        Some(JsonValue::Number(number)) => {
                            if let Some(value) = number.as_i64() {
                                builder.append_value(value);
                            } else if let Some(value) = number.as_u64() {
                                let value = i64::try_from(value).map_err(|_| {
                                    format!(
                                        "Parquet export: column '{column_name}' value {value} exceeds i64."
                                    )
                                })?;
                                builder.append_value(value);
                            } else {
                                return Err(format!(
                                    "Parquet export: column '{column_name}' expects an integer but found {number}."
                                ));
                            }
                        }
                        Some(other) => {
                            return Err(format!(
                                "Parquet export: column '{column_name}' expects an integer but found {other}."
                            ));
                        }
                    }
                }
                arrays.push(Arc::new(builder.finish()));
            }
            DataType::Float64 => {
                let mut builder = Float64Builder::with_capacity(batch.rows.len());
                for row in &batch.rows {
                    match row.get(index) {
                        None | Some(JsonValue::Null) => builder.append_null(),
                        Some(JsonValue::Number(number)) => {
                            builder.append_value(number.as_f64().unwrap_or_default());
                        }
                        Some(other) => {
                            return Err(format!(
                                "Parquet export: column '{column_name}' expects a number but found {other}."
                            ));
                        }
                    }
                }
                arrays.push(Arc::new(builder.finish()));
            }
            _ => {
                let mut builder =
                    StringBuilder::with_capacity(batch.rows.len(), batch.rows.len() * 16);
                for row in &batch.rows {
                    match row.get(index) {
                        None | Some(JsonValue::Null) => builder.append_null(),
                        Some(JsonValue::String(value)) => builder.append_value(value),
                        Some(other) => builder.append_value(other.to_string()),
                    }
                }
                arrays.push(Arc::new(builder.finish()));
            }
        }
    }
    arrow::array::RecordBatch::try_new(schema.clone(), arrays)
        .map_err(|e| format!("Failed to build parquet record batch: {e}"))
}

/// Excel worksheet names are capped at 31 chars and cannot contain
/// `[]:*?/\`; the sheet falls back to "Export" when nothing usable remains.
fn sanitize_sheet_name(table: &str) -> String {
    let sanitized: String = table
        .chars()
        .map(|character| match character {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => '_',
            _ => character,
        })
        .take(31)
        .collect();
    let sanitized = sanitized.trim_matches('\'').trim().to_string();
    if sanitized.is_empty() {
        "Export".to_string()
    } else {
        sanitized
    }
}

/// TSV serializer: header row on the first batch, then tab-separated rows.
/// NULL cells use the `\N` marker like CSV; embedded tabs/newlines/backslashes
/// are backslash-escaped (Postgres COPY convention) so values round-trip.
#[derive(Default)]
struct DelimitedSerializer {
    wrote_header: bool,
}

impl DelimitedSerializer {
    fn tsv() -> Self {
        Self::default()
    }
}

impl TableExportSerializer for DelimitedSerializer {
    fn serialize_batch(&mut self, batch: &QueryResult) -> Result<Vec<u8>, String> {
        let mut output = String::new();
        if !self.wrote_header {
            for (index, column) in batch.columns.iter().enumerate() {
                if index > 0 {
                    output.push('\t');
                }
                output.push_str(&tsv_escape(&column.name));
            }
            output.push('\n');
            self.wrote_header = true;
        }
        for row in &batch.rows {
            for (index, value) in row.iter().enumerate() {
                if index > 0 {
                    output.push('\t');
                }
                output.push_str(&tsv_cell(value));
            }
            output.push('\n');
        }
        Ok(output.into_bytes())
    }
}

fn row_to_json_object(
    columns: &[crate::database::models::ColumnInfo],
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

/// Renders a non-null JSON value as plain text for XML/HTML/Markdown cells:
/// strings unquoted, scalars via their JSON spelling, arrays/objects as
/// compact JSON.
fn xml_cell_text(value: &JsonValue) -> String {
    match value {
        JsonValue::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn html_escape(value: &str) -> String {
    // Same escaping as XML text content; quotes are unnecessary inside
    // element text but harmless to leave literal.
    xml_escape(value)
}

fn markdown_escape(value: &str) -> String {
    value.replace('|', "\\|").replace(['\r', '\n'], " ")
}

/// Sanitizes a column name into a valid XML 1.0 element name, mirroring the
/// frontend `sanitizeXmlName`: ASCII letter or underscore first, then
/// letters/digits/`_`/`.`/`-`; anything else falls back to `col_N`.
fn sanitize_xml_name(name: &str, index: usize) -> String {
    let fallback = format!("col_{index}");
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return fallback;
    };
    if !(first.is_ascii_alphabetic() || first == '_')
        || name.len() >= 3 && name[..3].eq_ignore_ascii_case("xml")
    {
        return fallback;
    }
    name.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

/// Resolves sanitized element names for every column, deduplicating
/// collisions (`a b` and `a_b` both sanitize to `a_b`) with a `_N` suffix.
fn resolve_xml_names(columns: &[String]) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let base = sanitize_xml_name(column, index);
            let count = seen.entry(base.clone()).or_insert(0);
            let name = if *count == 0 {
                base.clone()
            } else {
                format!("{base}_{count}")
            };
            *count += 1;
            name
        })
        .collect()
}

/// TSV cell rendering: NULL is the `\N` marker (same convention as CSV), and
/// tabs/newlines/backslashes are escaped so a cell never breaks the grid.
fn tsv_cell(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "\\N".to_string(),
        JsonValue::String(value) => tsv_escape(value),
        other => tsv_escape(&other.to_string()),
    }
}

fn tsv_escape(value: &str) -> String {
    if value.contains(['\t', '\n', '\r', '\\']) {
        value
            .replace('\\', "\\\\")
            .replace('\t', "\\t")
            .replace('\r', "\\r")
            .replace('\n', "\\n")
    } else {
        value.to_string()
    }
}

/// Picks the column an unordered export should page over: the primary key
/// when the table has one, else the first column. Only drivers whose paging
/// honours an ORDER BY/sort get one — Cassandra (page-state paging),
/// OpenSearch (scroll), and Redis (keyspace scans) keep their native order.
/// Structure lookup failures degrade to unordered paging rather than
/// failing the export.
async fn stable_export_order_column(
    driver: &dyn crate::database::driver::DatabaseDriver,
    request: &TableDataExportRequest,
) -> Option<String> {
    let column = match driver.driver_name() {
        "MongoDB" => "_id".to_string(),
        "MySQL" | "MariaDB" | "PostgreSQL" | "CockroachDB" | "Greenplum" | "Redshift"
        | "SQLite" | "LibSQL" | "DuckDB" | "SQL Server" | "Snowflake" | "BigQuery"
        | "ClickHouse" | "Vertica" | "Cloudflare D1" => {
            let structure = driver
                .get_table_structure(&request.table, request.database.as_deref())
                .await
                .ok()?;
            structure
                .columns
                .iter()
                .find(|column| column.is_primary_key)
                .or_else(|| structure.columns.first())
                .map(|column| column.name.clone())?
        }
        _ => return None,
    };
    Some(column)
}

/// Serializes one batch of rows as CSV text. NULL cells are written as the
/// unquoted `\N` marker (Postgres COPY convention) so they round-trip
/// through the CSV importer, which decodes `\N` back to NULL; a literal `\N`
/// string is escaped to `\\N`. Empty strings stay empty strings.
fn serialize_csv_batch(result: &QueryResult, include_header: bool) -> Result<Vec<u8>, String> {
    let mut output = String::new();
    if include_header {
        for (index, column) in result.columns.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            output.push_str(&csv_escape(&column.name));
        }
        output.push('\n');
    }
    for row in &result.rows {
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            output.push_str(&csv_cell(value));
        }
        output.push('\n');
    }
    Ok(output.into_bytes())
}

fn serialize_jsonl_batch(result: &QueryResult) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    for row in &result.rows {
        let mut object = JsonMap::new();
        for (index, column) in result.columns.iter().enumerate() {
            object.insert(
                column.name.clone(),
                row.get(index).cloned().unwrap_or(JsonValue::Null),
            );
        }
        serde_json::to_writer(&mut output, &object)
            .map_err(|e| format!("Failed to serialize JSONL row: {e}"))?;
        output.push(b'\n');
    }
    Ok(output)
}

/// Renders one cell for CSV export. `JsonValue::Null` becomes the `\N`
/// marker so NULL and "" stay distinguishable; strings that already look
/// like the marker (`\N`, `\\N`, …) gain one more leading backslash, which
/// the importer's `decode_csv_cell` strips again.
fn csv_cell(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "\\N".to_string(),
        JsonValue::String(value) => {
            if value.len() >= 2
                && value.ends_with('N')
                && value[..value.len() - 1].chars().all(|ch| ch == '\\')
            {
                csv_escape(&format!("\\{value}"))
            } else {
                csv_escape(value)
            }
        }
        _ => csv_escape(&value.to_string()),
    }
}

/// RFC 4180 quoting: quote only when the value contains a comma, quote, or
/// line break; embedded quotes double.
fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn safe_filename(value: &str) -> String {
    let safe = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        "table".to_string()
    } else {
        safe
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_export_serializer, serialize_csv_batch, serialize_jsonl_batch, temporary_export_path,
        TableDataExportRequest, TableExportFormat,
    };
    use crate::database::models::{ColumnInfo, DatabaseType, QueryResult};
    use serde_json::json;
    use std::path::Path;

    fn fixture() -> QueryResult {
        QueryResult {
            columns: vec![ColumnInfo {
                name: "name".into(),
                data_type: "TEXT".into(),
                is_nullable: false,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            }],
            rows: vec![vec![json!("Ada, Lovelace")]],
            affected_rows: 0,
            execution_time_ms: 0,
            query: String::new(),
            sandboxed: false,
            truncated: false,
        }
    }

    #[test]
    fn serializes_bounded_csv_and_jsonl_batches() {
        let csv = String::from_utf8(serialize_csv_batch(&fixture(), true).unwrap()).unwrap();
        assert!(csv.contains("\"Ada, Lovelace\""));
        let jsonl = String::from_utf8(serialize_jsonl_batch(&fixture()).unwrap()).unwrap();
        assert_eq!(jsonl.trim(), r#"{"name":"Ada, Lovelace"}"#);
    }

    #[test]
    fn temporary_output_stays_beside_the_destination() {
        let temporary = temporary_export_path(Path::new("C:/exports/users.csv"));
        assert_eq!(temporary.parent(), Some(Path::new("C:/exports")));
        assert!(temporary.to_string_lossy().ends_with(".part"));
    }

    fn wide_fixture() -> QueryResult {
        QueryResult {
            columns: vec![
                ColumnInfo {
                    name: "id".into(),
                    data_type: "INTEGER".into(),
                    is_nullable: false,
                    is_primary_key: true,
                    max_length: None,
                    default_value: None,
                },
                ColumnInfo {
                    name: "name".into(),
                    data_type: "TEXT".into(),
                    is_nullable: true,
                    is_primary_key: false,
                    max_length: None,
                    default_value: None,
                },
            ],
            rows: vec![
                vec![json!(1), json!("Ada")],
                vec![json!(2), serde_json::Value::Null],
            ],
            affected_rows: 0,
            execution_time_ms: 0,
            query: String::new(),
            sandboxed: false,
            truncated: false,
        }
    }

    fn request_for(format: &str) -> TableDataExportRequest {
        TableDataExportRequest {
            table: "users".into(),
            database: None,
            format: format.to_string(),
            order_by: None,
            order_dir: None,
            filter: None,
            overwrite: false,
            encrypt_password: None,
        }
    }

    /// Drives a serializer through one batch + finish and returns the full
    /// output bytes, mirroring `stream_table_export`'s write loop.
    fn render(format: TableExportFormat, batch: &QueryResult) -> Vec<u8> {
        let request = request_for(format.id());
        let mut serializer =
            build_export_serializer(format, &request, DatabaseType::PostgreSQL).unwrap();
        let mut output = serializer.serialize_batch(batch).unwrap();
        output.extend(serializer.finish().unwrap());
        output
    }

    #[test]
    fn parses_every_compiled_format() {
        for format in super::compiled_export_formats() {
            assert_eq!(
                TableExportFormat::parse(format.id).unwrap().id(),
                format.id,
                "compiled format must round-trip through parse"
            );
        }
        #[cfg(not(feature = "parquet-export"))]
        assert!(TableExportFormat::parse("parquet")
            .unwrap_err()
            .contains("not compiled"));
    }

    #[test]
    fn tsv_escapes_cells_and_marks_null() {
        let output = String::from_utf8(render(TableExportFormat::Tsv, &wide_fixture())).unwrap();
        let mut lines = output.lines();
        assert_eq!(lines.next(), Some("id\tname"));
        assert_eq!(lines.next(), Some("1\tAda"));
        assert_eq!(lines.next(), Some("2\t\\N"));
    }

    #[test]
    fn json_export_is_a_pretty_array() {
        let output = String::from_utf8(render(TableExportFormat::Json, &wide_fixture())).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed[0]["id"], json!(1));
        assert_eq!(parsed[1]["name"], serde_json::Value::Null);
        assert!(output.starts_with("[\n"));
        assert!(output.ends_with("]\n"));
    }

    #[test]
    fn sql_export_emits_dialect_quoted_inserts_per_row() {
        let output = String::from_utf8(render(TableExportFormat::Sql, &wide_fixture())).unwrap();
        let statements: Vec<&str> = output
            .split(';')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        assert_eq!(statements.len(), 2, "one INSERT per row");
        assert!(statements[0].starts_with("INSERT INTO \"users\" (\"id\", \"name\") VALUES"));
        assert!(statements[0].contains("'Ada'"));
        assert!(statements[1].contains("NULL"));
    }

    #[test]
    fn xml_export_marks_null_and_escapes_names() {
        let output = String::from_utf8(render(TableExportFormat::Xml, &wide_fixture())).unwrap();
        assert!(output.contains("<results xmlns:xsi="));
        assert!(output.contains("<name>Ada</name>"));
        assert!(output.contains("<name xsi:nil=\"true\"/>"));
        assert!(output.trim_end().ends_with("</results>"));
    }

    #[test]
    fn html_and_markdown_exports_render_tables() {
        let html = String::from_utf8(render(TableExportFormat::Html, &wide_fixture())).unwrap();
        assert!(html.contains("<th>name</th>"));
        assert!(html.contains("<td>Ada</td>"));
        assert!(html.contains("</table>"));
        let markdown =
            String::from_utf8(render(TableExportFormat::Markdown, &wide_fixture())).unwrap();
        assert!(markdown.contains("| id | name |"));
        assert!(markdown.contains("| --- | --- |"));
        assert!(markdown.contains("| 1 | Ada |"));
    }

    #[test]
    fn xlsx_export_produces_a_zip_workbook() {
        let output = render(TableExportFormat::Xlsx, &wide_fixture());
        // XLSX is a zip archive: PK\x03\x04 magic.
        assert_eq!(&output[..4], b"PK\x03\x04");
    }

    #[cfg(feature = "parquet-export")]
    #[test]
    fn parquet_export_produces_a_parquet_file() {
        let output = render(TableExportFormat::Parquet, &wide_fixture());
        // Parquet files open and close with the PAR1 magic.
        assert_eq!(&output[..4], b"PAR1");
        assert_eq!(&output[output.len() - 4..], b"PAR1");
    }
}
