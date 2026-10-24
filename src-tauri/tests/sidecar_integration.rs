mod support;

use support::{integration_enabled, probe_connection, sql_config, staged_bundle, EngineProbe};

#[tokio::test]
async fn duckdb_sidecar_connects_and_queries() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }
    let path =
        std::env::temp_dir().join(format!("tabler-sidecar-it-{}.duckdb", std::process::id()));
    let mut config = sql_config(
        tabler_lib::database::models::DatabaseType::DuckDB,
        0,
        "default",
    );
    config.file_path = Some(path.to_string_lossy().to_string());
    probe_connection(
        config,
        Some(staged_bundle("duckdb-driver")),
        EngineProbe::Sql("CREATE TABLE IF NOT EXISTS sidecar_probe (id INTEGER); INSERT INTO sidecar_probe VALUES (1); SELECT * FROM sidecar_probe"),
    )
    .await
    .expect("DuckDB sidecar production connection");
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn redis_sidecar_connects_and_lists_keys() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }
    let mut config = sql_config(
        tabler_lib::database::models::DatabaseType::Redis,
        16379,
        "default",
    );
    config.username = None;
    config.password = None;
    probe_connection(
        config,
        Some(staged_bundle("redis-driver")),
        EngineProbe::ListTables,
    )
    .await
    .expect("Redis sidecar production connection");
}

#[tokio::test]
async fn cassandra_sidecar_connects_and_reads_system_local() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }
    let mut config = sql_config(
        tabler_lib::database::models::DatabaseType::Cassandra,
        19042,
        "system",
    );
    config.username = None;
    config.password = None;
    probe_connection(
        config,
        Some(staged_bundle("cassandra-driver")),
        EngineProbe::Sql("SELECT cluster_name FROM system.local"),
    )
    .await
    .expect("Cassandra sidecar production connection");
}

#[tokio::test]
async fn libsql_sidecar_connects_and_queries() {
    if !integration_enabled() {
        eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
        return;
    }
    let mut config = sql_config(
        tabler_lib::database::models::DatabaseType::LibSQL,
        18080,
        "default",
    );
    config.username = None;
    config.password = None;
    config.database = None;
    probe_connection(
        config,
        Some(staged_bundle("libsql-driver")),
        EngineProbe::Sql("SELECT 1"),
    )
    .await
    .expect("LibSQL sidecar production connection");
}
