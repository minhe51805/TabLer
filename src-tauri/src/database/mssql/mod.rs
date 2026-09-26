use super::models::{ConnectionConfig, DatabaseType};
use std::sync::{Arc, RwLock};
use tiberius::Client;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::Compat;

pub type MssqlClient = Client<Compat<TcpStream>>;

/// SSMS-style server address parsed out of a [`ConnectionConfig`].
pub(crate) struct MssqlServerAddress {
    pub host: String,
    pub instance: Option<String>,
    pub port: u16,
    /// True when the port was written inside the server name itself
    /// (`host,port` / `host\\INSTANCE,port` / `host:port`). SSMS treats an
    /// explicit port as "connect directly, skip the SQL Browser".
    pub port_from_host: bool,
}

pub struct MssqlDriver {
    client: Arc<Mutex<MssqlClient>>,
    /// Kept so `cancel_query_request` can open a second connection and KILL
    /// the session — the primary client is busy running the query being
    /// cancelled, so it cannot issue the KILL itself.
    config: ConnectionConfig,
    current_db: Arc<RwLock<Option<String>>>,
    /// Set when a transaction rollback fails on this connection: the session
    /// is left inside an open transaction, so every further statement is
    /// refused until the user reconnects.
    poisoned: Arc<RwLock<Option<String>>>,
    /// request_id → session id (@@SPID) so cancel can reach the server.
    cancel_registry: Arc<RwLock<crate::database::query_cancel::QueryCancelRegistry>>,
    /// @@SPID of the primary client, fetched lazily once — it is constant for
    /// the connection's lifetime.
    session_id: Arc<RwLock<Option<i32>>>,
}

mod connect;
mod convert;
mod driver_ops;
mod exec;

#[cfg(test)]
mod mssql_parse_tests {
    use super::MssqlDriver;
    use crate::database::models::{ConnectionConfig, DatabaseType};
    use std::collections::HashMap;

    fn config(host: &str, port: Option<u16>, instance_name: Option<&str>) -> ConnectionConfig {
        let mut additional_fields = HashMap::new();
        if let Some(name) = instance_name {
            additional_fields.insert("instance_name".to_string(), name.to_string());
        }
        ConnectionConfig {
            id: "t".to_string(),
            name: "t".to_string(),
            db_type: DatabaseType::MSSQL,
            host: Some(host.to_string()),
            port,
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
            additional_fields,
            startup_commands: None,
            pre_connect_script: None,
            query_timeout_seconds: None,
            read_only: false,
            ssh_config: None,
        }
    }

    #[test]
    fn instance_field_with_server_prefix_is_sanitized_and_port_field_is_kept() {
        // The exact configuration that hit the SQL Browser probe (os error
        // 10054): full `SERVER\INSTANCE` pasted into the instance field plus
        // an explicit port in the port field.
        let address = MssqlDriver::parse_mssql_address(&config(
            "localhost",
            Some(14330),
            Some("LAPTOP-JFECRE1C\\MINH"),
        ));
        assert_eq!(address.instance.as_deref(), Some("MINH"));
        assert_eq!(address.port, 14330);
        assert!(!address.port_from_host);
    }

    #[test]
    fn instance_field_with_embedded_port_keeps_instance_only() {
        let address = MssqlDriver::parse_mssql_address(&config(
            "localhost",
            None,
            Some("SERVER\\MINH,14330"),
        ));
        assert_eq!(address.instance.as_deref(), Some("MINH"));
        assert_eq!(address.port, 1434);
    }

    #[test]
    fn bare_instance_without_port_targets_the_sql_browser() {
        let address = MssqlDriver::parse_mssql_address(&config("localhost", None, Some("MINH")));
        assert_eq!(address.instance.as_deref(), Some("MINH"));
        assert_eq!(address.port, 1434);
    }

    #[test]
    fn host_port_wins_over_instance_field() {
        let address =
            MssqlDriver::parse_mssql_address(&config("localhost,14330", Some(1433), Some("MINH")));
        assert_eq!(address.port, 14330);
        assert!(address.port_from_host);
    }
}

