use crate::database::manager::DatabaseManager;
use crate::database::models::DatabaseType;
use crate::utils::sql::split_sql_statements;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub statement_count: usize,
    pub schema_change_count: usize,
    pub data_change_count: usize,
    pub destructive_statement_count: usize,
    pub transactional: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub statement_count: usize,
    pub affected_rows: u64,
    pub transactional: bool,
}

/// Builds a deterministic restore plan before any write reaches the selected database.
#[tauri::command]
pub fn preview_database_restore(
    sql: String,
    db_type: DatabaseType,
) -> Result<RestorePreview, String> {
    if db_type == DatabaseType::OpenSearch {
        return Err(
            "SQL restore is not supported by the read-only OpenSearch plugin driver.".to_string(),
        );
    }
    let statements = split_sql_statements(&sql);
    if statements.is_empty() {
        return Err("The restore file does not contain any SQL statements.".to_string());
    }

    let schema_change_count = statements
        .iter()
        .filter(|statement| is_schema_change(statement))
        .count();
    let data_change_count = statements
        .iter()
        .filter(|statement| is_data_change(statement))
        .count();
    let destructive_statement_count = statements
        .iter()
        .filter(|statement| is_destructive(statement))
        .count();
    let transactional = supports_transactional_restore(db_type);

    Ok(RestorePreview {
        statement_count: statements.len(),
        schema_change_count,
        data_change_count,
        destructive_statement_count,
        transactional,
        warning: (!transactional).then(|| {
            "This database can auto-commit schema changes during restore. TableR will stop at the first error, but earlier changes may remain.".to_string()
        }),
    })
}

#[tauri::command]
pub async fn restore_database_sql(
    connection_id: String,
    sql: String,
    db_type: DatabaseType,
    db_manager: State<'_, DatabaseManager>,
) -> Result<RestoreResult, String> {
    if db_type == DatabaseType::OpenSearch {
        return Err(
            "SQL restore is not supported by the read-only OpenSearch plugin driver.".to_string(),
        );
    }
    let statements = split_sql_statements(&sql);
    if statements.is_empty() {
        return Err("The restore file does not contain any SQL statements.".to_string());
    }
    let transactional = supports_transactional_restore(db_type);
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| format!("The selected connection is not active: {error}"))?;
    let affected_rows = driver
        .execute_restore_statements(&statements)
        .await
        .map_err(|error| format!("Restore stopped before completion: {error}"))?;

    Ok(RestoreResult {
        statement_count: statements.len(),
        affected_rows,
        transactional,
    })
}

fn normalized_statement(statement: &str) -> String {
    statement
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_ascii_uppercase()
}

fn is_schema_change(statement: &str) -> bool {
    let normalized = normalized_statement(statement);
    ["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME"]
        .iter()
        .any(|keyword| normalized.starts_with(keyword))
}

fn is_data_change(statement: &str) -> bool {
    let normalized = normalized_statement(statement);
    ["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"]
        .iter()
        .any(|keyword| normalized.starts_with(keyword))
}

fn is_destructive(statement: &str) -> bool {
    let normalized = normalized_statement(statement);
    ["DROP", "TRUNCATE", "DELETE", "ALTER TABLE"]
        .iter()
        .any(|keyword| normalized.starts_with(keyword))
}

fn supports_transactional_restore(db_type: DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Redshift
            | DatabaseType::SQLite
            | DatabaseType::DuckDB
            | DatabaseType::LibSQL
            | DatabaseType::CloudflareD1
    )
}

#[cfg(test)]
mod tests {
    use super::preview_database_restore;
    use crate::database::driver::DatabaseDriver;
    use crate::database::models::ConnectionConfig;
    use crate::database::models::DatabaseType;
    use crate::database::mysql::MySqlDriver;
    use crate::database::postgres::PostgresDriver;
    use sqlx::{Connection, Executor, Row, SqliteConnection};
    use uuid::Uuid;

    fn integration_config(
        db_type: DatabaseType,
        prefix: &str,
        default_port: u16,
    ) -> ConnectionConfig {
        let variable = |name: &str| {
            std::env::var(format!("TABLER_TEST_{prefix}_{name}")).unwrap_or_else(|_| {
                panic!("TABLER_TEST_{prefix}_{name} must be set for this integration test")
            })
        };
        ConnectionConfig {
            name: format!("{prefix} restore integration"),
            db_type,
            host: Some(variable("HOST")),
            port: Some(
                std::env::var(format!("TABLER_TEST_{prefix}_PORT"))
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(default_port),
            ),
            username: Some(variable("USER")),
            password: Some(variable("PASSWORD")),
            database: Some(variable("DATABASE")),
            ..ConnectionConfig::default()
        }
    }

