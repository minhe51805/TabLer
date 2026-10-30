use sqlx::{Connection, Executor, PgConnection, SqliteConnection};
use std::fs;
use std::path::PathBuf;
use tabler_lib::database::driver::DatabaseDriver;
use tabler_lib::database::models::{ConnectionConfig, DatabaseType};
use tabler_lib::database::mssql::MssqlDriver;

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

    if std::env::var("TABLER_E2E_MSSQL").as_deref() == Ok("1") {
        let config = ConnectionConfig {
            db_type: DatabaseType::MSSQL,
            host: Some(
                std::env::var("TABLER_E2E_MSSQL_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            ),
            port: Some(
                std::env::var("TABLER_E2E_MSSQL_PORT")
                    .unwrap_or_else(|_| "11433".into())
                    .parse()?,
            ),
            username: Some(std::env::var("TABLER_E2E_MSSQL_USER").unwrap_or_else(|_| "sa".into())),
            password: Some(
                std::env::var("TABLER_E2E_MSSQL_PASSWORD")
                    .unwrap_or_else(|_| "TablerIntegration!123".into()),
            ),
            database: Some(
                std::env::var("TABLER_E2E_MSSQL_DATABASE").unwrap_or_else(|_| "master".into()),
            ),
            ..Default::default()
        };

        let driver = MssqlDriver::connect(&config).await?;
        driver
            .execute_query("IF OBJECT_ID('smoke_items') IS NOT NULL DROP TABLE smoke_items")
            .await?;
        driver
            .execute_query(
                "CREATE TABLE smoke_items (id INT PRIMARY KEY, label NVARCHAR(100) NOT NULL)",
            )
            .await?;
        driver
            .execute_query(
                "INSERT INTO smoke_items VALUES (1, N'MSSQL ready'), (2, N'desktop smoke')",
            )
            .await?;
        driver.disconnect().await?;
    }

    fs::write(data_dir.join("connections.json"), "[]\n")?;
    println!("Prepared TableR E2E fixtures in {}", data_dir.display());
    Ok(())
}