#[cfg(test)]
mod mssql_sql_builder_tests {
    use super::MssqlDriver;
    use crate::database::models::{RowKeyValue, TableCellUpdateRequest, TableRowInsertRequest};
    use serde_json::json;

    fn update_request(
        table: &str,
        database: Option<&str>,
        target_column: &str,
        value: serde_json::Value,
        primary_keys: Vec<RowKeyValue>,
    ) -> TableCellUpdateRequest {
        TableCellUpdateRequest {
            table: table.to_string(),
            database: database.map(str::to_string),
            target_column: target_column.to_string(),
            value,
            primary_keys,
        }
    }

    fn key(column: &str, value: serde_json::Value) -> RowKeyValue {
        RowKeyValue {
            column: column.to_string(),
            value,
        }
    }

    #[test]
    fn cell_update_uses_bracket_quoting_and_numbered_params() {
        let request = update_request(
            "users",
            None,
            "display name",
            json!("alice"),
            vec![key("id", json!(5))],
        );
        let (sql, values) = MssqlDriver::build_cell_update_statement(&request).unwrap();
        assert_eq!(
            sql,
            "UPDATE [dbo].[users] SET [display name] = @P1 WHERE [id] = @P2"
        );
        assert_eq!(values, vec![json!("alice"), json!(5)]);
    }

    #[test]
    fn cell_update_binds_each_non_null_key_and_skips_null_keys() {
        let request = update_request(
            "sales.orders",
            Some("appdb"),
            "total",
            json!(9.5),
            vec![
                key("tenant", json!("t1")),
                key("note", json!(null)),
                key("id", json!(7)),
            ],
        );
        let (sql, values) = MssqlDriver::build_cell_update_statement(&request).unwrap();
        assert_eq!(
            sql,
            "UPDATE [appdb].[sales].[orders] SET [total] = @P1 \
             WHERE [tenant] = @P2 AND [note] IS NULL AND [id] = @P3"
        );
        assert_eq!(values, vec![json!(9.5), json!("t1"), json!(7)]);
    }

    #[test]
    fn cell_update_without_primary_keys_is_rejected() {
        let request = update_request("users", None, "name", json!("x"), vec![]);
        assert!(MssqlDriver::build_cell_update_statement(&request).is_err());
    }

    #[test]
    fn row_insert_quotes_columns_and_escapes_brackets() {
        let request = TableRowInsertRequest {
            table: "audit]log".to_string(),
            database: None,
            values: vec![
                ("id".to_string(), json!(1)),
                ("we]ird".to_string(), json!("v")),
            ],
        };
        let (sql, values) = MssqlDriver::build_row_insert_statement(&request).unwrap();
        assert_eq!(
            sql,
            "INSERT INTO [dbo].[audit]]log] ([id], [we]]ird]) VALUES (@P1, @P2)"
        );
        assert_eq!(values, vec![json!(1), json!("v")]);
    }

    #[test]
    fn row_insert_without_values_is_rejected() {
        let request = TableRowInsertRequest {
            table: "users".to_string(),
            database: None,
            values: vec![],
        };
        assert!(MssqlDriver::build_row_insert_statement(&request).is_err());
    }
}

#[cfg(test)]
mod mssql_live_diagnostics {
    // The tests here are Windows-only (live SQL Server + SSPI); gate the
    // imports so non-Windows `--include-ignored` CI runs stay warning-free.
    #[cfg(windows)]
    use super::MssqlDriver;
    #[cfg(windows)]
    use crate::database::models::{ConnectionConfig, DatabaseType};
    #[cfg(windows)]
    use std::collections::HashMap;

