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
    }

    fs::write(data_dir.join("connections.json"), "[]\n")?;
    println!("Prepared TableR E2E fixtures in {}", data_dir.display());
    Ok(())
}
