#![allow(dead_code)]

use anyhow::{anyhow, ensure, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, LazyLock};
use tabler_lib::database::driver::DatabaseDriver;
use tabler_lib::database::manager::DatabaseManager;
use tabler_lib::database::models::{
    ConnectionConfig, DatabaseType, QueryParameter, QueryParameterType, RowKeyValue,
    TableCellUpdateRequest, TableRowDeleteRequest, TableRowInsertRequest,
};
use tabler_lib::storage::plugin_storage::{InstalledPluginRecord, PluginManifest, PluginStorage};
use tokio::sync::Mutex;

static PLUGIN_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static TEST_DATA_ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    let root =
        std::env::temp_dir().join(format!("tabler-driver-integration-{}", std::process::id()));
    std::env::set_var("TABLER_DATA_DIR", &root);
    root
});

pub fn integration_enabled() -> bool {
    matches!(
        std::env::var("TABLER_DRIVER_INTEGRATION").as_deref(),
        Ok("1") | Ok("true")
    ) || require_all_engines()
}

pub fn require_all_engines() -> bool {
    matches!(
        std::env::var("TABLER_REQUIRE_ALL_ENGINES").as_deref(),
        Ok("1") | Ok("true")
    )
}

pub fn required_env(name: &str) -> String {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => value,
        _ if require_all_engines() => {
            panic!("NOT_RUN: required environment variable {name} is missing")
        }
        _ => String::new(),
    }
}

pub fn envs_ready(names: &[&str]) -> bool {
    let missing: Vec<&str> = names
        .iter()
        .copied()
        .filter(|name| {
            std::env::var(name)
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
        })
        .collect();
    if require_all_engines() && !missing.is_empty() {
        panic!(
            "NOT_RUN: missing environment variables: {}",
            missing.join(", ")
        );
    }
    missing.is_empty()
}

pub fn base_config(db_type: DatabaseType) -> ConnectionConfig {
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
        query_timeout_seconds: None,
        ssh_config: None,
        read_only: false,
    }
}

pub fn sql_config(db_type: DatabaseType, port: u16, database: &str) -> ConnectionConfig {
    let mut config = base_config(db_type);
    config.host = Some("127.0.0.1".to_string());
    config.port = Some(port);
    config.username = Some("tabler".to_string());
    config.password = Some("tabler".to_string());
    config.database = Some(database.to_string());
    config
}

