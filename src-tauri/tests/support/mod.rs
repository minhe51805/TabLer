#![allow(dead_code)]

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tabler_lib::database::manager::DatabaseManager;
use tabler_lib::database::models::{ConnectionConfig, DatabaseType};
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
        match manager.connect(&config).await {
            Ok(()) => {
                last_connect_error = None;
                break;
            }
            Err(error) => {
                last_connect_error = Some(error);
                if attempt < 29 {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    }
    if let Some(error) = last_connect_error {
        return Err(error);
    }
    let probe_result = async {
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
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    let disconnect_result = manager.disconnect(&config.id).await;
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
