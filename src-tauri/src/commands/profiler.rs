use crate::database::manager::DatabaseManager;
use crate::database::models::DatabaseType;
use serde::Serialize;
use tauri::State;

/// Canonical column contract every engine's probe SQL must alias its columns to.
///
/// The live profiler is cross-engine: each supported engine samples the
/// currently-running statements from a different system view, but every probe
/// aliases its columns to exactly these names so the frontend renders a single,
/// engine-agnostic trace table. This is the P0 slice of the hybrid `TraceEvent`
/// model — session identity + timing + statement text — that later phases
/// (statement-store aggregates, native SQL Server XEvents) extend without
/// changing the frontend contract.
pub const PROFILER_COLUMNS: [&str; 9] = [
    "session_id",
    "db_name",
    "username",
    "application",
    "client_addr",
    "state",
    "wait_event",
    "duration_ms",
    "query_text",
];

/// PostgreSQL / Greenplum: active backends from `pg_stat_activity`. Our own
/// sampling backend is excluded via `pg_backend_pid()`, and idle sessions are
/// dropped so the trace only shows work in flight.
const POSTGRES_PROBE_SQL: &str = "SELECT \
pid::text AS session_id, \
datname AS db_name, \
usename AS username, \
application_name AS application, \
host(client_addr) AS client_addr, \
state AS state, \
wait_event_type AS wait_event, \
(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)::bigint AS duration_ms, \
query AS query_text \
FROM pg_stat_activity \
WHERE pid <> pg_backend_pid() \
AND state IS NOT NULL AND state <> 'idle' \
AND query IS NOT NULL AND query <> '' \
ORDER BY duration_ms DESC NULLS LAST \
LIMIT 200";

/// MySQL / MariaDB: `information_schema.PROCESSLIST`. Our own connection is
/// excluded via `CONNECTION_ID()`; `Sleep` commands (idle pooled sessions) are
/// dropped. `TIME` is whole seconds, promoted to milliseconds for the contract.
const MYSQL_PROBE_SQL: &str = "SELECT \
CAST(ID AS CHAR) AS session_id, \
DB AS db_name, \
USER AS username, \
'' AS application, \
HOST AS client_addr, \
STATE AS state, \
'' AS wait_event, \
(TIME * 1000) AS duration_ms, \
INFO AS query_text \
FROM information_schema.PROCESSLIST \
WHERE ID <> CONNECTION_ID() \
AND COMMAND <> 'Sleep' \
AND INFO IS NOT NULL \
ORDER BY TIME DESC \
LIMIT 200";

/// SQL Server: `sys.dm_exec_requests` joined to the session/connection DMVs and
/// the cached statement text. Our own session is excluded via `@@SPID` and only
/// user processes are kept. `total_elapsed_time` is already in milliseconds.
const MSSQL_PROBE_SQL: &str = "SELECT TOP (200) \
CAST(r.session_id AS VARCHAR(20)) AS session_id, \
DB_NAME(r.database_id) AS db_name, \
s.login_name AS username, \
s.program_name AS application, \
CAST(c.client_net_address AS VARCHAR(64)) AS client_addr, \
r.status AS state, \
r.wait_type AS wait_event, \
r.total_elapsed_time AS duration_ms, \
t.text AS query_text \
FROM sys.dm_exec_requests r \
JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id \
LEFT JOIN sys.dm_exec_connections c ON r.session_id = c.session_id \
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t \
WHERE r.session_id <> @@SPID AND s.is_user_process = 1 \
ORDER BY r.total_elapsed_time DESC";

/// Canonical column contract every engine's **top-queries** probe SQL aliases to.
///
/// Where [`PROFILER_COLUMNS`] samples *currently-running* statements, this is the
/// P1 aggregate view: the engine's statement store already accumulates per-digest
/// timing across every execution, so nothing is missed between polls. Each engine
/// reads a different store but aliases to exactly these names, so the frontend
/// renders one engine-agnostic ranking table.
pub const TOP_QUERY_COLUMNS: [&str; 5] = ["query_text", "calls", "total_ms", "mean_ms", "rows"];

