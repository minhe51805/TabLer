//! Connection export/import with AES-256-GCM encryption.
//! File format: { version: "1", salt: base64, iv: base64, data: base64 }

use crate::database::models::{ConnectionConfig, DatabaseType, SslMode};
use crate::storage::connection_storage::ConnectionStorage;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac_array;
use rand::RngCore;
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use tauri::State;
use uuid::Uuid;

const PBKDF2_V1_ITERATIONS: u32 = 100_000;
const PBKDF2_V2_ITERATIONS: u32 = 600_000;
const MIN_PASSWORD_LEN: usize = 10;
const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const EXPORT_AAD: &[u8] = b"tabler.connection-export.v2";
const EXPORT_FORMAT: &str = "tabler.connection-export";

#[derive(Serialize, Deserialize)]
struct EncryptedPayloadV1 {
    version: String,
    salt: String,
    iv: String,
    data: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedPayloadV2 {
    version: u8,
    format: String,
    cipher: String,
    kdf: String,
    iterations: u32,
    salt: String,
    nonce: String,
    data: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionExportDocument {
    version: u8,
    format: String,
    exported_at: String,
    connections: Vec<ExportableConnection>,
}

/// Derive a 256-bit key from password using PBKDF2-SHA256.
fn derive_key(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), salt, iterations)
}

/// Encrypt connection data with the authenticated, versioned v2 envelope.
pub fn encrypt_connections(data: &str, password: &str) -> Result<String, String> {
    if password.len() < MIN_PASSWORD_LEN {
        return Err(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters."
        ));
    }

    let mut rng = rand::rngs::OsRng;
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce_bytes);

    let key = derive_key(password, &salt, PBKDF2_V2_ITERATIONS);
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Failed to create cipher: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: data.as_bytes(),
                aad: EXPORT_AAD,
            },
        )
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let payload = EncryptedPayloadV2 {
        version: 2,
        format: EXPORT_FORMAT.to_string(),
        cipher: "AES-256-GCM".to_string(),
        kdf: "PBKDF2-HMAC-SHA256".to_string(),
        iterations: PBKDF2_V2_ITERATIONS,
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce_bytes),
        data: BASE64.encode(ciphertext),
    };

    serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize encrypted payload: {}", e))
}

/// Decrypts v2 exports and supports v1 files as a migration path.
pub fn decrypt_connections(encrypted: &str, password: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(encrypted)
        .map_err(|e| format!("Invalid encrypted file format: {e}"))?;
    let version = value
        .get("version")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let plaintext = if version == serde_json::json!(2) {
        decrypt_v2(
            serde_json::from_value(value).map_err(|e| format!("Invalid v2 export: {e}"))?,
            password,
        )?
    } else if version == serde_json::json!("1") {
        decrypt_v1(
            serde_json::from_value(value).map_err(|e| format!("Invalid v1 export: {e}"))?,
            password,
        )?
    } else {
        return Err("Unsupported connection export version.".to_string());
    };

    String::from_utf8(plaintext).map_err(|e| format!("Decrypted data is not valid UTF-8: {e}"))
}

fn decrypt_v2(payload: EncryptedPayloadV2, password: &str) -> Result<Vec<u8>, String> {
    if payload.format != EXPORT_FORMAT
        || payload.cipher != "AES-256-GCM"
        || payload.kdf != "PBKDF2-HMAC-SHA256"
    {
        return Err("Unsupported v2 connection export parameters.".to_string());
    }
    if payload.iterations < PBKDF2_V1_ITERATIONS || payload.iterations > 2_000_000 {
        return Err("Connection export uses unsupported KDF iterations.".to_string());
    }
    let salt = BASE64
        .decode(payload.salt)
        .map_err(|_| "Invalid v2 export salt.".to_string())?;
    let nonce_bytes = BASE64
        .decode(payload.nonce)
        .map_err(|_| "Invalid v2 export nonce.".to_string())?;
    let ciphertext = BASE64
        .decode(payload.data)
        .map_err(|_| "Invalid v2 export data.".to_string())?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err("Invalid v2 export nonce length.".to_string());
    }
    let key = derive_key(password, &salt, payload.iterations);
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Failed to create cipher: {e}"))?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: ciphertext.as_ref(),
                aad: EXPORT_AAD,
            },
        )
        .map_err(|_| "Decryption failed. Incorrect password or modified file.".to_string())
}

fn decrypt_v1(payload: EncryptedPayloadV1, password: &str) -> Result<Vec<u8>, String> {
    let salt = BASE64
        .decode(payload.salt)
        .map_err(|_| "Invalid v1 export salt.".to_string())?;
    let nonce_bytes = BASE64
        .decode(payload.iv)
        .map_err(|_| "Invalid v1 export IV.".to_string())?;
    let ciphertext = BASE64
        .decode(payload.data)
        .map_err(|_| "Invalid v1 export data.".to_string())?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err("Invalid v1 export IV length.".to_string());
    }
    let key = derive_key(password, &salt, PBKDF2_V1_ITERATIONS);
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Failed to create cipher: {e}"))?;
    cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| "Decryption failed. Incorrect password or modified file.".to_string())
}