    #[test]
    fn preview_counts_sql_dump_changes_and_marks_mysql_best_effort() {
        let preview = preview_database_restore(
            "-- backup\nCREATE TABLE users (id INTEGER); INSERT INTO users VALUES (1); DROP TABLE old_users;".to_string(),
            DatabaseType::MySQL,
        )
        .unwrap();

        assert_eq!(preview.statement_count, 3);
        assert_eq!(preview.schema_change_count, 2);
        assert_eq!(preview.data_change_count, 1);
        assert_eq!(preview.destructive_statement_count, 1);
        assert!(!preview.transactional);
        assert!(preview.warning.is_some());
    }

    #[test]
    fn opensearch_rejects_sql_restore_during_preview() {
        let error =
            preview_database_restore("CREATE INDEX users".to_string(), DatabaseType::OpenSearch)
                .unwrap_err();

        assert!(error.contains("read-only OpenSearch plugin driver"));
    }

    #[tokio::test]
    async fn sqlite_backup_statements_restore_inside_a_transaction() {
        let sql = "PRAGMA foreign_keys = OFF; CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO people (id, name) VALUES (1, 'Ada'); PRAGMA foreign_keys = ON;";
        let preview = preview_database_restore(sql.to_string(), DatabaseType::SQLite).unwrap();
        assert!(preview.transactional);

        let mut connection = SqliteConnection::connect(":memory:").await.unwrap();
        connection.execute("BEGIN").await.unwrap();
        for statement in crate::utils::sql::split_sql_statements(sql) {
            connection.execute(statement.as_str()).await.unwrap();
        }
        connection.execute("COMMIT").await.unwrap();

        let count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM people")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .get("count");
        assert_eq!(count, 1);
    }

    #[tokio::test]
    #[ignore = "requires a PostgreSQL service and TABLER_TEST_POSTGRES_* environment variables"]
    async fn postgres_restore_rolls_back_schema_and_data_after_a_failure() {
        let driver = PostgresDriver::connect(&integration_config(
            DatabaseType::PostgreSQL,
            "POSTGRES",
            5432,
        ))
        .await
        .unwrap();
        let table = format!("tabler_restore_{}", Uuid::new_v4().simple());
        let statements = vec![
            format!("CREATE TABLE {table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"),
            format!("INSERT INTO {table} (id, name) VALUES (1, 'Ada')"),
            format!("INSERT INTO {table}_missing (id) VALUES (1)"),
        ];

        assert!(driver
            .execute_restore_statements(&statements)
            .await
            .is_err());
        let result = driver
            .execute_query(&format!(
                "SELECT to_regclass('public.{table}') AS table_name"
            ))
            .await
            .unwrap();
        assert!(
            result.rows[0][0].is_null(),
            "the failed restore must roll back CREATE TABLE"
        );
    }

    #[tokio::test]
    #[ignore = "requires a MySQL service and TABLER_TEST_MYSQL_* environment variables"]
    async fn mysql_restore_applies_schema_and_data_to_a_live_server() {
        let driver = MySqlDriver::connect(&integration_config(DatabaseType::MySQL, "MYSQL", 3306))
            .await
            .unwrap();
        let table = format!("tabler_restore_{}", Uuid::new_v4().simple());
        let statements = vec![
            "SET FOREIGN_KEY_CHECKS=0".to_string(),
            format!("CREATE TABLE `{table}` (id INTEGER PRIMARY KEY, name VARCHAR(64) NOT NULL)"),
            format!("INSERT INTO `{table}` (id, name) VALUES (1, 'Ada')"),
            "SET FOREIGN_KEY_CHECKS=1".to_string(),
        ];

        driver
            .execute_restore_statements(&statements)
            .await
            .unwrap();
        let result = driver
            .execute_query(&format!("SELECT COUNT(*) AS count FROM `{table}`"))
            .await
            .unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!(1));
        driver
            .execute_query(&format!("DROP TABLE IF EXISTS `{table}`"))
            .await
            .unwrap();
    }
}
