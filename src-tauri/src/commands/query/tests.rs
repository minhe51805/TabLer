use super::sandbox::{
    cap_sandbox_result, timeout_for_statements, validate_sandbox_batch, validate_sandbox_statement,
};
use super::QueryCancellationState;
use crate::config::{mutating_query_timeout, read_only_query_timeout};
use crate::database::models::QueryResult;
use tokio_util::sync::CancellationToken;

fn result_with_rows(count: usize) -> QueryResult {
    QueryResult {
        columns: Vec::new(),
        rows: (0..count)
            .map(|index| vec![serde_json::Value::from(index as i64)])
            .collect(),
        affected_rows: 0,
        execution_time_ms: 0,
        query: String::new(),
        sandboxed: true,
        truncated: false,
    }
}

#[test]
fn sandbox_gateway_blocks_filesystem_and_network_sql() {
    // These parse as reads but reach the local filesystem / network / OS —
    // the sandbox must reject them before the driver is ever touched.
    assert!(validate_sandbox_statement("SELECT pg_read_file('/etc/passwd')", None).is_err());
    assert!(validate_sandbox_statement("SELECT load_file('/etc/passwd')", None).is_err());
    assert!(
        validate_sandbox_statement("SELECT * FROM read_csv('/home/u/.ssh/id_rsa')", None).is_err()
    );
    assert!(validate_sandbox_statement("SELECT * FROM users INTO OUTFILE '/tmp/u'", None).is_err());
    // A benign read with a lookalike column name must still pass.
    assert!(validate_sandbox_statement("SELECT read_csv_notes FROM reports", None).is_ok());
}

#[test]
fn cap_sandbox_result_truncates_rows_and_flags_truncated() {
    let mut result = result_with_rows(10);
    cap_sandbox_result(&mut result, 4, usize::MAX);
    assert_eq!(result.rows.len(), 4);
    assert!(result.truncated);

    // Under the caps: nothing dropped, flag stays false.
    let mut small = result_with_rows(3);
    cap_sandbox_result(&mut small, 5000, usize::MAX);
    assert_eq!(small.rows.len(), 3);
    assert!(!small.truncated);

    // Byte cap keeps at least one row even when the first row alone exceeds it.
    let mut byte_capped = result_with_rows(10);
    cap_sandbox_result(&mut byte_capped, 5000, 1);
    assert_eq!(byte_capped.rows.len(), 1);
    assert!(byte_capped.truncated);
}

#[test]
fn sandbox_uses_canonical_classifier_for_edge_cases() {
    assert!(validate_sandbox_statement("-- inspect\nSELECT 1", None).is_ok());
    assert!(validate_sandbox_statement(
        "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed",
        None
    )
    .is_ok());
    assert!(validate_sandbox_statement("SET search_path TO public", None).is_err());
    assert!(validate_sandbox_statement("SELECT 1; SELECT 2", None).is_err());
    assert!(validate_sandbox_statement("-- no executable SQL", None).is_err());
}

#[test]
fn mysql_server_commands_classify_readonly_under_mysql_dialect() {
    use crate::database::models::DatabaseType;
    // SHOW FULL PROCESSLIST fails the generic parser; the MySQL dialect
    // (plus the read-only server-command fallback) must classify it as a
    // read so the process-list preset works on MySQL/MariaDB.
    let decision = validate_sandbox_batch(
        &["SHOW FULL PROCESSLIST".to_string()],
        true,
        Some(DatabaseType::MySQL),
    );
    assert!(
        decision.is_ok(),
        "mysql process-list preset must pass: {decision:?}"
    );
    assert!(validate_sandbox_batch(&["SHOW FULL PROCESSLIST".to_string()], true, None).is_err());
    // The fallback must not widen the boundary to mutations.
    assert!(validate_sandbox_batch(
        &["UPDATE users SET name = 'x'".to_string()],
        true,
        Some(DatabaseType::MySQL),
    )
    .is_err());
}

#[test]
fn read_only_sandbox_rejects_mutating_ctes() {
    let mutating =
        vec!["WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed".to_string()];
    assert!(validate_sandbox_batch(&mutating, true, None).is_err());
    assert!(validate_sandbox_batch(&mutating, false, None).is_ok());
}