/// PostgreSQL / Greenplum: `pg_stat_statements` (PG13+ names `total_exec_time` /
/// `mean_exec_time`). Requires the `pg_stat_statements` extension to be created
/// and preloaded; the probe surfaces a clear error if the view is missing.
/// Timing columns are already in milliseconds.
const POSTGRES_TOP_QUERIES_SQL: &str = "SELECT \
query AS query_text, \
calls AS calls, \
round(total_exec_time::numeric, 2)::float8 AS total_ms, \
round(mean_exec_time::numeric, 2)::float8 AS mean_ms, \
rows AS rows \
FROM pg_stat_statements \
WHERE query IS NOT NULL AND query <> '' \
ORDER BY total_exec_time DESC \
LIMIT 200";

/// MySQL / MariaDB: `performance_schema.events_statements_summary_by_digest`.
/// The `*_TIMER_WAIT` columns are in picoseconds, so they are divided by 1e9 to
/// yield milliseconds. Requires `performance_schema` to be enabled.
const MYSQL_TOP_QUERIES_SQL: &str = "SELECT \
DIGEST_TEXT AS query_text, \
COUNT_STAR AS calls, \
ROUND(SUM_TIMER_WAIT / 1000000000, 2) AS total_ms, \
ROUND(AVG_TIMER_WAIT / 1000000000, 2) AS mean_ms, \
SUM_ROWS_SENT AS rows \
FROM performance_schema.events_statements_summary_by_digest \
WHERE DIGEST_TEXT IS NOT NULL \
ORDER BY SUM_TIMER_WAIT DESC \
LIMIT 200";

/// SQL Server: `sys.dm_exec_query_stats` joined to the cached statement text.
/// `total_elapsed_time` is microseconds, divided by 1000 for milliseconds; the
/// mean guards against a zero `execution_count`.
const MSSQL_TOP_QUERIES_SQL: &str = "SELECT TOP (200) \
t.text AS query_text, \
qs.execution_count AS calls, \
CAST(qs.total_elapsed_time / 1000.0 AS DECIMAL(18,2)) AS total_ms, \
CAST(qs.total_elapsed_time / 1000.0 / NULLIF(qs.execution_count, 0) AS DECIMAL(18,2)) AS mean_ms, \
qs.total_rows AS rows \
FROM sys.dm_exec_query_stats qs \
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t \
WHERE t.text IS NOT NULL \
ORDER BY qs.total_elapsed_time DESC";

/// A read-only probe the frontend polls to sample the engine's live activity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilerProbe {
    /// Stable lowercase engine key (matches the serialized `DatabaseType`), so
    /// the UI can label and branch on the capture source.
    pub engine: String,
    /// Human-readable description of where the sample comes from.
    pub source: String,
    /// The canonical column names the SQL aliases to, in contract order.
    pub columns: Vec<String>,
    /// The single read-only SELECT that samples currently-running statements.
    pub sql: String,
    /// UI floor for the poll interval (ms). Polling faster than this would add
    /// avoidable load without meaningfully improving fidelity.
    pub min_interval_ms: u32,
}