// ─── Serializable version of ConnectionConfig (excludes password and internal IDs) ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportableConnection {
    pub(crate) name: String,
    pub(crate) db_type: DatabaseType,
    pub(crate) host: Option<String>,
    pub(crate) port: Option<u16>,
    pub(crate) username: Option<String>,
    pub(crate) database: Option<String>,
    pub(crate) file_path: Option<String>,
    pub(crate) use_ssl: bool,
    pub(crate) ssl_mode: Option<SslMode>,
    pub(crate) ssl_ca_cert_path: Option<String>,
    pub(crate) ssl_client_cert_path: Option<String>,
    pub(crate) ssl_client_key_path: Option<String>,
    pub(crate) ssl_skip_host_verification: Option<bool>,
    pub(crate) color: Option<String>,
    pub(crate) additional_fields: HashMap<String, String>,
    pub(crate) startup_commands: Option<String>,
    /// Shell command run locally before connecting (workspace bundles carry it).
    #[serde(default)]
    pub(crate) pre_connect_script: Option<String>,
    /// SSH tunnel settings with secrets stripped (password/private key/
    /// passphrase live in the keyring and never leave the machine).
    #[serde(default)]
    pub(crate) ssh_config: Option<crate::ssh::ssh_tunnel::SshConfig>,
    /// Per-connection query timeout override (seconds); `None` keeps the
    /// classified defaults. `#[serde(default)]` keeps older export files
    /// importable.
    #[serde(default)]
    pub(crate) query_timeout_seconds: Option<u64>,
    /// Read-only guard flag; `#[serde(default)]` keeps older export files
    /// importable.
    #[serde(default)]
    pub(crate) read_only: bool,
}

impl From<&ConnectionConfig> for ExportableConnection {
    fn from(config: &ConnectionConfig) -> Self {
        Self {
            name: config.name.clone(),
            db_type: config.db_type,
            host: config.host.clone(),
            port: config.port,
            username: config.username.clone(),
            database: config.database.clone(),
            file_path: config.file_path.clone(),
            use_ssl: config.use_ssl,
            ssl_mode: config.ssl_mode,
            ssl_ca_cert_path: config.ssl_ca_cert_path.clone(),
            ssl_client_cert_path: config.ssl_client_cert_path.clone(),
            ssl_client_key_path: config.ssl_client_key_path.clone(),
            ssl_skip_host_verification: config.ssl_skip_host_verification,
            color: config.color.clone(),
            additional_fields: config.additional_fields.clone(),
            startup_commands: config.startup_commands.clone(),
            pre_connect_script: config.pre_connect_script.clone(),
            ssh_config: config.ssh_config.clone(),
            query_timeout_seconds: config.query_timeout_seconds,
            read_only: config.read_only,
        }
    }
}

impl ExportableConnection {
    /// Rebuild a full ConnectionConfig from an export entry. The export format
    /// never carries passwords, so the imported record starts credential-less
    /// unless the user supplied one in the import dialog.
    pub(crate) fn to_connection_config(&self, password: Option<String>) -> ConnectionConfig {
        let mut config = ConnectionConfig {
            id: Uuid::new_v4().to_string(),
            name: self.name.clone(),
            db_type: self.db_type,
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            password,
            database: self.database.clone(),
            file_path: self.file_path.clone(),
            use_ssl: self.use_ssl,
            ssl_mode: self.ssl_mode,
            ssl_ca_cert_path: self.ssl_ca_cert_path.clone(),
            ssl_client_cert_path: self.ssl_client_cert_path.clone(),
            ssl_client_key_path: self.ssl_client_key_path.clone(),
            ssl_skip_host_verification: self.ssl_skip_host_verification,
            color: self.color.clone(),
            additional_fields: self.additional_fields.clone(),
            startup_commands: self.startup_commands.clone(),
            pre_connect_script: self.pre_connect_script.clone(),
            query_timeout_seconds: self.query_timeout_seconds,
            ssh_config: self.ssh_config.clone(),
            read_only: self.read_only,
        };
        config.fill_generated_name();
        config
    }
}

/// Two entries describe the same connection when the id matches (re-import of
/// an already-persisted record) or when engine + endpoint + display name all
/// match (re-import of the same export file, which mints fresh ids).
pub(crate) fn is_same_connection(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    a.id == b.id
        || (a.db_type == b.db_type
            && a.name == b.name
            && a.host == b.host
            && a.port == b.port
            && a.file_path == b.file_path)
}

/// Persist imported configs through the same ConnectionStorage path that
/// `connect_database` uses, skipping entries that already exist.
fn persist_imported_connections(
    storage: &ConnectionStorage,
    imported: &[ExportableConnection],
    selected_indices: &[usize],
    passwords: &HashMap<usize, String>,
) -> Result<(), String> {
    let existing = storage
        .load_connections()
        .map_err(|error| format!("Failed to load saved connections: {error}"))?;
    for &index in selected_indices {
        let Some(exportable) = imported.get(index) else {
            continue;
        };
        let password = passwords
            .get(&index)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let config = exportable.to_connection_config(password);
        if existing
            .iter()
            .any(|saved| is_same_connection(saved, &config))
        {
            continue;
        }
        storage
            .save_connection(&config)
            .map_err(|error| format!("Failed to save the imported connection: {error}"))?;
    }
    Ok(())
}

