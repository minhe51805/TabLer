//! Stored procedure / function (routine) browsing, definition inspection, and
//! guarded execution.
//!
//! Listing reuses the driver's existing `list_schema_objects` metadata scan —
//! PostgreSQL, MySQL/MariaDB, and SQL Server already emit routine rows there —
//! then enriches them with an argument signature and language via one extra
//! catalog query per dialect. Definition and execution build dialect-specific
//! SQL (`pg_get_functiondef`, `SHOW CREATE PROCEDURE`, `sys.sql_modules`;
//! `CALL` / `SELECT` / `EXEC`) and run it through the same Safe Mode,
//! read-only, capability, timeout, and cancellation gates as `execute_query`.

use crate::commands::query::QueryCancellationState;
use crate::commands::safe_mode::SafeModeState;
use crate::database::capabilities::driver_capabilities;
use crate::database::driver::DatabaseDriver;
use crate::database::manager::DatabaseManager;
use crate::database::models::{DatabaseType, QueryParameter, QueryParameterType, QueryResult};
use crate::error::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

const ROUTINE_METADATA_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
pub struct RoutineInfo {
    pub name: String,
    /// `"procedure"` or `"function"`.
    pub kind: String,
    pub schema: Option<String>,
    pub language: Option<String>,
    /// Human-readable argument list, e.g. `IN p_id int, OUT p_total decimal(10,2)`.
    pub arg_signature: Option<String>,
    /// Raw engine object type (e.g. `SQL_STORED_PROCEDURE`, `PROCEDURE`).
    pub engine_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoutineDefinition {
    pub name: String,
    pub kind: String,
    pub definition: String,
}

// ---------------------------------------------------------------------------
// Dialect helpers
// ---------------------------------------------------------------------------

fn is_postgres_family(database_type: DatabaseType) -> bool {
    matches!(
        database_type,
        DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Redshift
            | DatabaseType::Vertica
    )
}

fn is_mysql_family(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::MySQL | DatabaseType::MariaDB)
}

/// Maps a raw driver `object_type` to the routine kind the UI understands.
/// Mirrors the frontend `classifySchemaObject` buckets: anything PROC-ish is a
/// procedure, FUNC/AGGREGATE-ish is a function; everything else is not a
/// routine (views, triggers, synonyms, types, …).
fn routine_kind(object_type: &str) -> Option<&'static str> {
    let value = object_type.trim().to_ascii_uppercase();
    if value.contains("PROC") {
        Some("procedure")
    } else if value.contains("FUNC") || value.contains("AGGREGATE") {
        Some("function")
    } else {
        None
    }
}

fn quote_identifier(identifier: &str, database_type: DatabaseType) -> String {
    match database_type {
        DatabaseType::MySQL | DatabaseType::MariaDB => {
            format!("`{}`", identifier.replace('`', "``"))
        }
        DatabaseType::MSSQL => format!("[{}]", identifier.replace(']', "]]")),
        _ => format!("\"{}\"", identifier.replace('"', "\"\"")),
    }
}

/// Single-quoted SQL string literal for catalog lookups (metadata queries run
/// through `execute_query`, which has no bind path).
fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn cell_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Null => None,
        other => Some(other.to_string()),
    }
}

fn engine_label(database_type: DatabaseType) -> &'static str {
    driver_capabilities(database_type).label
}

fn unsupported(database_type: DatabaseType, feature: &str) -> AppError {
    AppError::Other(format!(
        "{} is not supported for {}.",
        feature,
        engine_label(database_type)
    ))
}

