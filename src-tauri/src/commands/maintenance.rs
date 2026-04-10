use crate::database::manager::DatabaseManager;
use crate::database::models::QueryResult;
use tauri::State;
use tokio::time::{timeout, Duration};

const MAINTENANCE_TIMEOUT: Duration = Duration::from_secs(300);

/// Supported maintenance commands.
/// The frontend passes these as string enum values.
fn build_maintenance_sql(
    command: &str,
    db_type: &str,
    table: Option<&str>,
    database: Option<&str>,
) -> Result<String, String> {
    match command {
        "vacuum" => match db_type {
            "postgresql" | "greenplum" | "cockroachdb" | "redshift" | "vertica" => {
                if let Some(tbl) = table {
                    Ok(format!("VACUUM ANALYZE \"{}\";", tbl))
                } else {
                    Ok("VACUUM ANALYZE;".to_string())
                }
            }
            "sqlite" | "libsql" | "cloudflare_d1" => Ok("VACUUM;".to_string()),
            _ => Err(format!("VACUUM is not supported for {} databases.", db_type)),
        },
        "analyze" => match db_type {
            "postgresql" | "greenplum" | "cockroachdb" | "redshift" | "vertica" => {
                if let Some(tbl) = table {
                    Ok(format!("ANALYZE \"{}\";", tbl))
                } else {
                    Ok("ANALYZE;".to_string())
                }
            }
            "mysql" | "mariadb" => {
                if let Some(tbl) = table {
                    Ok(format!("ANALYZE TABLE `{}`;", tbl))
                } else {
                    return Err("ANALYZE requires a table name for MySQL/MariaDB.".to_string());
                }
            }
            "sqlite" | "libsql" | "cloudflare_d1" => {
                // SQLite ANALYZE runs on the entire database or a specific table/index
                if let Some(tbl) = table {
                    Ok(format!("ANALYZE \"{}\";", tbl))
                } else {
                    Ok("ANALYZE;".to_string())
                }
            }
            _ => Err(format!("ANALYZE is not supported for {} databases.", db_type)),
        },
        "optimize" => match db_type {
            "mysql" | "mariadb" => {
                if let Some(tbl) = table {
                    Ok(format!("OPTIMIZE TABLE `{}`;", tbl))
                } else {
                    return Err("OPTIMIZE TABLE requires a table name.".to_string());
                }
            }
            "clickhouse" => {
                if let Some(tbl) = table {
                    let db_prefix = database.map_or(String::new(), |d| format!("{}.", d));
                    Ok(format!("OPTIMIZE TABLE {}`{}` FINAL;", db_prefix, tbl))
                } else {
                    return Err("OPTIMIZE TABLE requires a table name for ClickHouse.".to_string());
                }
            }
            _ => Err(format!("OPTIMIZE is not supported for {} databases.", db_type)),
        },
        "reindex" => match db_type {
            "postgresql" | "greenplum" | "cockroachdb" | "redshift" | "vertica" => {
                if let Some(tbl) = table {
                    Ok(format!("REINDEX TABLE \"{}\";", tbl))
                } else {
                    if let Some(db) = database {
                        Ok(format!("REINDEX DATABASE \"{}\";", db))
                    } else {
                        Ok("REINDEX;".to_string())
                    }
                }
            }
            "sqlite" | "libsql" | "cloudflare_d1" => {
                if let Some(tbl) = table {
                    Ok(format!("REINDEX \"{}\";", tbl))
                } else {
                    Ok("REINDEX;".to_string())
                }
            }
            _ => Err(format!("REINDEX is not supported for {} databases.", db_type)),
        },
        "check_table" => match db_type {
            "mysql" | "mariadb" => {
                if let Some(tbl) = table {
                    Ok(format!("CHECK TABLE `{}`;", tbl))
                } else {
                    return Err("CHECK TABLE requires a table name.".to_string());
                }
            }
            "postgresql" | "greenplum" | "cockroachdb" => {
                // PostgreSQL doesn't have CHECK TABLE, but we can use a pg_catalog check
                if let Some(tbl) = table {
                    Ok(format!(
                        "SELECT relname, relpages, reltuples, relallvisible FROM pg_catalog.pg_class WHERE relname = '{}';",
                        tbl
                    ))
                } else {
                    return Err("CHECK TABLE requires a table name.".to_string());
                }
            }
            _ => Err(format!("CHECK TABLE is not supported for {} databases.", db_type)),
        },
        _ => Err(format!("Unknown maintenance command: {}", command)),
    }
}

#[tauri::command]
pub async fn run_maintenance_command(
    connection_id: String,
    command: String,
    table: Option<String>,
    database: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<QueryResult, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;

    let db_type = driver.driver_name();
    let sql = build_maintenance_sql(
        &command,
        db_type,
        table.as_deref(),
        database.as_deref(),
    )?;

    timeout(MAINTENANCE_TIMEOUT, driver.execute_query(&sql))
        .await
        .map_err(|_| format!(
            "Maintenance command '{}' timed out after {} seconds.",
            command,
            MAINTENANCE_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("Maintenance command '{}' failed: {}", command, e))
}