/// Export selected connections to an encrypted, versioned .tabler-connections file.
#[tauri::command]
pub fn export_connections_to_file(
    connections: Vec<ConnectionConfig>,
    password: String,
) -> Result<String, String> {
    if connections.is_empty() {
        return Err("No connections selected for export.".to_string());
    }
    if password.len() < MIN_PASSWORD_LEN {
        return Err(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters."
        ));
    }

    // Convert to exportable format (excludes password and internal IDs)
    let exportable: Vec<ExportableConnection> =
        connections.iter().map(ExportableConnection::from).collect();

    let document = ConnectionExportDocument {
        version: 2,
        format: EXPORT_FORMAT.to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        connections: exportable,
    };
    let json = serde_json::to_string(&document)
        .map_err(|e| format!("Failed to serialize connections: {}", e))?;

    let encrypted = encrypt_connections(&json, &password)?;

    let suggested_name = if connections.len() == 1 {
        let name = connections[0].name.trim();
        if !name.is_empty() {
            format!(
                "{}.tabler-connections",
                name.replace(
                    |c: char| !c.is_alphanumeric() && c != ' ' && c != '-' && c != '_',
                    "_"
                )
            )
        } else {
            "connections.tabler-connections".to_string()
        }
    } else {
        "connections.tabler-connections".to_string()
    };

    let path = FileDialog::new()
        .set_file_name(&suggested_name)
        .add_filter("TableR Connection Export", &["tabler-connections"])
        .save_file();

    match path {
        Some(file_path) => {
            std::fs::write(&file_path, &encrypted)
                .map_err(|e| format!("Failed to write file: {}", e))?;
            Ok(file_path.to_string_lossy().to_string())
        }
        None => Err("No file selected.".to_string()),
    }
}

/// Imports v2 connection exports and transparently migrates legacy v1 files.
/// When `selected_indices` is provided, those entries are persisted through
/// ConnectionStorage (the same path `connect_database` saves through) and any
/// per-entry passwords typed into the import dialog are stored in the keyring.
/// Without it the command is a pure preview: decrypt and return, save nothing.
#[tauri::command]
pub fn import_connections_from_file(
    file_path: String,
    password: String,
    selected_indices: Option<Vec<usize>>,
    passwords: Option<HashMap<usize, String>>,
    conn_storage: State<'_, ConnectionStorage>,
) -> Result<Vec<ExportableConnection>, String> {
    let encrypted =
        std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    let decrypted = decrypt_connections(&encrypted, &password)?;
    let connections = parse_decrypted_connections(&decrypted)?;

    if let Some(indices) = selected_indices {
        persist_imported_connections(
            &conn_storage,
            &connections,
            &indices,
            &passwords.unwrap_or_default(),
        )?;
    }

    Ok(connections)
}

fn parse_decrypted_connections(decrypted: &str) -> Result<Vec<ExportableConnection>, String> {
    if let Ok(document) = serde_json::from_str::<ConnectionExportDocument>(decrypted) {
        if document.version != 2 || document.format != EXPORT_FORMAT {
            return Err("Unsupported decrypted connection export document.".to_string());
        }
        return Ok(document.connections);
    }

    serde_json::from_str::<Vec<ExportableConnection>>(decrypted).map_err(|e| {
        format!("Failed to parse connection data: {e}. Make sure the password is correct.")
    })
}

// ─── External tool import (DBeaver / DataGrip) ───
//
// These formats are plaintext and carry no usable secrets: DBeaver encrypts
// passwords inside its own credential store and DataGrip keeps them in the
// IDE keychain, so imported connections always land credential-less and the
// user re-enters passwords in the preview dialog.

/// Preview payload for `import_external_connections`: the parsed connections
/// plus the entries that were skipped (unsupported engine, malformed row).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalImportResult {
    connections: Vec<ExportableConnection>,
    skipped: Vec<SkippedConnection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedConnection {
    name: String,
    reason: String,
}

/// DBeaver `.dbeaver/data-sources.json`: `{ "connections": { "<id>": {...} } }`.
#[derive(Debug, Deserialize)]
struct DBeaverDataSources {
    #[serde(default)]
    connections: HashMap<String, DBeaverConnection>,
}

#[derive(Debug, Deserialize)]
struct DBeaverConnection {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    driver: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    configuration: DBeaverConfiguration,
}

