//! Real-server integration tests for every self-hostable database driver.
//!
//! These go through the app's actual driver code paths
//! (`XxxDriver::connect` -> ping -> real round trips), not mocks.
//!
//! Usage:
//!   docker compose -f docker-compose.integration.yml up -d --wait
//!   TABLER_DRIVER_INTEGRATION=1 cargo test --test driver_integration
//!
//! Heavy engines additionally need the `heavy` compose profile and opt-in env:
//!   TABLER_IT_MSSQL=1, TABLER_IT_CASSANDRA=1

use std::sync::Arc;
use std::time::{Duration, Instant};

use tabler_lib::database::models::{ConnectionConfig, DatabaseType};
use tabler_lib::database::{
    cassandra::CassandraDriver, clickhouse::ClickHouseDriver, driver::DatabaseDriver,
    duckdb::DuckDbDriver, mongodb::MongoDbDriver, mssql::MssqlDriver, mysql::MySqlDriver,
    postgres::PostgresDriver, redis::RedisDriver,
};

fn integration_enabled() -> bool {
    matches!(
        std::env::var("TABLER_DRIVER_INTEGRATION").as_deref(),
        Ok("1") | Ok("true")
    )
}

fn base_config(db_type: DatabaseType) -> ConnectionConfig {
    ConnectionConfig {
        id: "integration-test".to_string(),
        name: "integration-test".to_string(),
        db_type,
        host: None,
        port: None,
        username: None,
        password: None,
        database: None,
        file_path: None,
        use_ssl: false,
        ssl_mode: None,
        ssl_ca_cert_path: None,
        ssl_client_cert_path: None,
        ssl_client_key_path: None,
        ssl_skip_host_verification: None,
        color: None,
        additional_fields: Default::default(),
        pre_connect_script: None,
        startup_commands: None,
        ssh_config: None,
    }
}

/// Keep trying `connect` until a freshly started container accepts us.
async fn retry_connect<T, F, Fut>(attempts: u32, mut make_future: F) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut last_err = None;
    for _ in 0..attempts {
        match make_future().await {
            Ok(value) => return Ok(value),
            Err(err) => {
                last_err = Some(err);
                tokio::time::sleep(Duration::from_millis(2000)).await;
            }
        }
    }
    Err(anyhow::anyhow!(
        "connect never became ready after {attempts} attempts: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

fn sql_config(db_type: DatabaseType, port: u16, database: &str) -> ConnectionConfig {
    let mut config = base_config(db_type);
    config.host = Some("127.0.0.1".to_string());
    config.port = Some(port);
    config.username = Some("tabler".to_string());
    config.password = Some("tabler".to_string());
    config.database = Some(database.to_string());
    config
}

// ─── SQLite + DuckDB (no server needed; prove file round-trips locally) ────

#[tokio::test]
async fn sqlite_file_round_trip_lifecycle() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }

    let path = std::env::temp_dir().join(format!("tabler-it-sqlite-{}.db", std::process::id()));
    let driver = tabler_lib::database::sqlite::SqliteDriver::connect(path.to_str().unwrap())
        .await
        .expect("SQLite connect");
    driver.ping().await.expect("SQLite ping");

    driver
        .execute_query(
            "CREATE TABLE IF NOT EXISTS tabler_it_sqlite (id INTEGER PRIMARY KEY, name TEXT)",
        )
        .await
        .expect("create");
    for i in 1..=3 {
        driver
            .execute_query(&format!(
                "INSERT INTO tabler_it_sqlite (id, name) VALUES ({i}, 'row-{i}')"
            ))
            .await
            .expect("insert");
    }
    assert_eq!(
        driver
            .count_rows("tabler_it_sqlite", None)
            .await
            .expect("count"),
        3
    );

    driver
        .execute_query("UPDATE tabler_it_sqlite SET name = 'updated' WHERE id = 1")
        .await
        .expect("update");
    driver
        .execute_query("DELETE FROM tabler_it_sqlite WHERE id = 3")
        .await
        .expect("delete");
    assert_eq!(
        driver
            .count_rows("tabler_it_sqlite", None)
            .await
            .expect("count after delete"),
        2
    );

    let tables = driver.list_tables(None).await.expect("list_tables");
    assert!(tables.iter().any(|t| t.name == "tabler_it_sqlite"));

    let _ = driver.disconnect().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn duckdb_file_round_trip_lifecycle() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }

    let path = std::env::temp_dir().join(format!("tabler-it-duckdb-{}.duckdb", std::process::id()));
    let mut config = base_config(DatabaseType::DuckDB);
    config.file_path = Some(path.to_string_lossy().into_owned());

    let driver = retry_connect(5, || async { DuckDbDriver::connect(&config).await })
        .await
        .expect("DuckDB connect");
    driver.ping().await.expect("DuckDB ping");

    driver
        .execute_query("CREATE OR REPLACE TABLE tabler_it_duck (id INTEGER, name VARCHAR)")
        .await
        .expect("create");
    driver
        .execute_query("INSERT INTO tabler_it_duck VALUES (1,'a'),(2,'b'),(3,'c')")
        .await
        .expect("insert");
    assert_eq!(
        driver
            .count_rows("tabler_it_duck", None)
            .await
            .expect("count"),
        3
    );

    let _ = driver.disconnect().await;
    let _ = std::fs::remove_file(&path);
}