// ---------------------------------------------------------------------------
// list_routines
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_routines(
    connection_id: String,
    database: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<RoutineInfo>, String> {
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    if !is_postgres_family(database_type)
        && !is_mysql_family(database_type)
        && database_type != DatabaseType::MSSQL
    {
        return Err(unsupported(database_type, "Routines").to_string());
    }
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let objects = timeout(
        ROUTINE_METADATA_TIMEOUT,
        driver.list_schema_objects(database.as_deref()),
    )
    .await
    .map_err(|_| "Listing routines timed out after 60 seconds.".to_string())?
    .map_err(|e| e.to_string())?;
    let mut routines: Vec<RoutineInfo> = objects
        .into_iter()
        .filter_map(|object| {
            routine_kind(&object.object_type).map(|kind| RoutineInfo {
                name: object.name,
                kind: kind.to_string(),
                schema: object.schema,
                language: None,
                arg_signature: None,
                engine_type: Some(object.object_type),
            })
        })
        .collect();

    if routines.is_empty() {
        return Ok(routines);
    }

    // Best-effort enrichment: argument signatures + language. A metadata
    // failure must not break listing — the base rows are already useful.
    if let Ok(database_type) = db_manager.connection_database_type(&connection_id).await {
        if let Some(sql) = routine_signature_query(database_type, database.as_deref(), &driver) {
            if let Ok(Ok(result)) =
                timeout(ROUTINE_METADATA_TIMEOUT, driver.execute_query(&sql)).await
            {
                merge_routine_signatures(&mut routines, &result);
            }
        }
    }

    Ok(routines)
}

/// One catalog query returning `(schema, name, arg_signature, language)` rows
/// for every routine, or `None` for engines without a signature source.
fn routine_signature_query(
    database_type: DatabaseType,
    database: Option<&str>,
    driver: &Arc<dyn DatabaseDriver>,
) -> Option<String> {
    if is_postgres_family(database_type) {
        // One row per (schema, name, kind): PostgreSQL allows a procedure and
        // a function to share a name, and overloads collapse into " | "-joined
        // signatures so the UI can still show every variant.
        Some(
            "SELECT n.nspname, p.proname, \
                    string_agg(pg_get_function_identity_arguments(p.oid), ' | '), \
                    min(l.lanname), \
                    CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END \
             FROM pg_proc p \
             JOIN pg_namespace n ON n.oid = p.pronamespace \
             JOIN pg_language l ON l.oid = p.prolang \
             WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') \
             GROUP BY n.nspname, p.proname, p.prokind \
             ORDER BY n.nspname, p.proname"
                .to_string(),
        )
    } else if is_mysql_family(database_type) {
        let filter = match database {
            Some(db) => format!("r.ROUTINE_SCHEMA = {}", sql_literal(db)),
            None => "r.ROUTINE_SCHEMA = DATABASE()".to_string(),
        };
        Some(format!(
            "SELECT r.ROUTINE_SCHEMA, r.ROUTINE_NAME, \
                    (SELECT GROUP_CONCAT( \
                        CONCAT_WS(' ', p.PARAMETER_MODE, p.PARAMETER_NAME, p.DTD_IDENTIFIER) \
                        ORDER BY p.ORDINAL_POSITION SEPARATOR ', ') \
                     FROM information_schema.PARAMETERS p \
                     WHERE p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA \
                       AND p.SPECIFIC_NAME = r.SPECIFIC_NAME \
                       AND p.ORDINAL_POSITION > 0), \
                    r.EXTERNAL_LANGUAGE, \
                    LOWER(r.ROUTINE_TYPE) \
             FROM information_schema.ROUTINES r \
             WHERE {filter} \
             ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME"
        ))
    } else if database_type == DatabaseType::MSSQL {
        let db = database
            .map(str::to_string)
            .or_else(|| driver.current_database());
        let prefix = db
            .as_deref()
            .map(|name| format!("[{}].", name.replace(']', "]]")))
            .unwrap_or_default();
        Some(format!(
            "SELECT s.name, o.name, \
                    STUFF((SELECT ', ' + p.name + ' ' + TYPE_NAME(p.user_type_id) + \
                                  CASE WHEN p.is_output = 1 THEN ' OUTPUT' ELSE '' END \
                           FROM {prefix}sys.parameters p \
                           WHERE p.object_id = o.object_id AND p.parameter_id > 0 \
                           ORDER BY p.parameter_id \
                           FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, ''), \
                    CASE WHEN o.type IN ('PC', 'FS', 'FT', 'AF') THEN 'CLR' ELSE 'SQL' END, \
                    CASE WHEN o.type IN ('P', 'PC') THEN 'procedure' ELSE 'function' END \
             FROM {prefix}sys.objects o \
             JOIN {prefix}sys.schemas s ON s.schema_id = o.schema_id \
             WHERE o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT', 'AF') \
             ORDER BY s.name, o.name"
        ))
    } else {
        None
    }
}

/// (schema, name, kind) → (arg_signature, language) — MySQL and PostgreSQL
/// both allow a procedure and a function to share one name.
type RoutineSignatureMap = HashMap<(String, String, String), (Option<String>, Option<String>)>;

fn merge_routine_signatures(routines: &mut [RoutineInfo], result: &QueryResult) {
    // Keyed by (schema, name, kind): MySQL and PostgreSQL both allow a
    // procedure and a function to share one name.
    let mut signatures: RoutineSignatureMap = HashMap::new();
    for row in &result.rows {
        let Some(schema) = row.first().and_then(cell_to_string) else {
            continue;
        };
        let Some(name) = row.get(1).and_then(cell_to_string) else {
            continue;
        };
        let signature = row.get(2).and_then(cell_to_string);
        let language = row.get(3).and_then(cell_to_string);
        let kind = row.get(4).and_then(cell_to_string).unwrap_or_default();
        signatures.insert((schema, name, kind), (signature, language));
    }
    for routine in routines.iter_mut() {
        let key = (
            routine.schema.clone().unwrap_or_default(),
            routine.name.clone(),
            routine.kind.clone(),
        );
        if let Some((signature, language)) = signatures.get(&key) {
            routine.arg_signature = signature.clone().filter(|s| !s.is_empty());
            routine.language = language.clone();
        }
    }
}

// ---------------------------------------------------------------------------
// get_routine_definition
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_routine_definition(
    connection_id: String,
    routine_name: String,
    schema: Option<String>,
    database: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<RoutineDefinition, String> {
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let name = routine_name.trim();
    if name.is_empty() {
        return Err("A routine name is required.".to_string());
    }

    if is_postgres_family(database_type) {
        let schema_filter = match schema.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(schema) => format!("n.nspname = {}", sql_literal(schema)),
            // No schema given: resolve through the session search_path so an
            // unqualified name behaves like it would in the query editor.
            None => "n.nspname = ANY (current_schemas(true))".to_string(),
        };
        let sql = format!(
            "SELECT p.prokind, pg_get_functiondef(p.oid) \
             FROM pg_proc p \
             JOIN pg_namespace n ON n.oid = p.pronamespace \
             WHERE p.proname = {} AND {schema_filter} \
             ORDER BY n.nspname, p.proname",
            sql_literal(name),
        );
        let result = run_metadata_query(&driver, &sql).await?;
        if result.rows.is_empty() {
            return Err(format!("Routine '{name}' was not found."));
        }
        let kind = if result
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(cell_to_string)
            .as_deref()
            == Some("p")
        {
            "procedure"
        } else {
            "function"
        };
        // Overloads: concatenate every variant's definition so nothing is hidden.
        let definition = result
            .rows
            .iter()
            .filter_map(|row| row.get(1).and_then(cell_to_string))
            .collect::<Vec<_>>()
            .join("\n\n");
        return Ok(RoutineDefinition {
            name: name.to_string(),
            kind: kind.to_string(),
            definition,
        });
    }

    if is_mysql_family(database_type) {
        let schema_filter = match schema
            .as_deref()
            .or(database.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(schema) => format!("ROUTINE_SCHEMA = {}", sql_literal(schema)),
            None => "ROUTINE_SCHEMA = DATABASE()".to_string(),
        };
        let lookup = format!(
            "SELECT ROUTINE_TYPE, ROUTINE_DEFINITION \
             FROM information_schema.ROUTINES \
             WHERE ROUTINE_NAME = {} AND {schema_filter} \
             LIMIT 1",
            sql_literal(name),
        );
        let result = run_metadata_query(&driver, &lookup).await?;
        let Some(row) = result.rows.first() else {
            return Err(format!("Routine '{name}' was not found."));
        };
        let routine_type = row
            .first()
            .and_then(cell_to_string)
            .unwrap_or_default()
            .to_ascii_uppercase();
        let kind = if routine_type == "PROCEDURE" {
            "procedure"
        } else {
            "function"
        };
        // SHOW CREATE returns the full DDL (ROUTINE_DEFINITION can be
        // truncated); fall back to the catalog text when privileges deny it.
        let qualified = match schema
            .as_deref()
            .or(database.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(schema) => format!(
                "{}.{}",
                quote_identifier(schema, database_type),
                quote_identifier(name, database_type)
            ),
            None => quote_identifier(name, database_type),
        };
        let show_sql = format!("SHOW CREATE {routine_type} {qualified}");
        let definition = match run_metadata_query(&driver, &show_sql).await {
            Ok(show_result) => show_result
                .rows
                .first()
                .and_then(|row| row.get(2))
                .and_then(cell_to_string)
                .or_else(|| row.get(1).and_then(cell_to_string)),
            Err(_) => None,
        }
        .or_else(|| row.get(1).and_then(cell_to_string));
        let Some(definition) = definition else {
            return Err(format!(
                "The definition of routine '{name}' is not available (insufficient privileges?)."
            ));
        };
        return Ok(RoutineDefinition {
            name: name.to_string(),
            kind: kind.to_string(),
            definition,
        });
    }

    if database_type == DatabaseType::MSSQL {
        let db = database
            .as_deref()
            .map(str::to_string)
            .or_else(|| driver.current_database());
        let prefix = db
            .as_deref()
            .map(|name| format!("[{}].", name.replace(']', "]]")))
            .unwrap_or_default();
        let schema_filter = match schema.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(schema) => format!("AND s.name = N{}", sql_literal(schema)),
            None => String::new(),
        };
        let sql = format!(
            "SELECT o.type, sm.definition \
             FROM {prefix}sys.objects o \
             JOIN {prefix}sys.schemas s ON s.schema_id = o.schema_id \
             LEFT JOIN {prefix}sys.sql_modules sm ON sm.object_id = o.object_id \
             WHERE o.name = N{} {schema_filter} \
               AND o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT', 'AF') \
             ORDER BY s.name",
            sql_literal(name),
        );
        let result = run_metadata_query(&driver, &sql).await?;
        let Some(row) = result.rows.first() else {
            return Err(format!("Routine '{name}' was not found."));
        };
        let object_type = row.first().and_then(cell_to_string).unwrap_or_default();
        let kind = routine_kind(match object_type.as_str() {
            "P" | "PC" => "PROCEDURE",
            _ => "FUNCTION",
        })
        .unwrap_or("function");
        let Some(definition) = row.get(1).and_then(cell_to_string) else {
            return Err(format!(
                "The definition of routine '{name}' is not available (encrypted or CLR assembly)."
            ));
        };
        return Ok(RoutineDefinition {
            name: name.to_string(),
            kind: kind.to_string(),
            definition,
        });
    }

    Err(unsupported(database_type, "Routine definitions").to_string())
}