#[derive(Debug, Default, Deserialize)]
struct DBeaverConfiguration {
    #[serde(default)]
    host: Option<String>,
    /// DBeaver writes the port as a string ("5432"); accept numbers too.
    #[serde(default)]
    port: Option<serde_json::Value>,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// Raw fields collected from either tool's file before engine mapping.
#[derive(Debug, Default)]
struct ExternalDraft {
    name: Option<String>,
    /// DBeaver `provider` / DataGrip `driver-ref` / DBeaver `driver` id.
    provider_hint: Option<String>,
    driver_hint: Option<String>,
    url: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    database: Option<String>,
    user: Option<String>,
}

/// Fields extracted from a JDBC URL (or a DBeaver-style `scheme://` URL).
#[derive(Debug, Default)]
struct ParsedJdbcUrl {
    /// The URL scheme, e.g. `postgresql`, `mysql`, `sqlserver`, `sqlite`.
    scheme: String,
    host: Option<String>,
    port: Option<u16>,
    database: Option<String>,
    user: Option<String>,
    /// File path for file-based engines (sqlite, duckdb).
    file_path: Option<String>,
}

/// Map a provider/driver/URL-scheme hint to a DatabaseType. Returns `None`
/// for engines TableR cannot connect to (db2, h2, ...) and for
/// unrecognized hints — those entries are reported as skipped.
fn engine_from_hint(hint: &str) -> Option<DatabaseType> {
    let hint = hint.to_lowercase();
    // Order matters: check the more specific names before their substrings
    // (mariadb before mysql, sqlserver before generic matches).
    if hint.contains("mariadb") {
        Some(DatabaseType::MariaDB)
    } else if hint.contains("mysql") {
        Some(DatabaseType::MySQL)
    } else if hint.contains("cockroach") {
        Some(DatabaseType::CockroachDB)
    } else if hint.contains("greenplum") {
        Some(DatabaseType::Greenplum)
    } else if hint.contains("redshift") {
        Some(DatabaseType::Redshift)
    } else if hint.contains("postgres") {
        Some(DatabaseType::PostgreSQL)
    } else if hint.contains("sqlite") {
        Some(DatabaseType::SQLite)
    } else if hint.contains("duckdb") {
        Some(DatabaseType::DuckDB)
    } else if hint.contains("sqlserver")
        || hint.contains("mssql")
        || hint.contains("jtds")
        || hint.contains("sql_server")
    {
        Some(DatabaseType::MSSQL)
    } else if hint.contains("mongo") {
        Some(DatabaseType::MongoDB)
    } else if hint.contains("redis") {
        Some(DatabaseType::Redis)
    } else if hint.contains("clickhouse") {
        Some(DatabaseType::ClickHouse)
    } else if hint.contains("cassandra") {
        Some(DatabaseType::Cassandra)
    } else if hint.contains("snowflake") {
        Some(DatabaseType::Snowflake)
    } else if hint.contains("vertica") {
        Some(DatabaseType::Vertica)
    } else if hint.contains("bigquery") {
        Some(DatabaseType::BigQuery)
    } else if hint.contains("oracle") || hint.contains("ords") {
        // Oracle thin/JDBC URLs (jdbc:oracle:thin:@//host:1521/service) map to
        // the ORDS driver; the imported port/service usually needs adjusting
        // to the ORDS HTTP endpoint and schema alias.
        Some(DatabaseType::Oracle)
    } else {
        // db2, h2, derby, hive, generic jdbc drivers, ...
        None
    }
}

fn parse_port_value(value: &serde_json::Value) -> Option<u16> {
    match value {
        serde_json::Value::Number(n) => n.as_u64().and_then(|v| u16::try_from(v).ok()),
        serde_json::Value::String(s) => s.trim().parse::<u16>().ok(),
        _ => None,
    }
}

/// Parse `jdbc:<scheme>:...` and bare `<scheme>:...` URLs. Handles the common
/// `scheme://host:port/db?k=v` shape plus SQL Server's `;key=value` tail and
/// file-based `sqlite:path` / `duckdb:path` URLs.
fn parse_jdbc_url(url: &str) -> Option<ParsedJdbcUrl> {
    let mut rest = url.trim();
    if let Some(stripped) = rest.strip_prefix("jdbc:") {
        rest = stripped;
    }
    let (scheme, mut tail) = rest.split_once(':')?;
    let scheme = scheme.to_lowercase();

    // Oracle JDBC URLs carry a driver subscheme before the address:
    // `jdbc:oracle:thin:@//host:1521/service` (and `oci:`/`oci8:` variants).
    if scheme == "oracle" {
        for subscheme in ["thin:", "oci8:", "oci:"] {
            if let Some(rest) = tail.strip_prefix(subscheme) {
                tail = rest;
                break;
            }
        }
    }
    let mut parsed = ParsedJdbcUrl {
        scheme: scheme.clone(),
        ..ParsedJdbcUrl::default()
    };

    // File-based engines: everything after the scheme is the file path.
    // Strip only the `//` authority marker so `jdbc:sqlite:/abs/path`
    // keeps its leading slash.
    if scheme == "sqlite" || scheme == "duckdb" {
        let path = tail.strip_prefix("//").unwrap_or(tail);
        if !path.is_empty() {
            parsed.file_path = Some(path.to_string());
        }
        return Some(parsed);
    }

    // Strip authority markers: `//` (standard) and `@//`/`@` (oracle thin).
    tail = tail
        .trim_start_matches("//")
        .trim_start_matches('@')
        .trim_start_matches("//");
    let (authority, tail) = match tail.find(['/', ';', '?']) {
        Some(idx) => (&tail[..idx], &tail[idx..]),
        None => (tail, ""),
    };

    // userinfo@host:port
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    if let Some((host, port)) = authority.rsplit_once(':') {
        if let Ok(port) = port.parse::<u16>() {
            parsed.host = Some(host.to_string());
            parsed.port = Some(port);
        } else {
            parsed.host = Some(authority.to_string());
        }
    } else if !authority.is_empty() {
        parsed.host = Some(authority.to_string());
    }

    // Tail: `/dbname?k=v` (standard) or `;databaseName=db;user=u` (sqlserver).
    let tail = tail.trim_start_matches('/');
    let (db_part, props_part) = match tail.find(['?', ';']) {
        Some(idx) => (&tail[..idx], &tail[idx..]),
        None => (tail, ""),
    };
    if !db_part.is_empty() {
        parsed.database = Some(db_part.to_string());
    }
    for pair in props_part.split(['?', ';', '&']) {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        match key.to_lowercase().as_str() {
            "databasename" | "database" => {
                if parsed.database.is_none() && !value.is_empty() {
                    parsed.database = Some(value.to_string());
                }
            }
            "user" | "username" => {
                if parsed.user.is_none() && !value.is_empty() {
                    parsed.user = Some(value.to_string());
                }
            }
            "portnumber" | "port" if parsed.port.is_none() => {
                parsed.port = value.parse::<u16>().ok();
            }
            // `password` and every other property are deliberately ignored:
            // credentials are never imported.
            _ => {}
        }
    }
    Some(parsed)
}

/// Turn a collected draft into an ExportableConnection, or a skip reason.
fn draft_to_exportable(draft: ExternalDraft, source: &str) -> Result<ExportableConnection, String> {
    let parsed_url = draft.url.as_deref().and_then(parse_jdbc_url);

    // Engine resolution order: explicit provider id, driver id, URL scheme.
    let db_type = draft
        .provider_hint
        .as_deref()
        .and_then(engine_from_hint)
        .or_else(|| draft.driver_hint.as_deref().and_then(engine_from_hint))
        .or_else(|| {
            parsed_url
                .as_ref()
                .and_then(|u| engine_from_hint(&u.scheme))
        })
        .ok_or_else(|| {
            let hint = draft
                .provider_hint
                .or_else(|| draft.driver_hint.clone())
                .or_else(|| parsed_url.as_ref().map(|u| u.scheme.clone()))
                .unwrap_or_else(|| "unknown".to_string());
            format!("unsupported engine ({hint})")
        })?;

    let is_file_based = matches!(db_type, DatabaseType::SQLite | DatabaseType::DuckDB);

    let host = draft
        .host
        .or_else(|| parsed_url.as_ref().and_then(|u| u.host.clone()));
    let port = draft
        .port
        .or_else(|| parsed_url.as_ref().and_then(|u| u.port));
    let database = draft
        .database
        .or_else(|| parsed_url.as_ref().and_then(|u| u.database.clone()));
    let user = draft
        .user
        .or_else(|| parsed_url.as_ref().and_then(|u| u.user.clone()));
    let file_path = if is_file_based {
        parsed_url
            .as_ref()
            .and_then(|u| u.file_path.clone())
            .or(database.clone())
    } else {
        None
    };

    let name = draft
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            host.clone()
                .or_else(|| file_path.clone())
                .or_else(|| database.clone())
                .unwrap_or_else(|| "Imported connection".to_string())
        });

    let mut additional_fields = HashMap::new();
    additional_fields.insert("import_source".to_string(), source.to_string());
    additional_fields.insert(
        "import_note".to_string(),
        "Password not imported — the source tool stores credentials encrypted; re-enter it after import.".to_string(),
    );

    Ok(ExportableConnection {
        name,
        db_type,
        host: if is_file_based { None } else { host },
        port: if is_file_based { None } else { port },
        username: user,
        database: if is_file_based { None } else { database },
        file_path,
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
        query_timeout_seconds: None,
        read_only: false,
    })
}

