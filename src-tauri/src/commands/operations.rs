use crate::database::manager::DatabaseManager;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationalQuery {
    pub id: String,
    pub label: String,
    pub description: String,
    pub sql: String,
}

fn query(id: &str, label: &str, description: &str, sql: &str) -> OperationalQuery {
    OperationalQuery {
        id: id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        sql: sql.to_string(),
    }
}

pub fn operational_queries_for_driver(driver: &str) -> Result<Vec<OperationalQuery>, String> {
    match driver {
        "postgresql" | "greenplum" | "cockroachdb" | "redshift" | "vertica" => Ok(vec![
            query("sessions", "Sessions", "Connections grouped by state", "SELECT state, COUNT(*) AS sessions FROM pg_stat_activity GROUP BY state ORDER BY sessions DESC"),
            query("long-queries", "Long queries", "Queries running longer than five seconds", "SELECT pid, usename, application_name, now() - query_start AS running_for, wait_event_type, query FROM pg_stat_activity WHERE state <> 'idle' AND query_start IS NOT NULL AND now() - query_start > interval '5 seconds' ORDER BY query_start ASC LIMIT 100"),
            query("locks", "Lock waits", "Blocked and waiting locks", "SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid, blocked.query AS blocked_query, blocking.query AS blocking_query FROM pg_locks blocked_locks JOIN pg_stat_activity blocked ON blocked.pid = blocked_locks.pid JOIN pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation AND blocking_locks.pid <> blocked_locks.pid JOIN pg_stat_activity blocking ON blocking.pid = blocking_locks.pid WHERE NOT blocked_locks.granted AND blocking_locks.granted LIMIT 100"),
            query("health", "Server health", "Server version, recovery state, and active connections", "SELECT version() AS version, pg_is_in_recovery() AS in_recovery, (SELECT COUNT(*) FROM pg_stat_activity) AS connections"),
        ]),
        "mysql" | "mariadb" => Ok(vec![
            query("sessions", "Sessions", "Open sessions grouped by command", "SELECT COMMAND AS command, COUNT(*) AS sessions FROM information_schema.PROCESSLIST GROUP BY COMMAND ORDER BY sessions DESC"),
            query("long-queries", "Long queries", "Queries running longer than five seconds", "SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep' AND TIME >= 5 ORDER BY TIME DESC LIMIT 100"),
            query("locks", "Lock waits", "InnoDB lock waits when performance_schema is available", "SELECT * FROM performance_schema.data_lock_waits LIMIT 100"),
            query("health", "Server health", "Uptime and connection counters", "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected', 'Threads_running', 'Max_used_connections')"),
        ]),
        _ => Err(format!("Operations dashboard is currently available for PostgreSQL and MySQL/MariaDB, not {driver}.")),
    }
}

#[tauri::command]
pub async fn get_operational_queries(
    connection_id: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<OperationalQuery>, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    operational_queries_for_driver(driver.driver_name())
}

#[cfg(test)]
mod tests {
    use super::operational_queries_for_driver;

    #[test]
    fn postgres_dashboard_has_all_observability_sections() {
        let queries = operational_queries_for_driver("postgresql").unwrap();
        assert_eq!(queries.len(), 4);
        assert!(queries.iter().any(|item| item.id == "locks"));
        assert!(queries
            .iter()
            .all(|item| item.sql.trim_start().starts_with("SELECT")));
    }

    #[test]
    fn mysql_dashboard_has_all_observability_sections() {
        let queries = operational_queries_for_driver("mysql").unwrap();
        assert_eq!(queries.len(), 4);
        assert!(queries.iter().any(|item| item.id == "sessions"));
        assert!(queries.iter().any(|item| item.id == "locks"));
    }

    #[test]
    fn dashboard_clearly_rejects_unsupported_engines() {
        assert!(operational_queries_for_driver("sqlite").is_err());
    }
}