async fn run_metadata_query(
    driver: &Arc<dyn DatabaseDriver>,
    sql: &str,
) -> Result<QueryResult, String> {
    timeout(ROUTINE_METADATA_TIMEOUT, driver.execute_query(sql))
        .await
        .map_err(|_| "Routine metadata query timed out after 60 seconds.".to_string())?
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// execute_routine
// ---------------------------------------------------------------------------

/// Coerces one raw argument string into a typed bind value. Empty input and
/// the literal `NULL` become SQL NULL (the only way to pass NULL through a
/// `Vec<String>`); `true`/`false` and clean numerics become their native
/// types; everything else stays text.
fn coerce_routine_arg(raw: &str, position: usize) -> QueryParameter {
    let trimmed = raw.trim();
    let (value, data_type) = if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
        (serde_json::Value::Null, QueryParameterType::Null)
    } else if trimmed.eq_ignore_ascii_case("true") {
        (serde_json::Value::Bool(true), QueryParameterType::Boolean)
    } else if trimmed.eq_ignore_ascii_case("false") {
        (serde_json::Value::Bool(false), QueryParameterType::Boolean)
    } else if let Ok(integer) = trimmed.parse::<i64>() {
        if integer.to_string() == trimmed {
            (
                serde_json::Value::from(integer),
                QueryParameterType::Integer,
            )
        } else {
            // Leading zeros / plus signs: keep the user's exact text.
            (
                serde_json::Value::String(raw.to_string()),
                QueryParameterType::Text,
            )
        }
    } else if trimmed.parse::<f64>().is_ok()
        && trimmed
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))
    {
        (
            serde_json::Value::from(trimmed.parse::<f64>().unwrap_or_default()),
            QueryParameterType::Decimal,
        )
    } else {
        (
            serde_json::Value::String(raw.to_string()),
            QueryParameterType::Text,
        )
    };
    QueryParameter {
        name: format!("p{position}"),
        value,
        data_type,
    }
}