#[test]
fn agent_readonly_boundary_blocks_mutations_and_allows_reads() {
    // `execute_agent_readonly_query` pins require_read_only = true, so the
    // shared batch validator must accept plain reads while rejecting every
    // mutating or schema-changing statement regardless of caller intent.
    assert!(validate_sandbox_batch(&["SELECT 1".to_string()], true, None).is_ok());
    assert!(validate_sandbox_batch(&["EXPLAIN SELECT 1".to_string()], true, None).is_ok());
    assert!(
        validate_sandbox_batch(&["UPDATE users SET name = 'x'".to_string()], true, None).is_err()
    );
    assert!(validate_sandbox_batch(&["DELETE FROM users".to_string()], true, None).is_err());
    assert!(validate_sandbox_batch(&["DROP TABLE users".to_string()], true, None).is_err());
    assert!(validate_sandbox_batch(
        &["INSERT INTO users(name) VALUES('x')".to_string()],
        true,
        None
    )
    .is_err());
}

#[test]
fn agent_parameterized_boundary_blocks_mutations_and_keeps_placeholders() {
    // The agent parameterized boundary pins read-only exactly like
    // `execute_agent_readonly_query`; placeholders must not slip past the
    // guard, and mutations are rejected before compilation.
    assert!(validate_sandbox_batch(
        &["SELECT * FROM users WHERE name = :name".to_string()],
        true,
        None,
    )
    .is_ok());
    assert!(
        validate_sandbox_batch(&["UPDATE users SET name = :name".to_string()], true, None).is_err()
    );
    assert!(validate_sandbox_batch(
        &["DELETE FROM users WHERE id = :id".to_string()],
        true,
        None
    )
    .is_err());
    assert!(validate_sandbox_batch(
        &["SELECT 1; DELETE FROM users WHERE id = :id".to_string()],
        true,
        None
    )
    .is_err());
}

#[test]
fn chunk_rows_covers_all_rows_with_bounded_batches() {
    use super::chunk_rows;
    assert!(chunk_rows(0, 500).is_empty());
    assert_eq!(chunk_rows(5, 500), vec![(0, 5)]);
    assert_eq!(
        chunk_rows(1_100, 500),
        vec![(0, 500), (500, 1_000), (1_000, 1_100)]
    );
    // chunk_size is sanitized by the caller, but the helper stays safe anyway.
    assert_eq!(chunk_rows(3, 0), vec![(0, 1), (1, 2), (2, 3)]);
}

#[tokio::test]
async fn agent_readonly_command_rejects_mutating_sql_that_looks_harmless() {
    // Same pin `execute_agent_readonly_query` hard-codes. These statements
    // start like reads (WITH/SELECT-shaped) or look like "just SQL", but
    // the boundary must still refuse them before a driver is involved.
    let rejected = [
        "UPDATE users SET name = 'x'",
        "DELETE FROM users",
        "DROP TABLE users",
        "ALTER TABLE users ADD COLUMN x INT",
        "INSERT INTO users(name) VALUES('x')",
        "TRUNCATE TABLE users",
        "CREATE TABLE x (id INT)",
        "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed",
        "SELECT 1; DELETE FROM users",
    ];
    for sql in rejected {
        assert!(
            validate_sandbox_batch(&[sql.to_string()], true, None).is_err(),
            "agent read-only boundary must reject {sql}"
        );
    }
    assert!(validate_sandbox_batch(&["SELECT 1".to_string()], true, None).is_ok());
    assert!(validate_sandbox_batch(
        &["WITH x AS (SELECT 1) SELECT * FROM x".to_string()],
        true,
        None
    )
    .is_ok());
}

#[tokio::test]
async fn cancellation_registry_replaces_and_cancels_active_requests() {
    let state = QueryCancellationState::default();
    let first = CancellationToken::new();
    let second = CancellationToken::new();

    state.register("query-1", first.clone()).await;
    state.register("query-1", second.clone()).await;
    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());

    assert!(state.cancel("query-1").await);
    assert!(second.is_cancelled());
    state.finish("query-1").await;
    assert!(!state.cancel("query-1").await);
}