// ─── SQL engines: one full CRUD contract executed through each driver ──────

async fn sql_lifecycle(
    engine: &'static str,
    db_type: DatabaseType,
    port: u16,
    database: &str,
    table: &str,
    create_sql: &str,
    insert_sql: &str,
) {
    let config = sql_config(db_type, port, database);

    // Generic driver entry point so the trait object path is exercised too.
    let connect_driver: Box<dyn DatabaseDriver> = match db_type {
        DatabaseType::PostgreSQL => Box::new(
            retry_connect(20, || async { PostgresDriver::connect(&config).await })
                .await
                .unwrap_or_else(|e| panic!("{engine} connect: {e}")),
        ),
        _ => Box::new(
            retry_connect(30, || async { MySqlDriver::connect(&config).await })
                .await
                .unwrap_or_else(|e| panic!("{engine} connect: {e}")),
        ),
    };

    connect_driver
        .ping()
        .await
        .unwrap_or_else(|e| panic!("{engine} ping: {e}"));

    connect_driver
        .execute_query(&format!("DROP TABLE IF EXISTS {table}"))
        .await
        .unwrap_or_else(|e| panic!("{engine} drop: {e}"));
    connect_driver
        .execute_query(create_sql)
        .await
        .unwrap_or_else(|e| panic!("{engine} create: {e}"));
    connect_driver
        .execute_query(insert_sql)
        .await
        .unwrap_or_else(|e| panic!("{engine} insert: {e}"));
    assert_eq!(
        connect_driver.count_rows(table, None).await.expect("count"),
        3,
        "{engine} row count after insert"
    );

    connect_driver.ping().await.expect("second ping");

    let _ = connect_driver.disconnect().await;
}

#[tokio::test]
async fn postgres_round_trip_lifecycle() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }
    sql_lifecycle(
        "PostgreSQL",
        DatabaseType::PostgreSQL,
        15432,
        "tabler_test",
        "tabler_it_pg",
        "CREATE TABLE tabler_it_pg (id INTEGER PRIMARY KEY, name TEXT)",
        "INSERT INTO tabler_it_pg VALUES (1,'a'),(2,'b'),(3,'c')",
    )
    .await;
}

#[tokio::test]
async fn mysql_round_trip_lifecycle() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }
    sql_lifecycle(
        "MySQL",
        DatabaseType::MySQL,
        13306,
        "tabler_test",
        "tabler_it_mysql",
        "CREATE TABLE tabler_it_mysql (id INT PRIMARY KEY, name VARCHAR(100))",
        "INSERT INTO tabler_it_mysql VALUES (1,'a'),(2,'b'),(3,'c')",
    )
    .await;
}

#[tokio::test]
async fn mariadb_round_trip_lifecycle() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }
    sql_lifecycle(
        "MariaDB",
        DatabaseType::MariaDB,
        13307,
        "tabler_test",
        "tabler_it_mariadb",
        "CREATE TABLE tabler_it_mariadb (id INT PRIMARY KEY, name VARCHAR(100))",
        "INSERT INTO tabler_it_mariadb VALUES (1,'a'),(2,'b'),(3,'c')",
    )
    .await;
}

// ─── ClickHouse (HTTP wire), plus optional heavy engines ───────────────────

#[tokio::test]
async fn clickhouse_round_trip_lifecycle() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }

    let config = sql_config(DatabaseType::ClickHouse, 18123, "default");

    let driver = retry_connect(20, || async { ClickHouseDriver::connect(&config).await })
        .await
        .expect("ClickHouse connect");
    driver.ping().await.expect("ClickHouse ping");

    driver
        .execute_query("DROP TABLE IF EXISTS tabler_it_ch")
        .await
        .expect("drop");
    driver
        .execute_query(
            "CREATE TABLE tabler_it_ch (id UInt32, name String) ENGINE = MergeTree ORDER BY id",
        )
        .await
        .expect("create");
    driver
        .execute_query("INSERT INTO tabler_it_ch VALUES (1,'a'),(2,'b'),(3,'c')")
        .await
        .expect("insert");
    assert_eq!(
        driver
            .count_rows("tabler_it_ch", None)
            .await
            .expect("count"),
        3
    );

    let _ = driver.disconnect().await;
}

