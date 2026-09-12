//! End-to-end Phase 4e test: spawn the reference sidecar as a real OS process
//! and drive it through the host `SidecarDriver` over stdio IPC.
//!
//! This exercises the whole Phase 4 stack against a real process boundary:
//! `SidecarDriver::spawn` (spawn + handshake + connect), unary round trips over
//! the framed protocol, and a clean `disconnect` (which stops the child). The
//! reference sidecar is backed by SQLite so no external server is required.
//!
//! Gated behind the `reference-sidecar` feature (which also builds the binary):
//!   cargo test --features reference-sidecar --test sidecar_e2e
//!
//! Note: like the other integration tests this links the app binaries, so run
//! it with the desktop app closed.
#![cfg(feature = "reference-sidecar")]

use std::path::PathBuf;

use tabler_lib::database::driver::DatabaseDriver;
use tabler_lib::database::models::{ConnectionConfig, DatabaseType};
use tabler_lib::database::sidecar::SidecarDriver;

fn sqlite_sidecar_config(path: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: "sidecar-e2e".into(),
        name: "sidecar-e2e".into(),
        db_type: DatabaseType::SQLite,
        host: None,
        port: None,
        username: None,
        password: None,
        database: None,
        file_path: Some(path.to_string()),
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

#[tokio::test]
async fn reference_sidecar_round_trips_over_a_real_process() {
    // Cargo builds the reference binary and exposes its path here because this
    // test depends on it via the shared package.
    let program = PathBuf::from(env!("CARGO_BIN_EXE_reference_sidecar"));
    let db_path =
        std::env::temp_dir().join(format!("tabler-sidecar-e2e-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&db_path);
    let config = sqlite_sidecar_config(db_path.to_str().unwrap());

    // spawn negotiates the handshake and opens the connection inside the child.
    let driver = SidecarDriver::spawn(&program, &[], &config)
        .await
        .expect("spawn reference sidecar");
    assert_eq!(driver.driver_name(), "sqlite-sidecar");

    driver.ping().await.expect("ping over sidecar");
    driver
        .execute_query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        .await
        .expect("create over sidecar");
    driver
        .execute_query("INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b')")
        .await
        .expect("insert over sidecar");

    let count = driver
        .count_rows("t", None)
        .await
        .expect("count over sidecar");
    assert_eq!(count, 2);

    let tables = driver
        .list_tables(None)
        .await
        .expect("list tables over sidecar");
    assert!(tables.iter().any(|t| t.name == "t"));

    let result = driver
        .execute_query("SELECT id, name FROM t ORDER BY id")
        .await
        .expect("select over sidecar");
    assert_eq!(result.rows.len(), 2);

    // disconnect stops the child process cleanly.
    driver.disconnect().await.expect("disconnect over sidecar");
    let _ = std::fs::remove_file(&db_path);
}