    /// Requires a live SQL Server instance on this machine. Run manually:
    /// `cargo test --lib mssql_live_connection -- --ignored --nocapture`
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn mssql_live_connection() {
        async fn variant(label: &str, mutate: impl FnOnce(&mut ConnectionConfig)) {
            let mut config = ConnectionConfig {
                id: "live-diag".to_string(),
                name: "live-diag".to_string(),
                db_type: DatabaseType::MSSQL,
                host: Some("localhost,14330".to_string()),
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
                additional_fields: HashMap::new(),
                startup_commands: None,
                pre_connect_script: None,
                query_timeout_seconds: None,
                read_only: false,
                ssh_config: None,
            };
            mutate(&mut config);
            let outcome = match MssqlDriver::connect(&config).await {
                Ok(_) => "OK".to_string(),
                Err(error) => format!("FAILED: {error:#}"),
            };
            println!("[{label}] {outcome}");
        }

        variant("baseline: localhost,14330 + Integrated + Off", |_| {}).await;
        variant(
            "encrypt_mode=mandatory",
            &|config: &mut ConnectionConfig| {
                config
                    .additional_fields
                    .insert("encrypt_mode".to_string(), "mandatory".to_string());
            },
        )
        .await;
        variant(
            "use_ssl=true (legacy SSL toggle)",
            &|config: &mut ConnectionConfig| {
                config.use_ssl = true;
            },
        )
        .await;
        variant(
            "localhost + port field 14330",
            &|config: &mut ConnectionConfig| {
                config.host = Some("localhost".to_string());
                config.port = Some(14330);
            },
        )
        .await;
        variant(
            "localhost + port field 1433 (wrong port)",
            &|config: &mut ConnectionConfig| {
                config.host = Some("localhost".to_string());
                config.port = Some(1433);
            },
        )
        .await;
        variant(
            "LAPTOP-JFECRE1C\\MINH (browser path)",
            &|config: &mut ConnectionConfig| {
                config.host = Some("LAPTOP-JFECRE1C\\MINH".to_string());
                config.port = None;
            },
        )
        .await;
        variant(
            "LAPTOP-JFECRE1C,14330 (hostname + port)",
            &|config: &mut ConnectionConfig| {
                config.host = Some("LAPTOP-JFECRE1C,14330".to_string());
                config.port = None;
            },
        )
        .await;
        variant("127.0.0.1,14330", &|config: &mut ConnectionConfig| {
            config.host = Some("127.0.0.1,14330".to_string());
            config.port = None;
        })
        .await;
        variant(
            "USER CONFIG: localhost + port 14330 + instance field SERVER\\\\MINH",
            &|config: &mut ConnectionConfig| {
                config.host = Some("localhost".to_string());
                config.port = Some(14330);
                config.additional_fields.insert(
                    "instance_name".to_string(),
                    "LAPTOP-JFECRE1C\\\\MINH".to_string(),
                );
            },
        )
        .await;

        // Raw SQL Browser diagnostics
        use tokio::net::UdpSocket;
        for (label, addr) in [
            ("localhost/MINH", "127.0.0.1:1434"),
            ("LAPTOP-JFECRE1C/MINH", "LAPTOP-JFECRE1C:1434"),
        ] {
            let sock = UdpSocket::bind("0.0.0.0:0").await.unwrap();
            let mut req = vec![4u8]; // CLNT_UCAST_EX
            req.extend(b"MINH".iter().flat_map(|b| [*b, 0])); // UTF-16LE
            req.extend([0u8, 0]);
            let send_res = sock.send_to(&req, addr).await;
            let mut buf = vec![0u8; 4096];
            let recv_res =
                tokio::time::timeout(std::time::Duration::from_secs(3), sock.recv_from(&mut buf))
                    .await;
            match (send_res, recv_res) {
                (Ok(_), Ok(Ok((len, _)))) => {
                    let resp = String::from_utf8_lossy(&buf[..len]).to_string();
                    println!("[SSRP probe {label}] response: {resp:?}");
                }
                (send, recv) => println!("[SSRP probe {label}] send={send:?} recv={recv:?}"),
            }
        }

        // Does connect_named itself establish TCP?
        let cfg_host = tiberius::Config::from_ado_string(
            "Server=LAPTOP-JFECRE1C\\MINH;Integrated Security=true",
        )
        .unwrap();
        println!(
            "[connect_named LAPTOP-JFECRE1C\\\\MINH] -> {:?}",
            <tokio::net::TcpStream as tiberius::SqlBrowser>::connect_named(&cfg_host)
                .await
                .map(|_| "TCP established")
                .map_err(|e| e.to_string())
        );

        // Table metadata diagnostics (reproduces the "No tables were found" bug)
        use crate::database::driver::DatabaseDriver;
        let mut diag = ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(14330),
            additional_fields: HashMap::new(),
            ..crate::database::mssql::config_defaults()
        };
        diag.additional_fields.insert(
            "instance_name".to_string(),
            "LAPTOP-JFECRE1C\\MINH".to_string(),
        );
        match MssqlDriver::connect(&diag).await {
            Ok(driver) => {
                for db_arg in [Some("dangkytest"), None] {
                    match driver.list_tables(db_arg).await {
                        Ok(tables) => println!(
                            "[list_tables {:?}] count={} names={:?}",
                            db_arg,
                            tables.len(),
                            tables
                                .iter()
                                .take(5)
                                .map(|t| format!(
                                    "{}|{}",
                                    t.schema.as_deref().unwrap_or("?"),
                                    t.name
                                ))
                                .collect::<Vec<_>>()
                        ),
                        Err(error) => println!("[list_tables {:?}] ERROR: {error:#}", db_arg),
                    }
                }
            }
            Err(error) => println!("[tables diag] connect failed: {error:#}"),
        }
    }
    /// Live probe: preview_write_transaction must run the UPDATE inside
    /// BEGIN/ROLLBACK and leave every row untouched.
    /// `cargo test --lib mssql_live_preview_write -- --ignored --nocapture`
    // Live probe bound to the dev machine's SQL Server instance (SSPI auth):
    // compiled only on Windows targets so `--include-ignored` CI runs on
    // Linux/macOS never reach it.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires a reachable local SQL Server"]
    async fn mssql_live_preview_write() {
        use crate::database::driver::DatabaseDriver;
        use crate::database::mssql::config_defaults;
        let mut config = config_defaults();
        config.host = Some("localhost".to_string());
        config.port = Some(14330);
        let driver: std::sync::Arc<dyn DatabaseDriver> =
            std::sync::Arc::new(MssqlDriver::connect(&config).await.expect("connect"));

        // Snapshot ALL rows first so the probe works on any dataset state.
        let snapshot = driver
            .execute_query("SELECT * FROM [QuanLySinhVienDB].[dbo].[SinhViens]")
            .await
            .expect("snapshot before");
        let before_count = snapshot.rows.len();
        assert!(before_count > 0, "fixture rows missing");

        let preview = driver
            .preview_write_transaction(&[format!(
                "UPDATE [QuanLySinhVienDB].[dbo].[SinhViens] SET HoTen = N'KHOA-PROBE-{}' WHERE 1=1",
                std::process::id()
            )])
            .await
            .expect("preview_write_transaction supported on MSSQL");
        println!(
            "[preview probe] affected (inside tx): {}",
            preview[0].affected_rows
        );

        let after = driver
            .execute_query("SELECT * FROM [QuanLySinhVienDB].[dbo].[SinhViens]")
            .await
            .expect("snapshot after");
        assert_eq!(
            snapshot.rows, after.rows,
            "rollback must leave data untouched"
        );
        println!("[preview probe] rolled back; {before_count} row(s) intact");
    }

    /// Live probe: replicate the global-search multi pipeline end-to-end.
    /// `cargo test --lib mssql_live_multi_search -- --ignored --nocapture`
    // Live probe bound to the dev machine's SQL Server instance (SSPI auth):
    // compiled only on Windows targets so `--include-ignored` CI runs on
    // Linux/macOS never reach it.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires a reachable local SQL Server"]
    async fn mssql_live_multi_search() {
        use crate::database::driver::DatabaseDriver;
        use crate::database::mssql::config_defaults;
        let mut config = config_defaults();
        config.host = Some("localhost".to_string());
        config.port = Some(14330);
        config.additional_fields.insert(
            "instance_name".to_string(),
            "LAPTOP-JFECRE1C\\MINH".to_string(),
        );
        let driver: std::sync::Arc<dyn DatabaseDriver> =
            std::sync::Arc::new(MssqlDriver::connect(&config).await.expect("connect"));

        use crate::commands::search::fetch_searchable_text_columns;
        let table = "dbo.SinhViens";
        let text = fetch_searchable_text_columns(
            &driver,
            DatabaseType::MSSQL,
            table,
            "[QuanLySinhVienDB].",
        )
        .await
        .iter()
        .map(|c| c.name.clone())
        .collect::<Vec<_>>();
        println!("[multi probe] text columns (cross-db): {:?}", text);
        assert!(!text.is_empty(), "no text columns found via cross-db scope");

        let predicate = text
            .iter()
            .map(|name| format!("[{name}] LIKE :keyword ESCAPE '\\'"))
            .collect::<Vec<_>>()
            .join(" OR ");
        let sql = format!(
            "SELECT TOP (50) * FROM [QuanLySinhVienDB].[dbo].[SinhViens] WHERE {predicate}"
        );
        println!("[multi probe] sql: {sql}");

        use crate::database::models::{QueryParameter, QueryParameterType};
        // Sample a real substring from the live data instead of asserting a
        // hard-coded name that may not exist.
        let probe = driver
            .execute_query(
                "SELECT TOP 1 SUBSTRING(HoTen, 1, 3) AS seed FROM [QuanLySinhVienDB].[dbo].[SinhViens] WHERE HoTen IS NOT NULL",
            )
            .await
            .expect("probe");
        let seed = probe
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(|v| v.as_str())
            .map(|s| format!("%{s}%"))
            .unwrap_or_else(|| "%My%".to_string());
        println!("[multi probe] seeded LIKE {seed} from live data");
        let parameters = vec![QueryParameter {
            name: "keyword".to_string(),
            value: serde_json::Value::String(seed.clone()),
            data_type: QueryParameterType::Text,
        }];
        // Compile exactly like the global-search command does.
        use crate::database::models::DatabaseType;
        use crate::database::parameterized_query::{
            compile_parameterized_query, placeholder_style_for_database,
        };
        let style = placeholder_style_for_database(DatabaseType::MSSQL);
        let compiled = compile_parameterized_query(&sql, &parameters, style).expect("compile");
        println!("[multi probe] compiled: {}", compiled.sql);
        let result = driver
            .execute_parameterized_query(&compiled.sql, &compiled.parameters)
            .await
            .expect("execute");
        println!("[multi probe] rows returned: {}", result.rows.len());
        assert!(
            !result.rows.is_empty(),
            "expected matching rows for seeded LIKE {seed}"
        );
    }

    /// Live probe: verify what object_type values list_schema_objects returns
    /// against the real server (run with --ignored --nocapture).
    // Live probe bound to the dev machine's SQL Server instance (SSPI auth):
    // compiled only on Windows targets so `--include-ignored` CI runs on
    // Linux/macOS never reach it.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn mssql_live_schema_objects() {
        use crate::database::driver::DatabaseDriver;
        use crate::database::mssql::config_defaults;
        let mut config = config_defaults();
        config.host = Some("localhost".to_string());
        config.port = Some(14330);
        config.additional_fields.insert(
            "instance_name".to_string(),
            "LAPTOP-JFECRE1C\\MINH".to_string(),
        );
        let driver = MssqlDriver::connect(&config).await.expect("connect");
        let objects = driver
            .list_schema_objects(Some("master"))
            .await
            .expect("list_schema_objects");
        let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
        for object in &objects {
            *counts.entry(object.object_type.clone()).or_default() += 1;
        }
        println!("[list_schema_objects master] total={}", objects.len());
        for (kind, count) in &counts {
            println!("  object_type={kind:?} count={count}");
        }
        for object in objects
            .iter()
            .filter(|o| o.schema.as_deref() == Some("dbo"))
        {
            println!("  dbo row: {} type={:?}", object.name, object.object_type);
        }
    }
}

/// Live-diagnostic connection defaults (used by the manual `tables diag` probe).
#[allow(dead_code)]
fn config_defaults() -> ConnectionConfig {
    use std::collections::HashMap;
    ConnectionConfig {
        id: "live-diag".to_string(),
        name: "live-diag".to_string(),
        db_type: DatabaseType::MSSQL,
        host: Some("localhost,14330".to_string()),
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
        additional_fields: HashMap::new(),
        startup_commands: None,
        pre_connect_script: None,
        query_timeout_seconds: None,
        read_only: false,
        ssh_config: None,
    }
}
