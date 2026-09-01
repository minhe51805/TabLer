use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{
    statement_returns_rows, METADATA_QUERY_ROW_LIMIT, MAX_QUERY_RESULT_ROWS,
};
use super::safety::{
    normalize_order_dir, qualify_mssql_table_name, quote_mssql_identifier, quote_mssql_order_by,
    sanitize_mssql_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use std::collections::HashSet;
use std::sync::{Arc, RwLock};
use std::time::Instant;
use tiberius::{
    AuthMethod, Client, ColumnData, Config, EncryptionLevel, Query as TiberiusQuery, Row,
};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

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
    current_db: Arc<RwLock<Option<String>>>,
}

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
            current_db: Arc::new(RwLock::new(Some(database_name.to_string()))),
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
            .map(|value| sanitize_instance(value))
            .flatten();
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
            (Some(user), "windows") => AuthMethod::windows(user.to_string(), password.to_string()),
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

    fn split_schema_table(table: &str) -> (String, String) {
        if let Some((schema, name)) = table.split_once('.') {
            (schema.to_string(), name.to_string())
        } else {
            ("dbo".to_string(), table.to_string())
        }
    }

    fn qualify_table_name(table: &str, database: Option<&str>) -> Result<String> {
        let (schema, name) = Self::split_schema_table(table);
        if let Some(database) = database.map(str::trim).filter(|value| !value.is_empty()) {
            return Ok(format!(
                "{}.{}.{}",
                quote_mssql_identifier(database)?,
                quote_mssql_identifier(&schema)?,
                quote_mssql_identifier(&name)?,
            ));
        }

        qualify_mssql_table_name(table, "dbo")
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "WITH", "EXEC", "EXECUTE", "SHOW"])
    }

    fn current_database_name(&self, explicit: Option<&str>) -> String {
        explicit
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| self.current_db.read().unwrap().clone())
            .unwrap_or_else(|| "master".to_string())
    }

    fn ms_cell_to_json(value: &ColumnData<'static>) -> serde_json::Value {
        match value {
            ColumnData::U8(Some(v)) => serde_json::Value::from(*v),
            ColumnData::I16(Some(v)) => serde_json::Value::from(*v),
            ColumnData::I32(Some(v)) => serde_json::Value::from(*v),
            ColumnData::I64(Some(v)) => serde_json::Value::from(*v),
            ColumnData::F32(Some(v)) => serde_json::Value::from(*v as f64),
            ColumnData::F64(Some(v)) => serde_json::Value::from(*v),
            ColumnData::Bit(Some(v)) => serde_json::Value::from(*v),
            ColumnData::Guid(Some(v)) => serde_json::Value::String(v.to_string()),
            ColumnData::String(Some(v)) => serde_json::Value::String(v.to_string()),
            ColumnData::Binary(Some(v)) => serde_json::Value::String(
                v.iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
            ),
            ColumnData::Numeric(Some(v)) => serde_json::Value::String(v.to_string()),
            ColumnData::DateTime(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            ColumnData::SmallDateTime(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            ColumnData::Time(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            ColumnData::Date(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            ColumnData::DateTime2(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            ColumnData::DateTimeOffset(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            _ => serde_json::Value::Null,
        }
    }

    fn ms_column_type(value: &ColumnData<'static>) -> String {
        match value {
            ColumnData::U8(_) => "tinyint",
            ColumnData::I16(_) => "smallint",
            ColumnData::I32(_) => "int",
            ColumnData::I64(_) => "bigint",
            ColumnData::F32(_) => "real",
            ColumnData::F64(_) => "float",
            ColumnData::Bit(_) => "bit",
            ColumnData::Guid(_) => "uniqueidentifier",
            ColumnData::String(_) => "nvarchar",
            ColumnData::Binary(_) => "varbinary",
            ColumnData::Numeric(_) => "numeric",
            ColumnData::DateTime(_) => "datetime",
            ColumnData::SmallDateTime(_) => "smalldatetime",
            ColumnData::Time(_) => "time",
            ColumnData::Date(_) => "date",
            ColumnData::DateTime2(_) => "datetime2",
            ColumnData::DateTimeOffset(_) => "datetimeoffset",
            _ => "unknown",
        }
        .to_string()
    }

    fn row_value_string(row: &Row, index: usize) -> Option<String> {
        row.cells().nth(index).and_then(|(_, value)| match value {
            ColumnData::String(Some(v)) => Some(v.to_string()),
            ColumnData::Guid(Some(v)) => Some(v.to_string()),
            ColumnData::Numeric(Some(v)) => Some(v.to_string()),
            ColumnData::I16(Some(v)) => Some(v.to_string()),
            ColumnData::I32(Some(v)) => Some(v.to_string()),
            ColumnData::I64(Some(v)) => Some(v.to_string()),
            ColumnData::U8(Some(v)) => Some(v.to_string()),
            ColumnData::F32(Some(v)) => Some(v.to_string()),
            ColumnData::F64(Some(v)) => Some(v.to_string()),
            ColumnData::Bit(Some(v)) => Some(v.to_string()),
            _ => None,
        })
    }

    fn row_value_i64(row: &Row, index: usize) -> Option<i64> {
        row.cells().nth(index).and_then(|(_, value)| match value {
            ColumnData::I16(Some(v)) => Some((*v).into()),
            ColumnData::I32(Some(v)) => Some((*v).into()),
            ColumnData::I64(Some(v)) => Some(*v),
            ColumnData::U8(Some(v)) => Some((*v).into()),
            ColumnData::String(Some(v)) => v.parse::<i64>().ok(),
            _ => None,
        })
    }

    fn build_result_from_rows(
        rows: &[Row],
        elapsed: u128,
        query: String,
        affected_rows: u64,
        sandboxed: bool,
        truncated: bool,
    ) -> QueryResult {
        let columns = rows
            .first()
            .map(|first| {
                first
                    .cells()
                    .map(|(column, value)| ColumnInfo {
                        name: column.name().to_string(),
                        data_type: Self::ms_column_type(value),
                        is_nullable: true,
                        is_primary_key: false,
                        max_length: None,
                        default_value: None,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let result_rows = rows
            .iter()
            .map(|row| {
                row.cells()
                    .map(|(_, value)| Self::ms_cell_to_json(value))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        QueryResult {
            columns,
            rows: result_rows,
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed,
            truncated,
        }
    }

    async fn query_rows(&self, sql: &str) -> Result<(Vec<Row>, bool)> {
        self.query_rows_with_limit(sql, MAX_QUERY_RESULT_ROWS).await
    }

    /// Like [`Self::query_rows`] but with a caller-chosen row cap. Metadata
    /// enumeration (schema objects) legitimately exceeds the interactive
    /// query cap on system databases (master alone has thousands of system
    /// objects), so it uses a much larger limit.
    async fn query_rows_with_limit(&self, sql: &str, limit: usize) -> Result<(Vec<Row>, bool)> {
        let mut client = self.client.lock().await;
        let rows = client.simple_query(sql).await?.into_first_result().await?;
        let truncated = rows.len() > limit;
        Ok((
            rows.into_iter().take(limit).collect::<Vec<_>>(),
            truncated,
        ))
    }

    async fn execute_statement(&self, sql: &str) -> Result<u64> {
        self.execute_bound(sql, &[]).await
    }

    fn bind_json_value(query: &mut TiberiusQuery<'_>, value: &serde_json::Value) {
        match value {
            serde_json::Value::Null => {
                query.bind(Option::<String>::None);
            }
            serde_json::Value::Bool(value) => {
                query.bind(*value);
            }
            serde_json::Value::Number(value) => {
                if let Some(integer) = value.as_i64() {
                    query.bind(integer);
                } else if let Some(float) = value.as_f64() {
                    query.bind(float);
                } else {
                    query.bind(value.to_string());
                }
            }
            serde_json::Value::String(value) => {
                query.bind(value.clone());
            }
            other => {
                query.bind(other.to_string());
            }
        }
    }

    async fn execute_bound(&self, sql: &str, values: &[serde_json::Value]) -> Result<u64> {
        let mut client = self.client.lock().await;
        let mut query = TiberiusQuery::new(sql);
        for value in values {
            Self::bind_json_value(&mut query, value);
        }
        Ok(query.execute(&mut *client).await?.total())
    }

    async fn query_parameterized_rows(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<(Vec<Row>, bool)> {
        let mut client = self.client.lock().await;
        let mut query = TiberiusQuery::new(sql);
        for parameter in parameters {
            match parameter.data_type {
                QueryParameterType::Text => query.bind(
                    parameter
                        .value
                        .as_str()
                        .ok_or_else(|| anyhow!("Parameter '{}' must be text.", parameter.name))?
                        .to_string(),
                ),
                QueryParameterType::Integer => {
                    query.bind(parameter.value.as_i64().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be an integer.", parameter.name)
                    })?)
                }
                QueryParameterType::Decimal => {
                    query.bind(parameter.value.as_f64().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be a number.", parameter.name)
                    })?)
                }
                QueryParameterType::Boolean => {
                    query.bind(parameter.value.as_bool().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be boolean.", parameter.name)
                    })?)
                }
                QueryParameterType::Json => query.bind(parameter.value.to_string()),
                QueryParameterType::Null => query.bind(Option::<String>::None),
            }
        }
        let rows = query.query(&mut *client).await?.into_first_result().await?;
        let truncated = rows.len() > MAX_QUERY_RESULT_ROWS;
        Ok((
            rows.into_iter().take(MAX_QUERY_RESULT_ROWS).collect(),
            truncated,
        ))
    }

    async fn execute_parameterized_statement(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<u64> {
        let mut client = self.client.lock().await;
        let mut query = TiberiusQuery::new(sql);
        for parameter in parameters {
            match parameter.data_type {
                QueryParameterType::Text => query.bind(
                    parameter
                        .value
                        .as_str()
                        .ok_or_else(|| anyhow!("Parameter '{}' must be text.", parameter.name))?
                        .to_string(),
                ),
                QueryParameterType::Integer => {
                    query.bind(parameter.value.as_i64().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be an integer.", parameter.name)
                    })?)
                }
                QueryParameterType::Decimal => {
                    query.bind(parameter.value.as_f64().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be a number.", parameter.name)
                    })?)
                }
                QueryParameterType::Boolean => {
                    query.bind(parameter.value.as_bool().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be boolean.", parameter.name)
                    })?)
                }
                QueryParameterType::Json => query.bind(parameter.value.to_string()),
                QueryParameterType::Null => query.bind(Option::<String>::None),
            }
        }
        Ok(query.execute(&mut *client).await?.total())
    }
}

#[async_trait]
impl DatabaseDriver for MssqlDriver {
    async fn ping(&self) -> Result<()> {
        let _ = self.query_rows("SELECT 1 AS ok").await?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let (rows, _) = self
            .query_rows("SELECT name FROM sys.databases ORDER BY name")
            .await?;

        Ok(rows
            .iter()
            .filter_map(|row| Self::row_value_string(row, 0))
            .map(|name| DatabaseInfo { name, size: None })
            .collect())
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let db = self.current_database_name(database);
        let sql = format!(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE \
             FROM [{}].INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW') \
             ORDER BY TABLE_SCHEMA, TABLE_NAME",
            db.replace(']', "]]")
        );
        let (rows, _) = self.query_rows(&sql).await?;

        Ok(rows
            .iter()
            .map(|row| TableInfo {
                schema: Self::row_value_string(row, 0),
                name: Self::row_value_string(row, 1).unwrap_or_default(),
                table_type: Self::row_value_string(row, 2).unwrap_or_else(|| "TABLE".to_string()),
                row_count: None,
                engine: Some("SQL Server".to_string()),
            })
            .collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let db = self.current_database_name(database);
        // SSMS-parity coverage: views, triggers (DML), stored procedures
        // (incl. CLR), all function kinds, synonyms, sequences, database-level
        // (DDL) triggers, assemblies, rules, standalone defaults, data types
        // (system categories / user-defined / table types / CLR) and XML
        // schema collections. System objects (is_ms_shipped = 1) are included
        // on purpose — they surface under the `sys` schema section in the
        // explorer, mirroring SSMS.
        let sql = format!(
            "SELECT s.name AS schema_name, o.name, \
                    CASE WHEN o.type = 'D' THEN N'DEFAULT' ELSE o.type_desc END \
             FROM [{}].sys.all_objects o \
             JOIN [{}].sys.schemas s ON s.schema_id = o.schema_id \
             LEFT JOIN [{}].sys.triggers tt ON tt.object_id = o.object_id \
             WHERE o.type IN ('V', 'TR', 'P', 'FN', 'TF', 'IF', 'SN', 'AF', 'PC', 'FS', 'FT', 'R', 'D') \
               AND (o.type <> 'TR' OR tt.parent_class <> 0) \
             UNION ALL \
             SELECT s.name AS schema_name, t.name, N'DATABASE_TRIGGER' \
             FROM [{}].sys.triggers t \
             JOIN [{}].sys.objects o ON o.object_id = t.object_id \
             JOIN [{}].sys.schemas s ON s.schema_id = o.schema_id \
             WHERE t.parent_class = 0 \
             UNION ALL \
             SELECT N'sys' AS schema_name, a.name, N'ASSEMBLY' \
             FROM [{}].sys.assemblies a \
             UNION ALL \
             SELECT s.name AS schema_name, t.name, \
                    CASE \
                      WHEN t.is_user_defined = 0 THEN \
                        CASE \
                          WHEN t.name IN (N'bigint', N'int', N'smallint', N'tinyint', N'bit', \
                                          N'decimal', N'numeric', N'money', N'smallmoney') \
                            THEN N'SYSTEM_EXACT_NUMERIC' \
                          WHEN t.name IN (N'float', N'real') \
                            THEN N'SYSTEM_APPROXIMATE_NUMERIC' \
                          WHEN t.name IN (N'date', N'datetime2', N'datetime', N'smalldatetime', \
                                          N'time', N'datetimeoffset') \
                            THEN N'SYSTEM_DATE_TIME' \
                          WHEN t.name IN (N'char', N'varchar', N'text') \
                            THEN N'SYSTEM_CHARACTER_STRING' \
                          WHEN t.name IN (N'nchar', N'nvarchar', N'ntext') \
                            THEN N'SYSTEM_UNICODE_CHARACTER_STRING' \
                          WHEN t.name IN (N'binary', N'varbinary', N'image') \
                            THEN N'SYSTEM_BINARY_STRING' \
                          WHEN t.name IN (N'geography', N'geometry') \
                            THEN N'SYSTEM_SPATIAL_DATA_TYPE' \
                          WHEN t.is_assembly_type = 1 THEN N'SYSTEM_CLR_DATA_TYPE' \
                          ELSE N'SYSTEM_OTHER_DATA_TYPE' \
                        END \
                      WHEN t.is_table_type = 1 THEN N'USER_TABLE_TYPE' \
                      WHEN t.is_assembly_type = 1 THEN N'USER_CLR_TYPE' \
                      ELSE N'USER_DEFINED_TYPE' \
                    END \
             FROM [{}].sys.types t \
             JOIN [{}].sys.schemas s ON s.schema_id = t.schema_id \
             UNION ALL \
             SELECT s.name AS schema_name, q.name, N'SEQUENCE' \
             FROM [{}].sys.sequences q \
             JOIN [{}].sys.schemas s ON s.schema_id = q.schema_id \
             UNION ALL \
             SELECT s.name AS schema_name, x.name, N'XML_SCHEMA_COLLECTION' \
             FROM [{}].sys.xml_schema_collections x \
             JOIN [{}].sys.schemas s ON s.schema_id = x.schema_id \
             ORDER BY schema_name, name",
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
        );
        let (rows, _) = self
            .query_rows_with_limit(&sql, METADATA_QUERY_ROW_LIMIT)
            .await?;

        Ok(rows
            .iter()
            .map(|row| SchemaObjectInfo {
                schema: Self::row_value_string(row, 0),
                name: Self::row_value_string(row, 1).unwrap_or_default(),
                object_type: Self::row_value_string(row, 2).unwrap_or_else(|| "OBJECT".to_string()),
                related_table: None,
                definition: None,
            })
            .collect())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let db = self.current_database_name(database);
        let (schema, name) = Self::split_schema_table(table);
        let db_name = db.replace(']', "]]");
        let schema_lit = schema.replace('\'', "''");
        let name_lit = name.replace('\'', "''");

        let columns_sql = format!(
            "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT \
             FROM [{db_name}].INFORMATION_SCHEMA.COLUMNS c \
             WHERE c.TABLE_SCHEMA = N'{schema_lit}' AND c.TABLE_NAME = N'{name_lit}' \
             ORDER BY c.ORDINAL_POSITION"
        );
        let pk_sql = format!(
            "SELECT ku.COLUMN_NAME \
             FROM [{db_name}].INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
             JOIN [{db_name}].INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku \
               ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME \
              AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA \
              AND tc.TABLE_NAME = ku.TABLE_NAME \
             WHERE tc.TABLE_SCHEMA = N'{schema_lit}' \
               AND tc.TABLE_NAME = N'{name_lit}' \
               AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'"
        );

        let (column_rows, _) = self.query_rows(&columns_sql).await?;
        let (pk_rows, _) = self.query_rows(&pk_sql).await?;
        let primary_keys = pk_rows
            .iter()
            .filter_map(|row| Self::row_value_string(row, 0))
            .collect::<HashSet<_>>();

        let columns = column_rows
            .iter()
            .map(|row| {
                let column_name = Self::row_value_string(row, 0).unwrap_or_default();
                let nullable = Self::row_value_string(row, 2)
                    .map(|value| value.eq_ignore_ascii_case("YES"))
                    .unwrap_or(true);

                ColumnDetail {
                    name: column_name.clone(),
                    data_type: Self::row_value_string(row, 1)
                        .unwrap_or_else(|| "nvarchar".to_string()),
                    is_nullable: nullable,
                    is_primary_key: primary_keys.contains(&column_name),
                    default_value: Self::row_value_string(row, 3),
                    extra: None,
                    column_type: None,
                    comment: None,
                }
            })
            .collect::<Vec<_>>();

        Ok(TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: None,
            object_type: Some("table".to_string()),
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let statements = split_sql_statements(sql);
        let mut total_affected = 0u64;
        let mut last_result = None;

        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
            if Self::query_returns_rows(statement) {
                let (rows, truncated) = self.query_rows(statement).await?;
                last_result = Some(Self::build_result_from_rows(
                    &rows,
                    0,
                    sql.to_string(),
                    total_affected,
                    false,
                    truncated,
                ));
            } else {
                total_affected += self.execute_statement(statement).await?;
            }
        }

        let elapsed = start.elapsed().as_millis();
        if let Some(mut result) = last_result {
            result.execution_time_ms = elapsed;
            result.affected_rows = total_affected;
            return Ok(result);
        }

        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: total_affected,
            execution_time_ms: elapsed,
            query: sql.to_string(),
            sandboxed: false,
            truncated: false,
        })
    }

    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        let start = Instant::now();
        if Self::query_returns_rows(sql) {
            let (rows, truncated) = self.query_parameterized_rows(sql, parameters).await?;
            let mut result =
                Self::build_result_from_rows(&rows, 0, sql.to_string(), 0, false, truncated);
            result.execution_time_ms = start.elapsed().as_millis();
            return Ok(result);
        }
        let affected_rows = self
            .execute_parameterized_statement(sql, parameters)
            .await?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows,
            execution_time_ms: start.elapsed().as_millis(),
            query: sql.to_string(),
            sandboxed: false,
            truncated: false,
        })
    }

    async fn get_table_data(
        &self,
        table: &str,
        database: Option<&str>,
        offset: u64,
        limit: u64,
        order_by: Option<&str>,
        order_dir: Option<&str>,
        filter: Option<&str>,
    ) -> Result<QueryResult> {
        let mut sql = format!(
            "SELECT * FROM {}",
            Self::qualify_table_name(table, database)?
        );

        if let Some(filter_clause) = sanitize_mssql_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }

        let order_expr = if let Some(order_by) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            format!("{} {}", quote_mssql_order_by(order_by)?, direction)
        } else {
            "(SELECT NULL)".to_string()
        };

        sql.push_str(&format!(
            " ORDER BY {order_expr} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
        ));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {}",
            Self::qualify_table_name(table, _database)?
        );
        let (rows, _) = self.query_rows(&sql).await?;
        rows.first()
            .and_then(|row| Self::row_value_i64(row, 0))
            .ok_or_else(|| anyhow!("SQL Server count query returned no rows"))
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {} WHERE {} IS NULL",
            Self::qualify_table_name(table, database)?,
            quote_mssql_order_by(column)?,
        );
        let (rows, _) = self.query_rows(&sql).await?;
        rows.first()
            .and_then(|row| Self::row_value_i64(row, 0))
            .ok_or_else(|| anyhow!("SQL Server null-count query returned no rows"))
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let mut values = Vec::new();
        values.push(request.value.clone());
        let mut where_clause = String::new();
        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                where_clause.push_str(" AND ");
            }

            where_clause.push_str(&quote_mssql_order_by(&primary_key.column)?);
            if primary_key.value.is_null() {
                where_clause.push_str(" IS NULL");
            } else {
                values.push(primary_key.value.clone());
                where_clause.push_str(&format!(" = @P{}", values.len()));
            }
        }

        let sql = format!(
            "UPDATE {} SET {} = @P1 WHERE {}",
            Self::qualify_table_name(&request.table, request.database.as_deref())?,
            quote_mssql_order_by(&request.target_column)?,
            where_clause
        );

        self.execute_bound(&sql, &values).await
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let mut values = Vec::new();
        let mut predicates = Vec::new();
        for row in &request.rows {
            if row.is_empty() {
                continue;
            }

            let mut parts = Vec::new();
            for key in row {
                if key.value.is_null() {
                    parts.push(format!("{} IS NULL", quote_mssql_order_by(&key.column)?));
                } else {
                    values.push(key.value.clone());
                    parts.push(format!(
                        "{} = @P{}",
                        quote_mssql_order_by(&key.column)?,
                        values.len(),
                    ));
                }
            }

            if !parts.is_empty() {
                predicates.push(format!("({})", parts.join(" AND ")));
            }
        }

        if predicates.is_empty() {
            return Err(anyhow!(
                "Deleting rows requires at least one valid row predicate"
            ));
        }

        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualify_table_name(&request.table, request.database.as_deref())?,
            predicates.join(" OR "),
        );

        self.execute_bound(&sql, &values).await
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let sql = format!("USE {}", super::safety::quote_mssql_identifier(database)?);
        self.execute_statement(&sql).await?;
        *self.current_db.write().unwrap() = Some(database.to_string());
        Ok(())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.read().unwrap().clone()
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let mut cols = Vec::new();
        let mut placeholders = Vec::new();
        let mut values = Vec::new();
        for (col, value) in &request.values {
            cols.push(quote_mssql_identifier(col)?.to_string());
            values.push(value.clone());
            placeholders.push(format!("@P{}", values.len()));
        }

        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            Self::qualify_table_name(&request.table, request.database.as_deref())?,
            cols.join(", "),
            placeholders.join(", "),
        );

        self.execute_bound(&sql, &values).await
    }

    fn driver_name(&self) -> &str {
        "SQL Server"
    }

    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        let table_quoted = qualify_mssql_table_name(referenced_table, "dbo")?;
        let col_quoted = quote_mssql_identifier(referenced_column)?;

        let label_expr = if !display_columns.is_empty() {
            let cols = display_columns
                .iter()
                .map(|c| quote_mssql_identifier(c).unwrap_or_else(|_| c.to_string()))
                .collect::<Vec<_>>()
                .join(", ");
            format!("COALESCE({})", cols)
        } else {
            col_quoted.clone()
        };

        let sql = if let Some(search_term) = search {
            format!(
                "SELECT TOP {} {} AS value, {} AS label \
                 FROM {} \
                 WHERE CAST({} AS NVARCHAR) LIKE '%{}%' \
                 ORDER BY {}",
                limit,
                col_quoted,
                label_expr,
                table_quoted,
                col_quoted,
                search_term.replace('\'', "''"),
                col_quoted
            )
        } else {
            format!(
                "SELECT TOP {} {} AS value, {} AS label \
                 FROM {} \
                 ORDER BY {}",
                limit, col_quoted, label_expr, table_quoted, col_quoted
            )
        };

        let (rows, _truncated) = self.query_rows(&sql).await?;
        let mut values = Vec::with_capacity(rows.len());
        for row in rows {
            let cells: Vec<ColumnData<'static>> = row.into_iter().collect();
            if cells.len() >= 2 {
                let json_value = Self::ms_cell_to_json(&cells[0]);
                let json_label = Self::ms_cell_to_json(&cells[1]);
                let label_str = json_label
                    .as_str()
                    .map(String::from)
                    .unwrap_or_else(|| json_label.to_string());
                values.push(LookupValue {
                    value: json_value,
                    label: label_str,
                });
            }
        }
        Ok(values)
    }
}

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
mod mssql_live_diagnostics {
    use super::MssqlDriver;
    use crate::database::models::{ConnectionConfig, DatabaseType};
    use std::collections::HashMap;

    /// Requires a live SQL Server instance on this machine. Run manually:
    /// `cargo test --lib mssql_live_connection -- --ignored --nocapture`
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
    /// Live probe: verify what object_type values list_schema_objects returns
    /// against the real server (run with --ignored --nocapture).
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
        for object in objects.iter().filter(|o| o.schema.as_deref() == Some("dbo")) {
            println!(
                "  dbo row: {} type={:?}",
                object.name, object.object_type
            );
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
        ssh_config: None,
    }
}