/// Serialize a `DatabaseType` to its stable lowercase key (e.g. `postgresql`).
fn engine_key(db_type: DatabaseType) -> String {
    serde_json::to_value(db_type)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

/// Resolve the active-session probe for an engine, or a clear roadmap error for
/// engines the live profiler does not sample yet.
pub fn profiler_probe_for_database_type(db_type: DatabaseType) -> Result<ProfilerProbe, String> {
    let columns = PROFILER_COLUMNS.iter().map(|name| name.to_string()).collect();
    match db_type {
        DatabaseType::PostgreSQL | DatabaseType::Greenplum => Ok(ProfilerProbe {
            engine: engine_key(db_type),
            source: "pg_stat_activity — active backends".to_string(),
            columns,
            sql: POSTGRES_PROBE_SQL.to_string(),
            min_interval_ms: 500,
        }),
        DatabaseType::MySQL | DatabaseType::MariaDB => Ok(ProfilerProbe {
            engine: engine_key(db_type),
            source: "information_schema.PROCESSLIST — active threads".to_string(),
            columns,
            sql: MYSQL_PROBE_SQL.to_string(),
            min_interval_ms: 500,
        }),
        DatabaseType::MSSQL => Ok(ProfilerProbe {
            engine: engine_key(db_type),
            source: "sys.dm_exec_requests — active requests".to_string(),
            columns,
            sql: MSSQL_PROBE_SQL.to_string(),
            min_interval_ms: 500,
        }),
        other => Err(format!(
            "The live profiler currently samples PostgreSQL, MySQL/MariaDB, and SQL Server. \
             {} support is on the roadmap (statement-store aggregates and native traces land \
             in later phases).",
            engine_key(other)
        )),
    }
}

/// Return the read-only probe used to poll a connection's live activity. The
/// frontend runs the returned SQL through the normal `execute_query` path (which
/// still enforces Safe Mode) on a timer and accumulates the trace client-side.
#[tauri::command]
pub async fn get_profiler_probe(
    connection_id: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<ProfilerProbe, String> {
    let db_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    profiler_probe_for_database_type(db_type)
}

/// A read-only probe that reads an engine's statement store to rank the most
/// expensive queries by cumulative execution time. Unlike the live probe this
/// is not polled on a tight timer — the frontend runs it on demand / manual
/// refresh — but it shares the same "SQL aliased to canonical columns" contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopQueriesProbe {
    /// Stable lowercase engine key (matches the serialized `DatabaseType`).
    pub engine: String,
    /// Human-readable description of which statement store is being read.
    pub source: String,
    /// The canonical column names the SQL aliases to, in contract order.
    pub columns: Vec<String>,
    /// The single read-only SELECT that ranks the statement store.
    pub sql: String,
    /// Operator-facing prerequisite the store depends on (e.g. an extension),
    /// surfaced in the UI so an empty/erroring result is self-explanatory.
    pub requires: String,
}

/// Resolve the top-queries probe for an engine, or a clear roadmap error for
/// engines whose statement store the profiler does not read yet.
pub fn top_queries_probe_for_database_type(
    db_type: DatabaseType,
) -> Result<TopQueriesProbe, String> {
    let columns = TOP_QUERY_COLUMNS.iter().map(|name| name.to_string()).collect();
    match db_type {
        DatabaseType::PostgreSQL | DatabaseType::Greenplum => Ok(TopQueriesProbe {
            engine: engine_key(db_type),
            source: "pg_stat_statements — cumulative statement stats".to_string(),
            columns,
            sql: POSTGRES_TOP_QUERIES_SQL.to_string(),
            requires: "The pg_stat_statements extension must be installed (CREATE EXTENSION \
                        pg_stat_statements) and preloaded via shared_preload_libraries."
                .to_string(),
        }),
        DatabaseType::MySQL | DatabaseType::MariaDB => Ok(TopQueriesProbe {
            engine: engine_key(db_type),
            source: "performance_schema — statement digest summary".to_string(),
            columns,
            sql: MYSQL_TOP_QUERIES_SQL.to_string(),
            requires: "performance_schema must be enabled (it is on by default) with statement \
                        digest instrumentation active."
                .to_string(),
        }),
        DatabaseType::MSSQL => Ok(TopQueriesProbe {
            engine: engine_key(db_type),
            source: "sys.dm_exec_query_stats — cached plan stats".to_string(),
            columns,
            sql: MSSQL_TOP_QUERIES_SQL.to_string(),
            requires: "Reads cached plan statistics; entries evicted from the plan cache are \
                        not shown, and VIEW SERVER STATE permission is required."
                .to_string(),
        }),
        other => Err(format!(
            "Top Queries currently reads the statement store for PostgreSQL, MySQL/MariaDB, and \
             SQL Server. {} support is on the roadmap.",
            engine_key(other)
        )),
    }
}

/// Return the read-only probe used to rank a connection's most expensive
/// statements. The frontend runs the returned SQL through the normal
/// `execute_query` path (which still enforces Safe Mode) on demand.
#[tauri::command]
pub async fn get_top_queries_probe(
    connection_id: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<TopQueriesProbe, String> {
    let db_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    top_queries_probe_for_database_type(db_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUPPORTED: [DatabaseType; 5] = [
        DatabaseType::PostgreSQL,
        DatabaseType::Greenplum,
        DatabaseType::MySQL,
        DatabaseType::MariaDB,
        DatabaseType::MSSQL,
    ];

    #[test]
    fn supported_engines_alias_every_canonical_column() {
        for db in SUPPORTED {
            let probe = profiler_probe_for_database_type(db).unwrap();
            for column in PROFILER_COLUMNS {
                assert!(
                    probe.sql.contains(&format!("AS {column}")),
                    "engine {db:?} probe is missing canonical column {column}"
                );
            }
            assert_eq!(probe.columns.len(), PROFILER_COLUMNS.len());
            assert!(probe.min_interval_ms >= 250);
            assert!(!probe.engine.is_empty());
            assert!(!probe.source.is_empty());
        }
    }

    #[test]
    fn probes_exclude_the_profilers_own_session() {
        assert!(profiler_probe_for_database_type(DatabaseType::PostgreSQL)
            .unwrap()
            .sql
            .contains("pg_backend_pid()"));
        assert!(profiler_probe_for_database_type(DatabaseType::MySQL)
            .unwrap()
            .sql
            .contains("CONNECTION_ID()"));
        assert!(profiler_probe_for_database_type(DatabaseType::MSSQL)
            .unwrap()
            .sql
            .contains("@@SPID"));
    }

    #[test]
    fn probes_are_single_read_only_statements() {
        for db in SUPPORTED {
            let sql = profiler_probe_for_database_type(db).unwrap().sql;
            let upper = sql.to_uppercase();
            assert!(
                upper.trim_start().starts_with("SELECT"),
                "engine {db:?} probe must start with SELECT"
            );
            for mutating in [
                "INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER ", "CREATE ", "TRUNCATE ",
            ] {
                assert!(
                    !upper.contains(mutating),
                    "engine {db:?} probe must be read-only but contains {mutating}"
                );
            }
            assert!(
                !sql.contains(';'),
                "engine {db:?} probe must be a single statement (no semicolons)"
            );
        }
    }

    #[test]
    fn unsupported_engines_report_a_clear_roadmap_error() {
        let error = profiler_probe_for_database_type(DatabaseType::SQLite).unwrap_err();
        assert!(error.contains("live profiler"));
        assert!(error.contains("sqlite"));
        assert!(profiler_probe_for_database_type(DatabaseType::MongoDB).is_err());
        assert!(profiler_probe_for_database_type(DatabaseType::Redis).is_err());
    }

    #[test]
    fn engine_key_is_the_lowercase_serialized_type() {
        assert_eq!(engine_key(DatabaseType::PostgreSQL), "postgresql");
        assert_eq!(engine_key(DatabaseType::MSSQL), "mssql");
        assert_eq!(engine_key(DatabaseType::MariaDB), "mariadb");
    }

    #[test]
    fn top_queries_probes_alias_every_canonical_column() {
        for db in SUPPORTED {
            let probe = top_queries_probe_for_database_type(db).unwrap();
            for column in TOP_QUERY_COLUMNS {
                assert!(
                    probe.sql.contains(&format!("AS {column}")),
                    "engine {db:?} top-queries probe is missing canonical column {column}"
                );
            }
            assert_eq!(probe.columns.len(), TOP_QUERY_COLUMNS.len());
            assert!(!probe.engine.is_empty());
            assert!(!probe.source.is_empty());
            assert!(!probe.requires.is_empty());
        }
    }

    #[test]
    fn top_queries_probes_read_the_expected_statement_store() {
        assert!(top_queries_probe_for_database_type(DatabaseType::PostgreSQL)
            .unwrap()
            .sql
            .contains("pg_stat_statements"));
        assert!(top_queries_probe_for_database_type(DatabaseType::MySQL)
            .unwrap()
            .sql
            .contains("events_statements_summary_by_digest"));
        assert!(top_queries_probe_for_database_type(DatabaseType::MSSQL)
            .unwrap()
            .sql
            .contains("dm_exec_query_stats"));
    }

    #[test]
    fn top_queries_probes_are_single_read_only_statements() {
        for db in SUPPORTED {
            let sql = top_queries_probe_for_database_type(db).unwrap().sql;
            let upper = sql.to_uppercase();
            assert!(
                upper.trim_start().starts_with("SELECT"),
                "engine {db:?} top-queries probe must start with SELECT"
            );
            for mutating in [
                "INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER ", "CREATE ", "TRUNCATE ",
            ] {
                assert!(
                    !upper.contains(mutating),
                    "engine {db:?} top-queries probe must be read-only but contains {mutating}"
                );
            }
            assert!(
                !sql.contains(';'),
                "engine {db:?} top-queries probe must be a single statement (no semicolons)"
            );
        }
    }

    #[test]
    fn top_queries_unsupported_engines_report_a_clear_roadmap_error() {
        let error = top_queries_probe_for_database_type(DatabaseType::SQLite).unwrap_err();
        assert!(error.contains("Top Queries"));
        assert!(error.contains("sqlite"));
        assert!(top_queries_probe_for_database_type(DatabaseType::MongoDB).is_err());
        assert!(top_queries_probe_for_database_type(DatabaseType::Redis).is_err());
    }
}