fn parse_dbeaver_json(content: &str) -> Result<Vec<ExternalDraft>, String> {
    let document: DBeaverDataSources = serde_json::from_str(content)
        .map_err(|e| format!("Failed to parse DBeaver data-sources.json: {e}"))?;
    Ok(document
        .connections
        .into_values()
        .map(|conn| ExternalDraft {
            name: conn.name,
            provider_hint: conn.provider,
            driver_hint: conn.driver,
            url: conn.configuration.url,
            host: conn.configuration.host,
            port: conn.configuration.port.as_ref().and_then(parse_port_value),
            database: conn.configuration.database,
            user: conn.configuration.user,
        })
        .collect())
}

/// Read an attribute off a quick-xml start/empty tag, unescaping entities.
fn xml_attr(e: &quick_xml::events::BytesStart<'_>, name: &str) -> Option<String> {
    e.attributes().flatten().find_map(|attr| {
        if attr.key.local_name().as_ref() == name.as_bytes() {
            attr.decoded_and_normalized_value(quick_xml::XmlVersion::Explicit1_0, e.decoder())
                .ok()
                .map(|v| v.into_owned())
        } else {
            None
        }
    })
}

/// Parse both XML flavors in a single pass:
/// - DBeaver legacy `data-sources.xml`: `<data-source>` elements with a
///   `provider` attribute and a `<connection host=... port=... user=...>`
///   child.
/// - DataGrip `dataSources.xml` / `dataSources.local.xml`: `<data-source>`
///   elements with `name`/`uuid` attributes and `<driver-ref>`, `<jdbc-url>`,
///   `<user-name>`, `<database-name>` text children.
fn parse_external_xml(content: &str) -> Result<Vec<ExternalDraft>, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);

    let mut drafts: Vec<ExternalDraft> = Vec::new();
    let mut current: Option<ExternalDraft> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"data-source" => {
                    // Both formats use <data-source>; DBeaver carries
                    // `provider`, DataGrip carries `name`/`uuid`.
                    current = Some(ExternalDraft {
                        name: xml_attr(&e, "name"),
                        provider_hint: xml_attr(&e, "provider"),
                        ..ExternalDraft::default()
                    });
                }
                b"connection" => {
                    // DBeaver legacy: connection details as attributes.
                    if let Some(draft) = current.as_mut() {
                        if let Some(driver) = xml_attr(&e, "driver") {
                            draft.driver_hint = Some(driver);
                        }
                        if let Some(url) = xml_attr(&e, "url") {
                            draft.url = Some(url);
                        }
                        if let Some(host) = xml_attr(&e, "host") {
                            draft.host = Some(host);
                        }
                        if let Some(port) = xml_attr(&e, "port") {
                            draft.port = port.parse::<u16>().ok();
                        }
                        if let Some(server) = xml_attr(&e, "server") {
                            draft.database = Some(server);
                        }
                        if let Some(user) = xml_attr(&e, "user") {
                            draft.user = Some(user);
                        }
                    }
                }
                // DataGrip leaf elements carry their value as text.
                b"jdbc-url" | b"user-name" | b"database-name" | b"driver-ref" => {
                    if let Some(draft) = current.as_mut() {
                        let local = e.local_name().as_ref().to_vec();
                        let text = reader
                            .read_text(e.name())
                            .ok()
                            .and_then(|t| t.decode().ok().map(|s| s.into_owned()))
                            .unwrap_or_default();
                        let text = text.trim();
                        if !text.is_empty() {
                            match local.as_slice() {
                                b"jdbc-url" => draft.url = Some(text.to_string()),
                                b"user-name" => draft.user = Some(text.to_string()),
                                b"database-name" => draft.database = Some(text.to_string()),
                                b"driver-ref" if draft.driver_hint.is_none() => {
                                    draft.driver_hint = Some(text.to_string());
                                }
                                _ => {}
                            }
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                // Self-closing variants of the same elements.
                b"data-source" => {
                    drafts.push(ExternalDraft {
                        name: xml_attr(&e, "name"),
                        provider_hint: xml_attr(&e, "provider"),
                        ..ExternalDraft::default()
                    });
                }
                b"connection" => {
                    if let Some(draft) = current.as_mut() {
                        if let Some(driver) = xml_attr(&e, "driver") {
                            draft.driver_hint = Some(driver);
                        }
                        if let Some(url) = xml_attr(&e, "url") {
                            draft.url = Some(url);
                        }
                        if let Some(host) = xml_attr(&e, "host") {
                            draft.host = Some(host);
                        }
                        if let Some(port) = xml_attr(&e, "port") {
                            draft.port = port.parse::<u16>().ok();
                        }
                        if let Some(server) = xml_attr(&e, "server") {
                            draft.database = Some(server);
                        }
                        if let Some(user) = xml_attr(&e, "user") {
                            draft.user = Some(user);
                        }
                    }
                }
                b"driver-ref" => {
                    if let Some(draft) = current.as_mut() {
                        if let Some(reference) = xml_attr(&e, "ref") {
                            draft.driver_hint = Some(reference);
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) => {
                if e.local_name().as_ref() == b"data-source" {
                    if let Some(draft) = current.take() {
                        drafts.push(draft);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Failed to parse XML data sources: {e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(drafts)
}

/// Parse a DBeaver or DataGrip export into drafts, then map to connections.
fn parse_external_file(file_path: &str, content: &str) -> Result<ExternalImportResult, String> {
    let trimmed = content.trim_start();
    let is_json = trimmed.starts_with('{');
    let is_xml = trimmed.starts_with('<') || trimmed.starts_with("<?xml");

    let (drafts, source) = if is_json {
        (parse_dbeaver_json(content)?, "dbeaver")
    } else if is_xml {
        // Distinguish DBeaver legacy XML from DataGrip XML by content markers.
        let source = if content.contains("data-sources") || content.contains("provider=") {
            "dbeaver"
        } else {
            "datagrip"
        };
        (parse_external_xml(content)?, source)
    } else {
        return Err(format!(
            "Unrecognized file format for {file_path}. Expected a DBeaver data-sources.json/.xml or a DataGrip dataSources.xml file."
        ));
    };

    let mut connections = Vec::new();
    let mut skipped = Vec::new();
    for draft in drafts {
        let label = draft
            .name
            .clone()
            .or_else(|| draft.host.clone())
            .unwrap_or_else(|| "unnamed".to_string());
        match draft_to_exportable(draft, source) {
            Ok(conn) => connections.push(conn),
            Err(reason) => skipped.push(SkippedConnection {
                name: label,
                reason,
            }),
        }
    }

    if connections.is_empty() && skipped.is_empty() {
        return Err("The file contains no connections.".to_string());
    }

    Ok(ExternalImportResult {
        connections,
        skipped,
    })
}

/// Import connections exported by external tools (DBeaver, DataGrip).
///
/// Supported inputs:
/// - DBeaver `.dbeaver/data-sources.json` (JSON `connections` map)
/// - DBeaver legacy `data-sources.xml`
/// - DataGrip `dataSources.xml` / `dataSources.local.xml`
///
/// Passwords are never imported — DBeaver encrypts them and DataGrip keeps
/// them in the IDE keychain — so every returned connection has an empty
/// password and carries an `import_note` in `additional_fields`.
///
/// Without `selected_indices` this is a pure preview. With it, the chosen
/// entries are persisted through ConnectionStorage and any per-entry
/// passwords typed into the dialog go to the keyring — the same contract as
/// `import_connections_from_file`.
#[tauri::command]
pub fn import_external_connections(
    file_path: String,
    selected_indices: Option<Vec<usize>>,
    passwords: Option<HashMap<usize, String>>,
    conn_storage: State<'_, ConnectionStorage>,
) -> Result<ExternalImportResult, String> {
    let content =
        std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;
    let result = parse_external_file(&file_path, &content)?;

    if let Some(indices) = selected_indices {
        persist_imported_connections(
            &conn_storage,
            &result.connections,
            &indices,
            &passwords.unwrap_or_default(),
        )?;
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypt_v1_fixture(data: &str, password: &str) -> String {
        let salt = [7_u8; SALT_LEN];
        let nonce_bytes = [9_u8; NONCE_LEN];
        let key = derive_key(password, &salt, PBKDF2_V1_ITERATIONS);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), data.as_bytes())
            .unwrap();
        serde_json::to_string(&EncryptedPayloadV1 {
            version: "1".to_string(),
            salt: BASE64.encode(salt),
            iv: BASE64.encode(nonce_bytes),
            data: BASE64.encode(ciphertext),
        })
        .unwrap()
    }

    #[test]
    fn v2_round_trip_uses_authenticated_envelope() {
        let exported = encrypt_connections("{\"hello\":true}", "correct horse battery").unwrap();
        let value: serde_json::Value = serde_json::from_str(&exported).unwrap();

        assert_eq!(value["version"], 2);
        assert_eq!(value["format"], EXPORT_FORMAT);
        assert_eq!(value["iterations"], PBKDF2_V2_ITERATIONS);
        assert_eq!(
            decrypt_connections(&exported, "correct horse battery").unwrap(),
            "{\"hello\":true}"
        );
    }

    #[test]
    fn v2_rejects_tampered_envelope_metadata() {
        let exported = encrypt_connections("secret", "correct horse battery").unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&exported).unwrap();
        value["format"] = serde_json::json!("other-format");

        assert!(decrypt_connections(&value.to_string(), "correct horse battery").is_err());
    }

    #[test]
    fn v1_payloads_remain_importable_for_migration() {
        let connection = ExportableConnection::from(&ConnectionConfig {
            name: "legacy".to_string(),
            ..ConnectionConfig::default()
        });
        let legacy_json = serde_json::to_string(&vec![connection]).unwrap();
        let exported = encrypt_v1_fixture(&legacy_json, "legacy-pass");
        let imported =
            parse_decrypted_connections(&decrypt_connections(&exported, "legacy-pass").unwrap())
                .unwrap();

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].name, "legacy");
    }

    #[test]
    fn v2_document_round_trip_preserves_connections() {
        let document = ConnectionExportDocument {
            version: 2,
            format: EXPORT_FORMAT.to_string(),
            exported_at: "2026-07-15T00:00:00Z".to_string(),
            connections: vec![ExportableConnection::from(&ConnectionConfig {
                name: "production".to_string(),
                db_type: DatabaseType::PostgreSQL,
                host: Some("db.example.test".to_string()),
                ..ConnectionConfig::default()
            })],
        };
        let plaintext = serde_json::to_string(&document).unwrap();
        let encrypted = encrypt_connections(&plaintext, "correct horse battery").unwrap();
        let imported = parse_decrypted_connections(
            &decrypt_connections(&encrypted, "correct horse battery").unwrap(),
        )
        .unwrap();

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].name, "production");
        assert_eq!(imported[0].host.as_deref(), Some("db.example.test"));
    }

    #[test]
    fn dbeaver_json_imports_postgres_and_mysql() {
        let json = r#"{
            "connections": {
                "pg-prod": {
                    "provider": "postgresql",
                    "driver": "postgres_jdbc",
                    "name": "Prod PG",
                    "configuration": {
                        "host": "prod.example.com",
                        "port": "5433",
                        "database": "shop",
                        "user": "admin"
                    }
                },
                "pg-url": {
                    "provider": "postgresql",
                    "driver": "postgres_jdbc",
                    "name": "Url PG",
                    "configuration": {
                        "url": "jdbc:postgresql://db.internal:5432/analytics?ssl=true",
                        "user": "reader"
                    }
                },
                "mysql-dev": {
                    "provider": "mysql",
                    "driver": "mysql8",
                    "name": "Dev MySQL",
                    "configuration": {
                        "host": "127.0.0.1",
                        "port": "3307",
                        "database": "appdb",
                        "user": "dev"
                    }
                }
            }
        }"#;

        let result = parse_external_file("data-sources.json", json).unwrap();
        assert_eq!(result.connections.len(), 3);
        assert!(result.skipped.is_empty());

        let prod = result
            .connections
            .iter()
            .find(|c| c.name == "Prod PG")
            .unwrap();
        assert_eq!(prod.db_type, DatabaseType::PostgreSQL);
        assert_eq!(prod.host.as_deref(), Some("prod.example.com"));
        assert_eq!(prod.port, Some(5433));
        assert_eq!(prod.database.as_deref(), Some("shop"));
        assert_eq!(prod.username.as_deref(), Some("admin"));
        assert!(prod.additional_fields.contains_key("import_note"));

        let url_pg = result
            .connections
            .iter()
            .find(|c| c.name == "Url PG")
            .unwrap();
        assert_eq!(url_pg.db_type, DatabaseType::PostgreSQL);
        assert_eq!(url_pg.host.as_deref(), Some("db.internal"));
        assert_eq!(url_pg.port, Some(5432));
        assert_eq!(url_pg.database.as_deref(), Some("analytics"));
        assert_eq!(url_pg.username.as_deref(), Some("reader"));

        let mysql = result
            .connections
            .iter()
            .find(|c| c.name == "Dev MySQL")
            .unwrap();
        assert_eq!(mysql.db_type, DatabaseType::MySQL);
        assert_eq!(mysql.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(mysql.port, Some(3307));
        assert_eq!(mysql.database.as_deref(), Some("appdb"));
        assert_eq!(mysql.username.as_deref(), Some("dev"));
    }

    #[test]
    fn dbeaver_json_skips_unsupported_engines() {
        let json = r#"{
            "connections": {
                "db2": {
                    "provider": "db2",
                    "driver": "db2_jcc",
                    "name": "DB2 LUW",
                    "configuration": {
                        "url": "jdbc:db2://db2.host:50000/SAMPLE",
                        "user": "db2inst1"
                    }
                }
            }
        }"#;

        let result = parse_external_file("data-sources.json", json).unwrap();
        assert!(result.connections.is_empty());
        assert_eq!(result.skipped.len(), 1);
        assert_eq!(result.skipped[0].name, "DB2 LUW");
    }

    #[test]
    fn dbeaver_json_imports_oracle_thin_url() {
        let json = r#"{
            "connections": {
                "ora": {
                    "provider": "oracle",
                    "driver": "oracle_thin",
                    "name": "Oracle DB",
                    "configuration": {
                        "url": "jdbc:oracle:thin:@//oracle.host:1521/ORCL",
                        "user": "scott"
                    }
                }
            }
        }"#;

        let result = parse_external_file("data-sources.json", json).unwrap();
        assert!(result.skipped.is_empty());
        assert_eq!(result.connections.len(), 1);
        let oracle = &result.connections[0];
        assert_eq!(oracle.db_type, DatabaseType::Oracle);
        assert_eq!(oracle.host.as_deref(), Some("oracle.host"));
        assert_eq!(oracle.port, Some(1521));
        assert_eq!(oracle.database.as_deref(), Some("ORCL"));
        assert_eq!(oracle.username.as_deref(), Some("scott"));
    }

    #[test]
    fn datagrip_xml_imports_jdbc_url_fields() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
    <data-source source="LOCAL" name="orders@localhost" uuid="abc-123">
      <driver-ref>postgresql</driver-ref>
      <jdbc-driver>org.postgresql.Driver</jdbc-driver>
      <jdbc-url>jdbc:postgresql://localhost:5432/orders</jdbc-url>
      <user-name>postgres</user-name>
    </data-source>
    <data-source source="LOCAL" name="ms-sql" uuid="def-456">
      <driver-ref>sqlserver.ms</driver-ref>
      <jdbc-url>jdbc:sqlserver://win-host:1433;databaseName=erp;user=sa</jdbc-url>
    </data-source>
  </component>
</project>"#;

        let result = parse_external_file("dataSources.local.xml", xml).unwrap();
        assert_eq!(result.connections.len(), 2);

        let pg = &result.connections[0];
        assert_eq!(pg.name, "orders@localhost");
        assert_eq!(pg.db_type, DatabaseType::PostgreSQL);
        assert_eq!(pg.host.as_deref(), Some("localhost"));
        assert_eq!(pg.port, Some(5432));
        assert_eq!(pg.database.as_deref(), Some("orders"));
        assert_eq!(pg.username.as_deref(), Some("postgres"));

        let ms = &result.connections[1];
        assert_eq!(ms.db_type, DatabaseType::MSSQL);
        assert_eq!(ms.host.as_deref(), Some("win-host"));
        assert_eq!(ms.port, Some(1433));
        assert_eq!(ms.database.as_deref(), Some("erp"));
        assert_eq!(ms.username.as_deref(), Some("sa"));
    }

    #[test]
    fn dbeaver_legacy_xml_imports_connection_attributes() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<data-sources>
  <data-source id="pg1" provider="postgresql" driver="postgres_jdbc" name="Legacy PG">
    <connection host="legacy.example.com" port="5432" server="warehouse" user="etl"/>
  </data-source>