/// Builds the dialect-specific invocation SQL plus bind parameters.
/// `mssql_function_is_table_valued` is resolved by the caller via a catalog
/// lookup; `None` defaults to scalar (`SELECT fn(...)`) since scalar UDFs are
/// the common case and the error message stays clear when wrong.
fn build_routine_call(
    database_type: DatabaseType,
    name: &str,
    kind: &str,
    args: &[String],
    schema: Option<&str>,
    database: Option<&str>,
    mssql_function_is_table_valued: Option<bool>,
) -> Result<(String, Vec<QueryParameter>), AppError> {
    let parameters: Vec<QueryParameter> = args
        .iter()
        .enumerate()
        .map(|(index, raw)| coerce_routine_arg(raw, index + 1))
        .collect();
    let is_procedure = kind.eq_ignore_ascii_case("procedure");

    if is_postgres_family(database_type) {
        let qualified = match schema.map(str::trim).filter(|s| !s.is_empty()) {
            Some(schema) => format!(
                "{}.{}",
                quote_identifier(schema, database_type),
                quote_identifier(name, database_type)
            ),
            None => quote_identifier(name, database_type),
        };
        let placeholders = (1..=args.len())
            .map(|i| format!(":p{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = if is_procedure {
            format!("CALL {qualified}({placeholders})")
        } else {
            // `SELECT * FROM` covers scalar AND set-returning functions.
            format!("SELECT * FROM {qualified}({placeholders})")
        };
        return Ok((sql, parameters));
    }

    if is_mysql_family(database_type) {
        // For MySQL the routine's "schema" IS the database; accept either arg.
        let qualifier = schema.or(database).map(str::trim).filter(|s| !s.is_empty());
        let qualified = match qualifier {
            Some(schema) => format!(
                "{}.{}",
                quote_identifier(schema, database_type),
                quote_identifier(name, database_type)
            ),
            None => quote_identifier(name, database_type),
        };
        let placeholders = (1..=args.len())
            .map(|i| format!(":p{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = if is_procedure {
            format!("CALL {qualified}({placeholders})")
        } else {
            format!("SELECT {qualified}({placeholders})")
        };
        return Ok((sql, parameters));
    }

    if database_type == DatabaseType::MSSQL {
        let mut parts: Vec<String> = Vec::new();
        if let Some(db) = database.map(str::trim).filter(|s| !s.is_empty()) {
            parts.push(quote_identifier(db, database_type));
        }
        if let Some(schema) = schema.map(str::trim).filter(|s| !s.is_empty()) {
            parts.push(quote_identifier(schema, database_type));
        } else if !parts.is_empty() {
            // `[db]..[name]` resolves through the default schema.
            parts.push(String::new());
        }
        parts.push(quote_identifier(name, database_type));
        let qualified = parts.join(".");
        let placeholders = (1..=args.len())
            .map(|i| format!(":p{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let arg_list = if args.is_empty() {
            String::new()
        } else {
            format!(" {placeholders}")
        };
        let sql = if is_procedure {
            format!("EXEC {qualified}{arg_list}")
        } else if mssql_function_is_table_valued.unwrap_or(false) {
            format!("SELECT * FROM {qualified}({placeholders})")
        } else {
            format!("SELECT {qualified}({placeholders})")
        };
        return Ok((sql, parameters));
    }

    Err(unsupported(database_type, "Routine execution"))
}

/// SQL Server scalar vs table-valued function lookup; `None` when the object
/// cannot be resolved (caller then assumes scalar).
async fn mssql_function_is_table_valued(
    driver: &Arc<dyn DatabaseDriver>,
    name: &str,
    schema: Option<&str>,
    database: Option<&str>,
) -> Option<bool> {
    let prefix = database
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|db| format!("[{}].", db.replace(']', "]]")))
        .unwrap_or_default();
    let schema_filter = schema
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("AND s.name = N{}", sql_literal(s)))
        .unwrap_or_default();
    let sql = format!(
        "SELECT o.type FROM {prefix}sys.objects o \
         JOIN {prefix}sys.schemas s ON s.schema_id = o.schema_id \
         WHERE o.name = N{} {schema_filter}",
        sql_literal(name),
    );
    let result = driver.execute_query(&sql).await.ok()?;
    let object_type = result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(cell_to_string)?;
    Some(matches!(object_type.as_str(), "IF" | "TF" | "FT"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_routine(
    connection_id: String,
    name: String,
    kind: String,
    args: Vec<String>,
    schema: Option<String>,
    database: Option<String>,
    request_id: Option<String>,
    safe_mode_approved_by_user: Option<bool>,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<QueryResult, AppError> {
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|e| AppError::Connection(e.to_string()))?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| AppError::Connection(e.to_string()))?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation(
            "A routine name is required.".to_string(),
        ));
    }
    let kind = kind.trim().to_ascii_lowercase();
    if kind != "procedure" && kind != "function" {
        return Err(AppError::Validation(format!(
            "Routine kind must be 'procedure' or 'function', got '{kind}'."
        )));
    }

    // SQL Server needs a catalog lookup to pick the scalar vs table-valued
    // invocation shape; other dialects build the call directly.
    let mssql_table_valued = if database_type == DatabaseType::MSSQL && kind == "function" {
        mssql_function_is_table_valued(&driver, name, schema.as_deref(), database.as_deref()).await
    } else {
        None
    };
    let (sql, parameters) = build_routine_call(
        database_type,
        name,
        &kind,
        &args,
        schema.as_deref(),
        database.as_deref(),
        mssql_table_valued,
    )?;

    // Execution delegates to the same commands the SQL editor uses, so the
    // read-only pin, Safe Mode classification (CALL/EXEC count as writes),
    // dangerous-capability rejection, capability gate, timeout resolution,
    // and `cancel_query` registration all behave identically.
    let operation_id = Uuid::new_v4();
    log::info!(
        "operation_id={} operation=routine.execute status=started connection_id={} routine={} kind={} arg_count={}",
        operation_id,
        connection_id,
        name,
        kind,
        parameters.len()
    );
    let mut result = if parameters.is_empty() {
        crate::commands::query::execute_query(
            connection_id,
            sql.clone(),
            request_id,
            None,
            safe_mode_approved_by_user,
            db_manager,
            cancellation_state,
            safe_mode,
        )
        .await?
    } else {
        crate::commands::query::execute_parameterized_query(
            connection_id,
            sql.clone(),
            parameters,
            request_id,
            safe_mode_approved_by_user,
            db_manager,
            cancellation_state,
            safe_mode,
        )
        .await?
    };
    // Record the statement actually sent so the result panel shows the real SQL.
    result.query = sql;
    log::info!(
        "operation_id={} operation=routine.execute status=succeeded rows={}",
        operation_id,
        result.rows.len()
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn builds_postgres_call_and_function_select() {
        let (call, params) = build_routine_call(
            DatabaseType::PostgreSQL,
            "do_work",
            "procedure",
            &args(&["42", "hello"]),
            Some("public"),
            None,
            None,
        )
        .expect("pg call");
        assert_eq!(call, "CALL \"public\".\"do_work\"(:p1, :p2)");
        assert_eq!(params[0].value, serde_json::json!(42));
        assert_eq!(params[1].value, serde_json::json!("hello"));

        let (select, _) = build_routine_call(
            DatabaseType::PostgreSQL,
            "get_total",
            "function",
            &args(&[]),
            None,
            None,
            None,
        )
        .expect("pg function");
        assert_eq!(select, "SELECT * FROM \"get_total\"()");
    }

    #[test]
    fn builds_mysql_call_and_function_select() {
        let (call, _) = build_routine_call(
            DatabaseType::MySQL,
            "archive_orders",
            "procedure",
            &args(&["2024"]),
            Some("shop"),
            None,
            None,
        )
        .expect("mysql call");
        assert_eq!(call, "CALL `shop`.`archive_orders`(:p1)");

        let (select, _) = build_routine_call(
            DatabaseType::MariaDB,
            "full_name",
            "function",
            &args(&["a", "b"]),
            None,
            Some("shop"),
            None,
        )
        .expect("mysql function");
        assert_eq!(select, "SELECT `shop`.`full_name`(:p1, :p2)");
    }

    #[test]
    fn builds_mssql_exec_and_function_shapes() {
        let (exec, _) = build_routine_call(
            DatabaseType::MSSQL,
            "usp_sync",
            "procedure",
            &args(&["x"]),
            Some("dbo"),
            Some("appdb"),
            None,
        )
        .expect("mssql exec");
        assert_eq!(exec, "EXEC [appdb].[dbo].[usp_sync] :p1");

        let (scalar, _) = build_routine_call(
            DatabaseType::MSSQL,
            "fn_tax",
            "function",
            &args(&["1"]),
            Some("dbo"),
            None,
            Some(false),
        )
        .expect("mssql scalar fn");
        assert_eq!(scalar, "SELECT [dbo].[fn_tax](:p1)");

        let (table_valued, _) = build_routine_call(
            DatabaseType::MSSQL,
            "fn_orders",
            "function",
            &args(&[]),
            Some("dbo"),
            None,
            Some(true),
        )
        .expect("mssql tvf");
        assert_eq!(table_valued, "SELECT * FROM [dbo].[fn_orders]()");
    }

    #[test]
    fn rejects_unsupported_engines() {
        let error = build_routine_call(
            DatabaseType::SQLite,
            "anything",
            "procedure",
            &args(&[]),
            None,
            None,
            None,
        )
        .expect_err("sqlite has no routines");
        assert!(error.to_string().contains("not supported"));
    }

    #[test]
    fn coerces_argument_strings() {
        assert_eq!(
            coerce_routine_arg("null", 1).data_type,
            QueryParameterType::Null
        );
        assert_eq!(
            coerce_routine_arg("", 1).data_type,
            QueryParameterType::Null
        );
        assert_eq!(coerce_routine_arg("true", 1).value, serde_json::json!(true));
        assert_eq!(coerce_routine_arg("42", 1).value, serde_json::json!(42));
        assert_eq!(coerce_routine_arg("4.5", 1).value, serde_json::json!(4.5));
        // Leading zeros stay text so identifiers like '007' are not mangled.
        assert_eq!(coerce_routine_arg("007", 1).value, serde_json::json!("007"));
        assert_eq!(
            coerce_routine_arg("hello", 1).value,
            serde_json::json!("hello")
        );
    }

    #[test]
    fn classifies_routine_object_types() {
        assert_eq!(routine_kind("PROCEDURE"), Some("procedure"));
        assert_eq!(routine_kind("SQL_STORED_PROCEDURE"), Some("procedure"));
        assert_eq!(routine_kind("FUNCTION"), Some("function"));
        assert_eq!(routine_kind("SQL_SCALAR_FUNCTION"), Some("function"));
        assert_eq!(routine_kind("SQL_TABLE_VALUED_FUNCTION"), Some("function"));
        assert_eq!(routine_kind("VIEW"), None);
        assert_eq!(routine_kind("SQL_TRIGGER"), None);
    }
}