#[tokio::test]
async fn redis_round_trip_lifecycle() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }

    let mut config = base_config(DatabaseType::Redis);
    config.host = Some("127.0.0.1".to_string());
    config.port = Some(16379);

    let driver = retry_connect(15, || async { RedisDriver::connect(&config).await })
        .await
        .expect("Redis connect");
    driver.ping().await.expect("Redis ping");
    // A real server answers its own keyspace listing.
    let _tables = driver.list_tables(None).await.expect("Redis keyspace scan");

    let _ = driver.disconnect().await;
}

#[tokio::test]
async fn mongodb_round_trip_lifecycle() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }

    let mut config = base_config(DatabaseType::MongoDB);
    config.host = Some("127.0.0.1".to_string());
    config.port = Some(27027);

    let driver = retry_connect(15, || async { MongoDbDriver::connect(&config).await })
        .await
        .expect("MongoDB connect");
    driver.ping().await.expect("MongoDB ping");

    let databases = driver.list_databases().await.expect("list_databases");
    assert!(
        databases.iter().any(|db| db.name == "admin"),
        "a fresh Mongo server always carries the admin database"
    );

    let _ = driver.disconnect().await;
}

// ─── Heavy engines (compose profile "heavy", opt-in per engine) ────────────

#[tokio::test]
async fn mssql_round_trip_lifecycle() {
    if std::env::var("TABLER_IT_MSSQL").as_deref() != Ok("1") {
        eprintln!("skipped: set TABLER_IT_MSSQL=1 and start the 'heavy' compose profile");
        return;
    }
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }

    let mut config = base_config(DatabaseType::MSSQL);
    config.host = Some("127.0.0.1".to_string());
    config.port = Some(11433);
    config.username = Some("sa".to_string());
    config.password = Some("TablerIntegration!123".to_string());
    config.database = Some("master".to_string());

    let driver = retry_connect(30, || async { MssqlDriver::connect(&config).await })
        .await
        .expect("MSSQL connect");
    driver.ping().await.expect("MSSQL ping");

    driver
        .execute_query("IF OBJECT_ID('tabler_it_mssql') IS NOT NULL DROP TABLE tabler_it_mssql")
        .await
        .expect("drop");
    driver
        .execute_query("CREATE TABLE tabler_it_mssql (id INT PRIMARY KEY, name NVARCHAR(100))")
        .await
        .expect("create");
    driver
        .execute_query("INSERT INTO tabler_it_mssql VALUES (1,'a'),(2,'b'),(3,'c')")
        .await
        .expect("insert");
    assert_eq!(
        driver
            .count_rows("tabler_it_mssql", None)
            .await
            .expect("count"),
        3
    );

    let _ = driver.disconnect().await;
}

#[tokio::test]
async fn cassandra_round_trip_lifecycle() {
    if std::env::var("TABLER_IT_CASSANDRA").as_deref() != Ok("1") {
        eprintln!("skipped: set TABLER_IT_CASSANDRA=1 and start the 'heavy' compose profile");
        return;
    }
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }

    let mut config = base_config(DatabaseType::Cassandra);
    config.host = Some("127.0.0.1".to_string());
    config.port = Some(19042);

    // ScyllaDB speaks the Cassandra wire protocol; no auth on the test node.
    let driver = retry_connect(40, || async { CassandraDriver::connect(&config).await })
        .await
        .expect("Cassandra/ScyllaDB connect");
    driver.ping().await.expect("Cassandra ping");

    // A real CQL round trip: every node answers from system.local.
    let result = driver
        .execute_query("SELECT cluster_name FROM system.local")
        .await
        .expect("CQL round trip");
    assert!(
        !result.rows.is_empty(),
        "system.local must answer a cluster name"
    );

    let _ = driver.disconnect().await;
}

