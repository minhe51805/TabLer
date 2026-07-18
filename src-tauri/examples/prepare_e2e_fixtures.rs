use serde_json::json;
use sqlx::{Connection, Executor, PgConnection, SqliteConnection};
use std::fs;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let data_dir = std::env::var_os("TABLER_E2E_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../.artifacts/e2e/runtime"));
    fs::create_dir_all(&data_dir)?;

    let sqlite_path = data_dir.join("smoke.sqlite");
    let sqlite_url = format!(
        "sqlite:{}?mode=rwc",
        sqlite_path.to_string_lossy().replace('\\', "/")
    );
    let mut sqlite = SqliteConnection::connect(&sqlite_url).await?;
    sqlite.execute("DROP TABLE IF EXISTS smoke_items").await?;
    sqlite
        .execute("CREATE TABLE smoke_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
        .await?;
    sqlite
        .execute(
            "INSERT INTO smoke_items (id, label) VALUES (1, 'SQLite ready'), (2, 'desktop smoke')",
        )
        .await?;
    sqlite.close().await?;

    let mut connections = vec![json!({
        "id": "e2e-sqlite",
        "name": "E2E SQLite",
        "db_type": "sqlite",
        "host": null,
        "port": null,
        "username": null,
        "password": null,
        "database": null,
        "file_path": sqlite_path,
        "use_ssl": false,
        "ssl_mode": null,
        "ssl_ca_cert_path": null,
        "ssl_client_cert_path": null,
        "ssl_client_key_path": null,
        "ssl_skip_host_verification": null,
        "color": "#3498db",
        "additional_fields": {},
        "pre_connect_script": null,
        "startup_commands": null,
        "ssh_config": null
    })];

    if std::env::var("TABLER_E2E_POSTGRES").as_deref() == Ok("1") {
        let host = std::env::var("TABLER_E2E_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port = std::env::var("TABLER_E2E_POSTGRES_PORT").unwrap_or_else(|_| "5432".into());
        let user = std::env::var("TABLER_E2E_POSTGRES_USER").unwrap_or_else(|_| "tabler".into());
        let database =
            std::env::var("TABLER_E2E_POSTGRES_DATABASE").unwrap_or_else(|_| "tabler_test".into());
        let password = std::env::var("TABLER_E2E_POSTGRES_PASSWORD").unwrap_or_default();
        let credentials = if password.is_empty() {
            user.clone()
        } else {
            format!("{user}:{password}")
        };
        let url = format!("postgresql://{credentials}@{host}:{port}/{database}");
        let mut postgres = PgConnection::connect(&url).await?;
        postgres
            .execute("DROP TABLE IF EXISTS public.smoke_items")
            .await?;
        postgres
            .execute(
                "CREATE TABLE public.smoke_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
            )
            .await?;
        postgres
            .execute("INSERT INTO public.smoke_items (id, label) VALUES (1, 'PostgreSQL ready'), (2, 'desktop smoke')")
            .await?;
        postgres.close().await?;

        connections.push(json!({
            "id": "e2e-postgresql",
            "name": "E2E PostgreSQL",
            "db_type": "postgresql",
            "host": host,
            "port": port.parse::<u16>()?,
            "username": user,
            "password": if password.is_empty() { None } else { Some(password) },
            "database": database,
            "file_path": null,
            "use_ssl": false,
            "ssl_mode": "disable",
            "ssl_ca_cert_path": null,
            "ssl_client_cert_path": null,
            "ssl_client_key_path": null,
            "ssl_skip_host_verification": null,
            "color": "#336791",
            "additional_fields": {},
            "pre_connect_script": null,
            "startup_commands": null,
            "ssh_config": null
        }));
    }

    fs::write(
        data_dir.join("connections.json"),
        serde_json::to_vec_pretty(&connections)?,
    )?;
    println!("Prepared TableR E2E fixtures in {}", data_dir.display());
    Ok(())
}