#[test]
fn timeout_uses_read_only_window_only_for_read_batches() {
    assert_eq!(
        timeout_for_statements(["SELECT 1"].into_iter(), None),
        read_only_query_timeout()
    );
    assert_eq!(
        timeout_for_statements(["SELECT 1", "SELECT 2"].into_iter(), None),
        read_only_query_timeout()
    );
    assert_eq!(
        timeout_for_statements(["UPDATE users SET name = 'x'"].into_iter(), None),
        mutating_query_timeout()
    );
    assert_eq!(
        timeout_for_statements(["SELECT 1", "DELETE FROM users"].into_iter(), None),
        mutating_query_timeout()
    );
    assert_eq!(
        timeout_for_statements(
            ["WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed"].into_iter(),
            None
        ),
        mutating_query_timeout()
    );
}

#[tokio::test]
async fn read_only_connection_rejects_writes_and_allows_reads() {
    // The per-connection pin must hold at the earliest command guard: a
    // read-only session runs SELECTs but refuses every mutating or
    // unclassifiable statement before the driver is touched.
    let root = std::env::temp_dir().join(format!("tabler-readonly-guard-{}", uuid::Uuid::new_v4()));
    let storage = crate::storage::plugin_storage::PluginStorage::from_data_dir(root.clone())
        .expect("plugin storage");
    let manager = crate::database::manager::DatabaseManager::with_plugin_storage(storage);
    let config = crate::database::models::ConnectionConfig {
        id: "ro-sqlite".to_string(),
        name: "RO SQLite".to_string(),
        db_type: crate::database::models::DatabaseType::SQLite,
        file_path: Some(":memory:".to_string()),
        read_only: true,
        ..crate::database::models::ConnectionConfig::default()
    };
    manager.connect(&config).await.expect("connect sqlite");

    assert!(
        super::assert_connection_writable_sql(&manager, &config.id, "SELECT 1")
            .await
            .is_ok()
    );
    for sql in [
        "INSERT INTO t VALUES (1)",
        "UPDATE t SET a = 1",
        "DELETE FROM t",
        "CREATE TABLE t (id INT)",
        "DROP TABLE t",
        "SELECT 1; DELETE FROM t",
        "this is not sql",
    ] {
        let error = super::assert_connection_writable_sql(&manager, &config.id, sql)
            .await
            .expect_err("read-only connection must reject writes");
        assert!(
            error.to_string().contains("read-only"),
            "expected read-only error for `{sql}`, got: {error}"
        );
    }
    // The blanket write guard fires for write-only commands too.
    let error = manager
        .assert_write_allowed(&config.id)
        .await
        .expect_err("write commands must be blocked");
    assert!(error.contains("read-only"));

    manager.disconnect(&config.id).await.expect("disconnect");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn writable_connection_passes_the_read_only_guard() {
    // Same harness, pin unset: the guard must not interfere with normal
    // connections regardless of statement kind.
    let root = std::env::temp_dir().join(format!("tabler-writable-guard-{}", uuid::Uuid::new_v4()));
    let storage = crate::storage::plugin_storage::PluginStorage::from_data_dir(root.clone())
        .expect("plugin storage");
    let manager = crate::database::manager::DatabaseManager::with_plugin_storage(storage);
    let config = crate::database::models::ConnectionConfig {
        id: "rw-sqlite".to_string(),
        name: "RW SQLite".to_string(),
        db_type: crate::database::models::DatabaseType::SQLite,
        file_path: Some(":memory:".to_string()),
        ..crate::database::models::ConnectionConfig::default()
    };
    manager.connect(&config).await.expect("connect sqlite");
    assert!(
        super::assert_connection_writable_sql(&manager, &config.id, "DELETE FROM t")
            .await
            .is_ok()
    );
    assert!(manager.assert_write_allowed(&config.id).await.is_ok());
    manager.disconnect(&config.id).await.expect("disconnect");
    let _ = std::fs::remove_dir_all(root);
}