pub fn insert_env(config: &mut ConnectionConfig, key: &str, env_name: &str) {
    if let Ok(value) = std::env::var(env_name) {
        if !value.trim().is_empty() {
            config.additional_fields.insert(key.to_string(), value);
        }
    }
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn install_bundle(storage: &PluginStorage, source: &Path) -> Result<()> {
    let bundle = storage.bundles_dir().join("driver.tableplugin");
    if bundle.exists() {
        std::fs::remove_dir_all(&bundle)?;
    }
    copy_dir_recursive(source, &bundle)?;
    let manifest: PluginManifest =
        serde_json::from_slice(&std::fs::read(bundle.join("plugin.json"))?)?;
    storage.save_plugins(&[InstalledPluginRecord {
        manifest,
        bundle_path: bundle.to_string_lossy().to_string(),
        enabled: true,
        installed_at: 1,
        updated_at: 1,
        verified: false,
        computed_integrity: None,
        validation_error: None,
        rollback_available: false,
        previous_version: None,
    }])?;
    Ok(())
}

pub enum EngineProbe {
    Sql(&'static str),
    ListTables,
    ListDatabases,
    VerticaWorkspace,
}

async fn probe_vertica_workspace(
    driver: &dyn DatabaseDriver,
    expected_database: &str,
) -> Result<()> {
    fn insertion(table: &str, id: i64, label: &str) -> TableRowInsertRequest {
        TableRowInsertRequest {
            table: table.to_string(),
            database: None,
            values: vec![
                ("id".to_string(), serde_json::json!(id)),
                ("label".to_string(), serde_json::json!(label)),
                ("active".to_string(), serde_json::json!(true)),
            ],
        }
    }

    fn id_key(id: i64) -> Vec<RowKeyValue> {
        vec![RowKeyValue {
            column: "id".to_string(),
            value: serde_json::json!(id),
        }]
    }

    let table_name = format!("tabler_vertica_probe_{}", std::process::id());
    let table = format!("public.{table_name}");
    driver
        .execute_query(&format!("DROP TABLE IF EXISTS {table}"))
        .await?;
    driver
        .execute_query(&format!(
            "CREATE TABLE {table} (id INT PRIMARY KEY, label VARCHAR(500), active BOOLEAN)"
        ))
        .await?;

    let probe_result = async {
        let databases = driver.list_databases().await?;
        ensure!(
            databases.iter().any(|db| db.name == expected_database),
            "Vertica did not report its current database"
        );
        let tables = driver.list_tables(None).await?;
        ensure!(
            tables.iter().any(|entry| {
                entry.name == table_name && entry.schema.as_deref() == Some("public")
            }),
            "Vertica v_catalog table listing omitted the probe table"
        );
        let objects = driver.list_schema_objects(None).await?;
        ensure!(
            objects.iter().all(|object| object.object_type == "VIEW"),
            "Vertica schema objects included an unsupported catalog object"
        );

        let structure = driver.get_table_structure(&table, None).await?;
        ensure!(
            structure.columns.len() == 3,
            "Vertica column count mismatch"
        );
        ensure!(
            structure.columns[0].name == "id" && structure.columns[0].is_primary_key,
            "Vertica primary-key metadata was not loaded: {:?}",
            structure.columns[0]
        );
        ensure!(
            structure.columns[1].is_nullable,
            "Vertica nullable metadata was decoded as false"
        );
        ensure!(
            structure.object_type.as_deref() == Some("BASE TABLE"),
            "Vertica object type was not loaded"
        );
        let preview = driver.get_table_columns_preview(&table, None).await?;
        ensure!(preview.len() == 3, "Vertica column preview mismatch");

        let original_label = "O'Reilly 😊; DROP TABLE ignored -- $1";
        ensure!(
            driver
                .insert_table_row(&insertion(&table, 1, original_label))
                .await?
                == 1
        );
        let inserted = driver
            .insert_table_rows_atomically(
                &[
                    insertion(&table, 2, "second"),
                    insertion(&table, 3, "third"),
                ],
                Arc::new(AtomicBool::new(false)),
            )
            .await?;
        ensure!(inserted == 2, "Vertica atomic insert count mismatch");

        let selected = driver
            .execute_parameterized_query(
                "SELECT :id AS id, :label AS label, '$ignored' AS literal",
                &[
                    QueryParameter {
                        name: "id".to_string(),
                        value: serde_json::json!(1),
                        data_type: QueryParameterType::Integer,
                    },
                    QueryParameter {
                        name: "label".to_string(),
                        value: serde_json::json!(original_label),
                        data_type: QueryParameterType::Text,
                    },
                ],
            )
            .await?;
        ensure!(
            selected.rows.len() == 1,
            "Vertica parameter query returned no row"
        );
        ensure!(
            selected.rows[0][1] == serde_json::json!(original_label),
            "Vertica parameter text did not round-trip"
        );
        let typed_values = driver
            .execute_query(
                "SELECT CAST(1.25 AS NUMERIC(10,2)) AS amount, \
                 CAST(2.5 AS FLOAT) AS score, DATE '2026-10-24' AS day, \
                 TIMESTAMP '2026-10-24 01:02:03' AS at",
            )
            .await?;
        ensure!(typed_values.rows[0][0] == serde_json::json!(1.25));
        ensure!(typed_values.rows[0][1] == serde_json::json!(2.5));
        ensure!(typed_values.rows[0][2] == serde_json::json!("2026-10-24"));
        ensure!(typed_values.rows[0][3] == serde_json::json!("2026-10-24 01:02:03"));

        let changed_label = "second 😊'; DROP TABLE ignored --";
        let changed = driver
            .execute_parameterized_query(
                &format!("UPDATE {table} SET label = :label WHERE id = :id"),
                &[
                    QueryParameter {
                        name: "label".to_string(),
                        value: serde_json::json!(changed_label),
                        data_type: QueryParameterType::Text,
                    },
                    QueryParameter {
                        name: "id".to_string(),
                        value: serde_json::json!(2),
                        data_type: QueryParameterType::Integer,
                    },
                ],
            )
            .await?;
        ensure!(
            changed.affected_rows == 1,
            "Vertica parameter update count mismatch"
        );

        let updated_label = "updated 😊'";
        let update = TableCellUpdateRequest {
            table: table.clone(),
            database: None,
            target_column: "label".to_string(),
            value: serde_json::json!(updated_label),
            primary_keys: id_key(1),
        };
        ensure!(driver.update_table_cell(&update).await? == 1);
        let mut atomic_update = update.clone();
        atomic_update.primary_keys = id_key(2);
        atomic_update.target_column = "active".to_string();
        atomic_update.value = serde_json::json!(false);
        ensure!(
            driver
                .apply_table_updates_atomically(&[atomic_update])
                .await?
                == 1
        );

        let selected = driver
            .select_rows_by_keys(&table, None, &[id_key(1), id_key(2)])
            .await?;
        ensure!(selected.len() == 2, "Vertica key lookup count mismatch");
        let column_types = selected[0]
            .columns
            .iter()
            .map(|column| column.data_type.as_str())
            .collect::<Vec<_>>();
        ensure!(
            column_types == ["INTEGER", "VARCHAR", "BOOLEAN"],
            "Vertica result type OIDs were not mapped: {column_types:?}"
        );
        ensure!(selected[0].rows[0][0] == serde_json::json!(1));
        ensure!(selected[0].rows[0][1] == serde_json::json!(updated_label));
        ensure!(selected[1].rows[0][1] == serde_json::json!(changed_label));
        ensure!(
            selected[1].rows[0][2] == serde_json::json!(false),
            "Vertica boolean decode mismatch: columns={:?}, row={:?}",
            selected[1].columns,
            selected[1].rows[0]
        );

        let previewed = driver
            .preview_write_transaction(&[format!(
                "INSERT INTO {table} (id, label, active) VALUES (99, 'preview', TRUE)"
            )])
            .await?;
        ensure!(previewed[0].affected_rows == 1);
        ensure!(
            driver.count_rows(&table, None).await? == 3,
            "Vertica preview did not roll back"
        );
        ensure!(
            driver
                .execute_restore_statements(&[format!(
                    "INSERT INTO {table} (id, label, active) VALUES (4, 'restore', TRUE)"
                )])
                .await?
                == 1
        );

        let lookup = driver
            .get_foreign_key_lookup_values(&table, "id", &["label"], Some("1"), 10)
            .await?;
        ensure!(lookup.len() == 1, "Vertica FK lookup count mismatch");
        ensure!(lookup[0].value == serde_json::json!(1));
        ensure!(lookup[0].label == updated_label);

        let deleted = driver
            .delete_table_rows(&TableRowDeleteRequest {
                table: table.clone(),
                database: None,
                rows: vec![id_key(3), id_key(4)],
            })
            .await?;
        ensure!(deleted == 2, "Vertica delete count mismatch");
        ensure!(driver.count_rows(&table, None).await? == 2);
        let page = driver
            .get_table_data(&table, None, 0, 10, Some("id"), Some("ASC"), None)
            .await?;
        ensure!(page.rows.len() == 2, "Vertica table page count mismatch");
        Ok::<(), anyhow::Error>(())
    }
    .await;

    let cleanup_result = driver
        .execute_query(&format!("DROP TABLE IF EXISTS {table}"))
        .await
        .map(|_| ());
    match (probe_result, cleanup_result) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(anyhow!("Vertica probe cleanup failed: {error}")),
        (Ok(()), Ok(())) => Ok(()),
    }
}

pub async fn probe_connection(
    config: ConnectionConfig,
    bundle: Option<PathBuf>,
    probe: EngineProbe,
) -> Result<()> {
    let _guard = PLUGIN_TEST_LOCK.lock().await;
    let root = TEST_DATA_ROOT.clone();
    let storage = PluginStorage::new()?;
    if let Some(bundle) = bundle {
        install_bundle(&storage, &bundle)?;
    }
    let manager = DatabaseManager::with_plugin_storage(storage);
    let mut last_connect_error = None;
    for attempt in 0..30 {
        match tokio::time::timeout(std::time::Duration::from_secs(5), manager.connect(&config))
            .await
        {
            Ok(Ok(())) => {
                last_connect_error = None;
                break;
            }
            Ok(Err(error)) => {
                last_connect_error = Some(error);
            }
            Err(_) => {
                last_connect_error = Some(anyhow!(
                    "connection attempt {} timed out after 5 seconds",
                    attempt + 1
                ));
            }
        }
        if last_connect_error.is_some() && attempt < 29 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
    if let Some(error) = last_connect_error {
        return Err(error);
    }
    let probe_result = tokio::time::timeout(std::time::Duration::from_secs(45), async {
        let driver = manager.get_driver(&config.id).await?;
        driver.ping().await?;
        match probe {
            EngineProbe::Sql(sql) => {
                driver.execute_query(sql).await?;
            }
            EngineProbe::ListTables => {
                driver.list_tables(None).await?;
            }
            EngineProbe::ListDatabases => {
                driver.list_databases().await?;
            }
            EngineProbe::VerticaWorkspace => {
                probe_vertica_workspace(
                    driver.as_ref(),
                    config.database.as_deref().unwrap_or_default(),
                )
                .await?;
            }
        }
        Ok::<(), anyhow::Error>(())
    })
    .await;
    let probe_result = match probe_result {
        Ok(result) => result,
        Err(_) => Err(anyhow!("integration probe timed out after 45 seconds")),
    };
    let disconnect_result = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        manager.disconnect(&config.id),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(anyhow!("integration disconnect timed out after 10 seconds")),
    };
    let cleanup_result = std::fs::remove_dir_all(&root);
    if let Err(error) = &probe_result {
        eprintln!("integration probe failed: {error:?}");
    }
    match (probe_result, disconnect_result, cleanup_result) {
        (Err(error), _, _) => Err(anyhow!("{error:#}")),
        (_, Err(error), _) => Err(error),
        (_, _, Err(error)) => Err(anyhow!("test cleanup failed: {error}")),
        _ => Ok(()),
    }
}

pub fn plugin_bundle(plugin_id: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("plugins")
        .join(plugin_id)
}

pub fn staged_bundle(plugin_id: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("dist-plugins")
        .join(plugin_id)
}