</data-sources>"#;

        let result = parse_external_file("data-sources.xml", xml).unwrap();
        assert_eq!(result.connections.len(), 1);
        let conn = &result.connections[0];
        assert_eq!(conn.name, "Legacy PG");
        assert_eq!(conn.db_type, DatabaseType::PostgreSQL);
        assert_eq!(conn.host.as_deref(), Some("legacy.example.com"));
        assert_eq!(conn.port, Some(5432));
        assert_eq!(conn.database.as_deref(), Some("warehouse"));
        assert_eq!(conn.username.as_deref(), Some("etl"));
    }

    #[test]
    fn sqlite_url_maps_to_file_path() {
        let json = r#"{
            "connections": {
                "lite": {
                    "provider": "sqlite",
                    "driver": "sqlite_jdbc",
                    "name": "Local SQLite",
                    "configuration": {
                        "url": "jdbc:sqlite:C:/data/local.db"
                    }
                }
            }
        }"#;

        let result = parse_external_file("data-sources.json", json).unwrap();
        assert_eq!(result.connections.len(), 1);
        let conn = &result.connections[0];
        assert_eq!(conn.db_type, DatabaseType::SQLite);
        assert_eq!(conn.file_path.as_deref(), Some("C:/data/local.db"));
        assert!(conn.host.is_none());
    }

    #[test]
    fn v2_requires_a_stronger_export_password() {
        assert!(encrypt_connections("secret", "short").is_err());
    }
}
