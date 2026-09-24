use super::{MssqlClient, MssqlDriver, MssqlServerAddress};
use crate::database::models::ConnectionConfig;
use anyhow::Result;
use std::sync::{Arc, RwLock};
use tiberius::{AuthMethod, Client, Config, EncryptionLevel};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::TokioAsyncWriteCompatExt;

impl MssqlDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let database_name = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("master");

        let client = Self::open_mssql_client(config, database_name).await?;

        Ok(Self {
            client: Arc::new(Mutex::new(client)),
            config: config.clone(),
            current_db: Arc::new(RwLock::new(Some(database_name.to_string()))),
            poisoned: Arc::new(RwLock::new(None)),
            cancel_registry: Arc::new(RwLock::new(
                crate::database::query_cancel::QueryCancelRegistry::new(),
            )),
            session_id: Arc::new(RwLock::new(None)),
        })
    }

    /// --- Server name parsing (SSMS-style) --------------------------------
    /// Accepts: "host", "host\\INSTANCE", "host,port",
    /// "host\\INSTANCE,port" and "host:port". A named instance is resolved
    /// through the SQL Browser service (UDP 1434) by tiberius.
    pub(crate) fn parse_mssql_address(config: &ConnectionConfig) -> MssqlServerAddress {
        let raw_host = config.host.as_deref().unwrap_or("127.0.0.1").trim();
        let mut host = raw_host.to_string();
        // Users often paste the full `SERVER\INSTANCE` (or `SERVER\INSTANCE,port`)
        // into the separate instance-name field; keep only the instance part.
        let sanitize_instance = |raw: &str| -> Option<String> {
            let value = raw.trim();
            let value = value.rsplit('\\').next().unwrap_or(value).trim();
            let value = value.split(',').next().unwrap_or(value).trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        };
        let mut instance: Option<String> = config
            .additional_fields
            .get("instance_name")
            .and_then(|value| sanitize_instance(value));
        let mut host_port: Option<u16> = None;

        if let Some((server, rest)) = raw_host.split_once('\\') {
            host = server.trim().to_string();
            let rest = rest.trim();
            if let Some((name, port)) = rest.split_once(',') {
                instance = Some(name.trim().to_string());
                host_port = port.trim().parse::<u16>().ok();
            } else {
                instance = Some(rest.to_string());
            }
        } else if let Some((server, port)) = raw_host.rsplit_once(',') {
            host = server.trim().to_string();
            host_port = port.trim().parse::<u16>().ok();
        } else if let Some((server, port)) = raw_host.rsplit_once(':') {
            if let Ok(parsed) = port.trim().parse::<u16>() {
                host = server.trim().to_string();
                host_port = Some(parsed);
            }
        }
        if host.is_empty() {
            host = "127.0.0.1".to_string();
        }

        let explicit_port = config.port.filter(|value| *value != 0);
        // SSMS parity: a port written inside the server name (`host,port` /
        // `host\\INSTANCE,port`) is authoritative and wins over the separate
        // port field, which is only a fallback default.
        let port = host_port.or(explicit_port).unwrap_or_else(|| {
            if instance.is_some() {
                1434
            } else {
                config.default_port()
            }
        });

        MssqlServerAddress {
            host,
            instance,
            port,
            port_from_host: host_port.is_some(),
        }
    }

    /// --- Authentication + wire config (SSMS parity) ----------------------
    /// - Blank username            -> Windows Authentication as the current
    ///   Windows user (SSPI), like pressing Connect in SSMS with
    ///   "Windows Authentication" selected.
    /// - Username + auth=windows   -> Windows Authentication with explicit
    ///   credentials ("Run as different user").
    /// - Username (default)        -> SQL Server authentication.
    pub(crate) fn build_mssql_tds_config(
        config: &ConnectionConfig,
        address: &MssqlServerAddress,
        database_name: &str,
    ) -> Result<Config> {
        let auth_type = config
            .additional_fields
            .get("auth_type")
            .map(|value| value.trim().to_lowercase())
            .unwrap_or_default();
        let user = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let password = config.password.as_deref().unwrap_or("");

        let auth = match (user, auth_type.as_str()) {
            // `AuthMethod::windows` (SSPI with explicit credentials) is gated
            // to Windows targets inside tiberius itself
            // (#[cfg(all(windows, feature = "winauth"))]): on Linux/macOS the
            // associated function does not exist, so this arm must be
            // cfg-gated too — otherwise every non-Windows CI job fails with
            // E0599 before it even reaches the auth logic.
            #[cfg(windows)]
            (Some(user), "windows") => {
                AuthMethod::windows(user, password.to_string())
            }
            #[cfg(not(windows))]
            (Some(_), "windows") => anyhow::bail!(
                "Windows Authentication with explicit credentials is only supported on Windows hosts."
            ),
            (Some(user), _) => AuthMethod::sql_server(user.to_string(), password.to_string()),
            (None, "sql") => anyhow::bail!("SQL Server authentication requires a username."),
            (None, _) => {
                #[cfg(windows)]
                {
                    AuthMethod::Integrated
                }
                #[cfg(not(windows))]
                {
                    anyhow::bail!("Windows Authentication is only supported on Windows hosts.");
                }
            }
        };

        // Azure SQL / managed instances always require TLS. Other servers:
        // "encrypt_mode = mandatory" or the legacy SSL toggle forces TLS,
        // everything else behaves like "Optional" in the mssql VS Code
        // extension (encrypt only if the server requires it).
        let encrypt_mode = config
            .additional_fields
            .get("encrypt_mode")
            .map(|value| value.trim().to_lowercase())
            .unwrap_or_default();
        let is_azure = address.host.to_lowercase().contains("database.windows.net");

        // A named instance connects directly when a real port is known
        // (from the server name or the port field) — SSMS parity. Only a
        // bare `SERVER\INSTANCE` without any port goes through the SQL
        // Browser, where tiberius needs the TDS port pre-set to 1434 for
        // its SSRP probe (see open_mssql_client, which rebuilds this
        // config with port 1434 for the probe).
        let port = address.port;

        let mut tds = Config::new();
        tds.host(&address.host);
        tds.port(port);
        tds.database(database_name);
        tds.authentication(auth);
        // Local SQL Server instances ship self-signed certificates; SSMS and
        // the mssql VS Code extension both default to trusting them, as do we
        // unless the user explicitly unchecks "Trust server certificate".
        let trust_server_cert = config
            .additional_fields
            .get("trust_server_cert")
            .map(|value| value.trim().to_lowercase())
            .unwrap_or_else(|| "true".to_string())
            != "false";
        if trust_server_cert {
            tds.trust_cert();
        }
        tds.encryption(
            if is_azure
                || encrypt_mode == "mandatory"
                || (encrypt_mode.is_empty() && config.use_ssl)
            {
                EncryptionLevel::Required
            } else {
                EncryptionLevel::Off
            },
        );

        if let Some(instance) = &address.instance {
            tds.instance_name(instance);
        }

        Ok(tds)
    }

    /// Opens a raw tiberius client for the given database using the SSMS-style
    /// connection config. Shared between the driver itself and the local
    /// database bootstrap command (which connects to `master` first).
    pub(crate) async fn open_mssql_client(
        config: &ConnectionConfig,
        database_name: &str,
    ) -> Result<MssqlClient> {
        let address = Self::parse_mssql_address(config);
        let tds = Self::build_mssql_tds_config(config, &address, database_name)?;

        let tcp = if address.instance.is_some() && !address.port_from_host {
            // Named instance: SSMS resolves it through the SQL Browser
            // (UDP 1434). Exception — an explicit non-default port (from
            // the port field) is tried directly first, exactly like typing
            // `SERVER\INSTANCE,port` in SSMS; if that is refused we still
            // fall back to the browser probe.
            let browser_tds = |address: &MssqlServerAddress| -> Result<Config> {
                Self::build_mssql_tds_config(
                    config,
                    &MssqlServerAddress {
                        host: address.host.clone(),
                        instance: address.instance.clone(),
                        port: 1434,
                        port_from_host: false,
                    },
                    database_name,
                )
            };
            if address.port != 1434 && address.port != config.default_port() {
                use tiberius::SqlBrowser;
                match TcpStream::connect(tds.get_addr()).await {
                    Ok(tcp) => tcp,
                    Err(_) => TcpStream::connect_named(&browser_tds(&address)?)
                        .await
                        .map_err(|error| {
                            // The SQL Browser probe fails with a raw OS error
                            // (e.g. 10054 reset / timeout) when the service is
                            // stopped or its UDP port is blocked, which is
                            // indistinguishable from a dead server for the
                            // user. Surface an actionable hint.
                            let raw = error.to_string();
                            anyhow::Error::msg(format!(
                                "SQL Server Browser is unreachable for instance '{}' (the UDP 1434 probe failed). \
Either start the 'SQL Server Browser' service as Administrator, or connect with an explicit \
port instead (e.g. 'localhost,1433'). Original error: {}",
                                address.instance.as_deref().unwrap_or(""),
                                raw
                            ))
                        })?,
                }
            } else {
                use tiberius::SqlBrowser;
                TcpStream::connect_named(&browser_tds(&address)?).await.map_err(|error| {
                    // The SQL Browser probe fails with a raw OS error (e.g.
                    // 10054 reset / timeout) when the service is stopped or its
                    // UDP port is blocked, which is indistinguishable from a
                    // dead server for the user. Surface an actionable hint.
                    let raw = error.to_string();
                    anyhow::Error::msg(format!(
                        "SQL Server Browser is unreachable for instance '{}' (the UDP 1434 probe failed). \
Either start the 'SQL Server Browser' service as Administrator, or connect with an explicit \
port instead (e.g. 'localhost,1433'). Original error: {}",
                        address.instance.as_deref().unwrap_or(""),
                        raw
                    ))
                })?
            }
        } else {
            // Default instance, or an explicit port in the server name
            // (`host\\INSTANCE,port`) which connects directly like SSMS.
            TcpStream::connect(tds.get_addr()).await?
        };
        tcp.set_nodelay(true)?;
        let client = Client::connect(tds, tcp.compat_write()).await?;

        Ok(client)
    }
}