fn postgres_live_config() -> Option<ConnectionConfig> {
    if let Ok(host) = std::env::var("TABLER_TEST_POSTGRES_HOST") {
        let mut config = base_config(DatabaseType::PostgreSQL);
        config.host = Some(host);
        config.port = Some(
            std::env::var("TABLER_TEST_POSTGRES_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(5432),
        );
        config.username = Some(
            std::env::var("TABLER_TEST_POSTGRES_USER").unwrap_or_else(|_| "tabler".to_string()),
        );
        config.password = Some(
            std::env::var("TABLER_TEST_POSTGRES_PASSWORD")
                .unwrap_or_else(|_| "tabler_test".to_string()),
        );
        config.database = Some(
            std::env::var("TABLER_TEST_POSTGRES_DATABASE")
                .unwrap_or_else(|_| "tabler_test".to_string()),
        );
        return Some(config);
    }
    integration_enabled().then(|| sql_config(DatabaseType::PostgreSQL, 15432, "tabler_test"))
}

fn mysql_live_config() -> Option<ConnectionConfig> {
    if let Ok(host) = std::env::var("TABLER_TEST_MYSQL_HOST") {
        let mut config = base_config(DatabaseType::MySQL);
        config.host = Some(host);
        config.port = Some(
            std::env::var("TABLER_TEST_MYSQL_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(3306),
        );
        config.username =
            Some(std::env::var("TABLER_TEST_MYSQL_USER").unwrap_or_else(|_| "tabler".to_string()));
        config.password = Some(
            std::env::var("TABLER_TEST_MYSQL_PASSWORD")
                .unwrap_or_else(|_| "tabler_test".to_string()),
        );
        config.database = Some(
            std::env::var("TABLER_TEST_MYSQL_DATABASE")
                .unwrap_or_else(|_| "tabler_test".to_string()),
        );
        return Some(config);
    }
    integration_enabled().then(|| sql_config(DatabaseType::MySQL, 13306, "tabler_test"))
}

#[tokio::test]
async fn sqlite_cancel_query_request_is_a_documented_noop() {
    let path =
        std::env::temp_dir().join(format!("tabler-it-sqlite-cancel-{}.db", std::process::id()));
    let driver = tabler_lib::database::sqlite::SqliteDriver::connect(path.to_str().unwrap())
        .await
        .expect("SQLite connect");
    assert!(
        !driver
            .cancel_query_request("unused")
            .await
            .expect("sqlite cancel"),
        "SQLite must not claim server-side cancel"
    );
    let _ = driver.disconnect().await;
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn postgres_cancels_running_query_server_side() {
    let Some(config) = postgres_live_config() else {
        eprintln!("skipped: set TABLER_TEST_POSTGRES_HOST or TABLER_DRIVER_INTEGRATION=1");
        return;
    };
    let driver = Arc::new(
        retry_connect(20, || {
            let config = config.clone();
            async move { PostgresDriver::connect(&config).await }
        })
        .await
        .expect("PostgreSQL connect"),
    );
    let worker = Arc::clone(&driver);
    let started = Instant::now();
    let handle = tokio::spawn(async move {
        worker
            .execute_query_for_request("it-pg-cancel", "SELECT pg_sleep(30)")
            .await
    });
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(
        driver
            .cancel_query_request("it-pg-cancel")
            .await
            .expect("cancel lookup"),
        "Postgres must report a server-side cancel"
    );
    let outcome = handle.await.expect("join");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "cancelled sleep must return quickly, took {:?}",
        started.elapsed()
    );
    assert!(
        outcome.is_err(),
        "pg_sleep should not complete: {outcome:?}"
    );
    let leftover = driver
        .execute_query(
            "SELECT count(*)::int FROM pg_stat_activity WHERE query LIKE '%pg_sleep%' AND state = 'active' AND pid <> pg_backend_pid()",
        )
        .await
        .expect("pg_stat_activity");
    let count = leftover.rows.first().and_then(|row| row.first()).cloned();
    assert_eq!(
        count,
        Some(serde_json::json!(0)),
        "sleep must not remain active: {leftover:?}"
    );
    let _ = driver.disconnect().await;
}

#[tokio::test]
async fn mysql_cancels_running_query_server_side() {
    let Some(config) = mysql_live_config() else {
        eprintln!("skipped: set TABLER_TEST_MYSQL_HOST or TABLER_DRIVER_INTEGRATION=1");
        return;
    };
    let driver = Arc::new(
        retry_connect(20, || {
            let config = config.clone();
            async move { MySqlDriver::connect(&config).await }
        })
        .await
        .expect("MySQL connect"),
    );
    let worker = Arc::clone(&driver);
    let started = Instant::now();
    let handle = tokio::spawn(async move {
        worker
            .execute_query_for_request("it-mysql-cancel", "SELECT SLEEP(30)")
            .await
    });
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(
        driver
            .cancel_query_request("it-mysql-cancel")
            .await
            .expect("cancel lookup"),
        "MySQL must report a server-side cancel"
    );
    let outcome = handle.await.expect("join");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "cancelled sleep must return quickly, took {:?}",
        started.elapsed()
    );
    let accepted = outcome.is_err()
        || outcome.as_ref().is_ok_and(|result| {
            result
                .rows
                .first()
                .and_then(|row| row.first())
                .is_some_and(|value| value == &serde_json::json!(1))
        });
    assert!(
        accepted,
        "SLEEP should abort (error) or return 1: {outcome:?}"
    );
    let _ = driver.disconnect().await;
}
